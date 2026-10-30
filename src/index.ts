import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAnswerCommands,
	registerReplayShortcut,
} from "./answer-commands.ts";
import { registerAskSettingsCommand } from "./ask-settings-command.ts";
import { registerAskTool } from "./ask-tool.ts";
import { resetAskConfigStore } from "./config/store.ts";
import {
	hasActiveConfigMessage,
	matchesConfigPrompt,
} from "./config-trigger.ts";
import { DeferredAsks, registerDeferredAskOpening } from "./deferred-ask.ts";
import { registerAskEntryRenderers } from "./entry-renderers.ts";
import { PI_ASK_CONFIG_PROMPT } from "./prompt-text.ts";
import { registerRecoveryContext } from "./recovery-context.ts";
import { createRemoteAskRuntime } from "./remote-ask.ts";
import { registerPendingAskResume } from "./resume-pending-ask.ts";
import { setSkillAutocompleteEvents } from "./ui/autocomplete.ts";

export default async function askExtension(pi: ExtensionAPI) {
	resetAskConfigStore();
	setSkillAutocompleteEvents(pi.events);
	pi.on("before_agent_start", (event, ctx) => {
		if (
			matchesConfigPrompt(event.prompt) &&
			!hasActiveConfigMessage(ctx.sessionManager)
		) {
			return {
				message: {
					customType: "pi_ask_config",
					content: PI_ASK_CONFIG_PROMPT,
					display: false,
				},
			};
		}
		return {};
	});
	const remoteAsk = createRemoteAskRuntime(pi.events);
	const shutdown = new AbortController();
	// Unresolved ask_user calls whose pi-ai placeholder result a request in this process
	// already sent. Recovery records this on its dismissal marker.
	const placeholderSentIds = new Set<string>();
	const deferredAsks = new DeferredAsks();
	registerAskTool(pi, remoteAsk, shutdown.signal, deferredAsks);
	registerDeferredAskOpening(pi, deferredAsks, remoteAsk, shutdown.signal);
	registerAskSettingsCommand(pi);
	registerAnswerCommands(pi, remoteAsk);
	registerPendingAskResume(pi, remoteAsk, placeholderSentIds, shutdown.signal);
	pi.on("session_shutdown", () => {
		shutdown.abort();
		remoteAsk.disposeAll();
	});
	registerRecoveryContext(pi, placeholderSentIds);
	registerAskEntryRenderers(pi);
	await registerReplayShortcut(pi, remoteAsk);
}
