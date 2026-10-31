# Ask tool contract

`ask_user` is a pi-native clarification tool for cases where implementation depends on user preference or missing requirements.

This document defines the stable external behavior. It does not explain internal helper-by-helper implementation.

## Model-facing tool text

The extension uses one concise tool description and three guidelines. The schema requires a `context` string, which comes first; it has no question limit and omits option `value`. It derives unique machine values from labels while accepting valid explicit values from older calls. The description limits asks to decisions needed now. For a specific requested decision, ask that question only, without other requirements or confirmation questions. This does not limit explicitly requested multi-question rounds. The description also states what the user sees: `context` in the chat, then the form, which shows only prompts, option labels and descriptions and disappears after Submit. The `context` description lists what explains a decision: findings, why each decision matters, why an option is recommended, hints, and answers to the user's questions. Guideline 2 splits every ask: each question and its options go only in the form, with the recommended option marked, and everything that explains goes only in `context`, not in message text. Neither `context` nor message text restates a question or lists its options, even when a skill or prompt gives a text format for questions, and the guideline states that the user does not see thinking, tool output, or files. The `recommended` field asks for the reason in `context`, and an option `description` says what the option means. General follow-up rules live in guideline 3. Elaborate results add an answer-first instruction to model-facing content without changing transcript rendering. Configuration guidance is conditional; the system prompt is never replaced.

## Input

```ts
{
  context: string;
  title?: string;
  questions: Array<{
    id: string;
    label?: string;
    prompt: string;
    type?: "single" | "multi" | "preview";
    required?: boolean;
    options: Array<{
      label: string;
      description?: string;
      preview?: string;
      recommended?: boolean;
    }>;
  }>;
}
```

The public tool schema has no option `value` property. Supply a label; the tool derives a unique machine value before execution. Valid explicit values from older calls remain accepted.

## Input rules

- `context` is required in the public schema and must be non-blank after trimming; a missing or blank `context` that reaches tool execution returns an `invalid_input` issue at path `context` together with any question issues, and no form opens
- at least one question is required
- every question must have non-empty trimmed `id` and `prompt`
- every question must have at least one option
- question ids must be unique within one tool call
- option `value`s must be unique within a question; missing values derive from label slugs and avoid collisions with valid explicit and derived values in that question
- blank optional `title`, question `label`, option `description`, and option `preview` fields are treated as omitted
- question `label` falls back to `Q1`, `Q2`, ...
- option `label` is required in the public schema; before schema validation, a missing or blank string label is derived from a non-empty `value` by replacing hyphens and underscores with spaces and capitalizing the first character
- `recommended` is optional presentation metadata; zero, one, or multiple options may set it to `true`
- recommended options render warning-colored `(recommended)` followed by muted ` | <description>` on the row under the label, or only `(recommended)` when no description exists; recommendations never preselect an answer
- `type` defaults to `single`; before schema validation, a tool-call question that omits `type` and gives every option non-blank preview text becomes `preview`, because only preview questions show option previews
- `required` defaults to `false`
- `required` is metadata only; it never blocks submission
- preview questions require preview text for every declared option; option descriptions do not satisfy this requirement, and invalid preview payloads report a fix hint to add preview text or switch to `type: "single"`
- all questions get an internal `Type your own` option

## Output

```ts
{
  content: [{ type: "text"; text: string }];
  details: {
    title?: string;
    cancelled: boolean;
    cancelReason?: "user" | "aborted" | "ui_unavailable" | "invalid_input";
    error?: {
      kind: "invalid_input";
      issues: Array<{
        path: string;
        message: string;
      }>;
    };
    mode: "submit" | "elaborate";
    questions: Array<{
      id: string;
      label: string;
      prompt: string;
      type: "single" | "multi" | "preview";
      presentedType?: "single" | "multi" | "preview";
    }>;
    answers: Record<
      string,
      {
        values: string[];
        labels: string[];
        indices: number[];
        customText?: string;
        note?: string;
        optionNotes?: Record<string, string>;
      }
    >;
    continuation?: {
      strategy: "refine_only" | "resume";
      affectedQuestionIds: string[];
      preservedAnswers: Record<string, {
        values: string[];
        labels: string[];
        indices: number[];
        customText?: string;
        note?: string;
        optionNotes?: Record<string, string>;
      }>;
      questionStates: Record<string, {
        status: "answered" | "needs_clarification" | "unanswered";
      }>;
    };
    elaboration?: {
      instruction: string;
      nextAction: "clarify" | "clarify_then_reask";
      items: Array<
        | {
            target: { kind: "question" };
            question: {
              id: string;
              label: string;
              prompt: string;
              type: "single" | "multi" | "preview";
              presentedType?: "single" | "multi" | "preview";
              options: Array<{
                value: string;
                label: string;
                description?: string;
                preview?: string;
                recommended?: boolean;
              }>;
            };
            answered: boolean;
            answer?: {
              values: string[];
              labels: string[];
              indices: number[];
              customText?: string;
              note?: string;
              optionNotes?: Record<string, string>;
            };
            note: string;
          }
        | {
            target: { kind: "option"; optionValue: string };
            question: {
              id: string;
              label: string;
              prompt: string;
              type: "single" | "multi" | "preview";
              presentedType?: "single" | "multi" | "preview";
              options: Array<{
                value: string;
                label: string;
                description?: string;
                preview?: string;
                recommended?: boolean;
              }>;
            };
            option: {
              value: string;
              label: string;
              description?: string;
              preview?: string;
              recommended?: boolean;
            };
            selected: boolean;
            answered: boolean;
            answer?: {
              values: string[];
              labels: string[];
              indices: number[];
              customText?: string;
              note?: string;
              optionNotes?: Record<string, string>;
            };
            note: string;
          }
      >;
    };
  };
}
```

## Live progress

While the TUI or RPC ask flow is open, `ask_user` sends a tool update after each committed answer change. Each update carries the answers so far in `details` and the same summary text shape as a submitted result in `content`. Navigation and review do not send updates. Updates stop when the flow ends, are not stored in the session, and are not sent to the model. The final result text is unchanged.

## Output rules

- `cancelled: true` means the user dismissed the flow, the run was aborted, UI was unavailable, or the payload was invalid before UI opened; every cancelled result includes `cancelReason`: `user` for cancel or dismiss (including command flows), `aborted` for a tool run interrupted by its abort signal, `ui_unavailable` for non-interactive modes, or `invalid_input` for payload validation failures. An aborted tool result says exactly: `The ask_user form was closed because the run was aborted. No answers were collected.` It contains no answers.
- semantically invalid payloads that reach tool execution return `error.kind === "invalid_input"` with structured `issues` and a transcript-friendly `Invalid ask_user payload:` message; the result is marked `isError: true`, so the model sees a failed tool call, and its rendered status is `Invalid tool payload`
- payloads missing schema-required fields fail Pi's schema validation before tool execution and use Pi's standard tool-error result without structured `details`
- `mode: "submit"` is normal completion; `mode: "elaborate"` means the user asked the agent to continue with follow-up clarification based on notes
- unanswered questions without notes are omitted from `answers`; note-only entries remain in `answers` to carry their notes, but all non-cancelled submitted result text includes `<label>: (no answer)` in summary mode and `? <label>: (no answer)` in transcript rendering
- in `mode: "elaborate"`, `answers` contains only committed answers; note-only entries move to `elaboration.items`
- `continuation.strategy === "refine_only"` means the next ask should refine the current flow rather than restart it
- `continuation.preservedAnswers` contains previously committed answers that should be kept as context and not re-asked
- `continuation.affectedQuestionIds` lists the only questions that should be revisited
- `continuation.questionStates` marks each question as `answered`, `needs_clarification`, or `unanswered`
- single-select answers still use arrays
- recommendation markers never change canonical submitted labels or values
- when `behaviour.presentSingleAsMulti` is enabled, requested single-select questions are presented and handled as multi-select in future/replayed ask flows; result question metadata keeps the requested `type`, adds `presentedType` when final presentation differs, and result text uses one compact note when any answered questions were presented differently
- `indices` are 1-based rendered option positions
- `customText` stores the free-form answer
- on single-select questions, saving free-form text clears selected options for that question
- on multi-select questions, `values` and `labels` include both selected options and `customText` when both are present
- on multi-select questions, selected options keep their original order and `customText` is appended last
- submitting free-form text on a multi-select question stays on the same question tab and marks the custom row selected
- on multi-select questions, toggling an empty custom row opens the free-form editor, while toggling a custom row with saved free-form text selects or deselects it without opening the editor or clearing the text
- saving or clearing free-form text on a multi-select question does not clear other selected options
- `note` stores a question-level note
- `optionNotes` includes only notes for selected options
- question notes may exist without a selected answer
- `elaboration.items` includes all question notes and all option notes, even for unselected options
- every elaboration item includes the full normalized question and option list for that question so referential notes like `above` remain understandable to the agent
- option-targeted elaboration items include the specific noted option plus whether it is currently selected
- question-targeted elaboration items include whether the question already has a committed answer
- `elaboration.instruction` tells the agent to answer the clarification directly first, then re-ask only the affected questions if a choice is still needed; elaborate result `content` also carries the short answer-first instruction so the model receives it
- when a submitted answer or note asks a question or asks for an explanation, agents answer it in `context` when they ask again, or in message text when they do not; when the user asks only for an explanation or asks for no form, agents do not call `ask_user`
- when a choice is still needed after that, agents should use another structured `ask_user` call, not plain-text choices
- when prior answers narrow the branch, agents should bundle the next 2-3 related unresolved decisions into one follow-up when possible; ask one at a time only when the next question materially depends on the previous answer
- `elaboration` is only present when `mode === "elaborate"`
- elaborate `content` text and transcript rendering describe each note directly using the full question prompt and option label, and include the current committed answer text when available, instead of a generic elaboration banner
- when the user selects `Elaborate` without adding notes, elaborate `content` text and transcript rendering still include the committed answer text so the agent can elaborate on that answer directly

## Supported UX

- a long form title wraps over as many lines as it needs
- tabbed multi-question flow; the tab bar shows `○`/`●` unanswered/answered markers and a `☰ Review` tab between `←` and `→` arrows, highlights the active tab, and keeps it visible on narrow terminals
- rules, preview frames, and the settings overlay frame use pi border colors and square corners; the custom-answer and note editor uses pi editor colors and completion-list styling
- custom-answer and note editors wrap long text at word boundaries inside their background bar; editor bars and the preview box end one column before the right edge; the stacked preview box starts in column 1, and box text has one space of padding on each side
- single-select, multi-select, and preview questions
- preview boxes appear beside options at wide widths and below them at narrow widths; each uses only the rows its content needs, up to the free terminal rows after pi's status, widgets, and footer plus the ask frame, prompt, options, and other question content. On short terminals, the preview keeps its minimum size and the options may page; paging hint rows shorten to `↑ N more` / `↓ N more` when the terminal is too narrow for the full hint with its page key, so no rendered line is ever wider than the terminal. Without a known viewport height, the preview retains the 14-row cap. Long previews scroll independently with `[` and `]` by default, show the number of lines above and below, and preserve plain-text spacing without Markdown. Beside the options, the list shows labels and the `(recommended)` marker only; the box heading shows the focused option's description. Long option descriptions may be shortened to fit the box.
- recommended options show the warning-colored `(recommended)` subtitle in standard and preview lists, without automatic selection
- active question type changes via configurable `main.changeQuestionType` hotkey, default `t`; non-preview questions toggle `single <-> multi`; preview questions toggle `preview <-> multi`
- inline free-form answers for all question types
- native pi-style `@` file path autocomplete inside free-form answer and note editors
- pi's `app.clipboard.pasteImage` key (default `Ctrl+V`, `Alt+V` on Windows; user remaps apply) in custom-answer and note editors works as in pi's main editor: a PNG, JPEG, GIF, or WebP clipboard image is saved to `<os tmpdir>/pi-clipboard-<uuid>.<ext>` and that path is inserted at the cursor; otherwise clipboard text is inserted. Clipboard errors are ignored. Results carry only the path text. Terminal (bracketed) paste is unchanged
- typing `/` at the start of text or after whitespace in custom-answer and note editors (including notes used for Elaborate) lists skills loaded by pi, including skills provided by other extensions; it works after prose and on later lines, but not inside a word. Arrow keys move the highlighted skill; Tab selects it and inserts `/skill:<name> `. Enter submits or saves literal text without selecting an automatically opened skill list, including a typed `/skill:` token. Enter retains pi's file-selection behavior for lists opened explicitly with Tab and for `@` mentions. If no skill matches a bare slash token, Tab falls back to pi's file path completion. When pi-better-skills provides shared autocomplete, its skill ranking is used; otherwise pi's registered skill command ranking applies. Other slash commands are not listed.
- submitted and elaborated results retain typed `/skill:name` tokens in the recorded answer or note; each distinct known skill is recorded in `details.resolvedSkills` and loaded after the ask result. For tool results, or idle command/recovery answers, pi-better-skills queues known, non-resident skills when present. An unknown or missing delivery outcome uses pi-ask’s block instead. While a command/recovery answer waits as a follow-up during streaming, pi-ask puts the block in that answer message rather than steering it into the current turn. Without pi-better-skills, pi-ask also appends pi’s block to the model-facing result. If a skill file cannot be read, the answer still arrives without that block. Unknown tokens are ignored; results without known tokens do not change
- question notes via `Shift+N`
- option notes via `n`
- number-key quick selection
- review tab shows a one-row action bar (`1 Submit │ 2 Elaborate │ 3 Cancel`, the focused action highlighted) above numbered question blocks; up/down move between actions, and the footer shows `↑↓ action`; each block shows its question label, question note, `→ answer` lines in the success color with option notes under their answers, or `unanswered` in the warning color; terminals too narrow for the bar show one action per row; on short terminals the answers scroll under the fixed bar and show how many questions are above and below, with the same narrow-terminal `↑ N more` / `↓ N more` hint fallback
- on the review tab, `Submit` and `Cancel` preview notes only for answered questions
- on the review tab, `Elaborate` preview expands to all question notes and all option notes, including notes on unselected options
- transcript-friendly call and result rendering; the call's `context` appears in the chat as a message above the `ask_user` row (see Execution and lifecycle)
- `/answer` command to convert the latest completed assistant message into an `AskParams` form through a synthetic `ask_user` tool call and open the ask UI
- `/answer` extraction may use an internal `freeform: true` option for open-ended questions with no explicit choices; these render as user-input-only questions with the label `Type your answer:`, no numbered option row, and no selection caret; this marker is not part of the public `ask_user` tool contract
- `/answer:again` command to replay the latest `/answer`-extracted form on the current branch
- `/ask:replay` command and configurable main-editor shortcut to replay the latest real `ask_user` form on the current branch; the shortcut uses the same missing-form notice, defaults to `ctrl+shift+r`, and can be disabled with `shortcuts.replay: null`; key changes require `/reload`
- automatic recovery of the newest unresolved `ask_user` form on startup, resume, fork, or in-session `/tree` navigation
- ask settings list with binary behaviour/notification toggles and a guarded reset-to-defaults action
- `?` in the ask flow and `/ask-settings` in pi open the same lightweight ask settings overlay
- settings attempt to persist immediately when changed: `Auto-submit when answered without notes`, `Confirm dismiss when dirty`, `Double-press review shortcuts`, `Notifications`, and `Show footer hints`; `Present single-select as multi-select` persists immediately when saving succeeds but applies only to new/replayed ask flows; save failures revert the setting and show a manual-edit message; resetting config to defaults requires pressing the reset action twice within a short confirmation window
- `Keymaps` is a persisted, context-aware config section for global, main-flow, editor, note-editor, and settings-modal actions
- the settings overlay scales to the terminal width and windows long content on short terminals so the focused setting and close hint remain visible; when settings are hidden, dim `↑ N more above` / `↓ N more below` cue rows count them; the description area reserves room for the longest setting description at the current width, so the overlay height stays fixed as focus moves, and at least one blank line separates it from the key footer; the settings list shows the absolute config file path for customizing keymaps, notifications, and extraction settings
- if the flow is already on the review tab, all questions are answered, and no notes exist, enabling auto-submit can complete the current ask flow immediately
- elaborate results are phrased as direct follow-up instructions, for example: `User asked to elaborate on question "Which option would you like to select?" option "Option A" with note "why this one?"`

## Keyboard behavior

Main flow:

- `global.settings` opens ask settings; default: `?`
- `global.dismiss` dismisses the active ask surface; default: `Ctrl+C`
- `main.nextTab` / `main.previousTab` move between tabs; defaults: `Tab`/`Right`, `Shift+Tab`/`Left`
- `main.nextOption` / `main.previousOption` move between options, or between review actions; defaults: `Down`, `Up`
- `main.pageUp` / `main.pageDown` move question focus by one visible page, or scroll review answers without moving the selected action; defaults: `Shift+Up` / `PageUp`, `Shift+Down` / `PageDown`; in pi fullscreen mode, pi's transcript takes `PageUp`, `PageDown`, `Home`, and `End` before the ask flow, so `Shift+Up` / `Shift+Down` page the form and the page indicators show only bindings that reach the form
- `main.previewUp` / `main.previewDown` scroll long preview text in a bounded preview pane, without moving option focus; defaults: `[` and `]`
- `main.confirm`, `main.cancel`, and `main.toggle` confirm, cancel, or toggle; defaults: `Enter`, `Esc`, `Space`
- `main.changeQuestionType` changes the active question type (non-preview: `single <-> multi`; preview: `preview <-> multi`); default: `t`; destructive `multi -> single` changes require pressing the type hotkey again, with no timeout, and the pending confirmation clears on other navigation/actions
- `main.optionNote` and `main.questionNote` open option/question notes; defaults: `n`, `Shift+N`
- an open or saved question note sits one blank row below the prompt
- question options and settings rows use the same ` ▶ ` focus pointer; multi-select options use `[ ]` and `[✓]`, and the question shows `Pick any · N of M selected` for predefined options (plus a selected custom answer, if any), followed by one blank line; saved option notes start in the same column as the option description
- question footers show the configured up/down and next-tab navigation, plus fixed `1-9` shortcuts; editor footers do not advertise tab navigation
- footers stay on one line: when the full hint list does not fit, hints are dropped in this order: up/down move, number keys (pick/toggle), type change, tab/back navigation; confirm, note, cancel/dismiss, and settings hints always stay and wrap only when even they do not fit
- on a short terminal, the header, tabs, question prompt, multi-selection count, and footer stay fixed while option rows and review answers window to the available rows; focused options and review actions stay visible, and indicators count hidden options or review questions when space permits
- in pi fullscreen mode, the wheel scrolls option rows or review answers under the pointer, or only the preview when over its box; scrolling does not move selection, and the next key restores list focus-follow; at a scroll boundary, the wheel event passes through to pi. Regular mode leaves mouse input to the terminal.
- pi `tui.select` up/down/confirm bindings also navigate and confirm when they do not conflict with an ask binding; pi select cancel never cancels an ask, and `Ctrl+C` still dismisses
- `1..9` is fixed and selects or toggles the matching option; on the review tab, `1`, `2`, and `3` trigger `Submit`, `Elaborate`, and `Cancel`
- when `Double-press review shortcuts` is enabled, review-tab `1`, `2`, and `3` require the same key twice without a timeout, and the review screen shows an inline hint for the pending action

Editing flow:

- `editor.submit` submits the current custom-answer editor input and closes the editor; default: `Enter`
- `noteEditor.save` saves the current note editor and keeps the ask flow open; default: `Enter`
- `editor.close` / `noteEditor.close` save draft and close the editor; default: `Esc`
- `global.dismiss` dismisses the entire flow immediately without saving the current editor draft when no dirty-dismiss confirmation is pending
- `global.settings` opens ask settings when the editor is empty; otherwise the key is delegated to the editor as text/input
- when editor has text, arrow keys and `Tab` stay in the editor so the cursor can move while typing; in pi fullscreen mode, `Home` and `End` scroll pi's transcript, so `Ctrl+A` / `Ctrl+E` move to the line start or end
- when editor is empty, editor-context `*WhenEmpty` navigation actions move options or tabs without requiring the editor close binding first
- `@` remains a fixed file-reference affordance in editors; `/` at the start of text or after whitespace opens pi skill completion; Tab selects the highlighted skill, and Enter saves or submits literal text without selecting an automatically opened skill list

Settings modal:

- `settingsModal.close` closes settings; defaults: `Esc`, `Ctrl+C`, `?`
- `settingsModal.nextOption` / `settingsModal.previousOption` move between settings; defaults: `Down`, `Up`
- `settingsModal.toggle` toggles the highlighted setting and attempts to save immediately; if saving fails, the setting reverts and an error is shown; on the reset action, the same binding must be pressed twice within a short confirmation window; defaults: `Enter`, `Space`

Dirty dismiss:

- when `Confirm dismiss when dirty` is enabled, cancelling or dismissing a dirty ask flow requires the same action a second time
- the dirty-dismiss warning stays visible until the user changes tabs in the ask flow

## Execution and lifecycle

While an interactive ask flow is open, pi-ask sets the `pi-ask` footer status to the current question number, or to review. The status updates when the active tab changes and clears when the flow submits, cancels, aborts, or errors. pi-ask does not change the terminal title, because pi has no API to restore it. This also applies to recovered TUI asks and RPC dialogs. Non-interactive calls do not show a waiting indicator.

`ask_user` registers with `exposure: "model-only"`: pi declares it to the model, and codemode scripts and other tools cannot call it through `ctx.executeTool()`. It stays declared when `codemode.mode` is `"only"`.

`ask_user` draws its own transcript rows (`renderShell: "self"`). The call row shows `context` as Markdown with the padding of an assistant message, then the `ask_user N question(s) (labels)` header row. While the call streams or its form is open, the header row and any answers reported so far have no background. A finished call draws the box of pi's default tool shell around the header and result rows, with the success or error background. pi's HTML exporter renders every call as pending and puts each call inside its own status box, so an export shows `context` and the header row inside that box. While the call streams, `context` appears as it arrives. In TUI mode the form opens below the transcript after the call ends, so `context` stays visible above it, and the answer returns as the tool result in the same turn. A call without `context` shows only the header row.

`ask_user` requests sequential execution. When one assistant message calls it alongside other tools, pi runs the entire batch one call at a time. A pre-aborted call does not open the UI; aborting an open flow closes it and emits the remote `completed` event. On session shutdown, open flows close. An interrupted recovered ask has no dismissal marker or tool result, so startup can reopen it again.

## Configuration advice

Pi-ask leaves the system prompt unchanged. When the expanded user prompt mentions `/ask-settings`, `pi-ask setting` or `pi-ask settings`, `keymap`, or `keybinding` (case-insensitive), pi-ask sends the configuration-doc sentence as a hidden model-facing message. Mentions of `ask_user`, `/answer`, `pi-ask` alone, or `ask settings` do not trigger it. It sends only one copy while that message remains in the model context, and sends it again after compaction removes it. A typed `/ask-settings` extension command runs before prompt matching and does not trigger this message.

## Non-TUI and non-interactive modes

pi-ask never changes the active tool list. Print and JSON sessions keep `ask_user` active, so a model that needs a user decision gets the `Needs user input` result below and can stop. The configuration-doc trigger also runs in headless sessions when the user's prompt matches.

The rich ask flow uses `ctx.ui.custom()` only in TUI mode. In RPC mode with a UI, pi-ask uses pi dialogs: single and preview options show labels and preview text before selection, multi options use repeated checkbox-prefixed selects with Done, and custom answers use input. The last select offers Submit or Cancel. Dismissing any dialog cancels as `user`; aborting cancels as `aborted`. RPC does not offer notes or Elaborate. Every dialog receives an abort signal. If `ask_user` is called directly without an interactive UI, it keeps the existing `Needs user input: ask_user requires interactive TUI mode.` content and `cancelReason: "ui_unavailable"` details.

The public schema requires question `id` and `prompt` plus option `label`, has no question limit, and has no option `value` property. Before schema validation, the tool derives a missing option value from a slug of its label. Derived values are unique within each question, including against explicit values. For example, `Offline only` becomes `offline-only`; a collision gets a numeric suffix. Older calls with valid explicit values remain accepted; blank explicit values remain invalid. The schema restricts question `type` to `single`, `multi`, or `preview`. The tool validates trimmed text, uniqueness, option counts, and preview requirements during execution and returns structured issues. Non-interactive results show `Label [value]`; submitted answers carry normalized values. Result rendering falls back to Pi's raw tool-error text when schema validation prevents execution.

The ask flow subscribes to runtime settings updates while open. In practice, this means changing `Auto-submit when answered without notes`, `Confirm dismiss when dirty`, `Double-press review shortcuts`, `Notifications`, `Show footer hints`, resetting config to defaults, or reloading config-backed keymaps can affect the in-progress ask flow immediately instead of only future asks when the change is saved or otherwise applied in memory. Load-time migrations and invalid config handling do not rewrite, rename, or back up the config file; invalid files load defaults for the session and show a notice. `Present single-select as multi-select` is applied when an ask flow is created and does not rewrite question semantics for an already-open flow; use `main.changeQuestionType` for live per-question changes.

## Notifications

When enabled, pi-ask emits one best-effort external notification per ask session after the ask UI opens and waits for input. The default title is `pi ask`; the message is `Question waiting: <label or prompt>`. Channels run in configured order and failures never fail or cancel the ask flow. Command channels run through Pi with shell syntax, a 5-second timeout, and the ask tool abort signal.

## Remote inter-extension events

pi-ask exposes a local `pi.events` contract for trusted Pi extensions. It does not expose a network API and does not automate terminal keystrokes. RPC opens pi dialogs and also emits lifecycle events. A trusted in-process bridge can submit while an RPC dialog is open; its valid submission wins and closes the dialog. Headless integrations cannot open dialogs and need their own user interaction.

Channels:

- `pi-ask:started`
- `pi-ask:completed`
- `pi-ask:submit`
- `pi-ask:submit-result`

Remote submissions must be explicit `{ kind: "answer" }` or `{ kind: "cancel" }` responses. The started event carries the ask's non-blank `context` when it has one, so a remote UI can show the explanation before the questions. Remote answers use question ids and normalized option values from the started event. pi-ask validates ids and values, recomputes labels/indices, and does not infer approval semantics from labels.

See [`remote-events.md`](remote-events.md) for payload shapes, examples, and a local smoke test.

## Slash command replay/extraction

- valid `ask_user` payloads are persisted as branch custom entries before the UI opens, so `/ask:replay` can reopen them after cancel, `/resume`, or `/tree`
- `/answer` scans the current branch for the latest assistant message; if that message did not finish with `stop`, extraction is refused
- `/answer` sends the preceding user message as context with the latest assistant text and asks the extractor for one synthetic `ask_user` tool call
- missing or invalid tool calls and deferred model responses are retried according to `answer.extractionRetries`; deferred content is ignored, and raw or fenced JSON text remains supported as a last-resort fallback
- `{ "questions": [] }` from extraction means no questions were found and is not treated as an invalid ask payload
- command-flow cancellation closes with a notification and does not send a message to the agent
- submitted or elaborated command-flow results are sent back with user-message semantics
- replay commands scan only `ctx.sessionManager.getBranch()`, ignore sibling/future branch payloads, and revalidate stored payloads before opening the UI
- the TUI transcript shows a one-line themed `ask saved` marker with the title or question count for each stored ask, and `pending ask dismissed` for each dismissal; both remain custom session entries and are never added to model context
- each new stored `ask:payload` entry receives a `/tree` label: `ask: <title>`, or `ask: <first question label or prompt> (<count> question[s])` without a title; whitespace is collapsed, and the label is capped at 60 characters with an ellipsis when truncated. Labels and label changes do not enter model context

## Interrupted ask resume

- on `session_start` with reason `startup`, `resume`, or `fork`, or after a `session_tree` navigation, pi-ask finds the newest `ask_user` tool call on the active branch that has neither a tool result nor an `ask:pending-dismissed` entry
- recovery does not run for `new`, `reload`, or non-TUI sessions; another event cannot open a second recovered flow while one is open
- the matching valid `ask:payload` supplies the form; if it is missing or invalid, pi-ask validates and uses the original tool call arguments instead
- the recovery flow is detached from the session event, so an open form does not block other lifecycle handlers
- because the interrupted `execute` promise no longer exists, submit sends the result with the same user-message semantics as replay commands
- submit and cancel both append `ask:pending-dismissed`, which prevents another automatic reopen; `/ask:replay` still works
- when a recovered ask has a valid stored payload on the active branch, submit changes its `/tree` label to `ask: <detail> (answered)` and cancel changes it to `ask: <detail> (dismissed)`; the 60-character cap preserves the outcome suffix. If recovery uses the original tool arguments because no valid payload exists, there is no stored payload entry to label
- recovered flows emit remote lifecycle events with source `ask:resume`
- before each model request, a dismissed recovered `ask_user` call without a real tool result receives one non-error result directly after its assistant message: `This ask_user call was interrupted by a restart. Its outcome, if any, follows in a later user message.` This applies to both submitted and cancelled recovery; calls without a dismissal marker or with a real result are unchanged. A call whose placeholder an earlier request already sent keeps pi's `No result provided` placeholder: a later assistant message precedes its dismissal, or a request was sent while its recovered form was open (the dismissal marker then records `placeholderSent: true`). pi-ask keeps that second fact in memory until it saves the dismissal. If pi stops after sending such a request while neither the dismissal nor a later reply has been saved, a later recovery may replace that placeholder with the pi-ask result. This can lose prompt-cache reuse from that result onward, but no stored reply follows the placeholder, so no thinking block can be dropped. The result is added only to the outgoing request, not to the session file. The splice leaves pi's system messages (the stored prompt and later prompt or tool updates) where they are. Outside this accepted crash window, these rules keep pi-ask from changing any part of a request that was already sent; other extensions' request transforms are outside this guarantee.

The fallback message includes normalized pending questions and options so the caller can re-ask them manually. `details.questions` still contains normalized question metadata, while `details.answers` stays empty until a user responds.

## Source of truth

Behavior should be verified against:

1. `src/types.ts` and exported state/result helpers
2. `tests/*.test.ts`
3. this contract
