import assert from "node:assert/strict";
import test from "node:test";
import { registerAskTool } from "../src/ask-tool.ts";
import type { AskParams } from "../src/types.ts";
import { runAskFlow } from "../src/ui/controller.ts";

const HAS_UI = "hasUI";
const FAILED_RE = /failed/;
const RECOVERY_FAILED_RE = /recovery screen failed/;

const params: AskParams = {
	context: "Both answers change the plan.",
	questions: [
		{ id: "a", prompt: "First?", options: [{ value: "yes", label: "Yes" }] },
		{ id: "b", prompt: "Second?", options: [{ value: "no", label: "No" }] },
	],
};

type IndicatorEvent =
	| { kind: "status"; key: string; text: string | undefined }
	| { kind: "title"; text: string };

function setup(mode: "tui" | "rpc") {
	const events: IndicatorEvent[] = [];
	const dialogs: Array<(answer: string | undefined) => void> = [];
	let input: (key: string) => void = () => {
		throw new Error("Ask did not open");
	};
	const ui = {
		setStatus(key: string, text: string | undefined) {
			events.push({ kind: "status", key, text });
		},
		setTitle(text: string) {
			events.push({ kind: "title", text });
		},
		setWorkingVisible() {
			// Working visibility does not affect the waiting indicator.
		},
		custom(factory: (...args: any[]) => any) {
			return new Promise((resolve) => {
				const component = factory(
					{
						requestRender() {
							// Rendering does not affect the waiting indicator.
						},
					},
					{
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
					},
					{},
					resolve
				);
				input = (key) => component.handleInput(key);
			});
		},
		select(_title: string, _options: string[]) {
			return new Promise<string | undefined>((resolve) =>
				dialogs.push(resolve)
			);
		},
		input() {
			throw new Error("Unexpected input dialog");
		},
	};
	let tool: any;
	registerAskTool({
		registerTool(value: unknown) {
			tool = value;
		},
		appendEntry() {
			// Stored payloads do not affect the waiting indicator.
		},
		getCommands() {
			return [];
		},
	} as never);
	const ctx = { mode, [HAS_UI]: true, cwd: process.cwd(), ui } as never;
	const abort = new AbortController();
	return {
		events,
		dialogs,
		abort,
		ctx,
		get input() {
			return input;
		},
		start() {
			return tool.execute(
				"waiting",
				params,
				abort.signal,
				() => {
					// Tool updates do not affect the waiting indicator.
				},
				ctx
			);
		},
	};
}

async function waitForOpen(flow: ReturnType<typeof setup>) {
	const deadline = Date.now() + 1500;
	while (flow.events.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert(flow.events.length > 0, "expected ask to open");
}

function expectPosition(events: IndicatorEvent[], position: string) {
	assert.deepEqual(events.at(-1), {
		kind: "status",
		key: "pi-ask",
		text: position,
	});
}
// pi cannot restore a title, so the ask must never change it.
function expectCleared(events: IndicatorEvent[]) {
	assert.deepEqual(events.at(-1), {
		kind: "status",
		key: "pi-ask",
		text: undefined,
	});
	assert.deepEqual(
		events.filter((event) => event.kind === "title"),
		[]
	);
}

for (const mode of ["tui", "rpc"] as const) {
	test(`${mode} shows waiting position on open and tab changes, then clears on submit`, async () => {
		const flow = setup(mode);
		const pending = flow.start();
		await waitForOpen(flow);
		expectPosition(flow.events, "question 1 of 2");
		if (mode === "tui") {
			flow.input("\t");
			expectPosition(flow.events, "question 2 of 2");
			flow.input("\t");
		} else {
			flow.dialogs.shift()?.("1. Yes");
			await new Promise((resolve) => setImmediate(resolve));
			expectPosition(flow.events, "question 2 of 2");
			flow.dialogs.shift()?.("1. No");
			await new Promise((resolve) => setImmediate(resolve));
		}
		expectPosition(flow.events, "review of 2 questions");
		if (mode === "tui") {
			flow.input("\r");
		} else {
			flow.dialogs.shift()?.("Submit");
		}
		await pending;
		expectCleared(flow.events);
	});

	for (const ending of ["cancel", "abort", "error"] as const) {
		test(`${mode} clears the waiting indicator on ${ending}`, async () => {
			const flow = setup(mode);
			if (ending === "error") {
				if (mode === "rpc") {
					(flow.ctx as any).ui.select = () => {
						throw new Error("dialog failed");
					};
				} else {
					(flow.ctx as any).ui.custom = () => {
						throw new Error("screen failed");
					};
				}
			}
			const pending = flow.start();
			if (ending === "error") {
				await assert.rejects(pending, FAILED_RE);
			} else {
				await waitForOpen(flow);
				if (ending === "abort") {
					flow.abort.abort();
				} else if (mode === "rpc") {
					flow.dialogs.shift()?.(undefined);
				} else {
					flow.input("\u001b");
				}
				assert.equal(
					(await pending).details.cancelReason,
					ending === "abort" ? "aborted" : "user"
				);
			}
			expectCleared(flow.events);
		});
	}
}

test("recovered TUI flow clears indicators if opening its screen throws", async () => {
	const flow = setup("tui");
	(flow.ctx as any).ui.custom = () => {
		throw new Error("recovery screen failed");
	};
	await assert.rejects(
		runAskFlow(flow.ctx, params, {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		}),
		RECOVERY_FAILED_RE
	);
	expectCleared(flow.events);
});
