import assert from "node:assert/strict";
import test from "node:test";
import {
	DeferredAsks,
	registerDeferredAskOpening,
} from "../src/deferred-ask.ts";
import type { AskParams } from "../src/types.ts";

const params: AskParams = {
	questions: [
		{
			id: "goal",
			label: "Goal",
			prompt: "What should I optimize for?",
			options: [
				{ value: "speed", label: "Speed" },
				{ value: "safety", label: "Safety" },
			],
		},
	],
};

const submitted = {
	cancelled: false,
	mode: "submit",
	questions: [
		{
			id: "goal",
			label: "Goal",
			prompt: "What should I optimize for?",
			type: "single",
		},
	],
	answers: { goal: { values: ["speed"], labels: ["Speed"], indices: [1] } },
};

const HAS_UI = "hasUI";
const noop = () => {
	// intentional test callback
};

async function until(condition: () => boolean, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function userEntry(id: string) {
	return {
		type: "message",
		id,
		message: { role: "user", content: [{ type: "text", text: "Plan it" }] },
	};
}

function setup(lastUserId: string) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const sent: string[] = [];
	let opened = 0;
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(name, handler);
		},
		sendUserMessage(text: string) {
			sent.push(text);
		},
		getCommands: () => [],
		events: { emit: noop, on: noop },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const ctx = {
		mode: "tui",
		[HAS_UI]: true,
		cwd: process.cwd(),
		isIdle: () => true,
		sessionManager: { getBranch: () => [userEntry(lastUserId)] },
		ui: {
			setWorkingVisible: noop,
			notify: noop,
			custom() {
				opened++;
				return Promise.resolve(submitted);
			},
		},
	};
	const asks = new DeferredAsks();
	registerDeferredAskOpening(
		pi as never,
		asks,
		undefined,
		new AbortController().signal
	);
	const settle = async (aborted = false) => {
		handlers.get("agent_settled")?.({ type: "agent_settled", aborted }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	return { asks, sent, settle, opened: () => opened };
}

test("a refusal is recorded once per user input, and the waiting form is taken once", () => {
	const asks = new DeferredAsks();
	assert.equal(asks.refused("u1"), false);
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	assert.equal(asks.refused("u1"), true);
	assert.equal(asks.take()?.toolCallId, "a1");
	assert.equal(asks.take(), undefined);
	asks.defer({ boundaryId: "u1", params, toolCallId: "a2" });
	asks.clear();
	assert.equal(asks.take(), undefined);
	assert.equal(asks.refused("u1"), true);
});

test("after the explanation turn settles, the refused form opens and its answer goes back as a user message", async () => {
	const { asks, sent, settle, opened } = setup("u1");
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	await settle();
	await until(() => sent.length > 0);
	assert.equal(opened(), 1);
	assert.deepEqual(sent, ["Goal: Speed"]);
});

test("a user message since the refusal makes the waiting form stale", async () => {
	const { asks, sent, settle, opened } = setup("u2");
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	await settle();
	assert.equal(opened(), 0);
	assert.deepEqual(sent, []);
});

test("an aborted turn drops the waiting form", async () => {
	const { asks, sent, settle, opened } = setup("u1");
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	await settle(true);
	await settle();
	assert.equal(opened(), 0);
	assert.deepEqual(sent, []);
});
