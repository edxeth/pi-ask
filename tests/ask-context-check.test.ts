import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findAskContext } from "../src/ask-context-check.ts";

let nextId = 0;
function entry(message: Record<string, unknown>): SessionEntry {
	nextId++;
	return {
		type: "message",
		id: `e${nextId}`,
		parentId: null,
		timestamp: "2026-10-30T00:00:00.000Z",
		message,
	} as unknown as SessionEntry;
}

const user = (text: string) =>
	entry({ role: "user", content: [{ type: "text", text }] });
const assistant = (...content: Record<string, unknown>[]) =>
	entry({ role: "assistant", content, stopReason: "toolUse" });
const thinking = { type: "thinking", thinking: "Plan the rundown." };
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string, name = "ask_user") => ({
	type: "toolCall",
	id,
	name,
	arguments: {},
});
const result = (
	toolCallId: string,
	toolName: string,
	cancelReason?: string,
	isError = cancelReason === "missing_context" ||
		cancelReason === "invalid_input"
) =>
	entry({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "result" }],
		details: cancelReason ? { cancelReason } : {},
		isError,
	});
const MISSING_CALL_RE = /no assistant message with tool call missing/;

test("text in the calling message counts, and the user message is the boundary", () => {
	const prompt = user("Plan it");
	const context = findAskContext(
		[prompt, assistant(thinking, text("Two designs exist."), call("a1"))],
		"a1"
	);
	assert.deepEqual(context, {
		blockTypes: ["thinking", "text", "toolCall"],
		boundaryId: prompt.id,
		hasText: true,
	});
});

test("thinking and a tool call alone give the user nothing to read", () => {
	const context = findAskContext(
		[user("Plan it"), assistant(thinking, call("a1"))],
		"a1"
	);
	assert.equal(context.hasText, false);
	assert.deepEqual(context.blockTypes, ["thinking", "toolCall"]);
});

test("whitespace-only text is not text", () => {
	const context = findAskContext(
		[user("Plan it"), assistant(text("  \n "), call("a1"))],
		"a1"
	);
	assert.equal(context.hasText, false);
});

test("text in an earlier message after the same user input counts", () => {
	const context = findAskContext(
		[
			user("Read the ADR, then ask"),
			assistant(text("The ADR names deepseek."), call("r1", "read")),
			result("r1", "read"),
			assistant(thinking, call("a1")),
		],
		"a1"
	);
	assert.equal(context.hasText, true);
});

test("an answered ask is user input, so earlier text does not count for the next ask", () => {
	const answer = result("a1", "ask_user");
	const context = findAskContext(
		[
			user("Plan it"),
			assistant(text("Two designs exist."), call("a1")),
			answer,
			assistant(thinking, call("a2")),
		],
		"a2"
	);
	assert.equal(context.hasText, false);
	assert.equal(context.boundaryId, answer.id);
});

test("refused and invalid asks are not user input", () => {
	const prompt = user("Plan it");
	const context = findAskContext(
		[
			prompt,
			assistant(text("Context first."), call("a0")),
			result("a0", "ask_user", "invalid_input"),
			assistant(thinking, call("a1")),
			result("a1", "ask_user", "missing_context"),
			assistant(thinking, call("a2")),
		],
		"a2"
	);
	assert.equal(context.hasText, true);
	assert.equal(context.boundaryId, prompt.id);
});

test("a schema failure is an error result, so it is not user input", () => {
	const prompt = user("Plan it");
	const context = findAskContext(
		[
			prompt,
			assistant(text("Context first."), call("a0")),
			result("a0", "ask_user", undefined, true),
			assistant(thinking, call("a1")),
		],
		"a1"
	);
	assert.equal(context.hasText, true);
	assert.equal(context.boundaryId, prompt.id);
});

test("a cancelled form is user input, so the next ask needs new text", () => {
	const cancelled = result("a0", "ask_user", "user");
	const context = findAskContext(
		[
			user("Plan it"),
			assistant(text("Context first."), call("a0")),
			cancelled,
			assistant(thinking, call("a1")),
		],
		"a1"
	);
	assert.equal(context.hasText, false);
	assert.equal(context.boundaryId, cancelled.id);
});

test("two asks in one message share the message text", () => {
	const context = findAskContext(
		[
			user("Plan it"),
			assistant(text("Both decisions explained."), call("a1"), call("a2")),
			result("a1", "ask_user"),
		],
		"a2"
	);
	assert.equal(context.hasText, true);
});

test("a branch without user input has an empty boundary", () => {
	const context = findAskContext([assistant(thinking, call("a1"))], "a1");
	assert.equal(context.boundaryId, "");
});

test("a call that is not on the branch is a contract violation", () => {
	assert.throws(
		() => findAskContext([user("Plan it")], "missing"),
		MISSING_CALL_RE
	);
});
