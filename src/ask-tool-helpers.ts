import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { UI_DIMENSIONS } from "./constants/ui.ts";
import { ASK_ELABORATION_INSTRUCTION } from "./prompt-text.ts";
import { renderResultText } from "./result.ts";
import {
	type ResolvedSkill,
	resolveSkillReferences,
	type SkillCommands,
} from "./skill-references.ts";
import { createInitialState } from "./state/create.ts";
import { collectValidationIssues } from "./state/normalize.ts";
import { summarizeResult, toAskResult } from "./state/result.ts";
import type {
	AskParams,
	AskQuestionInput,
	AskResult,
	AskValidationIssue,
} from "./types.ts";

interface ValidateParamsOptions {
	allowFreeform?: boolean;
	presentSingleAsMulti?: boolean;
}

export function validateParams(
	params: AskParams,
	options: ValidateParamsOptions = {}
):
	| { ok: true; state: ReturnType<typeof createInitialState> }
	| { ok: false; issues: AskValidationIssue[] } {
	const issues = collectValidationIssues(params, options);
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		state: createInitialState(params, options),
	};
}

const BLANK_CONTEXT_MESSAGE =
	"Context is required: write the explanation that the chat shows above the form";

/**
 * validateParams for an `ask_user` call, which also requires a non-blank `context`: blank
 * text would leave the user without an explanation. Stored payloads and `/answer` forms have none.
 */
export function validateToolParams(
	params: AskParams,
	options: ValidateParamsOptions
): ReturnType<typeof validateParams> {
	const validation = validateParams(params, options);
	const missingContext =
		typeof params.context === "string" && params.context.trim()
			? []
			: [{ path: "context", message: BLANK_CONTEXT_MESSAGE }];
	if (missingContext.length === 0) {
		return validation;
	}
	return {
		ok: false,
		issues: [...missingContext, ...(validation.ok ? [] : validation.issues)],
	};
}

export function invalidPayloadResponse(
	params: AskParams,
	issues: AskValidationIssue[]
) {
	return {
		content: [{ type: "text" as const, text: formatValidationError(issues) }],
		details: errorResultDetails(params, issues),
		isError: true,
	};
}

export const ABORTED_ASK_TEXT =
	"The ask_user form was closed because the run was aborted. No answers were collected.";

export function abortedResponse(params: AskParams) {
	return {
		content: [{ type: "text" as const, text: ABORTED_ASK_TEXT }],
		details: {
			...toAskResult(createInitialState(params)),
			cancelled: true,
			cancelReason: "aborted" as const,
		},
	};
}

export function nonInteractiveResponse(
	state: ReturnType<typeof createInitialState>
) {
	return {
		content: [
			{ type: "text" as const, text: formatNonInteractiveMessage(state) },
		],
		details: {
			...toAskResult(state),
			cancelled: true,
			cancelReason: "ui_unavailable" as const,
		},
	};
}

export function successfulResponse(
	result: AskResult,
	commands: SkillCommands = [],
	events?: ExtensionAPI["events"]
) {
	const texts = Object.values(result.answers).flatMap((answer) => [
		answer.customText ?? "",
		answer.note ?? "",
		...Object.values(answer.optionNotes ?? {}),
	]);
	for (const item of result.elaboration?.items ?? []) {
		texts.push(
			item.note,
			item.answer?.customText ?? "",
			item.answer?.note ?? ""
		);
	}
	const resolvedSkills = result.cancelled
		? []
		: resolveSkillReferences(texts, commands);
	const fallbackSkills = deliverSkills(resolvedSkills, events);
	return {
		content: [
			{
				type: "text" as const,
				text:
					summarizeResult(result) +
					(!result.cancelled && result.mode === "elaborate"
						? `\n${ASK_ELABORATION_INSTRUCTION}`
						: "") +
					(fallbackSkills.length ? `\n\n${fallbackSkills.join("\n\n")}` : ""),
			},
		],
		details: resolvedSkills.length ? { ...result, resolvedSkills } : result,
	};
}

const SKILL_API_CHANNEL = "pi-better-skills:request";

function deliverSkills(
	skills: ResolvedSkill[],
	events?: ExtensionAPI["events"]
): string[] {
	if (skills.length === 0) {
		return [];
	}
	let available = false;
	events?.emit(SKILL_API_CHANNEL, {
		version: 1,
		operation: "probe",
		reply: (reply: unknown) => {
			if (
				isReply(reply, "probe") &&
				reply.available === true &&
				Array.isArray(reply.versions) &&
				reply.versions.includes(1)
			) {
				available = true;
			}
		},
	});
	const delivered = new Set<string>();
	if (available) {
		events?.emit(SKILL_API_CHANNEL, {
			version: 1,
			operation: "deliver",
			names: skills.map(({ name }) => name),
			reply: (reply: unknown) => {
				if (!(isReply(reply, "deliver") && Array.isArray(reply.outcomes))) {
					return;
				}
				for (const outcome of reply.outcomes) {
					if (isDeliveredOutcome(outcome)) {
						delivered.add(outcome.name);
					}
				}
			},
		});
	}
	return skills.flatMap(({ name, path }) => {
		if (delivered.has(name)) {
			return [];
		}
		try {
			const body = stripFrontmatter(readFileSync(path, "utf-8")).trim();
			return [
				`<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`,
			];
		} catch {
			// A stale command path must not discard the submitted answers.
			return [];
		}
	});
}

function isDeliveredOutcome(value: unknown): value is { name: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		"name" in value &&
		typeof value.name === "string" &&
		"status" in value &&
		(value.status === "delivered" || value.status === "already-resident")
	);
}

function isReply(
	value: unknown,
	operation: string
): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 1 &&
		"operation" in value &&
		value.operation === operation
	);
}

type ToolTheme = ExtensionContext["ui"]["theme"];

/** What pi's tool render context says about the row. */
interface ToolRowState {
	isError: boolean;
	isPartial: boolean;
}

// pi pads tool rows by its outputPad setting. Hosts from before that setting pad by one
// column and pass no outputPad.
const LEGACY_OUTPUT_PAD = 1;

function outputPad(state: ToolRowState): number {
	return "outputPad" in state && typeof state.outputPad === "number"
		? state.outputPad
		: LEGACY_OUTPUT_PAD;
}

/**
 * A finished call's rows in the box that pi's default tool shell draws: the background of the
 * result's state, one blank row above the header and one below the result. A pending call has
 * no box. pi's HTML exporter renders every call as pending and puts it in its own status box,
 * so a pending background there would mark finished calls as running.
 */
function finishedRows(
	theme: ToolTheme,
	state: ToolRowState,
	...children: Array<Text | Spacer>
): Box {
	const token = state.isError ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(outputPad(state), 0, (text: string) =>
		theme.bg(token, text)
	);
	for (const child of children) {
		box.addChild(child);
	}
	return box;
}

/**
 * ask_user draws its own rows (`renderShell: "self"`): the call's `context` renders as a
 * message, then the header row.
 */
export function renderAskToolCall(
	args: unknown,
	theme: ToolTheme,
	state: ToolRowState
) {
	const params = args as AskParams;
	const pad = outputPad(state);
	const header = askToolCallText(params, theme);
	const headerRows = state.isPartial
		? new Text(header, pad, 0)
		: finishedRows(theme, state, new Spacer(1), new Text(header, 0, 0));
	const context =
		typeof params.context === "string" ? params.context.trim() : "";
	if (!context) {
		return headerRows;
	}
	const rows = new Container();
	rows.addChild(new Markdown(context, pad, 0, getMarkdownTheme()));
	rows.addChild(new Spacer(1));
	rows.addChild(headerRows);
	return rows;
}

/** The header text of an `ask_user` call: the question count and labels. */
export function askToolCallText(params: AskParams, theme: ToolTheme): string {
	const labels = Array.isArray(params.questions)
		? params.questions
				.map(
					(question: AskQuestionInput, index) =>
						question.label?.trim() || `Q${index + 1}`
				)
				.join(", ")
		: "";
	let text = theme.fg("toolTitle", theme.bold("ask_user "));
	text += theme.fg("muted", `${params.questions?.length ?? 0} question(s)`);
	if (labels) {
		text += theme.fg(
			"dim",
			` (${truncateToWidth(labels, UI_DIMENSIONS.callLabelTruncateWidth)})`
		);
	}
	return text;
}

interface AskToolResultView {
	content: Array<{ type?: string; text?: string }>;
	details?: AskResult;
}

/** The result rows continue the header rows: in the same box once the call has finished. */
export function renderAskToolResult(
	result: AskToolResultView,
	_options: unknown,
	theme: ToolTheme,
	state: ToolRowState
) {
	const text = askToolResultText(result, theme);
	return state.isPartial
		? new Text(text, outputPad(state), 0)
		: finishedRows(theme, state, new Text(text, 0, 0), new Spacer(1));
}

/** The transcript text of an `ask_user` result; pi's raw text when schema validation failed. */
export function askToolResultText(
	result: AskToolResultView,
	theme: ToolTheme
): string {
	const details = result.details;
	if (!(details && Array.isArray(details.questions))) {
		const text = result.content[0];
		return text?.type === "text" ? (text.text ?? "") : "";
	}
	const text = renderResultText(details);
	return details.error || details.cancelled ? theme.fg("warning", text) : text;
}

function errorResultDetails(
	params: AskParams,
	issues: AskValidationIssue[]
): AskResult {
	return {
		title: params.title,
		cancelled: true,
		cancelReason: "invalid_input",
		mode: "submit",
		questions: [],
		answers: {},
		error: {
			kind: "invalid_input",
			issues,
		},
	};
}

function formatValidationError(issues: AskValidationIssue[]): string {
	return [
		"Invalid ask_user payload:",
		...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
	].join("\n");
}

function formatNonInteractiveMessage(
	state: ReturnType<typeof createInitialState>
): string {
	const lines = [
		"Needs user input: ask_user requires interactive TUI mode.",
		"Run same tool call in interactive TUI mode, or ask user these questions manually:",
	];

	for (const [index, question] of state.questions.entries()) {
		lines.push(`${index + 1}. ${question.label}: ${question.prompt}`);
		for (const option of question.options) {
			lines.push(`   - ${option.label} [${option.value}]`);
		}
		lines.push("   - Type your own [custom]");
	}

	lines.push(
		"details.questions contains normalized pending questions. details.answers stays empty until user responds."
	);
	return lines.join("\n");
}
