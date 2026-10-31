import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { registerAskTool } from "../src/ask-tool.ts";
import { askToolCallText, askToolResultText } from "../src/ask-tool-helpers.ts";
import { AskOptionSchema, AskParamsSchema } from "../src/schema.ts";
import type { AskParams } from "../src/types.ts";

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
const CONTEXT_ARGUMENT_RE = /context/;
const HAS_UI = "hasUI";
const CONTEXT = "Speed and safety pull this plan in different directions.";
const BLANK_CONTEXT_ISSUE = {
	path: "context",
	message:
		"Context is required: write the explanation that the chat shows above the form",
};
// Strips SGR escape codes, so rendered rows compare as plain text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
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
			renderCall: (args: unknown, theme: any, state: unknown) => Rendered;
			renderResult: (
				result: any,
				options: unknown,
				theme: any,
				state: unknown
			) => Rendered;
			renderShell?: string;
		},
	};
}

interface Rendered {
	render(width: number): string[];
}

/** Rendered rows without escape codes or trailing padding. */
function rows(component: Rendered, width = 60): string[] {
	return component
		.render(width)
		.map((line) => line.replace(ANSI_RE, "").trimEnd());
}

function makeCtx(hasUi: boolean, mode = hasUi ? "tui" : "print"): unknown {
	return { [HAS_UI]: hasUi, mode };
}

function sampleParams(): AskParams {
	return {
		context: CONTEXT,
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
				guidance.includes("grounded") && guidance.includes("`context`")
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

test("ask tool includes custom answer fallback for preview questions", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			context: CONTEXT,
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
			context: CONTEXT,
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
			context: CONTEXT,
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
			context: CONTEXT,
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
			context: CONTEXT,
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
			context: CONTEXT,
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
		context: CONTEXT,
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
		context: CONTEXT,
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

test("a question without a type becomes a preview question when every option has preview text", async () => {
	const { tool } = registerMockTool();
	const option = (label: string, preview?: string) => ({ label, preview });
	const raw = {
		context: CONTEXT,
		questions: [
			{
				id: "tone",
				prompt: "Which tone?",
				options: [option("Paper", "Serif text"), option("Slate", "Mono text")],
			},
			{
				id: "partial",
				prompt: "Which layout?",
				options: [option("Sidebar", "Left list"), option("Tabs")],
			},
			{
				id: "blank",
				prompt: "Which density?",
				options: [option("Compact", "Tight rows"), option("Roomy", "  ")],
			},
			{
				id: "explicit",
				prompt: "Which themes?",
				type: "multi",
				options: [option("Light", "White"), option("Dark", "Black")],
			},
		],
	};
	const prepared = tool.prepareArguments(raw) as AskParams;
	assert.deepEqual(
		prepared.questions.map((question) => question.type),
		["preview", undefined, undefined, "multi"]
	);
	const result = await tool.execute(
		"call-inferred-preview",
		prepared,
		undefined,
		noop,
		makeCtx(false)
	);
	assert.deepEqual(
		result.details.questions.map((question: { type: string }) => question.type),
		["preview", "single", "single", "multi"]
	);
});

test("public schema requires semantic identifiers and labels", () => {
	const { tool } = registerMockTool();
	assert.deepEqual(tool.parameters.required, ["context", "questions"]);
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

test("public schema requires context first, before the title and questions", () => {
	const { tool } = registerMockTool();
	assert.deepEqual(Object.keys(tool.parameters.properties), [
		"context",
		"title",
		"questions",
	]);
	assert.equal(tool.parameters.properties.context.type, "string");
	const { questions } = sampleParams();
	assert.equal(Value.Check(tool.parameters, { questions }), false);
	assert.equal(
		Value.Check(tool.parameters, { context: CONTEXT, questions }),
		true
	);
});

test("an ask without context returns an invalid payload, opens no form and saves no payload", async () => {
	for (const context of [undefined, "", " \n\t "]) {
		const { tool, entries } = registerMockTool();
		let opened = false;
		const result = await tool.execute(
			"call-blank-context",
			{ ...sampleParams(), context },
			undefined,
			noop,
			{
				cwd: process.cwd(),
				mode: "tui",
				[HAS_UI]: true,
				ui: {
					setWorkingVisible: noop,
					custom() {
						opened = true;
					},
				},
			}
		);
		assert.equal(result.isError, true, String(context));
		assert.equal(result.details.cancelReason, "invalid_input");
		assert.deepEqual(result.details.error.issues, [BLANK_CONTEXT_ISSUE]);
		assert.equal(
			result.content[0].text,
			`Invalid ask_user payload:\n- context: ${BLANK_CONTEXT_ISSUE.message}`
		);
		assert.equal(opened, false);
		assert.deepEqual(entries, []);
	}
});

test("a number or boolean context fails pi's argument validation instead of becoming text", () => {
	// pi converts primitives to the schema type before validation; the call renderer still
	// reads the raw argument, so a converted context would open a form with no explanation.
	const { tool } = registerMockTool();
	for (const context of [42, true]) {
		const toolCall = {
			type: "toolCall",
			id: "call-non-string-context",
			name: "ask_user",
			arguments: tool.prepareArguments({ ...sampleParams(), context }),
		};
		assert.throws(
			() => validateToolArguments(tool as never, toolCall as never),
			CONTEXT_ARGUMENT_RE,
			String(context)
		);
	}
});

test("a blank context is reported with the question issues in one result", async () => {
	const { tool } = registerMockTool();
	const result = await tool.execute(
		"call-all-issues",
		{ questions: [] },
		undefined,
		noop,
		makeCtx(false)
	);
	assert.deepEqual(result.details.error.issues, [
		BLANK_CONTEXT_ISSUE,
		{ path: "questions", message: "At least one question is required" },
	]);
});

const plainTheme = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
	bg: (token: string, text: string) => `<${token}>${text}`,
};
const pending = { isPartial: true, isError: false };
const succeeded = { isPartial: false, isError: false };
const failed = { isPartial: false, isError: true };
const twoQuestions = [
	{ label: "Goal", options: [], prompt: "Q?", id: "goal" },
	{ label: "Tone", options: [], prompt: "Q?", id: "tone" },
];
const cancelledResult = {
	content: [{ type: "text", text: "ignored" }],
	details: { cancelled: true, mode: "submit", questions: [], answers: {} },
};

test("ask_user draws its own rows: the context as a message above the tool header", () => {
	// Markdown rows use pi's active theme, as assistant messages do.
	initTheme("dark");
	const { tool } = registerMockTool();
	assert.equal(tool.renderShell, "self");
	assert.deepEqual(
		rows(
			tool.renderCall(
				{
					context: "The ADR names **deepseek-v4.1-flash**.",
					questions: twoQuestions,
				},
				plainTheme,
				pending
			)
		),
		[
			" The ADR names deepseek-v4.1-flash.",
			"",
			" ask_user 2 question(s) (Goal, Tone)",
		]
	);
});

test("a call without context shows only the tool header", () => {
	const { tool } = registerMockTool();
	for (const context of [undefined, " \n "]) {
		assert.deepEqual(
			rows(
				tool.renderCall(
					{ context, questions: twoQuestions },
					plainTheme,
					pending
				)
			),
			[" ask_user 2 question(s) (Goal, Tone)"],
			String(context)
		);
	}
});

test("a finished call puts its header and result in a box with the result's background", () => {
	initTheme("dark");
	const { tool } = registerMockTool();
	const call = { context: "Read this.", questions: twoQuestions };
	assert.deepEqual(rows(tool.renderCall(call, plainTheme, succeeded)), [
		" Read this.",
		"",
		"<toolSuccessBg>",
		"<toolSuccessBg> ask_user 2 question(s) (Goal, Tone)",
	]);
	assert.deepEqual(
		rows(tool.renderResult(cancelledResult, undefined, plainTheme, succeeded)),
		["<toolSuccessBg> Cancelled", "<toolSuccessBg>"]
	);
	assert.deepEqual(rows(tool.renderCall(call, plainTheme, failed)).slice(2), [
		"<toolErrorBg>",
		"<toolErrorBg> ask_user 2 question(s) (Goal, Tone)",
	]);
	const invalid = {
		content: [{ type: "text", text: "ignored" }],
		details: {
			...cancelledResult.details,
			error: { kind: "invalid_input", issues: [] },
		},
	};
	assert.deepEqual(
		rows(tool.renderResult(invalid, undefined, plainTheme, failed)),
		["<toolErrorBg> Invalid tool payload", "<toolErrorBg>"]
	);
	const schemaError = {
		content: [
			{
				type: "text",
				text: 'Validation failed for tool "ask_user": missing label',
			},
		],
		details: {},
	};
	assert.deepEqual(
		rows(tool.renderResult(schemaError, undefined, plainTheme, failed)),
		[
			'<toolErrorBg> Validation failed for tool "ask_user": missing label',
			"<toolErrorBg>",
		]
	);
});

test("answers reported while the form is open show without a box", () => {
	const { tool } = registerMockTool();
	assert.deepEqual(
		rows(tool.renderResult(cancelledResult, undefined, plainTheme, pending)),
		[" Cancelled"]
	);
});

test("ask_user rows follow pi's tool padding setting", () => {
	initTheme("dark");
	const { tool } = registerMockTool();
	const call = { context: "Read this.", questions: [] };
	assert.deepEqual(
		rows(tool.renderCall(call, plainTheme, { ...pending, outputPad: 3 })),
		["   Read this.", "", "   ask_user 0 question(s)"]
	);
	assert.deepEqual(
		rows(
			tool.renderCall(call, plainTheme, { ...succeeded, outputPad: 3 })
		).slice(2),
		["<toolSuccessBg>", "<toolSuccessBg>   ask_user 0 question(s)"]
	);
});

test("a finished ask_user call draws the box of pi's default tool shell below its context", () => {
	initTheme("dark");
	const { tool } = registerMockTool();
	const ui = { requestRender: noop };
	const args = { context: "Read this first.", questions: twoQuestions };
	const ours = new ToolExecutionComponent(
		"ask_user",
		"call-ours",
		args,
		{},
		tool as never,
		ui as never,
		process.cwd()
	);
	// The default shell around the plain text rows that ask_user drew before it had context.
	const reference = new ToolExecutionComponent(
		"ask_user",
		"call-reference",
		args,
		{},
		{
			renderShell: "default",
			renderCall: (callArgs: AskParams, theme: any) =>
				new Text(askToolCallText(callArgs, theme), 0, 0),
			renderResult: (result: any, _options: unknown, theme: any) =>
				new Text(askToolResultText(result, theme), 0, 0),
		} as never,
		ui as never,
		process.cwd()
	);
	for (const component of [ours, reference]) {
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({ ...cancelledResult, isError: false } as never);
	}
	const ourRows = ours.render(60);
	const referenceRows = reference.render(60);
	assert.equal(referenceRows.length, 5);
	assert.deepEqual(ourRows.slice(-4), referenceRows.slice(-4));
	assert.deepEqual(
		ourRows.slice(0, -4).map((line) => line.replace(ANSI_RE, "").trimEnd()),
		["", " Read this first.", ""]
	);
});

test("pi's HTML export draws a finished call without a pending background", async () => {
	initTheme("dark");
	const { tool } = registerMockTool();
	// pi exports no API for its HTML exporter; this loads the module that /export uses.
	const exporter = new URL(
		"core/export-html/tool-renderer.js",
		import.meta.resolve("@earendil-works/pi-coding-agent")
	);
	const { createToolHtmlRenderer } = await import(exporter.href);
	const rgb = {
		toolPendingBg: "1,1,1",
		toolSuccessBg: "2,2,2",
		toolErrorBg: "3,3,3",
	} as const;
	const exportTheme = {
		...plainTheme,
		bg: (token: keyof typeof rgb, text: string) =>
			`\x1b[48;2;${rgb[token].replaceAll(",", ";")}m${text}\x1b[49m`,
	};
	const html = createToolHtmlRenderer({
		// pi 0.99 names this lookup getToolDefinition; pi 1.0 renamed it getToolRenderers.
		getToolDefinition: () => tool,
		getToolRenderers: () => tool,
		theme: exportTheme,
		cwd: process.cwd(),
	});
	const call = html.renderCall("call-1", "ask_user", {
		context: "Read this first.",
		questions: twoQuestions,
	});
	assert.ok(call.includes("Read this first."));
	assert.ok(call.includes("ask_user 2 question(s)"));
	assert.equal(call.includes("background-color"), false);
	const content = cancelledResult.content;
	for (const [isError, token] of [
		[false, "toolSuccessBg"],
		[true, "toolErrorBg"],
	] as const) {
		const result = html.renderResult(
			"call-1",
			"ask_user",
			content,
			cancelledResult.details,
			isError
		);
		assert.ok(
			result.expanded.includes(`background-color:rgb(${rgb[token]})`),
			token
		);
		assert.equal(result.expanded.includes("rgb(1,1,1)"), false);
	}
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
