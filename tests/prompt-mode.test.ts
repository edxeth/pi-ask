import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Value } from "typebox/value";
import { PI_ASK_CONFIG_PROMPT } from "../src/prompt-text.ts";
import { prepareAskParams } from "../src/state/normalize.ts";

// Each process loads the extension once, just as pi does. The tool definition stays stable.
const probe = `
import askExtension from "./src/index.ts";
import { successfulResponse } from "./src/ask-tool-helpers.ts";
const tools = [];
const pi = {
  on() {}, registerShortcut() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {}, getCommands() { return []; },
  registerTool(tool) { tools.push(tool); },
  events: { on() {}, emit() {} },
};
askExtension(pi);
process.env.PI_ASK_PROMPT_MODE = "full";
askExtension(pi);
const submitted = { cancelled: false, mode: "submit", questions: [], answers: {} };
const elaborated = { ...submitted, mode: "elaborate", elaboration: { items: [{ target: { kind: "question" }, question: { id: "q", label: "Goal", prompt: "Choose a goal", type: "single", options: [{ value: "speed", label: "Speed" }] }, note: "Why?", answered: false }] } };
const raw = { context: "Pick one.", questions: [{ id: "q", prompt: "Pick", options: [
  { label: "Offline only" }, { label: "Offline only" },
  { value: "offline-only-2", label: "Explicit" }, { label: "Offline only" },
] }] };
const prepared = tools[0].prepareArguments(raw);
const response = await tools[0].execute("missing-value", prepared, undefined, undefined, { mode: "print" });
const blank = tools[0].prepareArguments({ context: "Pick one.", questions: [{ id: "q", prompt: "Pick", options: [{ value: "", label: "Blank value" }] }] });
const blankResponse = await tools[0].execute("blank-value", blank, undefined, undefined, { mode: "print" });
const invalid = tools[0].prepareArguments({ context: "Pick one.", questions: [{ id: "q", prompt: "Pick", options: [{ value: 42, label: "Number" }] }] });
const invalidResponse = tools[0].parameters.properties.questions.items.properties.options.items.properties.value === undefined
  ? await tools[0].execute("invalid-value", invalid, undefined, undefined, { mode: "print" }) : undefined;
console.log(JSON.stringify({ tools: tools.map(({ description, promptSnippet, promptGuidelines, parameters }) => ({ description, promptSnippet, promptGuidelines, parameters })), result: successfulResponse(submitted).content[0].text, elaborated: successfulResponse(elaborated).content[0].text, prepared, response: { text: response.content[0].text, details: response.details }, blankResponse: blankResponse.content[0].text, invalidResponse: invalidResponse?.content[0].text }));
`;

function registeredText(mode: string | undefined) {
	const env = { ...process.env };
	if (mode === undefined) {
		env.PI_ASK_PROMPT_MODE = undefined;
	} else {
		env.PI_ASK_PROMPT_MODE = mode;
	}
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", probe],
		{
			cwd: new URL("..", import.meta.url),
			env,
			encoding: "utf8",
		}
	);
	assert.equal(result.status, 0, result.stderr);
	return {
		...JSON.parse(result.stdout),
		warnings: result.stderr.trim() ? result.stderr.trim().split("\n") : [],
	};
}

const compactGuideline =
	"Use `ask_user` before preference-sensitive decisions (scope, tone, UX, naming, architecture, docs, implementation direction), or when several valid directions exist; ask 1-3 concise questions instead of choosing one path yourself.";
const contextGuideline =
	"Put each question and its options only in the `ask_user` form, and mark your recommended option there. Put everything that explains only in `context`, not in message text. Never restate a question or list its options in `context` or message text, even when a skill or prompt gives a text format for questions. The user does not see your thinking, tool output, or files.";
const followUpGuideline =
	"If a submitted answer or note asks a question or asks for an explanation, answer it in `context` when you ask again, or in message text when you do not. If the user asks only for an explanation, or asks you not to use the form, do not call `ask_user`. If a choice is still needed, use another structured `ask_user` call, not plain-text choices in chat. When prior answers narrow the branch, bundle the next 2-3 related unresolved decisions into one follow-up when possible; ask one at a time only when the next question materially depends on the previous answer.";
const contextDescription =
	"Required Markdown that the chat shows as your message just above the form: what you found, why each decision matters, why you recommend an option, hints, and the answer to anything the user asked.";
const questionsDescription =
	"Questions to ask in the interactive clarification flow";
const labelDescription =
	"Required short visible option label shown in the list; a unique machine identifier is derived from this label.";
const derivedValuePattern = /Offline only \[offline-only\]/;
const blankValuePattern = /option 1: value is required/;
const recommendation =
	"Optional. Set true on an option you recommend for a grounded reason; give the reason in `context`.";

const compact = registeredText("compact");

test("registered tool uses the concise text and label-only schema", () => {
	assert.deepEqual(compact.warnings, []);
	assert.equal(compact.tools.length, 2);
	assert.deepEqual(compact.tools[0], compact.tools[1]);
	const tool = compact.tools[0];
	assert.deepEqual(tool.promptGuidelines, [
		compactGuideline,
		contextGuideline,
		followUpGuideline,
	]);
	assert.equal(
		tool.parameters.properties.questions.description,
		questionsDescription
	);
	assert.equal(
		tool.parameters.properties.context.description,
		contextDescription
	);
	assert.equal(
		Object.hasOwn(tool.parameters.properties.questions, "maxItems"),
		false
	);
	assert.equal(
		tool.promptSnippet,
		"Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding"
	);
	const option =
		tool.parameters.properties.questions.items.properties.options.items;
	assert.equal(option.properties.recommended.description, recommendation);
	assert.equal(option.properties.label.description, labelDescription);
	assert.equal(Object.hasOwn(option.properties, "value"), false);
	assert.deepEqual(option.required, ["label"]);
	assert.equal(JSON.stringify(tool).includes('"value"'), false);
	assert.equal(
		Value.Check(tool.parameters, {
			context: "Pick one.",
			questions: [
				{
					id: "q",
					prompt: "Pick",
					options: [{ value: "a", label: "A", recommended: true }],
				},
			],
		}),
		true
	);
	assert.equal(
		Value.Check(tool.parameters, {
			context: "Pick one.",
			questions: [{ id: "q", prompt: "Pick", options: [{ value: "a" }] }],
		}),
		false
	);
});

test("tool description bounds a specific decision without expanding the ask", () => {
	const description = compact.tools[0].description;
	assert.ok(description.includes("ask that question only"));
	assert.ok(
		description.includes(
			"do not add other requirements or confirmation questions"
		)
	);
});

test("schema has no question limit", () => {
	const questions = Array.from({ length: 12 }, (_, index) => ({
		id: `q${index}`,
		prompt: "Pick",
		options: [{ label: "Offline only" }],
	}));
	assert.equal(
		Value.Check(compact.tools[0].parameters, {
			context: "Pick one.",
			questions: questions.slice(0, 4),
		}),
		true
	);
	assert.equal(
		Value.Check(compact.tools[0].parameters, {
			context: "Pick one.",
			questions,
		}),
		true
	);
});

test("option preparation fills only missing values and avoids explicit and derived collisions", () => {
	const options = compact.prepared.questions[0].options;
	assert.deepEqual(
		options.map((option: { value: string }) => option.value),
		["offline-only", "offline-only-3", "offline-only-2", "offline-only-4"]
	);
	assert.equal(
		Value.Check(compact.tools[0].parameters, compact.prepared),
		true
	);
	assert.equal(compact.response.details.error, undefined);
	assert.match(compact.response.text, derivedValuePattern);
	assert.match(compact.blankResponse, blankValuePattern);
	assert.match(compact.invalidResponse, blankValuePattern);
});

test("option preparation strips accents from derived values", () => {
	const prepared = prepareAskParams({
		questions: [
			{
				id: "q",
				prompt: "Pick",
				options: [{ label: "Résumé" }, { label: "Zürich office" }],
			},
		],
	}) as { questions: Array<{ options: Array<{ value: string }> }> };
	assert.deepEqual(
		prepared.questions[0].options.map((option) => option.value),
		["resume", "zurich-office"]
	);
});

test("environment values cannot change the registered tool", () => {
	for (const mode of [undefined, "", "not-a-mode"]) {
		const actual = registeredText(mode);
		assert.deepEqual(actual.tools, compact.tools, String(mode));
		assert.deepEqual(actual.warnings, []);
	}
});

test("rule inventory has a single observed home for each rule", () => {
	const tool = compact.tools[0];
	const descriptions: Record<string, string> = {};
	function collect(node: unknown, path: string) {
		if (!node || typeof node !== "object") {
			return;
		}
		const schema = node as {
			description?: string;
			properties?: Record<string, unknown>;
			items?: unknown;
		};
		if (schema.description) {
			descriptions[path] = schema.description;
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			collect(child, `${path}.${key}`);
		}
		if (schema.items) {
			collect(schema.items, `${path}[]`);
		}
	}
	collect(tool.parameters, "parameters");
	const homes: Record<string, string> = {
		description: tool.description,
		"guideline.1": tool.promptGuidelines[0],
		"guideline.2": tool.promptGuidelines[1],
		"guideline.3": tool.promptGuidelines[2],
		config: PI_ASK_CONFIG_PROMPT,
		"result.elaborated": compact.elaborated,
		...descriptions,
	};
	// Inventory from the rule allocation in spec #1.
	// The config home is its trigger text.
	const rules: [string, string, string][] = [
		["G1", "guideline.1", "before preference-sensitive decisions"],
		["G2", "guideline.1", "1-3 concise questions"],
		["G3", "parameters.questions[].prompt", "one decision at a time"],
		["G4", "parameters.questions[].id", "stable question identifier"],
		[
			"G5",
			"parameters.questions[].options[].label",
			"Required short visible option label",
		],
		[
			"G6",
			"parameters.questions[].options[].recommended",
			"Set true on an option you recommend",
		],
		["G7", "parameters.questions[].type", "Question type"],
		["G8", "parameters.questions[].type", "Use `preview` only"],
		[
			"G9",
			"guideline.3",
			"If a choice is still needed, use another structured `ask_user` call, not plain-text choices",
		],
		[
			"G10",
			"guideline.3",
			"bundle the next 2-3 related unresolved decisions into one follow-up when possible",
		],
		[
			"G11",
			"guideline.3",
			"ask one at a time only when the next question materially depends",
		],
		["G12", "guideline.2", "only in the `ask_user` form"],
		[
			"G13",
			"guideline.3",
			"answer it in `context` when you ask again, or in message text when you do not",
		],
		["G14", "guideline.3", "do not call `ask_user`"],
		[
			"G15",
			"guideline.2",
			"Never restate a question or list its options in `context` or message text",
		],
		[
			"G16",
			"guideline.2",
			"Put everything that explains only in `context`, not in message text",
		],
		["D1", "parameters.questions[].prompt", "Required direct question"],
		[
			"D2",
			"parameters.questions[].options[].label",
			"unique machine identifier is derived from this label",
		],
		["D3", "parameters.questions[].options[].label", "shown in the list"],
		[
			"D4",
			"description",
			"The user reads `context` in the chat, then this form",
		],
		[
			"D5",
			"parameters.context",
			"Required Markdown that the chat shows as your message just above the form",
		],
		["C1", "config", "first read"],
		["E1", "result.elaborated", "First answer the user's note directly"],
	];
	assert.deepEqual(
		rules.map(([id]) => id),
		[
			"G1",
			"G2",
			"G3",
			"G4",
			"G5",
			"G6",
			"G7",
			"G8",
			"G9",
			"G10",
			"G11",
			"G12",
			"G13",
			"G14",
			"G15",
			"G16",
			"D1",
			"D2",
			"D3",
			"D4",
			"D5",
			"C1",
			"E1",
		]
	);
	for (const [id, path, phrase] of rules) {
		assert.ok(
			homes[path]?.includes(phrase),
			`${id}: ${path} must contain ${phrase}`
		);
	}
});

const sentenceBoundary = /(?<=\.)\s+/;
const whitespace = /\s+/g;

test("no normalized rule sentence occurs twice in registered tool text", () => {
	const sentences: string[] = [];
	function add(text: string) {
		for (const sentence of text.split(sentenceBoundary)) {
			const normalized = sentence.toLowerCase().replace(whitespace, " ").trim();
			if (normalized) {
				sentences.push(normalized);
			}
		}
	}
	function visit(node: unknown) {
		if (!node || typeof node !== "object") {
			return;
		}
		const schema = node as {
			description?: string;
			properties?: Record<string, unknown>;
			items?: unknown;
		};
		if (schema.description) {
			add(schema.description);
		}
		for (const child of Object.values(schema.properties ?? {})) {
			visit(child);
		}
		if (schema.items) {
			visit(schema.items);
		}
	}
	const tool = compact.tools[0];
	add(tool.description);
	for (const guideline of tool.promptGuidelines) {
		add(guideline);
	}
	visit(tool.parameters);
	add(compact.elaborated);
	assert.equal(new Set(sentences).size, sentences.length);
});
