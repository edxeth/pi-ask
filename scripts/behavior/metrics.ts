import type { Usage } from "@earendil-works/pi-ai";
import { prepareAskParams } from "../../src/state/normalize.ts";

type BilledTokens = Pick<
	Usage,
	"input" | "output" | "cacheRead" | "cacheWrite"
>;
interface UsageEvent {
	message?: { role: string; usage?: Partial<BilledTokens> };
	type: string;
}

const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isBilledTokens(
	usage: Partial<BilledTokens> | undefined
): usage is BilledTokens {
	return Boolean(
		usage &&
			fields.every(
				(field) =>
					typeof usage[field] === "number" && Number.isFinite(usage[field])
			)
	);
}
const positiveAssumption =
	/\b(?:I (?:will )?assume|I'll assume|assuming (?:that|the))\b|\bassumption:/i;
const stoppedPattern =
	/\b(can(?:not|'t) proceed|need (?:your|the owner's|user) (?:decision|input|choice)|await(?:ing)? (?:your|the owner's|user) (?:decision|input|choice)|blocked|must (?:choose|decide)|before (?:I can|we can) (?:plan|proceed))\b/i;

/** Heuristic text labels; the raw assistant response remains the source of truth. */
export function headlessTextMetrics(text: string) {
	return {
		statedAssumption: positiveAssumption.test(text),
		stoppedForDecision: stoppedPattern.test(text),
	};
}

/** Read finalized assistant messages only. Updates and tool results are not separate requests. */
export function tokenUsage(events: readonly UsageEvent[]) {
	const total: BilledTokens = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	let firstRequest: BilledTokens | null = null;
	let requestCount = 0;
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") {
			continue;
		}
		const usage = event.message.usage;
		if (!isBilledTokens(usage)) {
			throw new Error("Assistant message has missing or invalid usage");
		}
		const billed = {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
		};
		firstRequest ??= billed;
		requestCount++;
		for (const field of fields) {
			total[field] += billed[field];
		}
	}
	if (!firstRequest) {
		throw new Error("No completed assistant request with usage");
	}
	return { requestCount, firstRequest, total };
}

interface ContentPart {
	arguments?: unknown;
	id?: string;
	name?: string;
	text?: string;
	type: string;
}

interface TranscriptEvent {
	message?: {
		content?: string | readonly ContentPart[];
		details?: { cancelReason?: string };
		isError?: boolean;
		role: string;
		toolCallId?: string;
		toolName?: string;
		usage?: { cost?: { total?: number } };
	};
	type: string;
}

/** One finalized message, reduced to what the user saw and what the model sent. */
export interface TranscriptEntry {
	blocks?: string[];
	cancelReason?: string;
	/** Tool results only: invalid payloads and schema failures open no form. */
	isError?: boolean;
	role: "assistant" | "toolResult" | "user";
	text: string;
	toolCallId?: string;
	toolCalls?: Array<{ args: unknown; id?: string; name?: string }>;
	toolName?: string;
}

function contentParts(
	content: string | readonly ContentPart[] | undefined
): readonly ContentPart[] {
	return typeof content === "string"
		? [{ type: "text", text: content }]
		: (content ?? []);
}

function toTranscriptEntry(
	message: NonNullable<TranscriptEvent["message"]>
): TranscriptEntry | undefined {
	const parts = contentParts(message.content);
	const text = parts
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	if (message.role === "assistant") {
		return {
			role: "assistant",
			text,
			blocks: parts.map((part) => part.type),
			toolCalls: parts
				.filter((part) => part.type === "toolCall")
				.map((part) => ({
					id: part.id,
					name: part.name,
					args: part.arguments,
				})),
		};
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			text,
			toolName: message.toolName,
			toolCallId: message.toolCallId,
			cancelReason: message.details?.cancelReason,
			isError: message.isError === true,
		};
	}
	return message.role === "user" ? { role: "user", text } : undefined;
}

/** Finalized messages in order; streaming updates are not separate messages. */
export function transcriptFromEvents(
	events: readonly TranscriptEvent[]
): TranscriptEntry[] {
	return events.flatMap((event) => {
		if (event.type !== "message_end" || !event.message) {
			return [];
		}
		const entry = toTranscriptEntry(event.message);
		return entry ? [entry] : [];
	});
}

/** Sum of pi's per-request cost; requests without cost data add nothing. */
export function costTotal(events: readonly TranscriptEvent[]): number {
	return events.reduce(
		(sum, event) =>
			event.type === "message_end" && event.message?.role === "assistant"
				? sum + (event.message.usage?.cost?.total ?? 0)
				: sum,
		0
	);
}

/** An error result (invalid payload, schema failure) opened no form, so it is not user input. */
function isUserInput(entry: TranscriptEntry): boolean {
	return (
		entry.role === "user" ||
		(entry.role === "toolResult" &&
			entry.toolName === "ask_user" &&
			entry.isError !== true)
	);
}

type AskOutcome = "opened" | "invalid";

interface AskObservation {
	/** The call's own `context` argument, which the chat shows above the form. */
	context: string;
	factInContext?: boolean;
	/** The fact appears in the text that the form shows; `context` is not part of the form. */
	factInForm?: boolean;
	factInText?: boolean;
	/** User inputs seen before this call; the prompt is the first input. */
	inputIndex: number;
	outcome: AskOutcome;
	/** Questions of this call, as the form shows them. */
	questions: Array<{ label?: string; prompt?: string }>;
	/** Assistant message text since the last user input, including the calling message. */
	text: string;
}

interface AskObservations {
	asks: AskObservation[];
	/** Assistant text characters written after each user input, by input index. */
	textAfterInput: number[];
}

/** The questions as the form shows them: an omitted or blank label becomes Q1, Q2, … */
function questionsOf(args: unknown): AskObservation["questions"] {
	const questions = (args as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(questions)) {
		return [];
	}
	return questions.map(
		(question: { label?: unknown; prompt?: unknown }, index) => ({
			label:
				typeof question?.label === "string" && question.label.trim()
					? question.label
					: `Q${index + 1}`,
			prompt:
				typeof question?.prompt === "string" ? question.prompt : undefined,
		})
	);
}

function contextOf(args: unknown): string {
	const context = (args as { context?: unknown } | null)?.context;
	return typeof context === "string" ? context : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * The text that the form shows for a call: the title, each question's tab label and prompt, and
 * each option's label and description, with option previews only in a preview question. Ids and
 * option values stay hidden. The arguments are prepared as the tool prepares them, so derived
 * labels and preview types count.
 */
function formTextOf(args: unknown): string {
	const form = prepareAskParams(args);
	if (!isRecord(form)) {
		return "";
	}
	const questions = Array.isArray(form.questions) ? form.questions : [];
	return [form.title, ...questions.flatMap(questionTexts)]
		.filter((text) => typeof text === "string")
		.join("\n");
}

function questionTexts(question: unknown): unknown[] {
	if (!isRecord(question)) {
		return [];
	}
	const options = Array.isArray(question.options) ? question.options : [];
	return [
		question.label,
		question.prompt,
		...options.flatMap((option) =>
			isRecord(option)
				? [
						option.label,
						option.description,
						question.type === "preview" ? option.preview : undefined,
					]
				: []
		),
	];
}

function words(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function trigrams(list: readonly string[]): Set<string> {
	const grams = new Set<string>();
	for (let index = 0; index + 2 < list.length; index++) {
		grams.add(`${list[index]} ${list[index + 1]} ${list[index + 2]}`);
	}
	return grams;
}

const QUESTION_NUMBER = /\bQ(\d+)\b/;
const PARAGRAPH = /\n\s*\n/;
// Text repeats a passage when it holds at least half of the passage's word trigrams.
const REPEATED_SHARE = 0.5;

/** Whether `text` holds most of `passage`'s wording; a passage under three words has no trigrams. */
function holdsMostOf(text: string, passage: string): boolean {
	const grams = trigrams(words(passage));
	if (grams.size === 0) {
		return false;
	}
	const textGrams = trigrams(words(text));
	let shared = 0;
	for (const gram of grams) {
		if (textGrams.has(gram)) {
			shared++;
		}
	}
	return shared / grams.size >= REPEATED_SHARE;
}

/** The text asks the question again: a paragraph that starts with its number, or most of its wording. */
function isRepeated(
	question: AskObservation["questions"][number],
	text: string
): boolean {
	const number = `${question.label ?? ""} ${question.prompt ?? ""}`.match(
		QUESTION_NUMBER
	);
	const heading = number ? new RegExp(`^\\W*Q${number[1]}\\b`) : undefined;
	if (heading && text.split(PARAGRAPH).some((part) => heading.test(part))) {
		return true;
	}
	// A prompt under three words has no trigrams; only its number can show a repeat.
	return holdsMostOf(text, question.prompt ?? "");
}

/** What the user read in the chat before the form: the message text, then the call's context. */
function explanationOf(ask: AskObservation): string {
	return `${ask.text}\n\n${ask.context}`;
}

interface AskWindow {
	fact: RegExp | undefined;
	inputIndex: number;
	results: ReadonlyMap<string | undefined, TranscriptEntry>;
	text: string;
}

function observeCall(
	call: NonNullable<TranscriptEntry["toolCalls"]>[number],
	window: AskWindow
): AskObservation {
	const context = contextOf(call.args);
	return {
		inputIndex: window.inputIndex,
		outcome:
			window.results.get(call.id)?.isError === true ? "invalid" : "opened",
		questions: questionsOf(call.args),
		text: window.text,
		context,
		...(window.fact
			? {
					factInText: window.fact.test(window.text),
					factInContext: window.fact.test(context),
					factInForm: window.fact.test(formTextOf(call.args)),
				}
			: {}),
	};
}

function observeAsks(
	transcript: readonly TranscriptEntry[],
	factPattern: string | undefined
): AskObservations {
	const fact = factPattern ? new RegExp(factPattern, "i") : undefined;
	const results = new Map(
		transcript
			.filter(
				(entry) => entry.role === "toolResult" && entry.toolName === "ask_user"
			)
			.map((entry) => [entry.toolCallId, entry] as const)
	);
	const asks: AskObservation[] = [];
	const textAfterInput: number[] = [0];
	let windowText = "";
	for (const entry of transcript) {
		if (isUserInput(entry)) {
			textAfterInput.push(0);
			windowText = "";
			continue;
		}
		if (entry.role !== "assistant") {
			continue;
		}
		const inputIndex = textAfterInput.length - 1;
		windowText += `${entry.text}\n`;
		textAfterInput[inputIndex] += entry.text.trim().length;
		const window = { fact, inputIndex, results, text: windowText };
		asks.push(
			...(entry.toolCalls ?? [])
				.filter((call) => call.name === "ask_user")
				.map((call) => observeCall(call, window))
		);
	}
	return { asks, textAfterInput };
}

const isOpened = (ask: AskObservation) => ask.outcome === "opened";
const textChars = (ask: AskObservation) => ask.text.trim().length;
const contextChars = (ask: AskObservation) => ask.context.trim().length;

function followUpAfterFirstAnswer(observed: AskObservations) {
	const firstOpened = observed.asks.find(isOpened);
	if (!firstOpened) {
		return null;
	}
	const answerInput = firstOpened.inputIndex + 1;
	const later = observed.asks.filter((ask) => ask.inputIndex === answerInput);
	const laterOpened = later.filter(isOpened);
	return {
		textChars: observed.textAfterInput[answerInput] ?? 0,
		contextChars: laterOpened.reduce((sum, ask) => sum + contextChars(ask), 0),
		askCalls: later.length,
		openedAsks: laterOpened.length,
	};
}

/**
 * Whether the user could read an explanation before each ask_user form: the message text
 * since the last user input, and the call's `context`, which the chat shows above the form.
 */
export function askContextMetrics(
	transcript: readonly TranscriptEntry[],
	factPattern?: string
) {
	const observed = observeAsks(transcript, factPattern);
	const { asks } = observed;
	const opened = asks.filter(isOpened);
	const first = asks[0];
	return {
		askCalls: asks.length,
		openedAsks: opened.length,
		invalidAsks: asks.filter((ask) => ask.outcome === "invalid").length,
		asksWithoutContext: asks.filter((ask) => contextChars(ask) === 0).length,
		openedWithoutExplanation: opened.filter(
			(ask) => textChars(ask) === 0 && contextChars(ask) === 0
		).length,
		// Forms whose context mostly repeats the message text before it: the explanation written twice.
		explainedTwice: opened.filter((ask) => holdsMostOf(ask.text, ask.context))
			.length,
		// Questions of opened forms, and those that the explanation before the form already asked.
		formQuestions: opened.reduce((sum, ask) => sum + ask.questions.length, 0),
		repeatedQuestions: opened.reduce(
			(sum, ask) =>
				sum +
				ask.questions.filter((question) =>
					isRepeated(question, explanationOf(ask))
				).length,
			0
		),
		firstAsk: first
			? {
					textChars: textChars(first),
					contextChars: contextChars(first),
					factInText: first.factInText,
					factInContext: first.factInContext,
					factInForm: first.factInForm,
				}
			: null,
		afterFirstAnswer: followUpAfterFirstAnswer(observed),
	};
}

interface AskCall {
	args?: { questions?: readonly unknown[] };
}

/** A plan is counted only when assistant text explicitly passes the plan marker. */
export function interviewMetrics(
	asks: readonly AskCall[],
	startedAt: number,
	endedAt: number,
	planned: boolean
) {
	return {
		askCalls: asks.length,
		questionCount: asks.reduce(
			(sum, ask) => sum + (ask.args?.questions?.length ?? 0),
			0
		),
		followUpBundled: asks
			.slice(1)
			.some((ask) => (ask.args?.questions?.length ?? 0) >= 2),
		elapsedBeforePlanMs: planned ? endedAt - startedAt : null,
		runaway: asks.length > 5,
	};
}
