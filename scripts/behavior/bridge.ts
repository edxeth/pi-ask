/** In-process RPC bridge. The driver reads the JSONL trace after Pi exits. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	RemoteAskCompletedEvent,
	RemoteAskStartedEvent,
	RemoteAskSubmitResultEvent,
} from "../../src/remote-ask.ts";
import { cases } from "./cases.mjs";

type StartedQuestion = RemoteAskStartedEvent["questions"][number];

// Pi extension entry points require a default export.
// biome-ignore lint/style/noDefaultExport: Pi loads the default export from -e.
export default function behaviorBridge(pi: ExtensionAPI): void {
	const trace = process.env.PI_ASK_BEHAVIOR_TRACE;
	if (!trace) {
		throw new Error("PI_ASK_BEHAVIOR_TRACE is required");
	}
	const caseId = process.env.PI_ASK_BEHAVIOR_CASE;
	// A case with firstAnswer types that text as the answer to the first question of the first ask.
	const firstAnswer: string | undefined = cases.find(
		(behavior) => behavior.id === caseId
	)?.firstAnswer;
	let startedAsks = 0;
	const log = (kind: string, event: unknown) =>
		appendFileSync(trace, `${JSON.stringify({ kind, event })}\n`);
	const answerFor = (question: StartedQuestion, typed: string | undefined) => {
		const option = question.options[0];
		const choice =
			typed === undefined && option
				? { values: [option.value] }
				: { customText: typed ?? "A short descriptive name" };
		return caseId === "note"
			? { ...choice, note: "Please explain the trade-off before proceeding." }
			: choice;
	};
	for (const prefix of ["pi-ask", "@eko24ive/pi-ask"]) {
		pi.events.on(`${prefix}:started`, (data) => {
			const event = data as RemoteAskStartedEvent;
			log("started", event);
			const typed = startedAsks === 0 ? firstAnswer : undefined;
			startedAsks++;
			const answers = Object.fromEntries(
				event.questions.map((question, index) => [
					question.id,
					answerFor(question, index === 0 ? typed : undefined),
				])
			);
			pi.events.emit(`${prefix}:submit`, {
				version: 1,
				requestId: `behavior-${event.flowId}`,
				flowId: event.flowId,
				response: { kind: "answer", answers },
			});
		});
		pi.events.on(`${prefix}:submit-result`, (event) =>
			log("submit-result", event as RemoteAskSubmitResultEvent)
		);
		pi.events.on(`${prefix}:completed`, (event) =>
			log("completed", event as RemoteAskCompletedEvent)
		);
	}
}
