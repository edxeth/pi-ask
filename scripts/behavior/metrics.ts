import type { Usage } from "@earendil-works/pi-ai";

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
	/** Tool results only: refusals, invalid payloads and schema failures open no form. */
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

const REFUSED = "missing_context";

/** An error result (refusal, invalid payload, schema failure) opened no form, so it is not user input. */
function isUserInput(entry: TranscriptEntry): boolean {
	return (
		entry.role === "user" ||
		(entry.role === "toolResult" &&
			entry.toolName === "ask_user" &&
			entry.isError !== true)
	);
}

/** "deferred": refused, then opened by pi-ask after the explanation turn (from the bridge trace). */
type AskOutcome = "opened" | "refused" | "invalid" | "deferred";

/** A form pi-ask opened after a refusal, keyed by the refused call; answered unless cancelled. */
export interface DeferredForm {
	answered: boolean;
}

function askOutcome(
	result: TranscriptEntry | undefined,
	deferred: DeferredForm | undefined
): AskOutcome {
	if (result?.cancelReason === REFUSED) {
		return deferred ? "deferred" : "refused";
	}
	return result?.isError === true ? "invalid" : "opened";
}

interface AskObservation {
	/** The form was answered, so the next user input is its answer. */
	answered: boolean;
	factInForm?: boolean;
	factInText?: boolean;
	/** User inputs seen before this call; the prompt is the first input. */
	inputIndex: number;
	outcome: AskOutcome;
	/** Questions of this call, as the form shows them. */
	questions: Array<{ label?: string; prompt?: string }>;
	/** Text the user read before the form opened; a deferred form opens after the explanation turn. */
	textBeforeForm: number;
	/** That text itself, to find questions that it repeats. */
	textBeforeFormValue: string;
	/** Assistant message text since the last user input, including the calling message. */
	textChars: number;
}

interface AskObservations {
	asks: AskObservation[];
	/** Assistant text characters written after each user input, by input index. */
	textAfterInput: number[];
}

function questionsOf(args: unknown): AskObservation["questions"] {
	const questions = (args as { questions?: unknown } | null)?.questions;
	return Array.isArray(questions) ? questions : [];
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
// A repeated question shares at least half of its word trigrams with the text.
const REPEATED_SHARE = 0.5;

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
	const grams = trigrams(words(question.prompt ?? ""));
	if (grams.size < 2) {
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

interface AskWindow {
	deferredForms: ReadonlyMap<string | undefined, DeferredForm>;
	fact: RegExp | undefined;
	inputIndex: number;
	results: ReadonlyMap<string | undefined, TranscriptEntry>;
	text: string;
}

function observeCall(
	call: NonNullable<TranscriptEntry["toolCalls"]>[number],
	window: AskWindow
): AskObservation {
	const deferred = window.deferredForms.get(call.id);
	const outcome = askOutcome(window.results.get(call.id), deferred);
	return {
		inputIndex: window.inputIndex,
		outcome,
		questions: questionsOf(call.args),
		answered:
			outcome === "opened" ||
			(outcome === "deferred" && Boolean(deferred?.answered)),
		textChars: window.text.trim().length,
		textBeforeForm: window.text.trim().length,
		textBeforeFormValue: window.text,
		...(window.fact
			? {
					factInText: window.fact.test(window.text),
					factInForm: window.fact.test(JSON.stringify(call.args ?? null)),
				}
			: {}),
	};
}

function observeAsks(
	transcript: readonly TranscriptEntry[],
	factPattern: string | undefined,
	deferredForms: ReadonlyMap<string | undefined, DeferredForm>
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
	const windowAfterInput: string[] = [""];
	let windowText = "";
	for (const entry of transcript) {
		if (isUserInput(entry)) {
			textAfterInput.push(0);
			windowAfterInput.push("");
			windowText = "";
			continue;
		}
		if (entry.role !== "assistant") {
			continue;
		}
		const inputIndex = textAfterInput.length - 1;
		windowText += `${entry.text}\n`;
		textAfterInput[inputIndex] += entry.text.trim().length;
		windowAfterInput[inputIndex] = windowText;
		const window = {
			deferredForms,
			fact,
			inputIndex,
			results,
			text: windowText,
		};
		asks.push(
			...(entry.toolCalls ?? [])
				.filter((call) => call.name === "ask_user")
				.map((call) => observeCall(call, window))
		);
	}
	// A deferred form opened after the explanation turn: the user read the whole window's text.
	for (const ask of asks) {
		if (ask.outcome === "deferred") {
			ask.textBeforeForm = textAfterInput[ask.inputIndex] ?? 0;
			ask.textBeforeFormValue = windowAfterInput[ask.inputIndex] ?? "";
		}
	}
	return { asks, textAfterInput };
}

const isOpened = (ask: AskObservation) =>
	ask.outcome === "opened" || ask.outcome === "deferred";

function followUpAfterFirstAnswer(observed: AskObservations) {
	const firstOpened = observed.asks.find(
		(ask) => isOpened(ask) && ask.answered
	);
	if (!firstOpened) {
		return null;
	}
	const answerInput = firstOpened.inputIndex + 1;
	const later = observed.asks.filter((ask) => ask.inputIndex === answerInput);
	const laterOpened = later.filter(isOpened);
	return {
		textChars: observed.textAfterInput[answerInput] ?? 0,
		askCalls: later.length,
		openedAsks: laterOpened.length,
		firstCallHadText: later[0] ? later[0].textChars > 0 : null,
		firstOpenedHadText: laterOpened[0]
			? laterOpened[0].textBeforeForm > 0
			: null,
	};
}

/** After each refusal: did the next assistant message explain in text and end the turn, or call a tool again? */
function refusalFollowUps(transcript: readonly TranscriptEntry[]) {
	let explainedThenEnded = 0;
	let calledAgain = 0;
	transcript.forEach((entry, index) => {
		if (entry.role !== "toolResult" || entry.cancelReason !== REFUSED) {
			return;
		}
		const next = transcript
			.slice(index + 1)
			.find((later) => later.role === "assistant");
		if ((next?.toolCalls ?? []).length > 0) {
			calledAgain++;
		} else if (next?.text.trim()) {
			explainedThenEnded++;
		}
	});
	return { explainedThenEnded, calledAgain };
}

/**
 * Whether the user could read an explanation before each ask_user form.
 * Text counts when any assistant message since the last user input has a text block.
 */
export function askContextMetrics(
	transcript: readonly TranscriptEntry[],
	factPattern?: string,
	deferredForms: ReadonlyMap<string | undefined, DeferredForm> = new Map()
) {
	const observed = observeAsks(transcript, factPattern, deferredForms);
	const { asks } = observed;
	const opened = asks.filter(isOpened);
	const first = asks[0];
	return {
		askCalls: asks.length,
		openedAsks: opened.length,
		refusedAsks: asks.filter(
			(ask) => ask.outcome === "refused" || ask.outcome === "deferred"
		).length,
		invalidAsks: asks.filter((ask) => ask.outcome === "invalid").length,
		asksWithoutText: asks.filter((ask) => ask.textChars === 0).length,
		openedWithoutText: opened.filter((ask) => ask.textBeforeForm === 0).length,
		// Questions of opened forms, and those the text before the form already asked.
		formQuestions: opened.reduce((sum, ask) => sum + ask.questions.length, 0),
		repeatedQuestions: opened.reduce(
			(sum, ask) =>
				sum +
				ask.questions.filter((question) =>
					isRepeated(question, ask.textBeforeFormValue)
				).length,
			0
		),
		firstAsk: first
			? {
					textChars: first.textChars,
					factInText: first.factInText,
					factInForm: first.factInForm,
				}
			: null,
		afterFirstAnswer: followUpAfterFirstAnswer(observed),
		afterRefusal: refusalFollowUps(transcript),
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
