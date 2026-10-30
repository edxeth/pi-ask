import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
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

/** The form stays closed: the user has read nothing since their last input. */
export function missingContextResponse(
	params: AskParams,
	blockTypes: readonly string[]
) {
	return {
		content: [
			{ type: "text" as const, text: formatMissingContext(blockTypes) },
		],
		details: {
			...toAskResult(createInitialState(params)),
			cancelled: true,
			cancelReason: "missing_context" as const,
		},
		isError: true,
	};
}

function formatMissingContext(blockTypes: readonly string[]): string {
	return `ask_user did not open. Since the user's last input your messages contained only [${blockTypes.join(", ")}] blocks and no text, so the user has not read any explanation. Thinking, tool arguments and tool output are not shown as a reply. Reply now with the explanation as text: what you found, what the decision is and why it matters, your recommendation with its reason, and the answer to anything the user asked. Then end your turn without calling any tool. pi-ask opens this form for the user right after your reply, so do not mention that it did not open, and do not repeat its choices as a plain-text list.`;
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

export function renderAskToolCall(args: unknown, theme: ToolTheme) {
	const params = args as AskParams;
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
	return new Text(text, 0, 0);
}

export function renderAskToolResult(
	result: {
		content: Array<{ type?: string; text?: string }>;
		details?: AskResult;
	},
	_options: unknown,
	theme: ToolTheme
) {
	const details = result.details;
	if (!(details && Array.isArray(details.questions))) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
	}
	const text = renderResultText(details);
	return new Text(
		details.error || details.cancelled ? theme.fg("warning", text) : text,
		0,
		0
	);
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
