import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import {
	applyRemoteAskResponse,
	createRemoteAskRuntime,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	PI_ASK_SUBMIT_RESULT_EVENT,
	type RemoteAskCompletedEvent,
	type RemoteAskStartedEvent,
	type RemoteAskSubmitResultEvent,
} from "../src/remote-ask.ts";
import { createInitialState } from "../src/state/create.ts";
import type { AskParams } from "../src/types.ts";
import { runAskFlow } from "../src/ui/controller.ts";

type AskFlowRemote = Parameters<typeof runAskFlow>[2]["remote"];

test("remote bridge uses fork-scoped channels", () => {
	assert.equal(PI_ASK_STARTED_EVENT, "pi-ask:started");
	assert.equal(PI_ASK_COMPLETED_EVENT, "pi-ask:completed");
	assert.equal(PI_ASK_SUBMIT_EVENT, "pi-ask:submit");
	assert.equal(PI_ASK_SUBMIT_RESULT_EVENT, "pi-ask:submit-result");
});

const UNKNOWN_APPROVE_VALUE_RE = /Unknown option value "approve"/;

class TestEventBus {
	readonly events: Array<{ channel: string; data: unknown }> = [];
	private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		this.events.push({ channel, data });
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(data);
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
		return () => {
			this.handlers.set(
				channel,
				(this.handlers.get(channel) ?? []).filter(
					(candidate) => candidate !== handler
				)
			);
		};
	}
}

test("remote answer response validates and serializes explicit option values", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
			},
		],
	});

	const result = applyRemoteAskResponse(state, {
		kind: "answer",
		answers: {
			decision: { values: ["yes"], note: "ship it" },
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.state.completed, true);
	assert.deepEqual(result.state.answers.decision, {
		selected: [{ value: "yes", label: "Yes", index: 1 }],
		note: "ship it",
		customSelected: undefined,
		customText: undefined,
		optionNotes: undefined,
	});
});

test("remote answer response replaces stale UI answers", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes" }],
			},
			{
				id: "stale",
				prompt: "Old answer?",
				options: [{ value: "old", label: "Old" }],
			},
		],
	});
	state.answers.stale = {
		selected: [{ value: "old", label: "Old", index: 1 }],
	};

	const result = applyRemoteAskResponse(state, {
		kind: "answer",
		answers: { decision: { values: ["yes"] } },
	});

	assert.equal(result.ok, true);
	assert.deepEqual(Object.keys(result.state.answers), ["decision"]);
});

test("remote answer response rejects guessed or unknown option values", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes" }],
			},
		],
	});

	const result = applyRemoteAskResponse(state, {
		kind: "answer",
		answers: { decision: { values: ["approve"] } },
	});

	assert.equal(result.ok, false);
	assert.equal(result.error, "invalid_answer");
	assert.match(result.message, UNKNOWN_APPROVE_VALUE_RE);
	assert.equal(result.state.completed, false);
});

test("remote cancel completes the flow as cancelled", () => {
	const state = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes" }],
			},
		],
	});

	const result = applyRemoteAskResponse(state, { kind: "cancel" });

	assert.equal(result.ok, true);
	assert.equal(result.state.completed, true);
	assert.equal(result.state.cancelled, true);
});

test("started event questions are cloned", async () => {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	const questions = createInitialState({
		questions: [
			{
				id: "decision",
				prompt: "Proceed?",
				options: [{ value: "yes", label: "Yes", recommended: true }],
			},
		],
	}).questions;

	remoteAsk.startFlow({
		source: "tool",
		questions,
		onSubmit: () => ({ ok: true }),
	});
	await new Promise((resolve) => setImmediate(resolve));

	const started = bus.events.find(
		(event) => event.channel === PI_ASK_STARTED_EVENT
	)?.data as RemoteAskStartedEvent;
	assert.equal(started.questions[0].options[0].recommended, true);
	started.questions[0].options[0].label = "Mutated";
	started.questions[0].options[0].recommended = false;

	assert.equal(questions[0].options[0].label, "Yes");
	assert.equal(questions[0].options[0].recommended, true);
});

test("remote runtime disposes active flows and submit listener", () => {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let submitCalls = 0;
	const flow = remoteAsk.startFlow({
		source: "tool",
		questions: createInitialState({
			questions: [
				{
					id: "decision",
					prompt: "Proceed?",
					options: [{ value: "yes", label: "Yes" }],
				},
			],
		}).questions,
		onSubmit: () => {
			submitCalls += 1;
			return { ok: true };
		},
	});
	remoteAsk.disposeAll();

	bus.emit(PI_ASK_SUBMIT_EVENT, {
		version: 1,
		requestId: "request-1",
		flowId: flow.flowId,
		response: {
			kind: "answer",
			answers: { decision: { values: ["yes"] } },
		},
	});

	assert.equal(submitCalls, 0);
	assert.equal(
		bus.events.some((event) => event.channel === PI_ASK_SUBMIT_RESULT_EVENT),
		false
	);
});

test("disposing remote flows closes an open command flow", {
	timeout: 2000,
}, async () => {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let opened: () => void = () => {
		/* wait for the custom UI */
	};
	const opening = new Promise<void>((resolve) => {
		opened = resolve;
	});
	const resultPromise = runAskFlow(
		{
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				custom(callback: (...args: unknown[]) => unknown) {
					return new Promise((resolve) => {
						callback(
							{
								requestRender() {
									/* no render needed */
								},
							},
							plainTheme(),
							{},
							resolve
						);
						opened();
					});
				},
			},
		} as never,
		{
			questions: [
				{
					id: "decision",
					prompt: "Proceed?",
					options: [{ value: "yes", label: "Yes" }],
				},
			],
		},
		{
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			remote: { runtime: remoteAsk, source: "answer" },
		}
	);
	await opening;
	remoteAsk.disposeAll();
	const result = await resultPromise;
	assert.equal(result.cancelReason, "aborted");
	assert.equal(
		bus.events.filter((event) => event.channel === PI_ASK_COMPLETED_EVENT)
			.length,
		1
	);
});

test("remote submit resolves an active ask flow and emits lifecycle events", async () => {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let component: { handleInput(data: string): void } | undefined;

	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const event = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "request-1",
			flowId: event.flowId,
			response: {
				kind: "answer",
				answers: { decision: { values: ["yes"] } },
			},
		});
	});

	const result = await runAskFlow(
		{
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				custom(callback: (...args: unknown[]) => unknown) {
					return new Promise((resolve) => {
						component = callback(
							{
								requestRender() {
									// Rendering is not needed for this controller input test.
								},
							},
							plainTheme(),
							{},
							resolve
						) as typeof component;
					});
				},
			},
		} as never,
		{
			questions: [
				{
					id: "decision",
					prompt: "Proceed?",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
			],
		},
		{
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			remote: { runtime: remoteAsk, source: "tool", toolCallId: "call-1" },
		}
	);

	assert(component);
	assert.deepEqual(result.answers.decision, {
		values: ["yes"],
		labels: ["Yes"],
		indices: [1],
		customText: undefined,
		note: undefined,
		optionNotes: undefined,
	});

	const started = bus.events.find(
		(event) => event.channel === PI_ASK_STARTED_EVENT
	)?.data as RemoteAskStartedEvent;
	assert.equal(started.flowId, "tool:call-1");
	assert.equal(started.source, "tool");
	assert.equal(started.questions[0]?.id, "decision");

	const submitResult = bus.events.find(
		(event) => event.channel === PI_ASK_SUBMIT_RESULT_EVENT
	)?.data as RemoteAskSubmitResultEvent;
	assert.equal(submitResult.ok, true);

	const completed = bus.events.find(
		(event) => event.channel === PI_ASK_COMPLETED_EVENT
	)?.data as RemoteAskCompletedEvent;
	assert.equal(completed.flowId, "tool:call-1");
	assert.equal(completed.result.cancelled, false);

	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

async function startedEventFor(
	params: AskParams,
	remote: Omit<NonNullable<AskFlowRemote>, "runtime">
): Promise<RemoteAskStartedEvent> {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "request-1",
			flowId: (data as RemoteAskStartedEvent).flowId,
			response: { kind: "cancel" },
		});
	});
	await runAskFlow(
		{
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				custom(callback: (...args: unknown[]) => unknown) {
					return new Promise((resolve) => {
						callback(
							{
								requestRender() {
									// Rendering is not needed for this lifecycle test.
								},
							},
							plainTheme(),
							{},
							resolve
						);
					});
				},
			},
		} as never,
		params,
		{
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			remote: { runtime: remoteAsk, ...remote },
		}
	);
	const started = bus.events.find(
		(event) => event.channel === PI_ASK_STARTED_EVENT
	)?.data as RemoteAskStartedEvent | undefined;
	assert(started, "expected a started event");
	return started;
}

const decisionQuestions: AskParams["questions"] = [
	{
		id: "decision",
		prompt: "Proceed?",
		options: [{ value: "yes", label: "Yes" }],
	},
];

test("started event carries the tool call context for remote clients", async () => {
	const started = await startedEventFor(
		{
			context: "  Yes keeps the current plan.  ",
			questions: decisionQuestions,
		},
		{ source: "tool", toolCallId: "call-1" }
	);

	assert.equal(started.context, "Yes keeps the current plan.");
});

test("started event omits context when the ask has none", async () => {
	const replayed = await startedEventFor(
		{ questions: decisionQuestions },
		{ source: "ask:replay" }
	);
	const blank = await startedEventFor(
		{ context: "   ", questions: decisionQuestions },
		{ source: "tool", toolCallId: "call-2" }
	);

	assert.equal("context" in replayed, false);
	assert.equal("context" in blank, false);
});

function plainTheme() {
	return {
		bg(_color: string, text: string) {
			return text;
		},
		fg(_color: string, text: string) {
			return text;
		},
	};
}
