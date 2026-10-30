import assert from "node:assert/strict";
import { test } from "node:test";
import {
	askContextMetrics,
	costTotal,
	headlessTextMetrics,
	interviewMetrics,
	type TranscriptEntry,
	tokenUsage,
	transcriptFromEvents,
} from "../scripts/behavior/metrics.ts";

const usagePattern = /usage/;

test("usage counts each completed assistant request once, including cache tokens", () => {
	const events = [
		{
			type: "message_update",
			message: { role: "assistant", usage: { input: 999 } },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
			},
		},
		{ type: "message_end", message: { role: "toolResult" } },
		{
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 20, output: 5, cacheRead: 8, cacheWrite: 1 },
			},
		},
	];
	assert.deepEqual(tokenUsage(events), {
		requestCount: 2,
		firstRequest: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
		total: { input: 30, output: 7, cacheRead: 11, cacheWrite: 5 },
	});
});

test("usage rejects missing assistant usage instead of reporting zero billed tokens", () => {
	assert.throws(
		() => tokenUsage([{ type: "message_end", message: { role: "assistant" } }]),
		usagePattern
	);
});

test("headless text flags a positive assumption, not a refusal to assume", () => {
	assert.deepEqual(
		headlessTextMetrics(
			"Blocked. I withheld a plan rather than assuming a default."
		),
		{
			statedAssumption: false,
			stoppedForDecision: true,
		}
	);
	assert.deepEqual(
		headlessTextMetrics("I assume local-only storage and will proceed."),
		{
			statedAssumption: true,
			stoppedForDecision: false,
		}
	);
});

test("interview metrics track elapsed time to plan and repeated asks", () => {
	const asks = [
		{ args: { questions: [{ id: "scope" }] } },
		{ args: { questions: [{ id: "tone" }, { id: "layout" }] } },
		{ args: { questions: [{ id: "delivery" }] } },
	];
	assert.deepEqual(interviewMetrics(asks, 1000, 8000, true), {
		askCalls: 3,
		questionCount: 4,
		followUpBundled: true,
		elapsedBeforePlanMs: 7000,
		runaway: false,
	});
	assert.equal(
		interviewMetrics(asks, 1000, 8000, false).elapsedBeforePlanMs,
		null
	);
});

const prompt: TranscriptEntry = {
	role: "user",
	text: "Plan it. Ask me first.",
};

function assistant(
	text: string,
	calls: Array<{ id: string; name?: string; args?: unknown }> = []
): TranscriptEntry {
	return {
		role: "assistant",
		text,
		blocks: [
			"thinking",
			...(text ? ["text"] : []),
			...calls.map(() => "toolCall"),
		],
		toolCalls: calls.map((call) => ({
			id: call.id,
			name: call.name ?? "ask_user",
			args: call.args ?? { questions: [] },
		})),
	};
}

function askResult(toolCallId: string, cancelReason?: string): TranscriptEntry {
	return {
		role: "toolResult",
		text: "Storage: Local files",
		toolName: "ask_user",
		toolCallId,
		cancelReason,
		isError: cancelReason === "invalid_input",
	};
}

/** An ask_user call whose arguments carry the given context. */
function ask(id: string, context: string, questions: unknown[] = []) {
	return { id, args: { context, questions } };
}

test("transcript keeps finalized messages with block order, tool calls, and cancel reasons", () => {
	const transcript = transcriptFromEvents([
		{ type: "message_update", message: { role: "assistant", content: [] } },
		{
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "Go" }] },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking" },
					{ type: "toolCall", id: "a1", name: "ask_user", arguments: { x: 1 } },
				],
			},
		},
		{
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "ask_user",
				toolCallId: "a1",
				details: { cancelReason: "invalid_input" },
				isError: true,
				content: [{ type: "text", text: "Invalid ask_user payload:" }],
			},
		},
	]);
	assert.deepEqual(transcript, [
		{ role: "user", text: "Go" },
		{
			role: "assistant",
			text: "",
			blocks: ["thinking", "toolCall"],
			toolCalls: [{ id: "a1", name: "ask_user", args: { x: 1 } }],
		},
		{
			role: "toolResult",
			text: "Invalid ask_user payload:",
			toolName: "ask_user",
			toolCallId: "a1",
			cancelReason: "invalid_input",
			isError: true,
		},
	]);
});

test("cost sums pi's per-request totals of assistant messages", () => {
	assert.equal(
		costTotal([
			{
				type: "message_end",
				message: { role: "assistant", usage: { cost: { total: 0.25 } } },
			},
			{ type: "message_end", message: { role: "toolResult" } },
			{
				type: "message_end",
				message: { role: "assistant", usage: { cost: { total: 0.5 } } },
			},
		]),
		0.75
	);
});

test("the context of an ask explains it even when its message has only thinking", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [ask("a1", "The ADR names deepseek.")]),
		askResult("a1"),
	]);
	assert.deepEqual(
		{
			asksWithoutContext: metrics.asksWithoutContext,
			openedWithoutExplanation: metrics.openedWithoutExplanation,
			firstAsk: metrics.firstAsk,
		},
		{
			asksWithoutContext: 0,
			openedWithoutExplanation: 0,
			firstAsk: {
				textChars: 0,
				contextChars: "The ADR names deepseek.".length,
				factInText: undefined,
				factInContext: undefined,
				factInForm: undefined,
			},
		}
	);
});

test("an ask with neither message text nor context opens without an explanation", () => {
	for (const context of [undefined, " \n "]) {
		const metrics = askContextMetrics([
			prompt,
			assistant("", [{ id: "a1", args: { context, questions: [] } }]),
			askResult("a1"),
		]);
		assert.equal(metrics.asksWithoutContext, 1, String(context));
		assert.equal(metrics.openedWithoutExplanation, 1, String(context));
	}
});

test("text from an earlier message after the same user input explains an ask without context", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("I read the ADR. It names deepseek.", [
			{ id: "r1", name: "read" },
		]),
		{ role: "toolResult", text: "file", toolName: "read", toolCallId: "r1" },
		assistant("", [{ id: "a1" }]),
		askResult("a1"),
	]);
	assert.equal(metrics.asksWithoutContext, 1);
	assert.equal(metrics.openedWithoutExplanation, 0);
	assert.equal(
		metrics.firstAsk?.textChars,
		"I read the ADR. It names deepseek.".length
	);
});

test("an answered ask starts a new window, so the next ask needs new text or context", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Two designs exist.", [{ id: "a1" }]),
		askResult("a1"),
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.equal(metrics.openedWithoutExplanation, 1);
	assert.deepEqual(metrics.afterFirstAnswer, {
		textChars: 0,
		contextChars: 0,
		askCalls: 1,
		openedAsks: 1,
	});
});

test("context that repeats the message text before it counts as explained twice", () => {
	const explanation =
		"Files stay readable outside the app, while a database makes search faster.";
	const twice = askContextMetrics([
		prompt,
		assistant(explanation, [ask("a1", explanation)]),
		askResult("a1"),
	]);
	assert.equal(twice.explainedTwice, 1);
	const once = askContextMetrics([
		prompt,
		assistant("I checked the storage code.", [ask("a1", explanation)]),
		askResult("a1"),
	]);
	assert.equal(once.explainedTwice, 0);
});

const storageQuestion = {
	label: "Q1 Storage",
	prompt: "Q1: Store the notes as plain files or in a database?",
};

test("a question written in the text or the context before its form counts as repeated", () => {
	const grillingRound =
		"Two storage designs fit.\n\n❓ **Q1** - **Storage**: Files or a database?\n\n➡️ Files.";
	const inText = askContextMetrics([
		prompt,
		assistant(grillingRound, [
			ask("a1", "Storage decides sync.", [storageQuestion]),
		]),
		askResult("a1"),
	]);
	assert.deepEqual(
		{
			formQuestions: inText.formQuestions,
			repeatedQuestions: inText.repeatedQuestions,
		},
		{ formQuestions: 1, repeatedQuestions: 1 }
	);
	const inContext = askContextMetrics([
		prompt,
		assistant("", [ask("a1", grillingRound, [storageQuestion])]),
		askResult("a1"),
	]);
	assert.equal(inContext.repeatedQuestions, 1);
	const reworded = askContextMetrics([
		prompt,
		assistant("", [
			ask(
				"a1",
				"Should the app store the notes as plain files or in a database?",
				[storageQuestion]
			),
		]),
		askResult("a1"),
	]);
	assert.equal(reworded.repeatedQuestions, 1);
});

test("a question without its own label is repeated under the number the form shows", () => {
	for (const label of [undefined, "  "]) {
		const metrics = askContextMetrics([
			prompt,
			assistant("", [
				ask("a1", "❓ **Q1** - Pick a backend: local files or a database?", [
					{ label, prompt: "Should we keep all the records in SQLite?" },
				]),
			]),
			askResult("a1"),
		]);
		assert.equal(metrics.repeatedQuestions, 1, String(label));
	}
});

test("an exact repeat of a three-word prompt counts", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [
			ask("a1", "Enable offline sync?", [{ prompt: "Enable offline sync?" }]),
		]),
		askResult("a1"),
	]);
	assert.equal(metrics.repeatedQuestions, 1);
});

test("an explanation, and a passing mention of a question number, do not repeat the question", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Your Q1 note asked about backups.", [
			ask(
				"a1",
				"Files stay readable outside the app. A database makes search faster. Both designs back up the same way.",
				[storageQuestion]
			),
		]),
		askResult("a1"),
	]);
	assert.equal(metrics.repeatedQuestions, 0);
});

test("an invalid payload is not user input, so it does not reset the window", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Context first.", [{ id: "a1" }]),
		askResult("a1", "invalid_input"),
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.equal(metrics.openedWithoutExplanation, 0);
});

test("an invalid payload opens no form, so it is neither an opened ask nor an answer", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [{ id: "a1" }]),
		askResult("a1", "invalid_input"),
		assistant("Final answer."),
	]);
	assert.deepEqual(
		{
			askCalls: metrics.askCalls,
			openedAsks: metrics.openedAsks,
			invalidAsks: metrics.invalidAsks,
			openedWithoutExplanation: metrics.openedWithoutExplanation,
			afterFirstAnswer: metrics.afterFirstAnswer,
		},
		{
			askCalls: 1,
			openedAsks: 0,
			invalidAsks: 1,
			openedWithoutExplanation: 0,
			afterFirstAnswer: null,
		}
	);
});

test("after an invalid payload, the valid ask is the first opened form and its answer the first answer", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [ask("a1", " ")]),
		askResult("a1", "invalid_input"),
		assistant("", [ask("a2", "Context.")]),
		askResult("a2"),
		assistant("Done."),
	]);
	assert.equal(metrics.openedAsks, 1);
	assert.equal(metrics.openedWithoutExplanation, 0);
	assert.equal(metrics.invalidAsks, 1);
	assert.equal(metrics.asksWithoutContext, 1);
	assert.deepEqual(metrics.afterFirstAnswer, {
		textChars: "Done.".length,
		contextChars: 0,
		askCalls: 0,
		openedAsks: 0,
	});
});

test("a schema failure without a cancel reason is an error result, so it opens no form and is not input", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Context first.", [{ id: "a1" }]),
		{
			role: "toolResult",
			text: "Validation failed",
			toolName: "ask_user",
			toolCallId: "a1",
			isError: true,
		},
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.equal(metrics.openedWithoutExplanation, 0);
	assert.equal(metrics.openedAsks, 1);
	assert.equal(metrics.invalidAsks, 1);
});

test("two asks in one message share that message's text", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Both decisions explained.", [{ id: "a1" }, { id: "a2" }]),
		askResult("a1"),
		askResult("a2"),
	]);
	assert.equal(metrics.openedWithoutExplanation, 0);
	assert.equal(metrics.askCalls, 2);
});

test("after the first answer: an explanation in the next form's context, or text and no form", () => {
	const answeredThenAsked = askContextMetrics([
		prompt,
		assistant("", [ask("a1", "Options: A or B.")]),
		askResult("a1"),
		assistant("", [ask("a2", "A keeps notes local; B syncs them.")]),
		askResult("a2"),
	]);
	assert.deepEqual(answeredThenAsked.afterFirstAnswer, {
		textChars: 0,
		contextChars: "A keeps notes local; B syncs them.".length,
		askCalls: 1,
		openedAsks: 1,
	});
	const explainedOnly = askContextMetrics([
		prompt,
		assistant("", [ask("a1", "Options: A or B.")]),
		askResult("a1"),
		assistant("A keeps notes local; B syncs them. Reply in chat."),
	]);
	assert.deepEqual(explainedOnly.afterFirstAnswer, {
		textChars: "A keeps notes local; B syncs them. Reply in chat.".length,
		contextChars: 0,
		askCalls: 0,
		openedAsks: 0,
	});
});

test("a fact counts where the user reads it: text, context, or only the form", () => {
	const onlyInForm = askContextMetrics(
		[
			prompt,
			assistant("", [
				ask("a1", "The base model gates text changes.", [
					{ prompt: "Keep deepseek-v4.1-flash?" },
				]),
			]),
			askResult("a1"),
		],
		"deepseek"
	);
	assert.deepEqual(onlyInForm.firstAsk, {
		textChars: 0,
		contextChars: "The base model gates text changes.".length,
		factInText: false,
		factInContext: false,
		factInForm: true,
	});
	const inContext = askContextMetrics(
		[
			prompt,
			assistant("", [
				ask("a1", "The ADR names deepseek-v4.1-flash.", [
					{ prompt: "Change the base model?" },
				]),
			]),
			askResult("a1"),
		],
		"deepseek"
	);
	assert.equal(inContext.firstAsk?.factInContext, true);
	assert.equal(inContext.firstAsk?.factInForm, false);
});

test("a fact counts as in the form only where the form shows it", () => {
	const factInForm = (questions: unknown[]) =>
		askContextMetrics(
			[
				prompt,
				assistant("", [ask("a1", "Pick a model.", questions)]),
				askResult("a1"),
			],
			"deepseek"
		).firstAsk?.factInForm;
	const question = { id: "model", prompt: "Keep the current model?" };
	const hidden = [
		{ ...question, id: "deepseek", options: [{ label: "Keep current" }] },
		{ ...question, options: [{ label: "Keep current", value: "deepseek" }] },
		{
			...question,
			type: "single",
			options: [{ label: "Keep current", preview: "deepseek" }],
		},
	];
	for (const shape of hidden) {
		assert.equal(factInForm([shape]), false, JSON.stringify(shape));
	}
	const shown = [
		{ ...question, options: [{ label: "Keep deepseek" }] },
		{
			...question,
			options: [{ label: "Keep current", description: "Stay on deepseek." }],
		},
		{
			...question,
			type: "preview",
			options: [{ label: "Keep current", preview: "deepseek" }],
		},
		// The tool makes a question with previews on every option a preview question.
		{ ...question, options: [{ label: "Keep current", preview: "deepseek" }] },
		{ ...question, label: "deepseek", options: [{ label: "Keep current" }] },
	];
	for (const shape of shown) {
		assert.equal(factInForm([shape]), true, JSON.stringify(shape));
	}
});
