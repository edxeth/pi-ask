# Ask context lives in the message text

The user reads the agent's message text and then the `ask_user` form. The form shows only prompts, option labels and descriptions, and it disappears after Submit. Thinking, tool arguments and tool output are not a reply. In October 2026 session logs, 37% of asks opened with no message text since the user's last input, and 53% for claude-opus-5-5, so users answered questions whose context they had not seen.

The tool description now says what the user sees. Guideline 2 requires the context as message text before every call, and guideline 3 answers a typed question or an explanation request in message text first. In TUI mode and in RPC mode with a UI, an ask without assistant text since the user's last input is refused once per user input. The refusal tells the model to reply with the explanation and end its turn, and pi-ask opens the refused form when the run settles. The answer reaches the model as a user message, as for `/ask:replay`.

Live runs of `scripts/behavior/` on 2026-10-30 support both parts. They used the `context`, `typed-question` and `explain-only` cases, 3 runs each, on Haiku 5.5, Sonnet 5.5, Opus 5.5, GPT-6 Luna, GPT-6.1 Terra, GPT-6.1 Sol, GPT-6 Astra and GLM 5.3:

- Before this change, 77 of 97 forms opened without text. The text alone left 12 of 87, all of them Opus or Sonnet asks right after a tool result. A captured Opus message held the needed context in its second thinking block, followed by the tool call.
- A refusal that asked for text and a new call fixed none of the 12, because the retry also follows a tool result, and it cost 17% more than the text alone. Both models wrote text in every reply that ended their turn.
- With the explain-first refusal, 1 of 87 forms opened without text, at 15% higher total cost than the text alone. 10 of 11 refusals produced an explanation that ended the turn, and the form followed it.
- With the final refusal text, Opus and Sonnet opened 0 of 24 forms without text, and all 12 explanations followed the refusal without mentioning it.
- The base-model gate of ADR 0003 (deepseek-v4.1-flash against upstream 1.2.0, 3 runs of 11 cases) showed the same bundling, preview use and plan completion. Forms without text fell from 17 of 43 to 0 of 39.

Each refusal costs one more model request. The shorter description, without a sentence that repeated guideline 2, behaved the same as the longer one and is the shipped text.
