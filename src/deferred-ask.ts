import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lastUserInputId } from "./ask-context-check.ts";
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
	"on" | "sendUserMessage" | "exec" | "getCommands" | "events"
>;

/**
 * When the run settles after a refusal, open the refused form: the model was told to end its
 * turn with the explanation, so the user has read it. An aborted run, or a user message since
 * the refusal, makes the waiting form stale.
 */
export function registerDeferredAskOpening(
	pi: DeferredPi,
	asks: DeferredAsks,
	remoteAsk: RemoteAskRuntime | undefined,
	shutdownSignal: AbortSignal
): void {
	pi.on("agent_settled", (event, ctx) => {
		const ask = asks.take();
		const aborted = Boolean((event as { aborted?: unknown }).aborted);
		if (
			!ask ||
			aborted ||
			lastUserInputId(ctx.sessionManager.getBranch()) !== ask.boundaryId
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
