import {
	type ExtensionAPI,
	type ExtensionContext,
	getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Editor,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { AskConfig } from "../config/schema.ts";
import { getAskConfigStore } from "../config/store.ts";
import {
	createQuestionWaitingNotification,
	notifyQuestionWaiting,
} from "../notifications.ts";
import {
	applyRemoteAskResponse,
	type RemoteAskFlowHandle,
	type RemoteAskResponse,
	type RemoteAskRuntime,
	type RemoteAskSource,
	type RemoteAskSubmitResolution,
} from "../remote-ask.ts";
import type { SkillCommands } from "../skill-references.ts";
import { createInitialState } from "../state/create.ts";
import {
	getEditorDraft,
	saveEditorDraft,
	submitEditorDraft,
	syncStateToSelection,
} from "../state/editor.ts";
import { cycleCurrentQuestionType } from "../state/question-type.ts";
import { toAskResult } from "../state/result.ts";
import {
	getCurrentOption,
	getCurrentQuestion,
	isSubmitTab,
} from "../state/selectors.ts";
import {
	applyNumberShortcut,
	cancelFlow,
	confirmCurrentSelection,
	dismissFlow,
	enterOptionNoteMode,
	enterQuestionNoteMode,
	moveOption,
	moveTab,
	toggleCurrentMultiOption,
} from "../state/transitions.ts";
import { isEditingView } from "../state/view.ts";
import type { AskParams, AskResult, AskState } from "../types.ts";
import { withWaitingIndicator } from "../waiting-indicator.ts";
import { maybeAutoSubmitState } from "./auto-submit.ts";
import { createAskAutocompleteProvider } from "./autocomplete.ts";
import {
	loadNativeClipboard,
	type PasteClipboard,
	pasteFromClipboard,
} from "./clipboard-paste.ts";
import {
	DIRTY_DISMISS_NOTICE,
	shouldConfirmDirtyDismiss,
	shouldDiscardAfterConfirmation,
} from "./dismiss-guard.ts";
import type { AskInputCommand } from "./input.ts";
import { getInputCommand } from "./input.ts";
import { type AskViewport, renderAskScreen } from "./render.ts";
import {
	getReviewShortcutHint,
	resolveReviewShortcutDoublePress,
} from "./review-shortcuts.ts";
import { showAskSettings } from "./show-settings.ts";
import { SkillReferenceEditor } from "./skill-reference-editor.ts";

type CustomCallback = Parameters<ExtensionContext["ui"]["custom"]>[0];
type CustomCallbackArgs = CustomCallback extends (...args: infer T) => unknown
	? T
	: never;
type Tui = CustomCallbackArgs[0];
type Theme = CustomCallbackArgs[1];
type Keybindings = CustomCallbackArgs[2];
type Done = (result: AskResult) => void;
interface AskFlowOptions {
	allowFreeform?: boolean;
	exec: ExtensionAPI["exec"];
	getCommands?: () => SkillCommands;
	loadClipboard?: () => Promise<PasteClipboard | undefined>;
	onAnswerChange?: (state: AskState) => void;
	onTabChange?: (index: number) => void;
	presentSingleAsMulti?: boolean;
	remote?: {
		runtime: RemoteAskRuntime;
		source: RemoteAskSource;
		toolCallId?: string;
	};
	shutdownSignal?: AbortSignal;
	signal?: AbortSignal;
}

type AskFlowParams = AskParams &
	Pick<ExtensionContext, "cwd"> & {
		config: AskConfig;
		configNotice?: string;
		ctx: ExtensionContext;
		flowOptions: AskFlowOptions;
	};

interface AskFlowController {
	component?: Component;
	config: AskConfig;
	configNotice?: string;
	ctx: ExtensionContext;
	dismissNotice?: string;
	done: Done;
	editor: Editor;
	finished: boolean;
	flowOptions: AskFlowOptions;
	keybindings: Keybindings;
	pendingQuestionTypeChangeQuestionId?: string;
	pendingReviewShortcutActionIndex?: number;
	previewScrollTop: number;
	remoteFlow?: RemoteAskFlowHandle;
	removeAbortListeners: () => void;
	settingsOpen: boolean;
	state: AskState;
	suppressAutoInputForSelection: boolean;
	theme: Theme;
	tui: Tui;
	unsubscribeConfig: () => void;
	viewport: AskViewport;
}

export async function runAskFlow(
	ctx: ExtensionContext,
	params: AskParams,
	options: AskFlowOptions
): Promise<AskResult> {
	const store = getAskConfigStore();
	const { config, notice } = await store.ensureLoaded();
	const flowOptions = {
		...options,
		presentSingleAsMulti:
			options.presentSingleAsMulti ?? config.behaviour.presentSingleAsMulti,
	};
	if (flowOptions.signal?.aborted || flowOptions.shutdownSignal?.aborted) {
		return abortedResult(createInitialState(params, flowOptions));
	}
	if (ctx.mode !== "tui") {
		return {
			...toAskResult(createInitialState(params, flowOptions)),
			cancelled: true,
			cancelReason: "ui_unavailable",
		};
	}
	return withWaitingIndicator(ctx, params.questions.length, (onTabChange) =>
		ctx.ui.custom<AskResult>((...args) =>
			createAskFlowController(args, {
				...params,
				config,
				configNotice: notice?.text,
				cwd: ctx.cwd,
				ctx,
				flowOptions: { ...flowOptions, onTabChange },
			})
		)
	);
}

function createAskFlowController(
	[tui, theme, keybindings, done]: [
		Tui,
		Theme,
		Keybindings,
		(result: AskResult) => void,
	],
	params: AskFlowParams
) {
	const controller: AskFlowController = {
		config: params.config,
		configNotice: params.configNotice,
		ctx: params.ctx,
		flowOptions: params.flowOptions,
		dismissNotice: undefined,
		done,
		editor: createEditor(
			tui,
			theme,
			params.cwd,
			params.flowOptions.getCommands?.() ?? []
		),
		settingsOpen: false,
		finished: false,
		keybindings,
		previewScrollTop: 0,
		viewport: createAskViewport(tui.terminal?.rows ?? 24),
		removeAbortListeners: () => {
			// Replaced after the controller attaches abort listeners.
		},
		state: createInitialState(params, params.flowOptions),
		suppressAutoInputForSelection: false,
		pendingQuestionTypeChangeQuestionId: undefined,
		pendingReviewShortcutActionIndex: undefined,
		theme,
		tui,
		unsubscribeConfig: () => {
			// replaced immediately after controller creation
		},
	};

	controller.unsubscribeConfig = getAskConfigStore().subscribe((config) => {
		controller.config = config;
		controller.configNotice = undefined;
		controller.state = maybeAutoSubmitState(
			controller.state,
			controller.config
		);
		refresh(controller);
		maybeFinish(controller);
	});

	controller.editor.onSubmit = (value) => submitEditor(controller, value);
	controller.remoteFlow = startRemoteFlow(controller, params);
	const onAbort = () => finish(controller, abortedResult(controller.state));
	params.flowOptions.signal?.addEventListener("abort", onAbort, { once: true });
	params.flowOptions.shutdownSignal?.addEventListener("abort", onAbort, {
		once: true,
	});
	controller.removeAbortListeners = () => {
		params.flowOptions.signal?.removeEventListener("abort", onAbort);
		params.flowOptions.shutdownSignal?.removeEventListener("abort", onAbort);
	};
	if (
		params.flowOptions.signal?.aborted ||
		params.flowOptions.shutdownSignal?.aborted
	) {
		onAbort();
	}
	syncSelection(controller);
	if (!controller.finished) {
		notifyCurrentQuestion(controller).catch(() => {
			// Notification failures are best-effort and must not affect the ask flow.
		});
	}

	const component = {
		get focused() {
			return controller.editor.focused;
		},
		set focused(value: boolean) {
			controller.editor.focused = value;
		},
		render: (width: number) => renderController(controller, width),
		invalidate() {
			controller.editor.invalidate();
		},
		handleInput(data: string) {
			handleControllerInput(controller, data);
		},
		handleMouse(event: TuiMouseEvent) {
			return handleWheel(controller, event);
		},
		dispose() {
			controller.removeAbortListeners();
			controller.remoteFlow?.dispose();
			controller.unsubscribeConfig();
		},
	};
	controller.component = component;
	return component;
}

function createAskViewport(rows: number): AskViewport {
	return {
		rows,
		scrollTop: 0,
		optionStarts: [],
		bodyRows: 0,
		reviewScrollTop: 0,
		reviewPageRows: 0,
	};
}

// pi-tui's fullscreen viewport consumes these actions before a non-overlay
// component sees the key (TuiAltScreen.handleViewportInput). Search
// navigation keys apply only while search is open, so they are not listed.
const FULLSCREEN_TRANSCRIPT_ACTIONS = [
	"tui.altScreen.search",
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
] as const;

function getTranscriptKeys(
	controller: AskFlowController
): ReadonlySet<string> | undefined {
	if (controller.tui.mode !== "fullscreen") {
		return;
	}
	return new Set(
		FULLSCREEN_TRANSCRIPT_ACTIONS.flatMap((action) =>
			controller.keybindings.getKeys(action)
		).map((key) => key.toLowerCase())
	);
}

function renderController(
	controller: AskFlowController,
	width: number
): string[] {
	controller.viewport.rows = availableAskRows(controller, width);
	return renderAskScreen({
		viewport: controller.viewport,
		previewScrollTop: controller.previewScrollTop,
		onPreviewScrollTop: (top) => {
			controller.previewScrollTop = top;
		},
		config: controller.config,
		editor: controller.editor,
		transcriptKeys: getTranscriptKeys(controller),
		footerNotice: getFooterNotice(controller),
		reviewShortcutHint: getActiveReviewShortcutHint(controller),
		state: controller.state,
		theme: controller.theme,
		width,
	});
}

function availableAskRows(
	controller: AskFlowController,
	width: number
): number {
	const terminalRows = controller.tui.terminal?.rows ?? 24;
	// Pi mounts the ask in its editor container. In fullscreen the dock also
	// contains status, widgets, and footer; all consume rows outside this form.
	const siblings = controller.tui.children;
	const component = controller.component;
	if (!component) {
		return terminalRows;
	}
	const editorIndex = siblings?.findIndex(
		(child) => child instanceof Container && child.children.includes(component)
	);
	if (editorIndex === undefined || editorIndex < 1) {
		return terminalRows;
	}
	const dockRows = siblings
		.slice(1)
		.reduce(
			(sum, child, index) =>
				sum + (index + 1 === editorIndex ? 0 : child.render(width).length),
			0
		);
	return Math.max(1, terminalRows - dockRows);
}

function handleWheel(
	controller: AskFlowController,
	event: TuiMouseEvent
): { handled: true } | undefined {
	if (controller.finished || event.type !== "wheel" || !event.wheelDelta) {
		return;
	}
	const target = getWheelTarget(controller, event);
	if (!target) {
		return;
	}
	const next = Math.max(
		0,
		Math.min(target.maxTop, target.top + event.wheelDelta)
	);
	if (next === target.top) {
		return;
	}
	target.set(next);
	controller.viewport.followFocus = false;
	refresh(controller);
	return { handled: true };
}

function getWheelTarget(
	controller: AskFlowController,
	event: TuiMouseEvent
):
	| {
			top: number;
			maxTop: number;
			set: (top: number) => void;
	  }
	| undefined {
	const { mouseList, mousePreview, mouseReview } = controller.viewport;
	const within = (region: { start: number; end: number }) =>
		event.y >= region.start && event.y < region.end;
	if (
		mousePreview &&
		mouseList &&
		within(mouseList) &&
		within(mousePreview) &&
		event.x >= mousePreview.x
	) {
		return {
			top: controller.previewScrollTop,
			maxTop: mousePreview.maxTop,
			set: (top) => {
				controller.previewScrollTop = top;
			},
		};
	}
	if (mouseReview && within(mouseReview)) {
		return {
			top: controller.viewport.reviewScrollTop,
			maxTop: mouseReview.maxTop,
			set: (top) => {
				controller.viewport.reviewScrollTop = top;
			},
		};
	}
	if (mouseList && within(mouseList)) {
		return {
			top: controller.viewport.scrollTop,
			maxTop: mouseList.maxTop,
			set: (top) => {
				controller.viewport.scrollTop = top;
			},
		};
	}
	return;
}

function handleControllerInput(controller: AskFlowController, data: string) {
	controller.viewport.followFocus = true;
	controller.editor.disableSubmit = !isNativeEditorSubmitEnabled(controller);
	let command = getInputCommand(
		controller.state,
		controller.config,
		data,
		isEditingView(controller.state) ? controller.editor.getText() : ""
	);
	// Ask bindings win over pi aliases. In particular, Ctrl+C must dismiss, not cancel.
	if (
		command.kind === "ignore" &&
		typeof controller.keybindings.matches === "function"
	) {
		for (const [binding, alias] of [
			["tui.select.up", { kind: "moveOption", delta: -1 }],
			["tui.select.down", { kind: "moveOption", delta: 1 }],
			["tui.select.confirm", { kind: "confirm" }],
		] as const) {
			if (controller.keybindings.matches(data, binding)) {
				command = alias;
				break;
			}
		}
	}
	if (isEditingView(controller.state)) {
		handleEditingCommand(controller, command, data);
		return;
	}
	handleNavigationCommand(controller, command);
}

function isNativeEditorSubmitEnabled(controller: AskFlowController): boolean {
	if (controller.state.view.kind === "input") {
		return controller.config.keymaps.editor.submit.includes("enter");
	}
	if (controller.state.view.kind === "note") {
		return controller.config.keymaps.noteEditor.save.includes("enter");
	}
	return true;
}

function handleEditingCommand(
	controller: AskFlowController,
	command: AskInputCommand,
	data: string
) {
	if (command.kind === "dismiss") {
		handleExitFlow(controller, dismissFlow(controller.state));
		return;
	}
	if (command.kind === "showSettings") {
		showSettingsModal(controller);
		return;
	}
	if (command.kind === "editMoveTab") {
		commitSavedEditorNavigation(controller, moveTab, command.delta);
		return;
	}
	if (command.kind === "editMoveOption") {
		commitSavedEditorNavigation(controller, moveOption, command.delta);
		return;
	}
	if (command.kind === "editClose") {
		closeEditor(controller);
		return;
	}
	if (command.kind === "editSubmit") {
		submitEditor(controller, controller.editor.getText());
		return;
	}
	if (command.kind === "delegateToEditor") {
		if (isPasteImageKey(controller, data)) {
			pasteIntoEditor(controller);
			return;
		}
		controller.editor.handleInput(data);
		refresh(controller);
	}
}

// pi binds Ctrl+V (Alt+V on Windows) as app.clipboard.pasteImage only in its
// own main editor. The ask editor receives the raw key, so handle it here with
// the user's pi keybinding.
function isPasteImageKey(controller: AskFlowController, data: string) {
	return (
		typeof controller.keybindings.matches === "function" &&
		controller.keybindings.matches(data, "app.clipboard.pasteImage")
	);
}

function pasteIntoEditor(controller: AskFlowController) {
	const loadClipboard =
		controller.flowOptions.loadClipboard ?? loadNativeClipboard;
	// The clipboard read is async; skip the insert if the editor closed meanwhile.
	const target = {
		insertTextAtCursor(text: string) {
			if (controller.finished || !isEditingView(controller.state)) {
				return;
			}
			controller.editor.insertTextAtCursor(text);
			refresh(controller);
		},
	};
	loadClipboard()
		.then((clipboard) => pasteFromClipboard(target, clipboard))
		.catch(() => {
			// A missing or broken clipboard helper leaves the editor unchanged.
		});
}

function handleNavigationCommand(
	controller: AskFlowController,
	command: AskInputCommand
) {
	switch (command.kind) {
		case "moveTab":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			commitState(controller, moveTab(controller.state, command.delta));
			return;
		case "page":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			pageSelection(controller, command.delta);
			return;
		case "previewScroll":
			scrollPreview(controller, command.delta);
			return;
		case "moveOption":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			commitState(controller, moveOption(controller.state, command.delta));
			return;
		case "toggleMulti":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			handleToggleCurrentOption(controller);
			return;
		case "changeQuestionType":
			clearReviewShortcutPending(controller);
			handleChangeQuestionType(controller);
			return;
		case "openQuestionNote":
			clearQuestionTypeChangePending(controller);
			openQuestionNote(controller);
			return;
		case "openOptionNote":
			clearQuestionTypeChangePending(controller);
			openOptionNote(controller);
			return;
		case "confirm":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			commitState(controller, confirmCurrentSelection(controller.state), {
				finish: true,
			});
			return;
		case "cancel":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			handleExitFlow(controller, cancelFlow(controller.state));
			return;
		case "numberShortcut":
			handleNumberShortcut(controller, command.digit);
			return;
		case "dismiss":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			handleExitFlow(controller, dismissFlow(controller.state));
			return;
		case "showSettings":
			showSettingsModal(controller);
			return;
		default:
			return;
	}
}

function scrollPreview(controller: AskFlowController, delta: 1 | -1) {
	controller.previewScrollTop = Math.max(
		0,
		controller.previewScrollTop + delta
	);
	refresh(controller);
}

function handleNumberShortcut(controller: AskFlowController, digit: number) {
	if (handleReviewShortcutNumber(controller, digit)) {
		return;
	}
	clearReviewShortcutPending(controller);
	clearQuestionTypeChangePending(controller);
	commitState(controller, applyNumberShortcut(controller.state, digit));
}

function pageSelection(controller: AskFlowController, direction: 1 | -1) {
	if (isSubmitTab(controller.state)) {
		controller.viewport.reviewScrollTop = Math.max(
			0,
			controller.viewport.reviewScrollTop +
				direction * controller.viewport.reviewPageRows
		);
		refresh(controller);
		return;
	}
	// Measure the same wrapped rows that are displayed, not the number of options.
	renderController(controller, controller.tui.terminal?.columns ?? 80);
	const { optionStarts, bodyRows } = controller.viewport;
	const selected = isSubmitTab(controller.state)
		? controller.state.activeSubmitActionIndex
		: controller.state.activeOptionIndex;
	const currentLine = optionStarts[selected] ?? 0;
	const targetLine = currentLine + direction * bodyRows;
	const target =
		direction > 0
			? optionStarts.reduce(
					(index, start, candidate) =>
						start <= targetLine ? candidate : index,
					selected
				)
			: optionStarts.findIndex((start) => start >= targetLine);
	const nextIndex = target < 0 ? 0 : target;
	const delta = nextIndex === selected ? direction : nextIndex - selected;
	let state = controller.state;
	for (let step = 0; step < Math.abs(delta); step++) {
		state = moveOption(state, direction);
	}
	commitState(controller, state);
}

function handleToggleCurrentOption(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question) {
		return;
	}
	commitState(controller, toggleCurrentMultiOption(controller.state));
}

function handleChangeQuestionType(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question || isSubmitTab(controller.state)) {
		return;
	}
	const confirmed =
		controller.pendingQuestionTypeChangeQuestionId === question.id;
	const result = cycleCurrentQuestionType(controller.state, { confirmed });
	controller.dismissNotice = result.notice;
	if (result.needsConfirmation) {
		controller.pendingQuestionTypeChangeQuestionId = question.id;
		refresh(controller);
		return;
	}
	clearQuestionTypeChangePending(controller);
	commitState(controller, result.state, { finish: true });
}

function openQuestionNote(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question || isSubmitTab(controller.state)) {
		return;
	}
	commitState(
		controller,
		enterQuestionNoteMode(controller.state, question.id),
		{
			syncSelection: false,
		}
	);
}

function openOptionNote(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	const option = getCurrentOption(controller.state);
	if (
		!(question && option) ||
		option.isCustomOption ||
		isSubmitTab(controller.state)
	) {
		return;
	}
	commitState(
		controller,
		enterOptionNoteMode(controller.state, question.id, option.value),
		{ syncSelection: false }
	);
}

function reportAnswerChange(controller: AskFlowController) {
	if (!(controller.finished || controller.state.completed)) {
		controller.flowOptions.onAnswerChange?.(controller.state);
	}
}

function commitState(
	controller: AskFlowController,
	nextState: AskState,
	options: { finish?: boolean; syncSelection?: boolean } = {}
) {
	if (nextState.activeTabIndex !== controller.state.activeTabIndex) {
		controller.viewport.scrollTop = 0;
		controller.viewport.reviewScrollTop = 0;
		controller.previewScrollTop = 0;
		clearFooterNotices(controller);
	}
	if (nextState.activeOptionIndex !== controller.state.activeOptionIndex) {
		controller.previewScrollTop = 0;
	}
	controller.suppressAutoInputForSelection = false;
	const previousTab = controller.state.activeTabIndex;
	controller.state = nextState;
	if (options.syncSelection !== false) {
		syncSelection(controller);
	}
	reportAnswerChange(controller);
	controller.state = maybeAutoSubmitState(controller.state, controller.config);
	if (controller.state.activeTabIndex !== previousTab) {
		controller.flowOptions.onTabChange?.(controller.state.activeTabIndex);
	}
	hydrateEditor(controller);
	refresh(controller);
	if (options.finish) {
		maybeFinish(controller);
	}
}

function submitEditor(controller: AskFlowController, value: string) {
	controller.suppressAutoInputForSelection = false;
	const nextState = submitEditorDraft(controller.state, value);
	const previousTab = controller.state.activeTabIndex;
	if (nextState.activeTabIndex !== previousTab) {
		clearFooterNotices(controller);
	}
	controller.state = nextState;
	syncSelection(controller);
	reportAnswerChange(controller);
	controller.state = maybeAutoSubmitState(controller.state, controller.config);
	if (controller.state.activeTabIndex !== previousTab) {
		controller.flowOptions.onTabChange?.(controller.state.activeTabIndex);
	}
	hydrateEditor(controller);
	refresh(controller);
	maybeFinish(controller);
}

function commitSavedEditorNavigation(
	controller: AskFlowController,
	navigate: (state: AskState, delta: 1 | -1) => AskState,
	delta: 1 | -1
) {
	commitState(controller, navigate(saveEditorState(controller), delta));
}

function closeEditor(controller: AskFlowController) {
	const nextState = saveEditorState(controller);
	controller.suppressAutoInputForSelection = nextState.view.kind !== "input";
	controller.state = nextState;
	reportAnswerChange(controller);
	refresh(controller);
}

function handleExitFlow(controller: AskFlowController, nextState: AskState) {
	if (!shouldRequestDismissConfirmation(controller)) {
		commitState(controller, nextState, { finish: true });
		return;
	}
	if (shouldDiscardAfterConfirmation(!!controller.dismissNotice)) {
		commitState(controller, nextState, { finish: true });
		return;
	}
	controller.dismissNotice = DIRTY_DISMISS_NOTICE;
	refresh(controller);
}

function shouldRequestDismissConfirmation(
	controller: AskFlowController
): boolean {
	return shouldConfirmDirtyDismiss({
		config: controller.config,
		state: controller.state,
		editingText: isEditingView(controller.state)
			? controller.editor.getText()
			: "",
	});
}

function clearFooterNotices(controller: AskFlowController) {
	controller.configNotice = undefined;
	controller.dismissNotice = undefined;
}

function clearReviewShortcutPending(controller: AskFlowController) {
	controller.pendingReviewShortcutActionIndex = undefined;
}

function clearQuestionTypeChangePending(controller: AskFlowController) {
	controller.pendingQuestionTypeChangeQuestionId = undefined;
}

function getActiveReviewShortcutHint(
	controller: AskFlowController
): string | undefined {
	if (
		!(
			isSubmitTab(controller.state) &&
			controller.config.behaviour.doublePressReviewShortcuts
		)
	) {
		return;
	}
	return getReviewShortcutHint(controller.pendingReviewShortcutActionIndex);
}

function handleReviewShortcutNumber(
	controller: AskFlowController,
	digit: number
): boolean {
	if (
		!(
			isSubmitTab(controller.state) &&
			controller.config.behaviour.doublePressReviewShortcuts
		)
	) {
		return false;
	}

	const resolution = resolveReviewShortcutDoublePress(
		digit,
		controller.pendingReviewShortcutActionIndex
	);
	if (resolution.actionIndex === undefined) {
		return false;
	}

	controller.pendingReviewShortcutActionIndex = resolution.pendingActionIndex;
	const nextState = resolution.confirmed
		? applyNumberShortcut(controller.state, digit)
		: {
				...controller.state,
				activeSubmitActionIndex: resolution.actionIndex,
			};
	commitState(controller, nextState, { finish: resolution.confirmed });
	return true;
}

function getFooterNotice(controller: AskFlowController): string | undefined {
	return controller.dismissNotice ?? controller.configNotice;
}

function showSettingsModal(controller: AskFlowController) {
	if (controller.settingsOpen) {
		return;
	}
	controller.settingsOpen = true;
	showAskSettings(controller.ctx).finally(() => {
		controller.settingsOpen = false;
		refresh(controller);
	});
}

function refresh(controller: AskFlowController) {
	controller.tui.requestRender();
}

async function notifyCurrentQuestion(
	controller: AskFlowController
): Promise<void> {
	const question = getCurrentQuestion(controller.state);
	if (!question) {
		return;
	}
	await notifyQuestionWaiting(
		controller.config,
		createQuestionWaitingNotification(question),
		controller.flowOptions.exec,
		controller.flowOptions.signal
	);
}

function abortedResult(state: AskState): AskResult {
	return {
		...toAskResult({ ...state, answers: {}, cancelled: true, completed: true }),
		cancelReason: "aborted",
	};
}

function finish(controller: AskFlowController, result: AskResult) {
	if (controller.finished) {
		return;
	}
	controller.finished = true;
	controller.removeAbortListeners();
	controller.remoteFlow?.complete(result);
	controller.done(result);
}

function maybeFinish(controller: AskFlowController) {
	if (controller.state.completed) {
		finish(controller, toAskResult(controller.state));
	}
}

function startRemoteFlow(
	controller: AskFlowController,
	params: AskFlowParams
): RemoteAskFlowHandle | undefined {
	const remote = params.flowOptions.remote;
	if (!remote) {
		return;
	}
	return remote.runtime.startFlow({
		onAbort: () => finish(controller, abortedResult(controller.state)),
		source: remote.source,
		toolCallId: remote.toolCallId,
		title: controller.state.title,
		context: params.context,
		questions: controller.state.questions,
		onSubmit: (response) => submitRemoteResponse(controller, response),
	});
}

function submitRemoteResponse(
	controller: AskFlowController,
	response: RemoteAskResponse
): RemoteAskSubmitResolution {
	const resolution = applyRemoteAskResponse(controller.state, response);
	if (!resolution.ok) {
		return resolution;
	}
	commitState(controller, resolution.state, { finish: true });
	return { ok: true };
}

function hydrateEditor(controller: AskFlowController) {
	controller.editor.setText(getEditorDraft(controller.state));
}

function syncSelection(controller: AskFlowController) {
	if (controller.suppressAutoInputForSelection) {
		return;
	}
	controller.state = syncStateToSelection(controller.state);
}

function saveEditorState(controller: AskFlowController): AskState {
	const text = controller.editor.getText();
	controller.editor.setText("");
	return saveEditorDraft(controller.state, text);
}

function createEditor(
	tui: Tui,
	theme: Theme,
	cwd: string,
	commands: SkillCommands
) {
	const editor = new SkillReferenceEditor(tui, {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	});
	editor.setAutocompleteProvider(createAskAutocompleteProvider(cwd, commands));
	return editor;
}
