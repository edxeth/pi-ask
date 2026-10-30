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
		isError:
			cancelReason === "missing_context" || cancelReason === "invalid_input",
	};
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
				details: { cancelReason: "missing_context" },
				isError: true,
				content: [{ type: "text", text: "ask_user did not open." }],
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
			text: "ask_user did not open.",
			toolName: "ask_user",
			toolCallId: "a1",
			cancelReason: "missing_context",
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

test("an ask whose message has only thinking has no text before it", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [{ id: "a1" }]),
		askResult("a1"),
	]);
	assert.equal(metrics.asksWithoutText, 1);
	assert.equal(metrics.openedWithoutText, 1);
	assert.equal(metrics.firstAsk?.textChars, 0);
});

test("text from an earlier message after the same user input counts before an ask", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("I read the ADR. It names deepseek.", [
			{ id: "r1", name: "read" },
		]),
		{ role: "toolResult", text: "file", toolName: "read", toolCallId: "r1" },
		assistant("", [{ id: "a1" }]),
		askResult("a1"),
	]);
	assert.equal(metrics.asksWithoutText, 0);
	assert.equal(
		metrics.firstAsk?.textChars,
		"I read the ADR. It names deepseek.".length
	);
});

test("an answered ask starts a new window, so the next ask needs new text", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Two designs exist.", [{ id: "a1" }]),
		askResult("a1"),
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.equal(metrics.asksWithoutText, 1);
	assert.equal(metrics.afterFirstAnswer?.firstCallHadText, false);
});

test("a refused ask keeps the window open and the retry with text opens the form", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [{ id: "a1" }]),
		askResult("a1", "missing_context"),
		assistant("Here is the context.", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.deepEqual(
		{
			askCalls: metrics.askCalls,
			openedAsks: metrics.openedAsks,
			refusedAsks: metrics.refusedAsks,
			asksWithoutText: metrics.asksWithoutText,
			openedWithoutText: metrics.openedWithoutText,
		},
		{
			askCalls: 2,
			openedAsks: 1,
			refusedAsks: 1,
			asksWithoutText: 1,
			openedWithoutText: 0,
		}
	);
});

test("a refusal is not user input, so earlier text still counts for the retry", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Context from the file.", [{ id: "r1", name: "read" }]),
		{ role: "toolResult", text: "file", toolName: "read", toolCallId: "r1" },
		assistant("", [{ id: "a1" }]),
		askResult("a1", "missing_context"),
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.equal(metrics.asksWithoutText, 0);
	assert.equal(metrics.refusedAsks, 1);
});

test("after a refusal, an explanation that ends the turn differs from another tool call", () => {
	const explained = askContextMetrics([
		prompt,
		assistant("", [{ id: "a1" }]),
		askResult("a1", "missing_context"),
		assistant("Here is what I found and why it matters."),
	]);
	assert.deepEqual(explained.afterRefusal, {
		explainedThenEnded: 1,
		calledAgain: 0,
	});
	const askedAgain = askContextMetrics([
		prompt,
		assistant("", [{ id: "a1" }]),
		askResult("a1", "missing_context"),
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.deepEqual(askedAgain.afterRefusal, {
		explainedThenEnded: 0,
		calledAgain: 1,
	});
});

test("an invalid payload is not user input, so it does not reset the window", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("Context first.", [{ id: "a1" }]),
		askResult("a1", "invalid_input"),
		assistant("", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.equal(metrics.asksWithoutText, 0);
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
			asksWithoutText: metrics.asksWithoutText,
			openedWithoutText: metrics.openedWithoutText,
			afterFirstAnswer: metrics.afterFirstAnswer,
		},
		{
			askCalls: 1,
			openedAsks: 0,
			invalidAsks: 1,
			asksWithoutText: 1,
			openedWithoutText: 0,
			afterFirstAnswer: null,
		}
	);
});

test("after an invalid payload, the valid ask is the first opened form and its answer the first answer", () => {
	const metrics = askContextMetrics([
		prompt,
		assistant("", [{ id: "a1" }]),
		askResult("a1", "invalid_input"),
		assistant("Context.", [{ id: "a2" }]),
		askResult("a2"),
		assistant("Done."),
	]);
	assert.equal(metrics.openedAsks, 1);
	assert.equal(metrics.openedWithoutText, 0);
	assert.equal(metrics.invalidAsks, 1);
	assert.deepEqual(metrics.afterFirstAnswer, {
		textChars: "Done.".length,
		askCalls: 0,
		openedAsks: 0,
		firstCallHadText: null,
		firstOpenedHadText: null,
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
	assert.equal(metrics.asksWithoutText, 0);
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
	assert.equal(metrics.asksWithoutText, 0);
	assert.equal(metrics.askCalls, 2);
});

test("after the first answer: text before the next form, or no form at all", () => {
	const answeredThenAsked = askContextMetrics([
		prompt,
		assistant("Options: A or B.", [{ id: "a1" }]),
		askResult("a1"),
		assistant("A keeps notes local; B syncs them.", [{ id: "a2" }]),
		askResult("a2"),
	]);
	assert.deepEqual(answeredThenAsked.afterFirstAnswer, {
		textChars: "A keeps notes local; B syncs them.".length,
		askCalls: 1,
		openedAsks: 1,
		firstCallHadText: true,
		firstOpenedHadText: true,
	});
	const explainedOnly = askContextMetrics([
		prompt,
		assistant("Options: A or B.", [{ id: "a1" }]),
		askResult("a1"),
		assistant("A keeps notes local; B syncs them. Reply in chat."),
	]);
	assert.deepEqual(explainedOnly.afterFirstAnswer, {
		textChars: "A keeps notes local; B syncs them. Reply in chat.".length,
		askCalls: 0,
		openedAsks: 0,
		firstCallHadText: null,
		firstOpenedHadText: null,
	});
});

test("a fact found only in the form arguments is not in the text", () => {
	const metrics = askContextMetrics(
		[
			prompt,
			assistant("", [
				{
					id: "a1",
					args: { questions: [{ prompt: "Keep deepseek-v4.1-flash?" }] },
				},
			]),
			askResult("a1"),
		],
		"deepseek"
	);
	assert.deepEqual(metrics.firstAsk, {
		textChars: 0,
		factInText: false,
		factInForm: true,
	});
});
