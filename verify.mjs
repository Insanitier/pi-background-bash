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
 *   3. completion notices: skipped inside the 2s window, and `steer` (rides along with
 *      whatever the session is doing) outside it, never an end-of-turn follow-up
 *   4. a task with a `background_task wait` in flight produces NO completion card,
 *      because that wait's own result already carries the same outcome
 *   5. a task stopped on purpose reports nothing
 *   6. a killed auto-backgrounded (direct) task reports nothing
 *   7. the widget and status line clear once nothing is running
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
process.env.BACKGROUND_BASH_AUTO_BG_MS = "150";
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
const pi = {
	registerTool: (def) => tools.set(def.name, def),
	registerMessageRenderer: () => {},
	registerCommand: (name, def) => commands.set(name, def),
	on: () => {},
	sendMessage: (message, opts) => calls.messages.push({ ...message, opts }),
};
const ctx = { ui, cwd: WORK_DIR, sessionManager: { getSessionId: () => SESSION_ID } };

const cards = () => calls.messages.filter((m) => m.customType === "background-bash-completion");
const cardsFor = (id) => cards().filter((m) => m.details?.taskId === id);
const run = (name, params) => tools.get(name).execute("verify", params, undefined, undefined, ctx);
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
const quickId = String(quick.content[0].text).match(/task ([0-9a-f]{16})/)?.[1];
await new Promise((resolve) => setTimeout(resolve, 600));
check(
	"a task that finishes inside the 2s window reports nothing",
	quickId !== undefined && cardsFor(quickId).length === 0,
	JSON.stringify({ id: quickId, cards: cardsFor(quickId).length }),
);

const launched = await run("bash", { command: "sleep 2.5; echo slow-enough-to-report", run_in_background: true });
const firstId = String(launched.content[0].text).match(/task ([0-9a-f]{16})/)?.[1];
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
const waitId = String(waited.content[0].text).match(/task ([0-9a-f]{16})/)?.[1];
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

// ── 6. A stopped task reports nothing ──────────────────────────────────────
const doomed = await run("bash", { command: "sleep 30", run_in_background: true });
const doomedId = String(doomed.content[0].text).match(/task ([0-9a-f]{16})/)?.[1];
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
const victim = await run("bash", { command: "sleep 30", run_in_background: true });
const victimId = String(victim.content[0].text).match(/task ([0-9a-f]{16})/)?.[1];
await commands.get("bg").handler(undefined, ctx);
await new Promise((resolve) => setTimeout(resolve, 400));
const killNotice = calls.messages.find(
	(m) => m.customType === "background-bash-completion" && /killed by user/.test(String(m.content)),
);
check(
	"a user kill from /bg delivers the typed reason with steer",
	victimId !== undefined &&
		killNotice !== undefined &&
		String(killNotice.content).includes(victimId) &&
		killNotice.details?.reason === KILL_REASON &&
		killNotice.opts?.deliverAs === "steer" &&
		killNotice.opts?.triggerTurn === true,
	JSON.stringify({ id: victimId, notice: killNotice?.content, opts: killNotice?.opts, reason: killNotice?.details?.reason }),
);

// ── 7. A killed auto-backgrounded task reports nothing ─────────────────────
const backgrounded = await run("bash", { command: "sleep 30" });
const autoId = String(backgrounded.content[0].text).match(/Auto-backgrounded as (bg-[0-9a-f]{8})/)?.[1];
const autoStopped = autoId ? await run("background_task", { action: "kill", taskId: autoId }) : undefined;
await new Promise((resolve) => setTimeout(resolve, 1_200));
check(
	"a killed auto-backgrounded task reports nothing",
	autoId !== undefined &&
		/Auto-backgrounded/.test(String(backgrounded.content[0].text)) &&
		/Stopped background task/.test(String(autoStopped?.content[0].text)) &&
		cardsFor(autoId).length === 0,
	JSON.stringify({ id: autoId, killed: autoStopped?.content[0].text, cards: cardsFor(autoId).length }),
);

// ── 8. The widget clears once nothing is running ───────────────────────────
const cleared = await until(() => lastStatus() === undefined, 3_000);
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

// ── 9. Cleanup ─────────────────────────────────────────────────────────────
rmSync(TASK_ROOT, { recursive: true, force: true });
rmSync(join(tmpdir(), "pi-bg"), { recursive: true, force: true });
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
