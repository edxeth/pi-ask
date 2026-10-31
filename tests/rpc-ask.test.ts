import assert from "node:assert/strict";
import test from "node:test";
import { registerAskTool } from "../src/ask-tool.ts";
import {
	createRemoteAskRuntime,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
} from "../src/remote-ask.ts";
import type { AskParams } from "../src/types.ts";

const HAS_UI = "hasUI";

interface Dialog {
	kind: "select" | "input";
	options?: string[];
	resolve: (value: string | undefined) => void;
	signal?: AbortSignal;
	title: string;
}
function setup(params: AskParams, signal = new AbortController()) {
	const dialogs: Dialog[] = [];
	const updates: Array<{
		content: Array<{ text: string }>;
		details: { answers: Record<string, { values: string[] }> };
	}> = [];
	const emitted: Array<{ channel: string; data: any }> = [];
	const listeners = new Map<string, (data: any) => void>();
	const bus = {
		emit(channel: string, data: any) {
			emitted.push({ channel, data });
			listeners.get(channel)?.(data);
		},
		on(channel: string, fn: (data: any) => void) {
			listeners.set(channel, fn);
			return () => listeners.delete(channel);
		},
	};
	const remote = createRemoteAskRuntime(bus as never);
	let tool: any;
	registerAskTool(
		{
			registerTool(value: unknown) {
				tool = value;
			},
			appendEntry() {
				// Session writes do not affect the RPC dialog test.
			},
			getCommands() {
				return [];
			},
		} as never,
		remote
	);
	const ui = {
		custom() {
			throw new Error("RPC must not call custom");
		},
		setWorkingVisible() {
			// Visibility does not affect RPC dialogs.
		},
		select(title: string, options: string[], opts?: { signal?: AbortSignal }) {
			return new Promise<string | undefined>((resolve) =>
				dialogs.push({
					kind: "select",
					title,
					options,
					signal: opts?.signal,
					resolve,
				})
			);
		},
		input(
			title: string,
			_placeholder?: string,
			opts?: { signal?: AbortSignal }
		) {
			return new Promise<string | undefined>((resolve) =>
				dialogs.push({ kind: "input", title, signal: opts?.signal, resolve })
			);
		},
	};
	const pending = tool.execute(
		"rpc-call",
		{ context: "The RPC client shows this before the dialogs.", ...params },
		signal.signal,
		(update: (typeof updates)[number]) => updates.push(update),
		{
			mode: "rpc",
			[HAS_UI]: true,
			ui,
		}
	);
	async function next() {
		const deadline = Date.now() + 1500;
		while (dialogs.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const dialog = dialogs.shift();
		assert(dialog, "expected a dialog");
		return dialog;
	}
	return { pending, next, emitted, bus, signal, remote, updates };
}
function dialogOptions(dialog: Dialog): string[] {
	assert(dialog.options, "expected select options");
	return dialog.options;
}
function eventData(
	events: Array<{ channel: string; data: any }>,
	channel: string
): any {
	const event = events.find((item) => item.channel === channel);
	assert(event, `expected ${channel}`);
	return event.data;
}
const one: AskParams = {
	title: "Choose",
	questions: [
		{
			id: "goal",
			label: "Goal",
			prompt: "Which goal?",
			options: [
				{ value: "speed", label: "Speed" },
				{ value: "safety", label: "Safety" },
			],
		},
	],
};

test("RPC single selection and submit emit TUI-shaped lifecycle events", async () => {
	const flow = setup(one);
	const choice = await flow.next();
	assert.equal(choice.title, "Which goal?");
	assert(choice.options?.some((s) => s.includes("Speed")));
	assert(choice.signal);
	choice.resolve(dialogOptions(choice)[0]);
	const review = await flow.next();
	assert.deepEqual(review.options, ["Submit", "Cancel"]);
	review.resolve("Submit");
	const result = await flow.pending;
	assert.deepEqual(result.details.answers.goal.values, ["speed"]);
	const started = eventData(flow.emitted, PI_ASK_STARTED_EVENT);
	const completed = eventData(flow.emitted, PI_ASK_COMPLETED_EVENT);
	assert.equal(started.flowId, "tool:rpc-call");
	assert.equal(started.source, "tool");
	assert.equal(started.questions[0].id, "goal");
	assert.equal(
		started.context,
		"The RPC client shows this before the dialogs."
	);
	assert.equal(completed.flowId, started.flowId);
	assert.deepEqual(completed.result, result.details);
	flow.remote.disposeAll();
});

test("RPC multi toggles options, supports custom input and Done", async () => {
	const flow = setup({ questions: [{ ...one.questions[0], type: "multi" }] });
	const first = await flow.next();
	assert(first.options?.includes("Done"));
	assert(first.options?.some((s) => s.startsWith("[ ]")));
	first.resolve(dialogOptions(first)[0]);
	const second = await flow.next();
	assert(second.options?.some((s) => s.startsWith("[✓]")));
	second.resolve(
		dialogOptions(second).find((s) => s.includes("Type your own"))
	);
	const input = await flow.next();
	assert.equal(input.kind, "input");
	input.resolve("A custom goal");
	const third = await flow.next();
	third.resolve("Done");
	(await flow.next()).resolve("Submit");
	const result = await flow.pending;
	assert.deepEqual(result.details.answers.goal.values, [
		"speed",
		"A custom goal",
	]);
	assert.equal(result.details.answers.goal.customText, "A custom goal");
	flow.remote.disposeAll();
});

test("RPC preview text is visible before choosing, and single custom answer works", async () => {
	const flow = setup({
		questions: [
			{
				...one.questions[0],
				type: "preview",
				options: [
					{ value: "speed", label: "Speed", preview: "fast path" },
					{ value: "safety", label: "Safety", preview: "safer path" },
				],
			},
		],
	});
	const choice = await flow.next();
	assert(choice.options?.some((s) => s.includes("fast path")));
	assert(choice.options?.some((s) => s.includes("safer path")));
	choice.resolve(
		dialogOptions(choice).find((s) => s.includes("Type your own"))
	);
	(await flow.next()).resolve("A third option");
	(await flow.next()).resolve("Submit");
	const result = await flow.pending;
	assert.equal(result.details.answers.goal.customText, "A third option");
	flow.remote.disposeAll();
});

test("RPC dismissed dialog cancels as user, and abort cancels as aborted", async () => {
	const dismissed = setup(one);
	(await dismissed.next()).resolve(undefined);
	const cancelled = await dismissed.pending;
	assert.equal(cancelled.details.cancelReason, "user");
	assert.equal(
		eventData(dismissed.emitted, PI_ASK_COMPLETED_EVENT).result.cancelReason,
		"user"
	);
	dismissed.remote.disposeAll();
	const aborted = setup(one);
	const open = await aborted.next();
	aborted.signal.abort();
	const result = await aborted.pending;
	assert.equal(open.signal?.aborted, true);
	assert.equal(result.details.cancelReason, "aborted");
	assert.equal(
		eventData(aborted.emitted, PI_ASK_COMPLETED_EVENT).result.cancelReason,
		"aborted"
	);
	aborted.remote.disposeAll();
});

test("RPC Cancel at review cancels without answers", async () => {
	const flow = setup(one);
	const choice = await flow.next();
	choice.resolve(dialogOptions(choice)[0]);
	(await flow.next()).resolve("Cancel");
	const result = await flow.pending;
	assert.equal(result.details.cancelReason, "user");
	assert.deepEqual(result.details.answers, {});
	flow.remote.disposeAll();
});

test("RPC goes through each question and abort during input closes the dialog", async () => {
	const params: AskParams = {
		questions: [
			one.questions[0],
			{ ...one.questions[0], id: "next", prompt: "Next?" },
		],
	};
	const flow = setup(params);
	const first = await flow.next();
	first.resolve(dialogOptions(first)[0]);
	const second = await flow.next();
	assert.equal(second.title, "Next?");
	second.resolve("Type your own");
	const input = await flow.next();
	flow.signal.abort();
	const result = await flow.pending;
	assert.equal(input.signal?.aborted, true);
	assert.deepEqual(result.details.answers, {});
	assert.equal(result.details.cancelReason, "aborted");
	flow.remote.disposeAll();
});

test("bridge submit wins during an open RPC dialog and dismisses it", async () => {
	const flow = setup(one);
	const open = await flow.next();
	flow.bus.emit(PI_ASK_SUBMIT_EVENT, {
		version: 1,
		requestId: "bridge-1",
		flowId: "tool:rpc-call",
		response: { kind: "answer", answers: { goal: { values: ["safety"] } } },
	});
	const result = await flow.pending;
	assert.equal(open.signal?.aborted, true);
	assert.deepEqual(result.details.answers.goal.values, ["safety"]);
	open.resolve(dialogOptions(open)[0]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(flow.updates, []);
	assert.equal(
		flow.emitted.filter((e) => e.channel === PI_ASK_COMPLETED_EVENT).length,
		1
	);
	flow.remote.disposeAll();
});

test("disposing the remote runtime aborts an open RPC dialog", async () => {
	const flow = setup(one);
	const open = await flow.next();
	flow.remote.disposeAll();
	const result = await flow.pending;
	assert.equal(open.signal?.aborted, true);
	assert.equal(result.details.cancelReason, "aborted");
	assert.equal(
		eventData(flow.emitted, PI_ASK_COMPLETED_EVENT).result.cancelReason,
		"aborted"
	);
});

test("RPC reports partial answers after each change and stops on submit", async () => {
	const flow = setup({
		questions: [
			{ ...one.questions[0], type: "multi" },
			{ ...one.questions[0], id: "next", label: "Next", prompt: "Next?" },
		],
	});
	const first = await flow.next();
	first.resolve(dialogOptions(first)[0]);
	const second = await flow.next();
	assert.deepEqual(
		flow.updates.map((update) => update.content[0].text),
		["Goal: Speed\nNext: (no answer)"]
	);
	second.resolve(dialogOptions(second)[0]); // Remove Speed.
	const third = await flow.next();
	third.resolve(dialogOptions(third)[1]); // Add Safety.
	const fourth = await flow.next();
	fourth.resolve("Done");
	const next = await flow.next();
	next.resolve(dialogOptions(next)[0]);
	const review = await flow.next();
	assert.deepEqual(
		flow.updates.map((update) => update.content[0].text),
		[
			"Goal: Speed\nNext: (no answer)",
			"Goal: (no answer)\nNext: (no answer)",
			"Goal: Safety\nNext: (no answer)",
			"Goal: Safety\nNext: Speed",
		]
	);
	assert.deepEqual(
		flow.updates.map((update) => update.details.answers.goal?.values),
		[["speed"], undefined, ["safety"], ["safety"]]
	);
	review.resolve("Submit");
	const result = await flow.pending;
	assert.equal(result.content[0].text, "Goal: Safety\nNext: Speed");
	assert.equal(flow.updates.length, 4);
	flow.remote.disposeAll();
});
