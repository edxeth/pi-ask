import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyRemoteAskResponse,
	type RemoteAskAnswer,
	type RemoteAskFlowHandle,
	type RemoteAskResponse,
	type RemoteAskRuntime,
} from "./remote-ask.ts";
import { createInitialState } from "./state/create.ts";
import { toAskResult } from "./state/result.ts";
import type { AskParams, AskQuestion, AskResult, AskState } from "./types.ts";
import { withWaitingIndicator } from "./waiting-indicator.ts";

interface RpcAskOptions {
	onAnswerChange?: (state: AskState) => void;
	presentSingleAsMulti: boolean;
	remote?: RemoteAskRuntime;
	shutdownSignal?: AbortSignal;
	signal?: AbortSignal;
	toolCallId: string;
}

export function runRpcAskFlow(
	ctx: ExtensionContext,
	params: AskParams,
	options: RpcAskOptions
): Promise<AskResult> {
	return withWaitingIndicator(ctx, params.questions.length, (showTab) =>
		collectRpcAsk(ctx, params, options, showTab)
	);
}

async function collectRpcAsk(
	ctx: ExtensionContext,
	params: AskParams,
	options: RpcAskOptions,
	showTab: (index: number) => void
): Promise<AskResult> {
	let state = createInitialState(params, options);
	const dialogController = new AbortController();
	let finished = false;
	let settle!: (result: AskResult) => void;
	const ended = new Promise<AskResult>((resolve) => {
		settle = resolve;
	});
	let remoteFlow: RemoteAskFlowHandle | undefined;
	function finish(result: AskResult) {
		if (finished) {
			return;
		}
		finished = true;
		dialogController.abort();
		remoteFlow?.complete(result);
		settle(result);
	}
	function abort() {
		finish(cancelledResult(state, "aborted"));
	}
	function cancel() {
		finish(cancelledResult(state, "user"));
	}
	function submit(response: RemoteAskResponse) {
		const resolution = applyRemoteAskResponse(state, response);
		if (resolution.ok) {
			state = resolution.state;
			finish(toAskResult(state));
		}
		return resolution;
	}
	options.signal?.addEventListener("abort", abort, { once: true });
	options.shutdownSignal?.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal?.aborted || options.shutdownSignal?.aborted) {
			abort();
			return await ended;
		}
		remoteFlow = options.remote?.startFlow({
			source: "tool",
			toolCallId: options.toolCallId,
			title: state.title,
			questions: state.questions,
			onAbort: abort,
			onSubmit: submit,
		});
		// A bridge can submit as soon as started fires, even before the first dialog resolves.
		if (finished) {
			return await ended;
		}
		const answers = await collectAnswers(
			ctx,
			state.questions,
			showTab,
			dialogController.signal,
			ended,
			(currentAnswers) => {
				if (!finished) {
					reportPartialAnswers(state, currentAnswers, options);
				}
			}
		);
		if (finished) {
			return await ended;
		}
		if (!answers) {
			cancel();
			return await ended;
		}
		showTab(state.questions.length);
		const review = await waitForDialog(
			ctx.ui.select("Review answers", ["Submit", "Cancel"], {
				signal: dialogController.signal,
			}),
			ended
		);
		if (finished) {
			return await ended;
		}
		if (review !== "Submit") {
			cancel();
			return await ended;
		}
		submit({ kind: "answer", answers });
		return await ended;
	} finally {
		options.signal?.removeEventListener("abort", abort);
		options.shutdownSignal?.removeEventListener("abort", abort);
	}
}

function reportPartialAnswers(
	state: AskState,
	answers: Record<string, RemoteAskAnswer>,
	options: RpcAskOptions
) {
	const partial = applyRemoteAskResponse(state, { kind: "answer", answers });
	if (partial.ok) {
		options.onAnswerChange?.(partial.state);
	}
}

async function collectAnswers(
	ctx: ExtensionContext,
	questions: AskQuestion[],
	showTab: (index: number) => void,
	signal: AbortSignal,
	ended: Promise<AskResult>,
	onChange: (answers: Record<string, RemoteAskAnswer>) => void
): Promise<Record<string, RemoteAskAnswer> | undefined> {
	const answers: Record<string, RemoteAskAnswer> = {};
	for (const [index, question] of questions.entries()) {
		if (index > 0) {
			showTab(index);
		}
		const answer = await askQuestion(
			ctx,
			question,
			signal,
			ended,
			(partial) => {
				onChange({ ...answers, [question.id]: partial });
			}
		);
		if (!answer) {
			return;
		}
		answers[question.id] = answer;
		onChange(answers);
	}
	return answers;
}

function waitForDialog<T>(
	dialog: Promise<T>,
	ended: Promise<AskResult>
): Promise<T | undefined> {
	return Promise.race([dialog, ended.then(() => undefined)]);
}

async function askQuestion(
	ctx: ExtensionContext,
	question: AskQuestion,
	signal: AbortSignal,
	ended: Promise<AskResult>,
	onChange: (answer: RemoteAskAnswer) => void
): Promise<RemoteAskAnswer | undefined> {
	const optionLabels = question.options.map(
		(option, index) =>
			`${index + 1}. ${option.label}${option.preview ? `\n${option.preview}` : ""}`
	);
	const customLabel = "Type your own";
	const title = question.prompt;
	if (question.type !== "multi") {
		const chosen = await waitForDialog(
			ctx.ui.select(title, [...optionLabels, customLabel], { signal }),
			ended
		);
		if (chosen === undefined) {
			return;
		}
		if (chosen === customLabel) {
			const text = await waitForDialog(
				ctx.ui.input(`Type your own: ${question.label}`, "", { signal }),
				ended
			);
			return text === undefined ? undefined : { customText: text };
		}
		const index = optionLabels.indexOf(chosen);
		return index < 0 ? undefined : { values: [question.options[index].value] };
	}
	return askMultiQuestion(ctx, question, signal, ended, customLabel, onChange);
}

async function askMultiQuestion(
	ctx: ExtensionContext,
	question: AskQuestion,
	signal: AbortSignal,
	ended: Promise<AskResult>,
	customLabel: string,
	onChange: (answer: RemoteAskAnswer) => void
): Promise<RemoteAskAnswer | undefined> {
	const selected = new Set<string>();
	let customText: string | undefined;
	while (!signal.aborted) {
		const labels = question.options.map((option, index) =>
			checkboxLabel(option.label, index, selected.has(option.value))
		);
		const chosen = await waitForDialog(
			ctx.ui.select(question.prompt, [...labels, customLabel, "Done"], {
				signal,
			}),
			ended
		);
		if (chosen === undefined) {
			return;
		}
		if (chosen === "Done") {
			return { values: [...selected], customText };
		}
		if (chosen === customLabel) {
			const text = await waitForDialog(
				ctx.ui.input(`Type your own: ${question.label}`, "", { signal }),
				ended
			);
			if (text === undefined) {
				return;
			}
			customText = text;
			onChange({ values: [...selected], customText });
			continue;
		}
		const index = labels.indexOf(chosen);
		if (index < 0) {
			return;
		}
		const value = question.options[index].value;
		toggleValue(selected, value);
		onChange({ values: [...selected], customText });
	}
	return;
}

function checkboxLabel(label: string, index: number, checked: boolean): string {
	return `${checked ? "[✓]" : "[ ]"} ${index + 1}. ${label}`;
}

function toggleValue(selected: Set<string>, value: string): void {
	if (selected.has(value)) {
		selected.delete(value);
	} else {
		selected.add(value);
	}
}

function cancelledResult(
	state: AskState,
	reason: "user" | "aborted"
): AskResult {
	return {
		...toAskResult({ ...state, answers: {}, cancelled: true, completed: true }),
		cancelReason: reason,
	};
}
