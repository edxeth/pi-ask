import assert from "node:assert/strict";
import test from "node:test";
import { findLatestPayloadInCurrentBranch } from "../src/ask-payload-store.ts";
import {
	DeferredAsks,
	registerDeferredAskOpening,
} from "../src/deferred-ask.ts";
import type { AskParams } from "../src/types.ts";

const HAS_UI = "hasUI";
const noop = () => {
	// intentional test callback
};

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

/** The explanation turn: its stop reason tells whether the run ended with the model's reply. */
function replyEntry(stopReason: string) {
	return {
		type: "message",
		id: "reply",
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text: "Here is what I found." }],
		},
	};
}

function setup(lastUserId: string, replyStop = "stop") {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const branch: Record<string, unknown>[] = [
		userEntry(lastUserId),
		replyEntry(replyStop),
	];
	const steps: string[] = [];
	const sent: string[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(name, handler);
		},
		sendUserMessage(text: string) {
			sent.push(text);
		},
		appendEntry(customType: string, data: unknown) {
			steps.push(`append ${customType}`);
			branch.push({
				type: "custom",
				id: `entry-${branch.length}`,
				customType,
				data,
			});
		},
		setLabel: noop,
		getCommands: () => [],
		events: { emit: noop, on: noop },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const ctx = {
		mode: "tui",
		[HAS_UI]: true,
		cwd: process.cwd(),
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			setWorkingVisible: noop,
			notify: noop,
			custom() {
				steps.push("open form");
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
	// pi 1.0.2 emits only the type; pi 1.4 and later add aborted.
	const settle = async (
		event: Record<string, unknown> = { type: "agent_settled" }
	) => {
		handlers.get("agent_settled")?.(event, ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	return { asks, ctx, sent, settle, steps };
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

test("after the explanation turn, the refused form is saved for replay, opens, and its answer goes back as a user message", async () => {
	const { asks, ctx, sent, settle, steps } = setup("u1");
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	await settle();
	await until(() => sent.length > 0);
	assert.deepEqual(steps, ["append ask:payload", "open form"]);
	assert.deepEqual(sent, ["Goal: Speed"]);
	const replay = findLatestPayloadInCurrentBranch(ctx as never, "tool");
	assert.equal(replay.data?.sourceEntryId, "a1");
	assert.deepEqual(replay.data?.params, params);
});

test("a user message since the refusal makes the waiting form stale", async () => {
	const { asks, sent, settle, steps } = setup("u2");
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	await settle();
	assert.deepEqual(steps, []);
	assert.deepEqual(sent, []);
});

test("an aborted or failed explanation turn drops the waiting form, with the event pi 1.0.2 emits", async () => {
	for (const stopReason of ["aborted", "error", "toolUse"]) {
		const { asks, sent, settle, steps } = setup("u1", stopReason);
		asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
		await settle();
		await settle();
		assert.deepEqual(steps, [], stopReason);
		assert.deepEqual(sent, [], stopReason);
	}
});

test("the abort flag of pi 1.4 also drops the waiting form", async () => {
	const { asks, sent, settle, steps } = setup("u1");
	asks.defer({ boundaryId: "u1", params, toolCallId: "a1" });
	await settle({ type: "agent_settled", aborted: true });
	assert.deepEqual(steps, []);
	assert.deepEqual(sent, []);
});
