import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { registerAskTool } from "../src/ask-tool.ts";
import { AskOptionSchema, AskParamsSchema } from "../src/schema.ts";
import type { AskParams } from "../src/types.ts";
import { sessionWithContext } from "./fixtures/ask-context.ts";

const NON_INTERACTIVE_MESSAGE_RE =
	/Needs user input: ask_user requires interactive TUI mode\./;
const FIRST_QUESTION_RE = /1\. Goal: What should I optimize for\?/;
const SPEED_OPTION_RE = /- Speed \[speed\]/;
const CUSTOM_OPTION_RE = /- Type your own \[custom\]/;
const DUPLICATE_ID_RE =
	/questions\[1\]\.id: Question 2: duplicate question id "scope"/;
const PREVIEW_RULE_RE =
	/questions\[0\]\.options\[0\]\.preview: Question 1, option 1: preview questions require preview text for every option; add preview text or use type "single" instead/;
const MISSING_OPTION_VALUE_RE =
	/questions\[0\]\.options\[0\]\.value: Question 1, option 1: value is required/;
const EMPTY_QUESTIONS_RE = /questions: At least one question is required/;
const INVALID_TYPE_RE =
	/questions\[0\]\.type: Question 1: invalid type "grid"; expected "single", "multi", or "preview"/;
const HAS_UI = "hasUI";
const noop = () => {
	// intentional test callback
};

function registerMockTool() {
	const tools: Record<string, unknown>[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	registerAskTool({
		getCommands() {
			return [];
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
	} as never);
	return {
		entries,
		tool: tools[0] as {
			execute: (...args: any[]) => Promise<any>;
			parameters: Record<string, any>;
			prepareArguments: (args: unknown) => unknown;
			promptGuidelines: string[];
			renderCall: (args: unknown, theme: any) => { text: string };
			renderResult: (
				result: any,
				options: unknown,
				theme: any
			) => { text: string };
		},
	};
}

const CALL_IDS = [
	"call-1",
	"call-abort",
	"call-blank-optionals",
	"call-json",
	"call-prepared-labels",
	"call-tui",
	"tool-answer",
];

function makeCtx(hasUi: boolean, mode = hasUi ? "tui" : "print"): unknown {
	return {
		[HAS_UI]: hasUi,
		mode,
		sessionManager: sessionWithContext(...CALL_IDS),
	};
}

function sampleParams(): AskParams {
	return {
		title: "Clarify next step",
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
}

test("ask option schema and tool guidance support grounded recommendations", () => {
	const { tool } = registerMockTool();

	assert.equal(
		Value.Check(AskOptionSchema, {
			value: "small",
			label: "Small",
			description: "Lowest implementation risk",
			recommended: true,
		}),
		true
	);
	assert(
		[
			...tool.promptGuidelines,
			tool.parameters.properties.questions.items.properties.options.items
				.properties.recommended.description,
		].some(
			(guidance) =>
				guidance.includes("grounded") && guidance.includes("message text")
		)
	);
});

test("ask params schema constrains question types", () => {
	assert.equal(
		Value.Check(AskParamsSchema, {
			questions: [
				{
					id: "layout",
					prompt: "Choose a layout",
					type: "grid",
					options: [{ value: "compact", label: "Compact" }],
				},
			],
		}),
		false
	);
});

test("ask_user runs sequentially with other tools in its batch", () => {
	const { tool } = registerMockTool();
	assert.equal(
		(tool as typeof tool & { executionMode?: string }).executionMode,
		"sequential"
	);
});

test("ask_user is declared to the model but not callable from codemode scripts", () => {
	const { tool } = registerMockTool();
	assert.equal(
		(tool as typeof tool & { exposure?: string }).exposure,
		"model-only"
	);
});

test("a pre-aborted ask returns without opening the UI", async () => {
	const { tool } = registerMockTool();
	const abort = new AbortController();
	abort.abort();
	let opened = false;
	const result = await tool.execute(
		"pre-aborted",
		sampleParams(),
		abort.signal,
		noop,
		{
			mode: "tui",
			ui: {
				custom() {
					opened = true;
				},
			},
		}
	);
	assert.equal(opened, false);
	assert.equal(result.details.cancelReason, "aborted");
	assert.deepEqual(result.details.answers, {});
	assert.equal(
		result.content[0].text,
		"The ask_user form was closed because the run was aborted. No answers were collected."
	);
});

test("abort closes an open ask and emits remote completion", async () => {
	const abort = new AbortController();
	const updates: Array<{
		content: Array<{ text: string }>;
		details: { answers: Record<string, { values: string[] }> };
	}> = [];
	const events: Array<{ channel: string; data: any }> = [];
	const handlers = new Map<string, (data: unknown) => void>();
	const { createRemoteAskRuntime, PI_ASK_COMPLETED_EVENT } = await import(
		"../src/remote-ask.ts"
	);
	const remote = createRemoteAskRuntime({
		emit(channel: string, data: unknown) {
			events.push({ channel, data });
		},
		on(channel: string, handler: (data: unknown) => void) {
			handlers.set(channel, handler);
			return () => {
				handlers.delete(channel);
			};
		},
	} as never);
	const tools: any[] = [];
	registerAskTool(
		{
			registerTool(value: unknown) {
				tools.push(value);
			},
			appendEntry() {
				// The fake only observes remote completion.
			},
			getCommands() {
				return [];
			},
		} as never,
		remote
	);
	let opened = false;
	let component: { handleInput(data: string): void } | undefined;
	let signalOpened: () => void = noop;
	const opening = new Promise<void>((resolve) => {
		signalOpened = resolve;
	});
	const pending = tools[0].execute(
		"call-abort",
		sampleParams(),
		abort.signal,
		(update: (typeof updates)[number]) => updates.push(update),
		{
			cwd: process.cwd(),
			mode: "tui",
			sessionManager: sessionWithContext("call-abort"),
			ui: {
				setWorkingVisible() {
					// Visibility does not affect lifecycle.
				},
				custom(callback: (...args: unknown[]) => unknown) {
					opened = true;
					signalOpened();
					return new Promise((resolve) => {
						component = callback(
							{
								requestRender() {
									// Rendering does not affect lifecycle.
								},
							},
							{
								bg: (_: string, text: string) => text,
								fg: (_: string, text: string) => text,
							},
							{},
							resolve
						) as typeof component;
					});
				},
			},
		}
	);
	await opening;
	assert.equal(opened, true);
	assert(component);
	component.handleInput("1");
	assert.deepEqual(
		updates.map((update) => update.content[0].text),
		["Goal: Speed"]
	);
	assert.deepEqual(updates[0].details.answers.goal.values, ["speed"]);
	abort.abort();
	const result = await pending;
	component.handleInput("2");
	assert.equal(updates.length, 1);
	assert.equal(result.details.cancelReason, "aborted");
	assert.deepEqual(result.details.answers, {});
	assert.equal(
		result.content[0].text,
		"The ask_user form was closed because the run was aborted. No answers were collected."
	);
	assert.equal(
		events.find((event) => event.channel === PI_ASK_COMPLETED_EVENT)?.data
			.result.cancelReason,
		"aborted"
	);
	remote.disposeAll();
});

test("ask tool stores valid payloads as soon as they are called", async () => {
	const { entries, tool } = registerMockTool();
	const params = sampleParams();

	await tool.execute("call-1", params, undefined, noop, makeCtx(false));

	assert.equal(entries.length, 1);
	assert.equal(entries[0].customType, "ask:payload");
	assert.deepEqual(entries[0].data, {
		version: 1,
		source: "tool",
		params,
		sourceEntryId: "call-1",
		timestamp: (entries[0].data as { timestamp: number }).timestamp,
	});
});

test("ask tool returns pending questions in non-interactive mode", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		sampleParams(),
		undefined,
		noop,
		makeCtx(false)
	);

	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "ui_unavailable");
	assert.equal(result.details.mode, "submit");
	assert.deepEqual(result.details.questions, [
		{
			id: "goal",
			label: "Goal",
			prompt: "What should I optimize for?",
			type: "single",
		},
	]);
	assert.deepEqual(result.details.answers, {});
	assert.match(result.content[0].text, NON_INTERACTIVE_MESSAGE_RE);
	assert.match(result.content[0].text, FIRST_QUESTION_RE);
	assert.match(result.content[0].text, SPEED_OPTION_RE);
	assert.match(result.content[0].text, CUSTOM_OPTION_RE);
});

test("ask tool reports unavailable UI in JSON mode without changing its content", async () => {
	const { tool } = registerMockTool();
	const result = await tool.execute(
		"call-json",
		sampleParams(),
		undefined,
		noop,
		makeCtx(false, "json")
	);

	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "ui_unavailable");
	assert.equal(
		result.content[0].text,
		"Needs user input: ask_user requires interactive TUI mode.\n" +
			"Run same tool call in interactive TUI mode, or ask user these questions manually:\n" +
			"1. Goal: What should I optimize for?\n" +
			"   - Speed [speed]\n" +
			"   - Safety [safety]\n" +
			"   - Type your own [custom]\n" +
			"details.questions contains normalized pending questions. details.answers stays empty until user responds."
	);
});

test("ask tool reports a user cancel from the TUI", async () => {
	const { tool } = registerMockTool();
	let component: { handleInput(data: string): void } | undefined;
	const resultPromise = tool.execute(
		"call-tui",
		sampleParams(),
		undefined,
		noop,
		{
			cwd: process.cwd(),
			mode: "tui",
			sessionManager: sessionWithContext("call-tui"),
			ui: {
				setWorkingVisible() {
					// Visibility does not affect this tool result test.
				},
				custom(callback: (...args: unknown[]) => unknown) {
					return new Promise((resolve) => {
						component = callback(
							{
								requestRender() {
									// Rendering does not affect this tool result test.
								},
							},
							{
								bg: (_color: string, text: string) => text,
								fg: (_color: string, text: string) => text,
							},
							{},
							resolve
						) as typeof component;
					});
				},
			},
		}
	);

	await new Promise((resolve) => setImmediate(resolve));
	assert(component);
	component.handleInput("\x1b");
	const result = await resultPromise;
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "user");
	assert.equal(result.content[0].text, "User cancelled the ask flow");
});

const MISSING_CONTEXT_TEXT_RE =
	/^ask_user did not open\. Since the user's last input your messages contained only \[thinking, toolCall\] blocks and no text/;

function textlessAsk(entryId: string, toolCallId: string) {
	return {
		type: "message",
		id: entryId,
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Explain, then ask." },
				{ type: "toolCall", id: toolCallId, name: "ask_user", arguments: {} },
			],
		},
	};
}

function userMessage(entryId: string) {
	return {
		type: "message",
		id: entryId,
		message: { role: "user", content: [{ type: "text", text: "Plan it" }] },
	};
}

function refusalResult(entryId: string, toolCallId: string, details: unknown) {
	return {
		type: "message",
		id: entryId,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "ask_user",
			content: [{ type: "text", text: "ask_user did not open." }],
			details,
			isError: true,
		},
	};
}

function contextCheckCtx(branch: unknown[], onOpen: () => void) {
	return {
		cwd: process.cwd(),
		mode: "tui",
		[HAS_UI]: true,
		sessionManager: { getBranch: () => branch },
		ui: {
			setWorkingVisible: noop,
			custom() {
				onOpen();
				return Promise.resolve({
					cancelled: true,
					cancelReason: "user",
					mode: "submit",
					questions: [],
					answers: {},
				});
			},
		},
	};
}

test("a TUI ask without message text since the user's input is refused, with no form and no saved payload", async () => {
	const { tool, entries } = registerMockTool();
	let opened = false;
	const result = await tool.execute(
		"bare-1",
		sampleParams(),
		undefined,
		noop,
		contextCheckCtx([userMessage("u1"), textlessAsk("a1", "bare-1")], () => {
			opened = true;
		})
	);
	assert.equal(result.isError, true);
	assert.equal(result.details.cancelReason, "missing_context");
	assert.match(result.content[0].text, MISSING_CONTEXT_TEXT_RE);
	assert.equal(opened, false);
	assert.deepEqual(entries, []);
});

test("the second text-less ask after one user input opens the form, and a new input is refused again", async () => {
	const { tool } = registerMockTool();
	let opened = 0;
	const branch: unknown[] = [userMessage("u1"), textlessAsk("a1", "bare-1")];
	const ctx = contextCheckCtx(branch, () => {
		opened++;
	});
	const first = await tool.execute(
		"bare-1",
		sampleParams(),
		undefined,
		noop,
		ctx
	);
	branch.push(
		refusalResult("r1", "bare-1", first.details),
		textlessAsk("a2", "bare-2")
	);
	const second = await tool.execute(
		"bare-2",
		sampleParams(),
		undefined,
		noop,
		ctx
	);
	branch.push(userMessage("u2"), textlessAsk("a3", "bare-3"));
	const third = await tool.execute(
		"bare-3",
		sampleParams(),
		undefined,
		noop,
		ctx
	);
	assert.deepEqual(
		[
			first.details.cancelReason,
			second.details.cancelReason,
			third.details.cancelReason,
		],
		["missing_context", "user", "missing_context"]
	);
	assert.equal(opened, 1);
});

test("non-interactive modes keep the Needs user input result without a context check", async () => {
	const { tool } = registerMockTool();
	const result = await tool.execute(
		"bare-print",
		sampleParams(),
		undefined,
		noop,
		{
			mode: "print",
			sessionManager: { getBranch: () => [] },
		}
	);
	assert.match(result.content[0].text, NON_INTERACTIVE_MESSAGE_RE);
	assert.equal(result.details.cancelReason, "ui_unavailable");
});

test("ask tool includes custom answer fallback for preview questions", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "layout",
					label: "Layout",
					prompt: "Which layout?",
					type: "preview",
					options: [{ value: "compact", label: "Compact", preview: "A" }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(false)
	);

	assert.match(result.content[0].text, CUSTOM_OPTION_RE);
});

test("ask tool rejects invalid payloads before UI opens with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "scope",
					prompt: "Pick scope",
					options: [{ value: "small", label: "Small" }],
				},
				{
					id: "scope",
					prompt: "Pick tone",
					options: [{ value: "direct", label: "Direct" }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.isError, true);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "invalid_input");
	assert.equal(result.details.mode, "submit");
	assert.equal(result.details.questions.length, 0);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[1].id",
				message: 'Question 2: duplicate question id "scope"',
			},
		],
	});
	assert.match(result.content[0].text, DUPLICATE_ID_RE);
});

test("ask tool reports missing option values with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "api_style",
					prompt: "Pick API style",
					options: [{ label: "REST" } as never],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[0].options[0].value",
				message: "Question 1, option 1: value is required",
			},
		],
	});
	assert.match(result.content[0].text, MISSING_OPTION_VALUE_RE);
});

test("ask tool reports empty questions with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions",
				message: "At least one question is required",
			},
		],
	});
	assert.match(result.content[0].text, EMPTY_QUESTIONS_RE);
});

test("ask tool reports invalid question types with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "layout",
					prompt: "Pick layout",
					type: "grid" as never,
					options: [{ value: "compact", label: "Compact" }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[0].type",
				message:
					'Question 1: invalid type "grid"; expected "single", "multi", or "preview"',
			},
		],
	});
	assert.match(result.content[0].text, INVALID_TYPE_RE);
});

test("ask tool reports preview validation with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "layout",
					prompt: "Pick layout",
					type: "preview",
					options: [{ value: "compact", label: "Compact", preview: "   " }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[0].options[0].preview",
				message:
					'Question 1, option 1: preview questions require preview text for every option; add preview text or use type "single" instead',
			},
		],
	});
	assert.match(result.content[0].text, PREVIEW_RULE_RE);
});

test("ask tool accepts blank optional presentation fields", async () => {
	const { tool } = registerMockTool();
	const params: AskParams = {
		title: "   ",
		questions: [
			{
				id: "scope",
				label: "  ",
				prompt: "Pick scope",
				options: [
					{
						value: "small",
						label: "Small",
						description: " ",
						preview: "\t",
					},
				],
			},
		],
	};
	assert.equal(Value.Check(AskParamsSchema, params), true);
	const result = await tool.execute(
		"call-blank-optionals",
		params,
		undefined,
		noop,
		makeCtx(false)
	);

	assert.equal(result.details.error, undefined);
	assert.equal(result.details.title, undefined);
	assert.equal(result.details.questions[0].label, "Q1");
});

test("ask tool prepares missing and blank option labels before schema validation", async () => {
	const { tool } = registerMockTool();
	const raw = {
		questions: [
			{
				id: "encryption",
				prompt: "Choose encryption",
				options: [
					{ value: "region-local-kms-reencrypt-dek" },
					{ value: "follow_up", label: "  " },
					{ value: "existing", label: "Existing label" },
				],
			},
		],
	};

	assert.equal(Value.Check(AskParamsSchema, raw), false);
	const prepared = tool.prepareArguments(raw) as AskParams;
	assert.equal(Value.Check(AskParamsSchema, prepared), true);
	assert.deepEqual(
		prepared.questions[0]?.options.map((option) => option.label),
		["Region local kms reencrypt dek", "Follow up", "Existing label"]
	);

	const result = await tool.execute(
		"call-prepared-labels",
		prepared,
		undefined,
		noop,
		makeCtx(false)
	);
	assert.equal(result.details.error, undefined);
});

test("public schema requires semantic identifiers and labels", () => {
	const { tool } = registerMockTool();
	assert.deepEqual(tool.parameters.required, ["questions"]);
	const questionSchema = tool.parameters.properties.questions.items;
	assert.deepEqual(questionSchema.required, ["id", "prompt", "options"]);
	assert.deepEqual(questionSchema.properties.options.items.required, ["label"]);

	const missingLabel = {
		questions: [
			{
				id: "scope",
				prompt: "Pick scope",
				options: [{ value: "small" }],
			},
		],
	};
	assert.equal(Value.Check(AskParamsSchema, missingLabel), false);
});

test("ask tool transcript renderers summarize call and cancelled result", () => {
	const { tool } = registerMockTool();
	const theme = {
		bold: (text: string) => text,
		fg: (_token: string, text: string) => text,
	};

	const callText = tool.renderCall(
		{
			questions: [
				{ label: "Goal", options: [], prompt: "Q?", id: "goal" },
				{ label: "Tone", options: [], prompt: "Q?", id: "tone" },
			],
		},
		theme
	).text;
	assert.equal(callText, "ask_user 2 question(s) (Goal, Tone)");

	const resultText = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				cancelled: true,
				mode: "submit",
				questions: [],
				answers: {},
			},
		},
		undefined,
		theme
	).text;
	assert.equal(resultText, "Cancelled");

	const invalidText = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				cancelled: true,
				mode: "submit",
				questions: [],
				answers: {},
				error: {
					kind: "invalid_input",
					issues: [],
				},
			},
		},
		undefined,
		theme
	).text;
	assert.equal(invalidText, "Invalid tool payload");

	const schemaErrorText = tool.renderResult(
		{
			content: [
				{
					type: "text",
					text: 'Validation failed for tool "ask_user": missing label',
				},
			],
			details: {},
		},
		undefined,
		theme
	).text;
	assert.equal(
		schemaErrorText,
		'Validation failed for tool "ask_user": missing label'
	);
});

test("ask_user asks the skill provider to deliver after a submitted tool result", async () => {
	const { createEventBus } = await import("@earendil-works/pi-coding-agent");
	const { createRemoteAskRuntime, PI_ASK_STARTED_EVENT, PI_ASK_SUBMIT_EVENT } =
		await import("../src/remote-ask.ts");
	const { getAskConfigStore } = await import("../src/config/store.ts");
	const { DEFAULT_ASK_CONFIG } = await import("../src/config/defaults.ts");
	const { fileURLToPath } = await import("node:url");
	const bus = createEventBus();
	const remote = createRemoteAskRuntime(bus);
	const requests: string[][] = [];
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
			requests.push(r.names ?? []);
			r.reply({
				version: 1,
				operation: "deliver",
				outcomes: [{ name: "tdd", status: "delivered" }],
			});
		}
	});
	bus.on(PI_ASK_STARTED_EVENT, (event: unknown) => {
		const started = event as { flowId: string };
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "tool-answer",
			flowId: started.flowId,
			response: {
				kind: "answer",
				answers: { goal: { values: ["speed"], note: "Use /skill:tdd" } },
			},
		});
	});
	const config = getAskConfigStore();
	config.setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	const tools: any[] = [];
	registerAskTool(
		{
			events: bus,
			getCommands: () => [
				{
					name: "skill:tdd",
					source: "skill",
					sourceInfo: {
						path: fileURLToPath(
							new URL("./fixtures/skill/SKILL.md", import.meta.url)
						),
					},
				},
			],
			appendEntry: noop,
			registerTool(tool: unknown) {
				tools.push(tool);
			},
		} as never,
		remote
	);
	try {
		const result = await tools[0].execute(
			"tool-answer",
			sampleParams(),
			undefined,
			noop,
			{
				cwd: process.cwd(),
				mode: "tui",
				sessionManager: sessionWithContext("tool-answer"),
				ui: {
					setWorkingVisible: noop,
					custom: (callback: (...args: any[]) => unknown) =>
						new Promise((resolve) => {
							callback(
								{ requestRender: noop },
								{
									bg: (_: string, text: string) => text,
									fg: (_: string, text: string) => text,
								},
								{},
								resolve
							);
						}),
				},
			}
		);
		assert.deepEqual(requests, [["tdd"]]);
		assert.equal(
			result.content[0].text,
			"Goal: Speed\nGoal note: Use /skill:tdd"
		);
	} finally {
		remote.disposeAll();
		config.setConfig(DEFAULT_ASK_CONFIG);
	}
});
