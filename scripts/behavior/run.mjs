#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";
import {
	askContextMetrics,
	costTotal,
	interviewMetrics,
	tokenUsage,
	transcriptFromEvents,
} from "./metrics.ts";
import { executePrint } from "./print.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = "9router/cbcn/deepseek-v4.1-flash";
const reportOnly = [
	"anthropic/claude-opus-5-5",
	"openai-codex/gpt-6-sol",
	"zai/glm-5.3",
	"9router/cbcn/kimi-k3-1",
	"grok-cli/grok-4.7",
];
const args = process.argv.slice(2);
function option(flag, fallback) {
	const index = args.indexOf(flag);
	if (index < 0) {
		return fallback;
	}
	if (!args[index + 1] || args[index + 1].startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return args[index + 1];
}
const models = option("--models", [base, ...reportOnly].join(",")).split(",");
const modes = option("--modes", "upstream,fork").split(",");
const selected = option("--case", "all");
const selectedIds = selected === "all" ? [] : selected.split(",");
// A model may carry pi's thinking suffix, for example anthropic/claude-opus-5-5:high.
const thinkingLevels = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
// PI_ASK_BEHAVIOR_VARIANT labels records when several worktrees run the same matrix.
const variant = process.env.PI_ASK_BEHAVIOR_VARIANT;
const repeats = option("--repeats", "default");
const outputDir =
	process.env.PI_ASK_BEHAVIOR_DIR ??
	join(homedir(), ".pi/artifacts/pi-ask/behavior");
const timeoutMs = Number(process.env.PI_ASK_BEHAVIOR_TIMEOUT_MS ?? 120_000);
if (
	models.some((m) => !(m.includes("/") && m.split("/")[1])) ||
	modes.some((m) => !["upstream", "fork"].includes(m)) ||
	!Number.isSafeInteger(timeoutMs) ||
	timeoutMs <= 0 ||
	(repeats !== "default" &&
		(!Number.isSafeInteger(Number(repeats)) || Number(repeats) <= 0)) ||
	selectedIds.some((id) => !cases.some((c) => c.id === id)) ||
	args.some(
		(arg, i) =>
			i % 2 === 0 &&
			!["--models", "--modes", "--case", "--repeats"].includes(arg)
	) ||
	args.length % 2
) {
	throw new Error("Invalid arguments. See scripts/behavior/README.md");
}
// Declared before the batch loop: records built inside it read this constant.
const configDoc = /docs\/configuration\.md/;
const planMarker = /(?:^|\n)PLAN:/i;
// pi-ask may open a refused form after the run settles and start a new run with the answer.
const settleGraceMs = 3000;
await mkdir(outputDir, { recursive: true });
const upstreamCopy = modes.includes("upstream")
	? await copyUpstream()
	: undefined;
const upstreamEntry = upstreamCopy
	? join(upstreamCopy, "src/index.ts")
	: undefined;
const batch = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
batchRuns: for (const model of models) {
	for (const mode of modes) {
		for (const behavior of cases.filter(
			(c) => selected === "all" || selectedIds.includes(c.id)
		)) {
			const count =
				repeats === "default" ? defaultRuns(model) : Number(repeats);
			for (let run = 1; run <= count; run++) {
				const name = `${batch}-${model.replaceAll("/", "_")}-${mode}-${behavior.id}-${run}`;
				const path = join(outputDir, `${name}.json`);
				try {
					const record = await (behavior.kind === "print"
						? executePrint
						: execute)({
						root,
						model,
						mode,
						behavior,
						run,
						timeoutMs,
						upstreamEntry,
					});
					await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
					console.log(
						`${path}: asked=${record.asked} questions=${record.questionCount} followUp=${record.followUp}`
					);
				} catch (error) {
					await writeFile(
						path,
						`${JSON.stringify({ model, mode, case: behavior.id, run, infrastructureError: String(error) }, null, 2)}\n`
					);
					console.error(`${path}: ${error}`);
					// Stop on infrastructure failure to avoid charging for a broken batch.
					process.exitCode = 1;
					break batchRuns;
				}
			}
		}
	}
}

if (upstreamCopy) {
	await rm(upstreamCopy, { recursive: true, force: true });
}

async function copyUpstream() {
	// Install the pinned upstream package into a temp prefix, so the baseline never depends on pi's settings.
	const install = await mkdtemp(join(tmpdir(), "pi-ask-upstream-install-"));
	let manifest;
	try {
		execFileSync(
			"npm",
			[
				"install",
				"--prefix",
				install,
				"--no-save",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--omit=dev",
				"--omit=peer",
				"@eko24ive/pi-ask@1.2.0",
			],
			{ stdio: "ignore", timeout: 120_000 }
		);
		manifest = join(install, "node_modules/@eko24ive/pi-ask/package.json");
	} catch (error) {
		await rm(install, { recursive: true, force: true });
		throw error;
	}
	const packageInfo = JSON.parse(readFileSync(manifest, "utf8"));
	if (packageInfo.version !== "1.2.0") {
		throw new Error(`Expected upstream 1.2.0, found ${packageInfo.version}`);
	}
	const destination = await mkdtemp(join(tmpdir(), "pi-ask-upstream-"));
	try {
		await cp(dirname(manifest), destination, { recursive: true });
		await symlink(
			join(root, "node_modules"),
			join(destination, "node_modules"),
			"dir"
		);
		return destination;
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	} finally {
		await rm(install, { recursive: true, force: true });
	}
}

function defaultRuns(model) {
	return model === base ? 3 : 1;
}

function parseModel(model) {
	const [provider, ...idParts] = model.split("/");
	const id = idParts.join("/");
	const colon = id.lastIndexOf(":");
	const suffix = colon > 0 ? id.slice(colon + 1) : "";
	return thinkingLevels.has(suffix)
		? { provider, modelId: id.slice(0, colon), thinking: suffix }
		: { provider, modelId: id, thinking: undefined };
}

/** Finish once the run settles and no new run starts within the grace period. */
function settleWatcher(onSettled) {
	let timer;
	return {
		observe(event) {
			if (event.type === "agent_start" || event.type === "agent_settled") {
				clearTimeout(timer);
			}
			if (event.type === "agent_settled") {
				timer = setTimeout(onSettled, settleGraceMs);
			}
		},
		stop() {
			clearTimeout(timer);
		},
	};
}

/** Setup order: set_model, then set_thinking_level when requested, then the prompt. */
function setupCommands(prompt, thinking) {
	const promptCommand = { id: "prompt", type: "prompt", message: prompt };
	return new Map([
		[
			"set_model",
			thinking
				? { id: "thinking", type: "set_thinking_level", level: thinking }
				: promptCommand,
		],
		["set_thinking_level", promptCommand],
	]);
}

async function execute({ model, mode, behavior, run, timeoutMs }) {
	const scratch = await mkdtemp(join(tmpdir(), "pi-ask-behavior-"));
	const tracePath = join(scratch, "bridge.jsonl");
	const { provider, modelId, thinking } = parseModel(model);
	const startedAt = Date.now();
	const child = spawnRpc(model, mode, behavior.id, tracePath);
	const nextSetupCommand = setupCommands(behavior.prompt, thinking);
	let stderr = "";
	const events = [];
	let buffer = "";
	let finished = false;
	const settle = settleWatcher(() => {
		finished = true;
		child.stdin.end();
	});
	const exit = new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolveExit({ code, signal }));
	});
	let timer;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (text) => {
		stderr += text;
	});
	child.stdout.setEncoding("utf8");
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: RPC framing and command lifecycle share one stream callback.
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				try {
					const event = JSON.parse(line);
					event.receivedAt = Date.now();
					events.push(event);
					const next =
						event.type === "response" && event.success
							? nextSetupCommand.get(event.command)
							: undefined;
					if (next) {
						child.stdin.write(`${JSON.stringify(next)}\n`);
					}
					settle.observe(event);
				} catch (error) {
					stderr += `\nInvalid RPC JSON: ${error}: ${line}`;
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	try {
		child.stdin.write(
			`${JSON.stringify({ id: "model", type: "set_model", provider, modelId })}\n`
		);
		const status = await Promise.race([
			exit,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`RPC timeout after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
		checkRpcStatus(events, status, finished, buffer, stderr);
		return await buildRecord({
			events,
			tracePath,
			model,
			mode,
			behavior,
			run,
			stderr,
			startedAt,
		});
	} finally {
		clearTimeout(timer);
		settle.stop();
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
		await exit.catch(() => {
			/* Child spawn failure is reported by the caller. */
		});
		await rm(scratch, { recursive: true, force: true });
	}
}

function checkRpcStatus(events, status, finished, buffer, stderr) {
	const rejected = events.find(
		(event) => event.type === "response" && !event.success
	);
	if (rejected) {
		throw new Error(`RPC ${rejected.command}: ${rejected.error}`);
	}
	if (
		status.code !== 0 ||
		!finished ||
		buffer.trim() ||
		stderr.includes("Invalid RPC JSON")
	) {
		throw new Error(
			`RPC exit=${status.code} signal=${status.signal} agentEnd=${finished} stderr=${stderr.slice(-3000)}`
		);
	}
}

function spawnRpc(model, mode, caseId, tracePath) {
	const { provider, modelId, thinking } = parseModel(model);
	const env = { ...process.env };
	env.PI_ASK_BEHAVIOR_TRACE = tracePath;
	if (upstreamEntry) {
		env.PI_ASK_BEHAVIOR_UPSTREAM_ENTRY = upstreamEntry;
	}
	env.PI_ASK_BEHAVIOR_CASE = caseId;
	return spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--tools",
			"read,ask_user",
			"-e",
			mode === "upstream"
				? join(root, "scripts/behavior/upstream-rpc.ts")
				: join(root, "src/index.ts"),
			"-e",
			join(root, "scripts/behavior/bridge.ts"),
			"--model",
			`${provider}/${modelId}`,
			...(thinking ? ["--thinking", thinking] : []),
		],
		{
			cwd: root,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		}
	);
}

function buildInterviewMetrics(asks, events, startedAt) {
	const planEvent = events.find(
		(e) =>
			e.type === "message_end" &&
			e.message?.role === "assistant" &&
			e.message.content?.some(
				(part) => part.type === "text" && planMarker.test(part.text)
			)
	);
	return {
		...interviewMetrics(
			asks,
			startedAt,
			planEvent?.receivedAt ?? startedAt,
			Boolean(planEvent)
		),
		runDurationMs:
			(events.findLast((e) => e.type === "agent_end")?.receivedAt ??
				startedAt) - startedAt,
	};
}

function followUpKind(asks, behavior, text) {
	if (asks.length > 1) {
		return asks.slice(1).some((c) => c.args?.questions?.length >= 2)
			? "bundled"
			: "separate";
	}
	return behavior.id === "narrowing" && text.includes("?")
		? "plain_text"
		: "none";
}

async function readBridgeTrace(tracePath) {
	const traceText = await readFile(tracePath, "utf8").catch((error) => {
		if (error.code === "ENOENT") {
			return "";
		}
		throw error;
	});
	const trace = traceText.trim()
		? traceText.trim().split("\n").map(JSON.parse)
		: [];
	const started = trace.filter((e) => e.kind === "started").length;
	const completed = trace.filter((e) => e.kind === "completed").length;
	const submitted = trace.filter(
		(e) => e.kind === "submit-result" && e.event.ok
	).length;
	if (
		trace.some((e) => e.kind === "submit-result" && !e.event.ok) ||
		started !== completed ||
		started !== submitted
	) {
		throw new Error(`Bridge failure: ${traceText}`);
	}
	return trace;
}

function askValidationErrors(events, refused) {
	return events
		.filter(
			(e) =>
				e.type === "tool_execution_end" &&
				e.toolName === "ask_user" &&
				!refused.has(e.toolCallId) &&
				(e.isError || e.result?.details?.cancelReason === "invalid_input")
		)
		.map((e) => e.result);
}

/** Refused and invalid asks open no form, so the bridge never sees them; count opened asks only. */
function classifyAsks(calls, events) {
	const refused = askIdsWhere(
		events,
		(e) => e.result?.details?.cancelReason === "missing_context"
	);
	const withoutForm = askIdsWhere(
		events,
		(e) =>
			e.isError === true ||
			["missing_context", "invalid_input"].includes(
				e.result?.details?.cancelReason
			)
	);
	return {
		refused,
		asks: calls.filter((c) => c.name === "ask_user" && !withoutForm.has(c.id)),
	};
}

function askIdsWhere(events, matches) {
	return new Set(
		events
			.filter(
				(e) =>
					e.type === "tool_execution_end" &&
					e.toolName === "ask_user" &&
					matches(e)
			)
			.map((e) => e.toolCallId)
	);
}

async function buildRecord({
	events,
	tracePath,
	model,
	mode,
	behavior,
	run,
	stderr,
	startedAt,
}) {
	const errors = events.filter(
		(e) =>
			(e.type === "response" && !e.success) ||
			e.type === "agent_error" ||
			e.type === "error" ||
			(e.type === "message_end" &&
				e.message?.role === "assistant" &&
				e.message?.stopReason === "error")
	);
	if (errors.length) {
		throw new Error(
			`RPC error: ${JSON.stringify(errors).slice(0, 3000)} stderr=${stderr.slice(-1000)}`
		);
	}
	const trace = await readBridgeTrace(tracePath);
	const calls = events
		.filter((e) => e.type === "tool_execution_start")
		.map((e) => ({ id: e.toolCallId, name: e.toolName, args: e.args }));
	const text = events
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.flatMap(
			(e) =>
				e.message.content
					?.filter((p) => p.type === "text")
					.map((p) => p.text) ?? []
		)
		.join("\n");
	const { asks, refused } = classifyAsks(calls, events);
	if (asks.length > 0 && !trace.some((event) => event.kind === "started")) {
		throw new Error("Bridge failure: ask_user ran without a started event");
	}
	const questions = asks.flatMap((c) => c.args?.questions ?? []);
	const transcript = transcriptFromEvents(events);
	return {
		model,
		mode,
		variant: variant ?? mode,
		thinkingLevel: parseModel(model).thinking ?? null,
		case: behavior.id,
		run,
		prompt: behavior.prompt,
		asked: asks.length > 0,
		questionCount: questions.length,
		questionTypes: questions.map((q) => q.type ?? "single"),
		recommendations: questions.flatMap((q) =>
			(q.options ?? [])
				.filter((o) => o.recommended)
				.map((o) => ({
					questionId: q.id,
					value: o.value,
					reason: o.description ?? null,
				}))
		),
		validationErrors: askValidationErrors(events, refused),
		followUp: followUpKind(asks, behavior, text),
		configurationDocRead: calls.some(
			(c) => c.name === "read" && configDoc.test(c.args?.path ?? "")
		),
		toolCalls: calls,
		assistantText: text,
		bridgeTrace: trace,
		askContext: askContextMetrics(transcript, behavior.factPattern),
		// Forms that ask_user refused for missing context and opened after the explanation turn.
		deferredForms: trace.filter(
			(event) =>
				event.kind === "started" && event.event?.source === "ask:deferred"
		).length,
		transcript,
		tokenUsage: tokenUsage(events),
		costTotal: costTotal(events),
		...(behavior.id === "interview"
			? { interview: buildInterviewMetrics(asks, events, startedAt) }
			: {}),
	};
}
