import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findLatestPayloadInCurrentBranch } from "../src/ask-payload-store.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import askExtension from "../src/index.ts";
import {
	ASK_PENDING_DISMISSED_ENTRY_TYPE,
	findPendingAskToolCall,
} from "../src/pending-ask.ts";
import {
	createRemoteAskRuntime,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	type RemoteAskCompletedEvent,
	type RemoteAskStartedEvent,
} from "../src/remote-ask.ts";
import { registerPendingAskResume } from "../src/resume-pending-ask.ts";
import type { AskParams } from "../src/types.ts";

const CANVAS_RE = /Canvas/;
const SKILL_BLOCK_RE =
	/<skill name="tdd" location="[^"]+">\nReferences are relative to [^\n]+\n\n# Test first\nStart with a failing test\.\n<\/skill>/;

const params: AskParams = {
	title: "Choose engine",
	questions: [
		{
			id: "engine",
			prompt: "Chart engine?",
			options: [
				{ value: "canvas", label: "Canvas" },
				{ value: "svg", label: "SVG" },
			],
		},
	],
};

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

function askToolCall(id: string, argumentsValue: unknown = params) {
	return assistantMessage([
		{ type: "toolCall", id, name: "ask_user", arguments: argumentsValue },
	]);
}

function assistantMessage(content: unknown[], stopReason = "toolUse") {
	return {
		type: "message",
		message: { role: "assistant", content, stopReason },
	};
}

function toolResult(toolCallId: string) {
	return {
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "ask_user" },
	};
}

function storedPayload(
	sourceEntryId: string,
	storedParams: unknown = params,
	version = 1
) {
	return {
		id: `payload-${sourceEntryId}`,
		type: "custom",
		customType: "ask:payload",
		data: {
			version,
			source: "tool",
			params: storedParams,
			sourceEntryId,
			timestamp: 1,
		},
	};
}

function dismissed(toolCallId: string) {
	return {
		type: "custom",
		customType: ASK_PENDING_DISMISSED_ENTRY_TYPE,
		data: { toolCallId },
	};
}

function scannerContext(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}

test("pending ask scan selects the newest unresolved ask_user call", () => {
	const pending = findPendingAskToolCall(
		scannerContext([
			askToolCall("call-1"),
			storedPayload("call-1"),
			askToolCall("call-2"),
			storedPayload("call-2"),
			toolResult("call-2"),
		])
	);

	assert.deepEqual(pending, { params, toolCallId: "call-1" });
});

test("pending ask scan uses the latest unresolved call within one assistant message", () => {
	const pending = findPendingAskToolCall(
		scannerContext([
			assistantMessage([
				{ type: "toolCall", id: "call-1", name: "ask_user", arguments: params },
				{ type: "toolCall", id: "other", name: "read", arguments: {} },
				{ type: "toolCall", id: "call-2", name: "ask_user", arguments: params },
			]),
		])
	);

	assert.equal(pending?.toolCallId, "call-2");
});

test("pending ask scan ignores tool-shaped content from failed assistant responses", () => {
	assert.equal(
		findPendingAskToolCall(
			scannerContext([
				assistantMessage(
					[
						{
							type: "toolCall",
							id: "failed-call",
							name: "ask_user",
							arguments: params,
						},
					],
					"error"
				),
			])
		),
		undefined
	);
});

test("pending ask scan prefers its valid persisted payload", () => {
	const persistedParams = { ...params, title: "Persisted title" };
	const pending = findPendingAskToolCall(
		scannerContext([
			askToolCall("call-1", { ...params, title: "Recorded title" }),
			storedPayload("call-1", persistedParams),
		])
	);

	assert.equal(pending?.params, persistedParams);
});

test("pending ask fallback fills missing option values", () => {
	const valueless = {
		questions: [
			{
				id: "engine",
				prompt: "Chart engine?",
				options: [{ label: "Canvas" }, { label: "SVG" }],
			},
		],
	};
	const branch = scannerContext([askToolCall("call-1", valueless)]);

	assert.deepEqual(
		findPendingAskToolCall(branch)?.params.questions[0].options.map(
			(option) => option.value
		),
		["canvas", "svg"]
	);
});

test("pending ask scan validates recorded arguments as payload fallback", () => {
	assert.deepEqual(
		findPendingAskToolCall(scannerContext([askToolCall("call-1")])),
		{ params, toolCallId: "call-1" }
	);
	assert.deepEqual(
		findPendingAskToolCall(
			scannerContext([
				askToolCall("call-2"),
				storedPayload("call-2", params, 99),
			])
		),
		{ params, toolCallId: "call-2" }
	);
	assert.deepEqual(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-3"), storedPayload("call-3", {})])
		),
		{ params, toolCallId: "call-3" }
	);
	assert.equal(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-4", { questions: [] })])
		),
		undefined
	);
	assert.equal(
		findPendingAskToolCall(scannerContext([askToolCall("call-5", {})])),
		undefined
	);
});

test("pending ask scan skips a newer invalid call for an older valid call", () => {
	const pending = findPendingAskToolCall(
		scannerContext([
			askToolCall("valid-call"),
			askToolCall("invalid-call", { questions: [] }),
		])
	);

	assert.deepEqual(pending, { params, toolCallId: "valid-call" });
});

test("pending ask scan ignores tool results and persisted dismissals", () => {
	assert.equal(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-1"), toolResult("call-1")])
		),
		undefined
	);
	assert.equal(
		findPendingAskToolCall(
			scannerContext([askToolCall("call-2"), dismissed("call-2")])
		),
		undefined
	);
});

test("pending dismissal does not hide the payload from manual replay", () => {
	const lookup = findLatestPayloadInCurrentBranch(
		scannerContext([
			askToolCall("call-1"),
			storedPayload("call-1"),
			dismissed("call-1"),
		]),
		"tool"
	);

	assert.equal(lookup.data?.params, params);
});

test("pending ask recovery scans startup, resume, fork, and tree only in TUI", () => {
	let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;
	let sessionTreeHandler: ((event: any, ctx: any) => void) | undefined;
	const remoteAsk = createRemoteAskRuntime(new TestEventBus() as never);
	registerPendingAskResume(
		{
			getCommands() {
				return [];
			},
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "session_start") {
					sessionStartHandler = handler;
				} else if (event === "session_tree") {
					sessionTreeHandler = handler;
				}
			},
		} as never,
		remoteAsk,
		new Set()
	);
	assert(sessionStartHandler);
	assert(sessionTreeHandler);

	const branchReads: string[] = [];
	for (const reason of ["startup", "resume", "fork", "new", "reload"]) {
		sessionStartHandler(
			{ type: "session_start", reason },
			{
				mode: "tui",
				sessionManager: {
					getBranch() {
						branchReads.push(reason);
						return [];
					},
				},
			}
		);
	}

	sessionStartHandler(
		{ type: "session_start", reason: "startup" },
		{
			mode: "rpc",
			sessionManager: {
				getBranch() {
					branchReads.push("rpc");
					return [];
				},
			},
		}
	);

	for (const mode of ["tui", "rpc"]) {
		sessionTreeHandler(
			{ type: "session_tree" },
			{
				mode,
				sessionManager: {
					getBranch() {
						branchReads.push(`tree:${mode}`);
						return [];
					},
				},
			}
		);
	}

	assert.deepEqual(branchReads, ["startup", "resume", "fork", "tree:tui"]);
	remoteAsk.disposeAll();
});

test("tree navigation reopens a pending ask only on the new branch and only once while open", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	const harness = createResumeHarness([], remoteAsk);
	const pendingBranch = [askToolCall("tree-call"), storedPayload("tree-call")];

	harness.tree([]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		bus.events.filter((event) => event.channel === PI_ASK_STARTED_EVENT).length,
		0
	);

	harness.tree(pendingBranch);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const started = findEvent<RemoteAskStartedEvent>(bus, PI_ASK_STARTED_EVENT);
	assert.equal(started.toolCallId, "tree-call");
	harness.tree(pendingBranch);
	harness.start("resume");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		bus.events.filter((event) => event.channel === PI_ASK_STARTED_EVENT).length,
		1
	);

	bus.emit(PI_ASK_SUBMIT_EVENT, {
		version: 1,
		requestId: "tree-cancel",
		flowId: started.flowId,
		response: { kind: "cancel" },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.dismissedToolCallIds, ["tree-call"]);
	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("recovered ask sets and clears the waiting footer, leaving the title, on cancel", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	const status: [string, string | undefined][] = [];
	const titles: string[] = [];
	let dismissed!: () => void;
	const dismissal = new Promise<void>((resolve) => {
		dismissed = resolve;
	});
	const harness = createResumeHarness(
		[askToolCall("waiting-call"), storedPayload("waiting-call")],
		remoteAsk,
		{
			onStatus: (key, text) => status.push([key, text]),
			onTitle: (title) => titles.push(title),
			onDismissNotice: dismissed,
		}
	);
	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "waiting-cancel",
			flowId: (data as RemoteAskStartedEvent).flowId,
			response: { kind: "cancel" },
		});
	});
	harness.start("resume");
	await dismissal;
	assert.deepEqual(status, [
		["pi-ask", "question 1 of 1"],
		["pi-ask", undefined],
	]);
	assert.deepEqual(titles, []);
	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("resumed submit persists dismissal, delivers an answer, and emits remote lifecycle events", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const branch: unknown[] = [askToolCall("call-1"), storedPayload("call-1")];
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let skillRequests = 0;
	bus.on("pi-better-skills:request", () => {
		skillRequests++;
	});
	const delivered: Array<{ text: string; options: unknown }> = [];
	let resolveDelivery: (() => void) | undefined;
	const delivery = new Promise<void>((resolve) => {
		resolveDelivery = resolve;
	});
	const harness = createResumeHarness(branch, remoteAsk, {
		idle: false,
		events: bus,
		commands: [
			{
				name: "skill:tdd",
				source: "skill",
				sourceInfo: {
					path: fileURLToPath(
						new URL("./fixtures/skill/SKILL.md", import.meta.url)
					),
					source: "test",
					scope: "user",
					origin: "top-level",
				},
			},
		],
		onSend(text, options) {
			delivered.push({ text, options });
			resolveDelivery?.();
		},
	});

	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const started = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "submit-1",
			flowId: started.flowId,
			response: {
				kind: "answer",
				answers: { engine: { values: ["canvas"], note: "use /skill:tdd" } },
			},
		});
	});

	const handlerResult = harness.start("resume");
	assert.equal(handlerResult, undefined);
	await delivery;

	assert.deepEqual(harness.dismissedToolCallIds, ["call-1"]);
	assert.deepEqual(harness.labels, [
		["payload-call-1", "ask: Choose engine (answered)"],
	]);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0].text, CANVAS_RE);
	assert.match(delivered[0].text, SKILL_BLOCK_RE);
	assert.equal(skillRequests, 0);
	assert.deepEqual(delivered[0].options, { deliverAs: "followUp" });

	const started = findEvent<RemoteAskStartedEvent>(bus, PI_ASK_STARTED_EVENT);
	assert.equal(started.source, "ask:resume");
	assert.equal(started.toolCallId, "call-1");
	// This stored payload predates the context argument.
	assert.equal("context" in started, false);
	const completed = findEvent<RemoteAskCompletedEvent>(
		bus,
		PI_ASK_COMPLETED_EVENT
	);
	assert.equal(completed.source, "ask:resume");
	assert.equal(completed.result.cancelled, false);

	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("idle resumed submit uses the provider without inlining a duplicate", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const branch: unknown[] = [askToolCall("call-1"), storedPayload("call-1")];
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	const skillRequests: string[][] = [];
	bus.on("pi-better-skills:request", (request: unknown) => {
		const r = request as {
			operation: string;
			names?: string[];
			reply: (value: unknown) => void;
		};
		if (r.operation === "probe") {
			r.reply({
				version: 1,
				operation: "probe",
				available: true,
				versions: [1],
			});
		}
		if (r.operation === "deliver") {
			skillRequests.push(r.names ?? []);
			r.reply({
				version: 1,
				operation: "deliver",
				outcomes: [{ name: "tdd", status: "already-resident" }],
			});
		}
	});
	const delivered: Array<{ text: string; options: unknown }> = [];
	let resolveDelivery: (() => void) | undefined;
	const delivery = new Promise<void>((resolve) => {
		resolveDelivery = resolve;
	});
	const harness = createResumeHarness(branch, remoteAsk, {
		idle: true,
		events: bus,
		commands: [
			{
				name: "skill:tdd",
				source: "skill",
				sourceInfo: {
					path: fileURLToPath(
						new URL("./fixtures/skill/SKILL.md", import.meta.url)
					),
					source: "test",
					scope: "user",
					origin: "top-level",
				},
			},
		],
		onSend(text, options) {
			delivered.push({ text, options });
			resolveDelivery?.();
		},
	});

	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const started = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "submit-1",
			flowId: started.flowId,
			response: {
				kind: "answer",
				answers: { engine: { values: ["canvas"], note: "use /skill:tdd" } },
			},
		});
	});

	const handlerResult = harness.start("resume");
	assert.equal(handlerResult, undefined);
	await delivery;

	assert.deepEqual(harness.dismissedToolCallIds, ["call-1"]);
	assert.deepEqual(harness.labels, [
		["payload-call-1", "ask: Choose engine (answered)"],
	]);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0].text, CANVAS_RE);
	assert.doesNotMatch(delivered[0].text, SKILL_BLOCK_RE);
	assert.deepEqual(skillRequests, [["tdd"]]);
	assert.equal(delivered[0].options, undefined);

	const started = findEvent<RemoteAskStartedEvent>(bus, PI_ASK_STARTED_EVENT);
	assert.equal(started.source, "ask:resume");
	assert.equal(started.toolCallId, "call-1");
	const completed = findEvent<RemoteAskCompletedEvent>(
		bus,
		PI_ASK_COMPLETED_EVENT
	);
	assert.equal(completed.source, "ask:resume");
	assert.equal(completed.result.cancelled, false);

	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("resumed cancel persists dismissal and does not reopen on a second resume", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const branch: unknown[] = [askToolCall("call-1"), storedPayload("call-1")];
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	let resolveCancellation: (() => void) | undefined;
	const cancellation = new Promise<void>((resolve) => {
		resolveCancellation = resolve;
	});
	const harness = createResumeHarness(branch, remoteAsk, {
		onDismissNotice: () => resolveCancellation?.(),
	});

	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const started = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "cancel-1",
			flowId: started.flowId,
			response: { kind: "cancel" },
		});
	});

	harness.start("startup");
	await cancellation;
	await new Promise<void>((resolve) => setImmediate(resolve));
	harness.start("resume");
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(harness.dismissedToolCallIds, ["call-1"]);
	assert.deepEqual(harness.labels, [
		["payload-call-1", "ask: Choose engine (dismissed)"],
	]);
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(
		bus.events.filter((event) => event.channel === PI_ASK_STARTED_EVENT).length,
		1
	);
	const completed = findEvent<RemoteAskCompletedEvent>(
		bus,
		PI_ASK_COMPLETED_EVENT
	);
	assert.equal(completed.source, "ask:resume");
	assert.equal(completed.result.cancelled, true);
	assert.equal(completed.result.cancelReason, "user");

	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("session shutdown closes recovery without dismissal; startup still finds the pending ask", {
	timeout: 2000,
}, async () => {
	const branch: unknown[] = [
		askToolCall("call-shutdown"),
		storedPayload("call-shutdown"),
	];
	const bus = new TestEventBus();
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	let opened = 0;
	let completed = 0;
	let dismissedCount = 0;
	let sentCount = 0;
	let closeFlow: (() => void) | undefined;
	bus.on(PI_ASK_COMPLETED_EVENT, () => {
		completed += 1;
	});
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify() {
				// Notifications do not affect lifecycle.
			},
			setWorkingVisible() {
				// Visibility does not affect lifecycle.
			},
			custom(
				callback: (...args: any[]) => { handleInput(data: string): void }
			) {
				opened += 1;
				return new Promise((resolve) => {
					const component = callback(
						{
							requestRender() {
								// Rendering does not affect lifecycle.
							},
						},
						plainTheme(),
						{},
						resolve
					);
					closeFlow = () => component.handleInput("\x1b");
				});
			},
		},
	};
	function loadExtension() {
		const pi = {
			events: bus,
			on(name: string, handler: (event: any, ctx: any) => void) {
				handlers.set(name, handler);
			},
			registerTool() {
				// Registration is not under test.
			},
			registerShortcut() {
				// Main-editor shortcuts are outside this test seam.
			},
			registerCommand() {
				// Registration is not under test.
			},
			registerEntryRenderer() {
				// Registration is not under test.
			},
			getCommands() {
				return [];
			},
			appendEntry(customType: string, data: unknown) {
				dismissedCount += 1;
				branch.push({ type: "custom", customType, data });
			},
			sendUserMessage() {
				sentCount += 1;
			},
		};
		askExtension(pi as never);
		getAskConfigStore().setConfig(disabledNotificationConfig());
	}
	loadExtension();
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opened, 1);
	handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(completed, 1);
	assert.equal(dismissedCount, 0);
	assert.equal(sentCount, 0);
	assert.equal(
		findPendingAskToolCall(scannerContext(branch))?.toolCallId,
		"call-shutdown"
	);
	loadExtension();
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opened, 2);
	closeFlow?.();
	await new Promise((resolve) => setImmediate(resolve));
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

// A request sent while the recovered form is open already carries pi-ai's placeholder for
// the call. Pi stores that request's reply only when it ends, so the dismissal can land
// before the reply. Later requests must keep the placeholder that was already sent.
test("a dismissal after a request sent while the recovered form was open keeps the placeholder", {
	timeout: 2000,
}, async () => {
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const branch: unknown[] = [
		askToolCall("call-race"),
		storedPayload("call-race"),
	];
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	let closeFlow: (() => void) | undefined;
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		isIdle: () => false,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify() {
				// Notifications do not affect the request.
			},
			setWorkingVisible() {
				// Visibility does not affect the request.
			},
			custom(
				callback: (...args: any[]) => { handleInput(data: string): void }
			) {
				return new Promise((resolve) => {
					const component = callback(
						{
							requestRender() {
								// Rendering does not affect the request.
							},
						},
						plainTheme(),
						{},
						resolve
					);
					closeFlow = () => component.handleInput("\x1b");
				});
			},
		},
	};
	askExtension({
		events: new TestEventBus(),
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		registerTool() {
			// Registration is not under test.
		},
		registerShortcut() {
			// Main-editor shortcuts are outside this test seam.
		},
		registerCommand() {
			// Registration is not under test.
		},
		registerEntryRenderer() {
			// Registration is not under test.
		},
		getCommands() {
			return [];
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		setLabel() {
			// Labels are not under test.
		},
		sendUserMessage() {
			// The cancelled form sends no answer.
		},
	} as never);
	getAskConfigStore().setConfig(disabledNotificationConfig());
	const request = async () => {
		const messages = branch.flatMap((entry) => {
			const candidate = entry as { type: string; message?: unknown };
			return candidate.type === "message" ? [candidate.message] : [];
		});
		const result = (await handlers.get("context_with_system")?.(
			{ type: "context_with_system", messages },
			ctx
		)) as { messages?: unknown[] } | undefined;
		return result?.messages ?? messages;
	};

	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(closeFlow, "the recovered form is open");
	branch.push({
		type: "message",
		message: { role: "user", content: "Meanwhile, continue" },
	});
	const sent = await request();
	closeFlow?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(branch.at(-1), {
		type: "custom",
		customType: ASK_PENDING_DISMISSED_ENTRY_TYPE,
		data: { toolCallId: "call-race", placeholderSent: true },
	});
	branch.push(assistantMessage([{ type: "text", text: "Reply" }], "stop"), {
		type: "message",
		message: { role: "user", content: "Next" },
	});

	const next = await request();
	assert.deepEqual(next.slice(0, sent.length), sent);
	assert.equal(
		next.some((message) => (message as { role: string }).role === "toolResult"),
		false
	);
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

function createResumeHarness(
	branch: unknown[],
	remoteAsk: ReturnType<typeof createRemoteAskRuntime>,
	options: {
		idle?: boolean;
		onDismissNotice?: () => void;
		onStatus?: (key: string, text: string | undefined) => void;
		onTitle?: (title: string) => void;
		onSend?: (text: string, sendOptions: unknown) => void;
		commands?: ReturnType<
			import("@earendil-works/pi-coding-agent").ExtensionAPI["getCommands"]
		>;
		events?: TestEventBus;
	} = {}
) {
	let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;
	let sessionTreeHandler: ((event: any, ctx: any) => void) | undefined;
	const dismissedToolCallIds: string[] = [];
	const sentMessages: Array<{ text: string; options: unknown }> = [];
	const labels: [string, string][] = [];

	registerPendingAskResume(
		{
			events: options.events,
			getCommands() {
				return options.commands ?? [];
			},
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "session_start") {
					sessionStartHandler = handler;
				} else if (event === "session_tree") {
					sessionTreeHandler = handler;
				}
			},
			appendEntry(customType: string, data: { toolCallId: string }) {
				branch.push({ type: "custom", customType, data });
				dismissedToolCallIds.push(data.toolCallId);
			},
			setLabel(id: string, label: string) {
				labels.push([id, label]);
			},
			sendUserMessage(text: string, sendOptions: unknown) {
				sentMessages.push({ text, options: sendOptions });
				options.onSend?.(text, sendOptions);
			},
		} as never,
		remoteAsk,
		new Set()
	);
	assert(sessionStartHandler);
	assert(sessionTreeHandler);

	const ctx = {
		cwd: process.cwd(),
		isIdle: () => options.idle ?? true,
		mode: "tui",
		sessionManager: { getBranch: () => branch },
		ui: {
			setStatus(key: string, text: string | undefined) {
				options.onStatus?.(key, text);
			},
			setTitle(title: string) {
				options.onTitle?.(title);
			},
			custom(callback: (...args: any[]) => unknown) {
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
			notify(message: string) {
				if (message.startsWith("Unanswered ask_user form dismissed")) {
					options.onDismissNotice?.();
				}
			},
			setWorkingVisible() {
				// The harness only checks completion behavior.
			},
		},
	};

	return {
		dismissedToolCallIds,
		labels,
		sentMessages,
		start(reason: "startup" | "resume" | "fork") {
			return sessionStartHandler?.({ type: "session_start", reason }, ctx);
		},
		tree(nextBranch: unknown[]) {
			branch.splice(0, branch.length, ...nextBranch);
			return sessionTreeHandler?.({ type: "session_tree" }, ctx);
		},
	};
}

function disabledNotificationConfig() {
	return {
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	};
}

function findEvent<T>(bus: TestEventBus, channel: string): T {
	const event = bus.events.find((candidate) => candidate.channel === channel);
	assert(event);
	return event.data as T;
}

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
