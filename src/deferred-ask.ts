import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { lastUserInputId } from "./ask-context-check.ts";
import { appendAskPayload } from "./ask-payload-store.ts";
import { successfulResponse } from "./ask-tool-helpers.ts";
import { getAskConfigStore } from "./config/store.ts";
import type { RemoteAskRuntime } from "./remote-ask.ts";
import { runRpcAskFlow } from "./rpc-ask.ts";
import type { AskParams, AskResult } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";

/** An ask refused for missing context; pi-ask opens it once the model's explanation turn settles. */
export interface DeferredAsk {
	/** The user input the refusal belongs to. */
	boundaryId: string;
	params: AskParams;
	toolCallId: string;
}

/** One refusal per user input, and at most one form waiting for the turn to end. */
export class DeferredAsks {
	private readonly refusedInputs = new Set<string>();
	private pending?: DeferredAsk;

	refused(boundaryId: string): boolean {
		return this.refusedInputs.has(boundaryId);
	}

	defer(ask: DeferredAsk): void {
		this.refusedInputs.add(ask.boundaryId);
		this.pending = ask;
	}

	/** A form opened through the tool, so the waiting form is not needed. */
	clear(): void {
		this.pending = undefined;
	}

	take(): DeferredAsk | undefined {
		const ask = this.pending;
		this.pending = undefined;
		return ask;
	}
}

type DeferredPi = Pick<
	ExtensionAPI,
	| "on"
	| "sendUserMessage"
	| "exec"
	| "getCommands"
	| "events"
	| "appendEntry"
	| "setLabel"
>;

/** The run ended with the model's own reply, not with an abort, an error, or a cut tool loop. */
function endedWithReply(branch: readonly SessionEntry[]): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			return entry.message.stopReason === "stop";
		}
	}
	return false;
}

/**
 * When the run settles after a refusal, open the refused form: the model was told to end its
 * turn with the explanation, so the user has read it. The form stays closed when the run did
 * not end with the model's reply (an abort, an error) or the user wrote since the refusal.
 */
export function registerDeferredAskOpening(
	pi: DeferredPi,
	asks: DeferredAsks,
	remoteAsk: RemoteAskRuntime | undefined,
	shutdownSignal: AbortSignal
): void {
	pi.on("agent_settled", (event, ctx) => {
		const ask = asks.take();
		if (!ask) {
			return;
		}
		const branch = ctx.sessionManager.getBranch();
		// pi 1.4 and later also report an abort on the event; earlier versions do not.
		const aborted = Boolean((event as { aborted?: unknown }).aborted);
		if (
			aborted ||
			!endedWithReply(branch) ||
			lastUserInputId(branch) !== ask.boundaryId
		) {
			return;
		}
		openDeferredAsk(pi, ctx, ask, remoteAsk, shutdownSignal).catch(
			(error: unknown) => {
				ctx.ui.notify(
					`ask_user could not open the waiting form: ${error instanceof Error ? error.message : String(error)}`,
					"error"
				);
			}
		);
	});
}

async function openDeferredAsk(
	pi: DeferredPi,
	ctx: ExtensionContext,
	ask: DeferredAsk,
	remoteAsk: RemoteAskRuntime | undefined,
	shutdownSignal: AbortSignal
): Promise<void> {
	// Saved when the form opens, as for a tool call, so /ask:replay finds it.
	appendAskPayload(pi, ctx, {
		params: ask.params,
		source: "tool",
		sourceEntryId: ask.toolCallId,
	});
	const result = await collectDeferredAnswers(
		pi,
		ctx,
		ask,
		remoteAsk,
		shutdownSignal
	);
	if (result.cancelled) {
		ctx.ui.notify("Ask form cancelled.", "info");
		return;
	}
	const text = successfulResponse(
		result,
		pi.getCommands(),
		ctx.isIdle() ? pi.events : undefined
	).content[0].text;
	pi.sendUserMessage(
		text,
		ctx.isIdle() ? undefined : { deliverAs: "followUp" }
	);
}

async function collectDeferredAnswers(
	pi: DeferredPi,
	ctx: ExtensionContext,
	ask: DeferredAsk,
	remoteAsk: RemoteAskRuntime | undefined,
	shutdownSignal: AbortSignal
): Promise<AskResult> {
	if (ctx.mode === "rpc") {
		const config = await getAskConfigStore().getConfig();
		return runRpcAskFlow(ctx, ask.params, {
			presentSingleAsMulti: config.behaviour.presentSingleAsMulti,
			remote: remoteAsk,
			shutdownSignal,
			source: "ask:deferred",
			toolCallId: ask.toolCallId,
		});
	}
	return runAskFlow(ctx, ask.params, {
		exec: pi.exec,
		getCommands: () => pi.getCommands(),
		shutdownSignal,
		remote: remoteAsk
			? {
					runtime: remoteAsk,
					source: "ask:deferred",
					toolCallId: ask.toolCallId,
				}
			: undefined,
	});
}
