import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { AskOptionSchema, AskParamsSchema } from "./schema.ts";

export const ASK_TOOL_PROMPT_SNIPPET =
	"Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding";

export const ASK_TOOL_DESCRIPTION =
	"Interactive clarification tool for cases where the next step depends on user preferences, missing requirements, or choosing between multiple valid directions. Ask only for the decisions needed now, collect normalized answers, and continue using those answers explicitly instead of guessing. When the user requests a specific decision, ask that question only; do not add other requirements or confirmation questions. The user reads your message text, then this form. The form shows only each question prompt with its option labels and descriptions, and it disappears after Submit. Write explanations as message text outside the tool call; your thinking and tool output are not a reply to the user.";
export const ASK_TOOL_PROMPT_GUIDELINES = [
	"Use `ask_user` before preference-sensitive decisions (scope, tone, UX, naming, architecture, docs, implementation direction), or when several valid directions exist; ask 1-3 concise questions instead of choosing one path yourself.",
	"Before every `ask_user` call, write the context as message text in the same turn: what you found, what the decision is and why it matters, your recommendation with its reason, any steps the user must take, and the answer to anything the user asked. Context that exists only in your thinking, tool arguments, tool output, or files does not count, and the form does not replace this text.",
	"If a submitted answer or note asks a question or asks for an explanation, answer it in message text first. If the user asks only for an explanation, or asks you not to use the form, answer in message text and do not call `ask_user`. If a choice is still needed, use another structured `ask_user` call, not plain-text choices in chat. When prior answers narrow the branch, bundle the next 2-3 related unresolved decisions into one follow-up when possible; ask one at a time only when the next question materially depends on the previous answer.",
] as const;
export const ASK_ELABORATION_INSTRUCTION =
	"First answer the user's note directly using the question and option context; re-ask only the affected question if a choice is still needed.";
export const ASK_RECOMMENDED_DESCRIPTION =
	"Optional. Set true on an option you recommend for a grounded reason; state the reason in `description`.";
const { value: _internalValue, ...toolOptionProperties } =
	AskOptionSchema.properties;
const toolOptionSchema = {
	...AskOptionSchema,
	required: ["label"],
	properties: {
		...toolOptionProperties,
		label: Type.String({
			description:
				"Required short visible option label shown in the list; a unique machine identifier is derived from this label.",
		}),
		recommended: Type.Optional(
			Type.Boolean({ description: ASK_RECOMMENDED_DESCRIPTION })
		),
	},
};
const toolQuestionSchema = {
	...AskParamsSchema.properties.questions.items,
	properties: {
		...AskParamsSchema.properties.questions.items.properties,
		options: {
			...AskParamsSchema.properties.questions.items.properties.options,
			items: toolOptionSchema,
		},
	},
};
export const AskToolParamsSchema = {
	...AskParamsSchema,
	properties: {
		...AskParamsSchema.properties,
		questions: {
			...AskParamsSchema.properties.questions,
			description: "Questions to ask in the interactive clarification flow",
			items: toolQuestionSchema,
		},
	},
};

const CONFIGURATION_DOC_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"docs",
	"configuration.md"
);
export const PI_ASK_CONFIG_PROMPT = `When the user asks to configure, customize, debug, or explain @fasalzein/pi-ask settings or keymaps, first read ${CONFIGURATION_DOC_PATH} and follow it as the source of truth before editing config files.`;
