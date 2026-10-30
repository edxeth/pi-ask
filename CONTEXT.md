# pi-ask

pi-ask is a pi extension that lets the agent stop and ask the user structured questions, then continue with normalized answers.

## Language

### Project

**Upstream**:
The project pi-ask started from, `eko24ive/pi-ask`, published as `@eko24ive/pi-ask`.
_Avoid_: original, parent

### The ask

**Ask**:
One `ask_user` tool call and the questions it carries.
_Avoid_: interview, questionnaire, form (when you mean the call)

**Ask flow**:
The interactive surface that collects answers for one ask, from open to close.
_Avoid_: form, dialog, modal

**Ask context**:
The explanation an ask carries in its required `context` argument: findings, why each decision matters, why an option is recommended. The chat shows it as a message above the ask flow; questions and options stay in the ask flow.
_Avoid_: preamble, message text (when you mean the argument)

**Question**:
One decision inside an ask, with an id, a prompt, a type, and options.

**Question type**:
How a question is answered: `single` (one answer), `multi` (several answers), or `preview` (one answer, each option carries preview text).

**Option**:
One predefined answer to a question, identified by its value.
_Avoid_: choice, item

**Recommended option**:
An option the agent marks as its grounded preference; shown to the user, never preselected.

**Custom answer**:
Free text the user types instead of, or next to, the predefined options ("Type your own").
_Avoid_: freeform answer, other

**Note**:
Free text the user attaches to a question (question note) or to an option (option note) without it being an answer.

**Review tab**:
The last tab of an ask flow, where the user chooses Submit, Elaborate, or Cancel.
_Avoid_: submit tab

### Outcomes

**Submit**:
The user ends the ask flow and returns the committed answers.

**Elaborate**:
The user ends the ask flow and asks the agent to respond to the notes before deciding.

**Cancel**:
The ask flow ends without answers. The user can cancel from the review tab or with the cancel key.

**Dismiss**:
The user closes the whole ask flow at once from any screen, including an open editor. The result is a cancel.

**Cancel reason**:
Why an ask ended without answers: `user` (cancel or dismiss), `aborted` (the agent run was aborted), `ui_unavailable` (no interactive surface in this mode), or `invalid_input` (the payload failed validation).

### Lifecycle

**Pending ask**:
An ask in the session transcript that has no tool result and no dismissal marker.

**Recovery**:
Reopening the newest pending ask automatically when a session starts, resumes, or forks.
_Avoid_: resume (that is a pi session event)

**Replay**:
Reopening a stored ask on demand with `/ask:replay` or `/answer:again`.

**Extraction**:
Turning the last assistant message into an ask with `/answer`.

**Remote bridge**:
A trusted in-process pi extension that observes and answers ask flows through pi-ask's `pi.events` channels.
_Avoid_: remote API, RPC API

### Model-facing text

**Model-facing text**:
Every string pi-ask adds to what the model receives: tool description, prompt snippet, prompt guidelines, parameter schema, config sentence, and tool result content.

**Prompt format**:
One concise fork format; the upstream npm package is the behavior comparison baseline.

**Rule**:
One model-facing instruction about when or how to use `ask_user`.

**Rule home**:
The single place where a rule lives in the prompt format.

**Config sentence**:
The model-facing instruction to read the pi-ask configuration doc before changing pi-ask settings or keymaps.

**Follow-up rules**:
The rules for answering and asking again after an answer or note: answer a question or explanation request in the ask context when asking again, or in message text otherwise, and use another structured `ask_user` call instead of plain-text choices when a choice is still needed. When prior answers narrow the branch, bundle the next 2-3 related unresolved decisions when possible; ask one at a time only when the next question materially depends on the previous answer. These rules live in guideline 3, not in the `questions` parameter description or results. A per-result hint was removed in #30 because it made models keep asking.
_Avoid_: follow-up hint

### Verification

**Base model**:
The model whose ask behavior must not regress for a model-facing text change to ship.

**Model matrix**:
The set of models, one per model family plus the base model, on which the behavior set runs.

**Behavior set**:
The fixed list of decision prompts, with scripted answers, used to compare ask behavior between the fork and upstream package.
