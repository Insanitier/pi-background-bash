#!/usr/bin/env node
/**
 * verify.mjs — the regression net for this extension.
 *
 * It covers the two defects that were reported against it and the surgical fixes
 * around them:
 *
 *   1. the module parses and loads (type stripping plus the whole import graph)
 *   2. the bash guidance keeps long work inside the tracked shell instead of
 *      telling the model to hand-detach it with nohup/setsid/&
 *   3. completion notices always ride along with the run (`steer`), never an end-of-turn
 *      follow-up that can be dropped — and never suppressed just because the task was quick
 *   4. a task with a `background_task wait` in flight produces NO completion card,
 *      because that wait's own result already carries the same outcome
 *   5. a task stopped on purpose reports nothing
 *   6. a killed auto-backgrounded (direct) task reports nothing
 *   7. the widget and status line clear once nothing is running
 *   8. card shape: description (command, id) -> tail -> log path -> outcome LAST, with
 *      the three ways out repeated while a task still runs and nothing else
 *   9. cards carry sanitized output: escape sequences never reach the model
 *  10. `background_task output` is gone; an unknown action fails loudly instead of
 *      falling into the kill branch
 *  11. a bounded wait hands back a snapshot (status + tail + log path) and leaves the task
 *      alone; a wait that timed out does NOT swallow the completion card
 *  12. the log of a task killed on purpose survives, so the path on its card stays valid
 *  13. one representation: every task is a detached process with a log under the session
 *      directory, and shutdown kills the lot — nothing is restored on the next start
 *  14. the wait paths the model can actually hit: waiting on a task that already finished,
 *      and aborting a wait — the latter must hand the task back to the completion card
 *
 * Not covered here, because it cannot be triggered deterministically: a kill that
 * fails with something other than ESRCH must leave the watcher armed (see the
 * "Signal first" comment in the kill action).
 *
 * Isolation: HOME and PI_CODING_AGENT_DIR point into a temp dir, the session id is
 * random, and the task/output directories this run creates are removed at the end.
 * Run it with `node verify.mjs` (or `npm test`); it takes a few seconds.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "extensions", "background-bash.ts");

// ── 0. Locate the Pi SDK so its bare imports resolve outside the Pi runtime ──
const sdkRoot = (() => {
	if (process.env.PI_SDK_DIR) return process.env.PI_SDK_DIR;
	const bin = execFileSync("readlink", ["-f", execFileSync("which", ["pi"], { encoding: "utf-8" }).trim()], {
		encoding: "utf-8",
	}).trim();
	for (let dir = dirname(bin); dir !== "/"; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		if (JSON.parse(readFileSync(manifest, "utf-8")).name === "@earendil-works/pi-coding-agent") return dir;
	}
	throw new Error("cannot locate @earendil-works/pi-coding-agent; set PI_SDK_DIR");
})();

registerHooks({
	resolve(specifier, context, next) {
		// Anchor the SDK's bare specifiers at its own node_modules, the way the Pi
		// runtime resolves them for an extension.
		if (specifier.startsWith("@earendil-works/") || specifier === "typebox") {
			return next(specifier, {
				...context,
				parentURL: pathToFileURL(join(sdkRoot, "node_modules", "anchor.mjs")).href,
			});
		}
		return next(specifier, context);
	},
});

// ── 1. A throwaway HOME, a random session, and fast background windows ───────
const HOME = join(tmpdir(), `pi-background-bash-verify-${process.pid}`);
const AGENT_DIR = join(HOME, ".pi", "agent");
mkdirSync(AGENT_DIR, { recursive: true });
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
// Outlive the 2s quick-completion window by a hair, then auto-background.
process.env.BACKGROUND_BASH_AUTO_BG_MS = "400";
// Let the extension's own inline self-check run as part of this harness.
process.env.BACKGROUND_BASH_SELF_TEST = "1";

const SESSION_ID = `verify-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
const WORK_DIR = join(HOME, "work");
mkdirSync(WORK_DIR, { recursive: true });
const TASK_ROOT = join(tmpdir(), "pi-background-bash", Buffer.from(SESSION_ID).toString("base64url"));

const checks = [];
const check = (name, ok, detail) => {
	checks.push([name, ok]);
	console.log(`${ok ? "✅" : "✗"} ${name}${ok || detail === undefined ? "" : `\n     ${String(detail).slice(0, 400)}`}`);
};
const until = async (predicate, timeoutMs = 8_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	return predicate();
};

// ── 2. A stub Pi host: record tools, messages and UI frames ─────────────────
const tools = new Map();
const commands = new Map();
const calls = { messages: [], status: [], widgets: [] };
const KILL_REASON = "理由能不能送到";
let pickedKill = false;
const ui = {
	setWidget: (key, value) => calls.widgets.push([key, value]),
	setStatus: (key, value) => calls.status.push([key, value]),
	notify: () => {},
	select: async (_title, items) => {
		if (pickedKill) return undefined;
		const kill = items.find((item) => item === "Kill");
		if (kill !== undefined) {
			pickedKill = true;
			return kill;
		}
		return items[0];
	},
	input: async () => KILL_REASON,
	editor: async () => {},
};
const handlers = new Map();
const pi = {
	registerTool: (def) => tools.set(def.name, def),
	registerMessageRenderer: () => {},
	registerCommand: (name, def) => commands.set(name, def),
	on: (event, handler) => handlers.set(event, handler),
	sendMessage: (message, opts) => calls.messages.push({ ...message, opts }),
};
const ctx = { ui, cwd: WORK_DIR, sessionManager: { getSessionId: () => SESSION_ID } };

const cards = () => calls.messages.filter((m) => m.customType === "background-bash-completion");
const cardsFor = (id) => cards().filter((m) => m.details?.taskId === id);
const idOf = (text) => String(text).match(/\(([0-9a-f]{16}|bg-[0-9a-f]{8})\)/)?.[1];
const run = (name, params, signal) => tools.get(name).execute("verify", params, signal, undefined, ctx);
const lastStatus = () => calls.status.at(-1)?.[1];

// ── 3. Load the extension and register its tools ────────────────────────────
try {
	const module = await import(pathToFileURL(EXTENSION).href);
	module.default(pi);
	check(
		"the module loads and registers bash + background_task",
		tools.has("bash") && tools.has("background_task"),
		[...tools.keys()].join(", "),
	);
} catch (error) {
	check("the module loads and registers bash + background_task", false, error.stack);
	console.log("\nFAIL: the extension did not load");
	rmSync(HOME, { recursive: true, force: true });
	process.exit(1);
}

const guidance = (tools.get("bash").promptGuidelines ?? []).join("\n");
check(
	"the bash guidance stays compact and about the tool",
	(tools.get("bash").promptGuidelines ?? []).length === 3 &&
		/run_in_background=true/.test(guidance) &&
		/until loop/.test(guidance) &&
		/background_task/.test(guidance) &&
		!/no[hu]up|setsid|disown/i.test(guidance),
);

// ── 4. Explicit background task: completion arrives as steer ────────────────
const quick = await run("bash", { command: "echo hello-from-a-background-task", run_in_background: true });
const quickId = idOf(quick.content[0].text);
const quickCard = quickId ? (await until(() => cardsFor(quickId).length === 1), cardsFor(quickId)[0]) : undefined;
check(
	"a background task that finishes immediately still reports its outcome",
	quickId !== undefined &&
		cardsFor(quickId).length === 1 &&
		String(quickCard?.content).includes("hello-from-a-background-task") &&
		String(quickCard?.content).split("\n").at(-1) === "completed",
	JSON.stringify({ id: quickId, cards: cardsFor(quickId).length, card: quickCard?.content }),
);

const launched = await run("bash", { command: "sleep 2.5; echo slow-enough-to-report", run_in_background: true });
const firstId = idOf(launched.content[0].text);
const firstCard = firstId ? (await until(() => cardsFor(firstId).length > 0), cardsFor(firstId)[0]) : undefined;
check(
	"a slower background task reports completion with steer",
	firstId !== undefined &&
		firstCard?.opts?.deliverAs === "steer" &&
		firstCard?.opts?.triggerTurn === true,
	JSON.stringify({ id: firstId, text: launched.content[0].text, opts: firstCard?.opts }),
);

// ── 5. A wait in flight suppresses the duplicate card ───────────────────────
const waited = await run("bash", { command: "sleep 2.5; echo waited-to-the-end", run_in_background: true });
const waitId = idOf(waited.content[0].text);
const pendingWait = waitId
	? run("background_task", { action: "wait", taskId: waitId })
	: Promise.resolve({ content: [{ text: "no task id was reported" }] });
const waitResult = await pendingWait;
await new Promise((resolve) => setTimeout(resolve, 400));
check(
	"a wait in flight suppresses the duplicate card",
	waitId !== undefined &&
		String(waitResult.content[0].text).includes("completed") &&
		cardsFor(waitId).length === 0,
	JSON.stringify({ id: waitId, result: waitResult.content[0].text, cards: cardsFor(waitId).length }),
);

// ── 5b. A bounded wait hands back a snapshot; a timeout keeps the card ─────
const snapshot = await run("bash", { command: "echo started-work; sleep 3.5; echo finished-work", run_in_background: true });
const snapshotId = idOf(snapshot.content[0].text);
await new Promise((resolve) => setTimeout(resolve, 400)); // let the first line land
const peek = snapshotId
	? await run("background_task", { action: "wait", taskId: snapshotId, seconds: 0 })
	: { content: [{ text: "" }] };
const peekText = String(peek.content[0].text);
check(
	"wait 0 returns status, tail and log path, and leaves the task running",
	snapshotId !== undefined &&
		peekText.includes("started-work") &&
		peekText.includes("Log: ") &&
		peekText.split("\n").at(-1) === "still running after 0s (not a failure; the task is unaffected)",
	JSON.stringify({ id: snapshotId, text: peekText }),
);

const bounded = snapshotId
	? await run("background_task", { action: "wait", taskId: snapshotId, seconds: 1 })
	: { content: [{ text: "" }] };
const boundedText = String(bounded.content[0].text);
const laterCard = snapshotId ? (await until(() => cardsFor(snapshotId).length === 1, 8_000), cardsFor(snapshotId)[0]) : undefined;
check(
	"a wait that timed out does not swallow the completion card",
	snapshotId !== undefined &&
		boundedText.split("\n").at(-1) === "still running after 1s (not a failure; the task is unaffected)" &&
		cardsFor(snapshotId).length === 1 &&
		String(laterCard?.content).split("\n").at(-1) === "completed",
	JSON.stringify({ id: snapshotId, wait: boundedText, cards: cardsFor(snapshotId).length, card: laterCard?.content }),
);

// ── 5c. Waiting on a task that already finished ────────────────────────────
const afterTheFact = firstId
	? await run("background_task", { action: "wait", taskId: firstId, seconds: 0 })
	: { content: [{ text: "" }] };
const afterText = String(afterTheFact.content[0].text);
const afterLines = afterText.split("\n");
const afterLogIndex = afterLines.findIndex((line) => line.startsWith("Log: "));
check(
	"waiting on a finished task returns the same shape, immediately",
	firstId !== undefined &&
		afterLines.at(-1) === "completed" &&
		afterLogIndex > 0 &&
		afterLines[afterLogIndex - 1].includes("slow-enough-to-report") &&
		afterLines[0].includes(firstId),
	JSON.stringify({ id: firstId, text: afterText }),
);

// ── 5d. An aborted wait must not swallow the completion card ───────────────
const cancelTask = await run("bash", { command: "echo cancel-me; sleep 2.5", run_in_background: true });
const cancelId = idOf(cancelTask.content[0].text);
const controller = new AbortController();
const cancelledWait = cancelId
	? run("background_task", { action: "wait", taskId: cancelId, seconds: 30 }, controller.signal)
	: Promise.resolve({ content: [{ text: "" }] });
await new Promise((resolve) => setTimeout(resolve, 300));
controller.abort();
const cancelled = await cancelledWait;
const cancelledText = String(cancelled.content[0].text);
const cancelCard = cancelId
	? (await until(() => cardsFor(cancelId).length === 1, 8_000), cardsFor(cancelId)[0])
	: undefined;
check(
	"an aborted wait reports itself cancelled and still lets the card through",
	cancelId !== undefined &&
		cancelledText.split("\n").at(-1) === "wait cancelled after 0s; still running, unaffected" &&
		cancelledText.includes("cancel-me") &&
		cancelledText.includes("Log: ") &&
		cardsFor(cancelId).length === 1 &&
		String(cancelCard?.content).split("\n").at(-1) === "completed",
	JSON.stringify({ id: cancelId, wait: cancelledText, cards: cardsFor(cancelId).length, card: cancelCard?.content }),
);

// ── 6. A stopped task reports nothing ──────────────────────────────────────
const doomed = await run("bash", { command: "sleep 30", run_in_background: true });
const doomedId = idOf(doomed.content[0].text);
// Past the 2s window, so only the deliberate stop can explain a missing card.
await new Promise((resolve) => setTimeout(resolve, 2_500));
const stopped = doomedId
	? await run("background_task", { action: "kill", taskId: doomedId })
	: { content: [{ text: "no task id was reported" }] };
await new Promise((resolve) => setTimeout(resolve, 600));
check(
	"a task stopped on purpose reports nothing",
	/Stopped background task/.test(String(stopped.content[0].text)) && cardsFor(doomedId).length === 0,
	JSON.stringify({ result: stopped.content[0].text, cards: cardsFor(doomedId).length }),
);

// ── 6b. A user kill from /bg delivers the typed reason as steer ────────────
const victim = await run("bash", { command: "echo about-to-be-killed; sleep 30", run_in_background: true });
const victimId = idOf(victim.content[0].text);
// Long enough for the runner to create output.log and print its first line: killing a
// task in its first milliseconds would leave the card without a tail to assert on.
await new Promise((resolve) => setTimeout(resolve, 600));
await commands.get("bg").handler(undefined, ctx);
await new Promise((resolve) => setTimeout(resolve, 400));
const killNotice = calls.messages.find(
	(m) => m.customType === "background-bash-completion" && /killed by user/.test(String(m.content)),
);
const killLines = String(killNotice?.content ?? "").split("\n");
// The line just above `Log: ` is the tail; the outcome is always the last line.
const killLogIndex = killLines.findIndex((line) => line.startsWith("Log: "));
check(
	"a user kill from /bg delivers the typed reason with steer",
	victimId !== undefined &&
		killNotice !== undefined &&
		String(killNotice.content).includes(victimId) &&
		killLines.at(-1) === `killed by user: ${KILL_REASON}` &&
		String(killNotice.content).includes("Log: ") &&
		// The line above the log path, not the command echoed in the first line — that
		// one would pass even with no output at all.
		killLogIndex > 0 &&
		killLines[killLogIndex - 1] === "about-to-be-killed" &&
		killNotice.details?.reason === KILL_REASON &&
		killNotice.opts?.deliverAs === "steer" &&
		killNotice.opts?.triggerTurn === true,
	JSON.stringify({ id: victimId, lines: killLines, opts: killNotice?.opts }),
);

check(
	"the log of a task killed on purpose survives, so its card path stays valid",
	killNotice !== undefined &&
		existsSync(String(killNotice.content).split("Log: ")[1]?.split("\n")[0] ?? ""),
	JSON.stringify({ path: String(killNotice?.content).split("Log: ")[1]?.split("\n")[0] }),
);

// ── 6c. Card shape: outcome last, tail and log path in between ─────────────
const successLines = String(firstCard?.content ?? "").split("\n");
check(
	"a success card is description -> tail -> log -> outcome last",
	successLines.length >= 4 &&
		/^".*" \(.*, [0-9a-f]{16}\)$/.test(successLines[0]) &&
		String(firstCard?.content).includes("slow-enough-to-report") &&
		successLines.at(-2)?.startsWith("Log: ") === true &&
		successLines.at(-1) === "completed",
	JSON.stringify({ lines: successLines }),
);

const failedTask = await run("bash", { command: "sleep 2.5; echo boom; exit 3", run_in_background: true });
const failedId = idOf(failedTask.content[0].text);
const failedCard = failedId ? (await until(() => cardsFor(failedId).length > 0), cardsFor(failedId)[0]) : undefined;
check(
	"a failure card ends with the exit code and keeps the old, larger tail",
	failedId !== undefined &&
		String(failedCard?.content).includes("boom") &&
		String(failedCard?.content).split("\n").at(-1) === "failed (exit 3)",
	JSON.stringify({ id: failedId, card: failedCard?.content }),
);

// ── 6d. Sanitized output: escapes never reach the model ────────────────────
const colored = await run("bash", { command: "sleep 2.5; printf '\\033[31mred\\033[0m done\\n'", run_in_background: true });
const colorId = idOf(colored.content[0].text);
const colorCard = colorId ? (await until(() => cardsFor(colorId).length > 0), cardsFor(colorId)[0]) : undefined;
check(
	"a card strips terminal escapes but keeps the text",
	colorId !== undefined &&
		!String(colorCard?.content).includes("\u001b") &&
		String(colorCard?.content).includes("red done"),
	JSON.stringify({ id: colorId, card: colorCard?.content }),
);

// ── 6e. Auto-background card: what it printed, and the three ways out ──────
const autoBg = await run("bash", { command: "echo warming up; sleep 30" });
const autoBgText = String(autoBg.content[0].text);
check(
	"the auto-background card holds the tail and the three ways out",
	/auto-backgrounded after 400s|auto-backgrounded after \d+s/.test(autoBgText) &&
		autoBgText.includes("warming up") &&
		autoBgText.includes("background_task wait") &&
		autoBgText.includes("background_task kill") &&
		autoBgText.includes("full log: "),
	JSON.stringify({ text: autoBgText }),
);
const autoBgId = autoBgText.match(/\(([0-9a-f]{16}|bg-[0-9a-f]{8})\)/)?.[1];
if (autoBgId) await run("background_task", { action: "kill", taskId: autoBgId }).catch(() => {});

// ── 6f. `output` is gone; unknown actions fail loudly ─────────────────────
let outputGone = false;
try {
	await run("background_task", { action: "output", taskId: firstId });
} catch (error) {
	outputGone = /Unsupported action/.test(String(error?.message));
}
check(
	"the output action is gone and an unknown action fails loudly",
	outputGone &&
		!/background_task output/.test((tools.get("background_task").promptGuidelines ?? []).join("\n")) &&
		!/read output/.test(String(tools.get("background_task").description)),
	JSON.stringify({ outputGone, guidelines: tools.get("background_task").promptGuidelines, description: tools.get("background_task").description }),
);

// ── 6g. Both entries end in the same terminal card ────────────────────────
// Must outlive the hardcoded 2s quick-completion window, or the foreground path answers
// directly and no task (and so no completion card) ever exists.
const autoDone = await run("bash", { command: "echo bg-start; sleep 2.6; echo bg-done" });
const autoDoneId = idOf(String(autoDone.content[0].text));
const autoDoneCard = autoDoneId
	? (await until(() => cardsFor(autoDoneId).length === 1, 8_000), cardsFor(autoDoneId)[0])
	: undefined;
const autoLines = String(autoDoneCard?.content ?? "").split("\n");
const autoLogIndex = autoLines.findIndex((line) => line.startsWith("Log: "));
const autoLogPath = autoLines[autoLogIndex]?.slice("Log: ".length) ?? "";
check(
	"an auto-backgrounded task ends in the same card shape as an explicit one",
	autoDoneId !== undefined &&
		autoLines.at(-1) === "completed" &&
		autoLogIndex > 0 &&
		autoLines[autoLogIndex - 1] === "bg-done" &&
		// Same contract, same place on disk: the session directory, keyed by task id.
		autoLogPath.startsWith(TASK_ROOT) &&
		String(firstCard?.content ?? "").split("Log: ")[1]?.split("\n")[0].startsWith(TASK_ROOT) === true,
	JSON.stringify({ id: autoDoneId, lines: autoLines, explicit: successLines.at(-2) }),
);

// ── 7. A killed auto-backgrounded task reports nothing ─────────────────────
const backgrounded = await run("bash", { command: "sleep 30" });
const autoId = idOf(backgrounded.content[0].text);
const autoStopped = autoId ? await run("background_task", { action: "kill", taskId: autoId }) : undefined;
await new Promise((resolve) => setTimeout(resolve, 1_200));
check(
	"a killed auto-backgrounded task reports nothing",
	autoId !== undefined &&
		/auto-backgrounded/.test(String(backgrounded.content[0].text)) &&
		String(backgrounded.content[0].text).includes("full log: ") &&
		/Stopped background task/.test(String(autoStopped?.content[0].text)) &&
		cardsFor(autoId).length === 0,
	JSON.stringify({ id: autoId, killed: autoStopped?.content[0].text, cards: cardsFor(autoId).length }),
);

// ── 8c. Drain: kill whatever is still running, then the widget must clear ──
const stillRunning = await run("background_task", { action: "list" });
const leftovers = String(stillRunning.content[0].text).match(/[0-9a-f]{16}|bg-[0-9a-f]{8}/g) ?? [];
for (const id of leftovers) await run("background_task", { action: "kill", taskId: id }).catch(() => {});

// ── 8. The widget clears once nothing is running ───────────────────────────
const cleared = await until(() => lastStatus() === undefined, 6_000);
check(
	"the widget and status line clear when nothing is running",
	cleared,
	JSON.stringify(calls.status.slice(-4)),
);

// ── 8b. Every notice rides into the run: never a follow-up ─────────────────
check(
	"every notice uses steer, never a follow-up that can be dropped",
	calls.messages.length > 0 && calls.messages.every((m) => m.opts?.deliverAs === "steer"),
	JSON.stringify(calls.messages.map((m) => m.opts)),
);

// ── 8d. Shutdown kills what this session started, both kinds alike ─────────
// Both tasks write their own pid, so the check does not depend on how the shell
// rewrites its command line (a trailing `# marker` comment gets stripped by exec).
const pidFile = join(HOME, "shutdown-pids");
const pidCommand = `echo $$ >> ${pidFile}; sleep 30`;
await run("bash", { command: pidCommand, run_in_background: true });
await run("bash", { command: pidCommand });
const pids = await until(() => {
	try {
		return readFileSync(pidFile, "utf-8").trim().split("\n").filter(Boolean).length >= 2;
	} catch {
		return false;
	}
}, 3_000)
	? readFileSync(pidFile, "utf-8").trim().split("\n").filter(Boolean).map(Number)
	: [];
const isAlive = (pid) => {
	try {
		return !readFileSync(`/proc/${pid}/stat`, "utf-8").split(" ")[2].startsWith("Z");
	} catch {
		return false;
	}
};
const bothAlive = pids.length === 2 && pids.every(isAlive);
await handlers.get("session_shutdown")();
await new Promise((resolve) => setTimeout(resolve, 1_000));
check(
	"shutdown kills every task of this session, explicit and auto-backgrounded alike",
	bothAlive && pids.every((pid) => !isAlive(pid)),
	JSON.stringify({ pids, bothAlive, alive: pids.map(isAlive) }),
);

// ── 9. Cleanup ─────────────────────────────────────────────────────────────
rmSync(TASK_ROOT, { recursive: true, force: true });
// Every log lives under TASK_ROOT, so this one rmSync is the whole cleanup: no shared
// directory is touched, unlike the version that used to wipe /tmp/pi-bg for every session.
rmSync(HOME, { recursive: true, force: true });

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${checks.length - failed.length}/${checks.length} checks`);
if (failed.length > 0) {
	for (const [name] of failed) console.log(`  ✗ ${name}`);
	process.exit(1);
}
// The extension leaves fs watchers and a sidebar ticker alive; nothing else here owns
// the loop, so end the run deliberately.
process.exit(0);
