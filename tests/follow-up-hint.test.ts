import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// A new process exercises the registered tool.
const probe = `
import { registerAskTool } from "./src/ask-tool.ts";
import { DEFAULT_ASK_CONFIG } from "./src/config/defaults.ts";
import { getAskConfigStore } from "./src/config/store.ts";
await getAskConfigStore().ensureLoaded();
getAskConfigStore().setConfig({ ...DEFAULT_ASK_CONFIG, notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false } });
let tool;
registerAskTool({ registerTool(value) { tool = value; }, appendEntry() {}, getCommands() { return []; } });
const params = { questions: [{ id: "goal", label: "Goal", prompt: "Choose a goal", options: [{ value: "speed", label: "Speed" }] }] };
const theme = { fg(_color, text) { return text; }, bg(_color, text) { return text; } };
async function interactive(keys) {
  let component;
  const pending = tool.execute("call", params, undefined, () => {}, {
    cwd: process.cwd(), mode: "tui",
    sessionManager: { getBranch: () => [
      { type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "Ask me." }] } },
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: "Here is the context." }, { type: "toolCall", id: "call", name: "ask_user", arguments: {} }] } },
    ] },
    ui: {
      setWorkingVisible() {},
      custom(callback) {
        return new Promise(resolve => {
          component = callback({ requestRender() {} }, theme, {}, resolve);
        });
      },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  for (const key of keys) component.handleInput(key);
  return pending;
}
const cases = {
  submitted: await interactive(["1", "\\r"]),
  elaborated: await interactive(["1", "\\x1b[B", "\\r"]),
  cancelled: await interactive(["\\x1b"]),
  cancelledElaborate: await interactive(["1", "\\x1b[B", "\\x1b", "\\x1b"]),
  invalid: await tool.execute("invalid", { questions: [] }, undefined, () => {}, { mode: "print" }),
  unavailable: await tool.execute("print", params, undefined, () => {}, { mode: "print" }),
  aborted: await tool.execute("abort", params, AbortSignal.abort(), () => {}, { mode: "tui" }),
};
console.log(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([name, response]) => [name, {
  content: response.content[0].text,
  rendered: tool.renderResult(response, undefined, theme).text,
  mode: response.details.mode,
  cancelled: response.details.cancelled,
}]))));
`;

function run() {
	const env = { ...process.env };
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", probe],
		{
			cwd: new URL("..", import.meta.url),
			env,
			encoding: "utf8",
			timeout: 10_000,
		}
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as Record<
		string,
		{ content: string; rendered: string; mode: string; cancelled: boolean }
	>;
}

const answerFirstLine =
	"First answer the user's note directly using the question and option context; re-ask only the affected question if a choice is still needed.";

test("elaborate results carry one answer-first instruction without changing other results", () => {
	const results = run();
	assert.equal(results.submitted.content, "Goal: Speed");
	assert.equal(results.elaborated.mode, "elaborate");
	assert.ok(results.elaborated.content.includes("User asked to elaborate"));
	assert.equal(results.elaborated.content.split(answerFirstLine).length, 2);
	for (const kind of [
		"cancelled",
		"cancelledElaborate",
		"invalid",
		"unavailable",
		"aborted",
	]) {
		assert.equal(results[kind].cancelled, true, kind);
		assert.equal(results[kind].content.includes(answerFirstLine), false, kind);
	}
	assert.equal(results.elaborated.rendered.includes(answerFirstLine), false);
});
