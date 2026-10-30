import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findAskContext } from "./ask-context-check.ts";
import { appendAskPayload } from "./ask-payload-store.ts";
import {
	abortedResponse,
	invalidPayloadResponse,
	missingContextResponse,
	nonInteractiveResponse,
	renderAskToolCall,
	renderAskToolResult,
	successfulResponse,
	validateParams,
} from "./ask-tool-helpers.ts";
import { getAskConfigStore } from "./config/store.ts";
import { DeferredAsks } from "./deferred-ask.ts";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_PROMPT_GUIDELINES,
	ASK_TOOL_PROMPT_SNIPPET,
	AskToolParamsSchema,
} from "./prompt-text.ts";
import type { RemoteAskRuntime } from "./remote-ask.ts";
import { runRpcAskFlow } from "./rpc-ask.ts";
import { prepareAskParams } from "./state/normalize.ts";
import { summarizeResult, toAskResult } from "./state/result.ts";
import type { AskParams, AskState } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";

export function registerAskTool(
	pi: ExtensionAPI,
	remoteAsk?: RemoteAskRuntime,
	shutdownSignal?: AbortSignal,
	deferredAsks: DeferredAsks = new DeferredAsks()
) {
	pi.registerTool({
		executionMode: "sequential",
		// Codemode scripts must not open an interactive prompt the model cannot see.
		exposure: "model-only",
		name: "ask_user",
		label: "Ask User",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet: ASK_TOOL_PROMPT_SNIPPET,
		promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
		parameters: AskToolParamsSchema,
		prepareArguments: (args) => prepareAskParams(args) as AskParams,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			executeAskTool(
				pi,
				deferredAsks,
				toolCallId,
				params as AskParams,
				signal,
				onUpdate,
				ctx,
				remoteAsk,
				shutdownSignal
			),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

function isInteractive(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || (ctx.mode === "rpc" && ctx.hasUI);
}

function refuseWithoutContext(
	ctx: ExtensionContext,
	toolCallId: string,
	params: AskParams,
	deferredAsks: DeferredAsks
) {
	const context = findAskContext(ctx.sessionManager.getBranch(), toolCallId);
	// One refusal per user input, so a model that ignores it cannot loop.
	if (context.hasText || deferredAsks.refused(context.boundaryId)) {
		// This form opens now, so no refused form waits for the turn to end.
		deferredAsks.clear();
		return;
	}
	deferredAsks.defer({ boundaryId: context.boundaryId, params, toolCallId });
	return missingContextResponse(params, context.blockTypes);
}

async function executeAskTool(
	pi: Pick<
		ExtensionAPI,
		"appendEntry" | "setLabel" | "exec" | "getCommands" | "events"
	>,
	deferredAsks: DeferredAsks,
	toolCallId: string,
	params: AskParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext,
	remoteAsk?: RemoteAskRuntime,
	shutdownSignal?: AbortSignal
) {
	if (signal?.aborted || shutdownSignal?.aborted) {
		return abortedResponse(params);
	}
	const config = await getAskConfigStore().getConfig();
	const validation = validateParams(params, {
		presentSingleAsMulti: config.behaviour.presentSingleAsMulti,
	});
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	const interactive = isInteractive(ctx);
	const refusal = interactive
		? refuseWithoutContext(ctx, toolCallId, params, deferredAsks)
		: undefined;
	if (refusal) {
		return refusal;
	}
	appendAskPayload(pi, ctx, {
		params,
		source: "tool",
		sourceEntryId: toolCallId,
	});
	if (!interactive) {
		return nonInteractiveResponse(validation.state);
	}
	ctx.ui.setWorkingVisible(false);
	let acceptingUpdates = true;
	let lastAnswers = JSON.stringify(validation.state.answers);
	const reportAnswerChange = (state: AskState) => {
		if (!(acceptingUpdates && onUpdate)) {
			return;
		}
		const result = toAskResult(state);
		const answers = JSON.stringify(result.answers);
		if (answers === lastAnswers) {
			return;
		}
		lastAnswers = answers;
		onUpdate({
			content: [{ type: "text", text: summarizeResult(result) }],
			details: result,
		});
	};
	try {
		const result =
			ctx.mode === "rpc"
				? await runRpcAskFlow(ctx, params, {
						presentSingleAsMulti: config.behaviour.presentSingleAsMulti,
						remote: remoteAsk,
						signal,
						shutdownSignal,
						toolCallId,
						onAnswerChange: reportAnswerChange,
					})
				: await runAskFlow(ctx, params, {
						shutdownSignal,
						onAnswerChange: reportAnswerChange,
						exec: pi.exec,
						getCommands: () => pi.getCommands(),
						signal,
						remote: remoteAsk
							? { runtime: remoteAsk, source: "tool", toolCallId }
							: undefined,
					});
		return result.cancelReason === "aborted"
			? abortedResponse(params)
			: successfulResponse(result, pi.getCommands(), pi.events);
	} finally {
		acceptingUpdates = false;
		ctx.ui.setWorkingVisible(true);
	}
}
