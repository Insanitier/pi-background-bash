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
 *  15. aborting a foreground command kills it (SIGKILL to its process group, the way the
 *      built-in bash tool does) instead of letting it run to completion
 *  16. Python tooling is routed through uv, unconditionally: pip and friends are refused
 *      with the uv equivalent (explicit interpreter paths included), python3 runs through
 *      uv, without uv it falls back to the real interpreter, and other commands are
 *      untouched
 *  17. the completion notice renders as a card (Status title, command row, collapsed body
 *      behind the real expand hint, log footer), the status line carries its `Status: `
 *      prefix, and an entry written before the card existed still renders its text
 *  18. `then_run` fuses a change with the command that follows it: the change lands first,
 *      the command runs in the same call through the same foreground path as bash (uv
 *      policy and the auto-background card included), a failed change skips the command, a
 *      failed command is an error that still carries the change and does not roll it back,
 *      and the card shows the command's output — which neither built-in renderer does alone
 *  19. the uv shim runs a project on the project's own environment: a `.venv` built on a
 *      different interpreter than the first `python3` on PATH is used as it is, never
 *      rebuilt around that interpreter (which would throw the installed packages away)
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const messageRenderers = new Map();
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
	registerMessageRenderer: (type, renderer) => messageRenderers.set(type, renderer),
	registerCommand: (name, def) => commands.set(name, def),
	on: (event, handler) => handlers.set(event, handler),
	sendMessage: (message, opts) => calls.messages.push({ ...message, opts }),
};
const ctx = { ui, cwd: WORK_DIR, sessionManager: { getSessionId: () => SESSION_ID } };

const cards = () => calls.messages.filter((m) => m.customType === "background-bash-completion");
const cardsFor = (id) => cards().filter((m) => m.details?.taskId === id);
const isAlivePid = (pid) => {
	try {
		return !readFileSync(`/proc/${pid}/stat`, "utf-8").split(" ")[2].startsWith("Z");
	} catch {
		return false;
	}
};
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

check(
	"the bash tool carries no guidelines: the cards (6e) and the schema do the work",
	(tools.get("bash").promptGuidelines ?? []).length === 0 &&
		/run_in_background/.test(JSON.stringify(tools.get("bash").parameters)) &&
		!/no[hu]up|setsid|disown/i.test(tools.get("bash").description),
);

// ── 3b. Python tooling routed through uv: unconditional, no setting ─────────
const uvFailure = async (command) => {
	try {
		await run("bash", { command });
		return undefined;
	} catch (error) {
		return String(error?.message);
	}
};
const pipError = await uvFailure("pip install requests");
const explicitPathError = await uvFailure(".venv/bin/python -m pip install requests");
const plainCommand = await run("bash", { command: "echo plain-command-fine" });
check(
	"pip is refused with uv guidance, explicit interpreter paths included",
	/Use uv instead/.test(String(pipError)) &&
		/Use uv instead/.test(String(explicitPathError)) &&
		String(plainCommand.content[0].text).includes("plain-command-fine"),
	JSON.stringify({ pipError, explicitPathError, plain: plainCommand.content[0].text }),
);

const shimDir = join(tmpdir(), "pi-background-bash", "shims");
const hasUv = (() => {
	try {
		execFileSync("which", ["uv"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
})();
const redirected = await run("bash", {
	command: `python3 -c 'import sys; print("interpreter:", sys.executable)'`,
});
const redirectedText = String(redirected.content[0].text);
check(
	"python3 runs through uv instead of the shim",
	!hasUv || (redirectedText.includes("interpreter:") && !redirectedText.includes(shimDir)),
	JSON.stringify({ hasUv, redirected: redirectedText.slice(0, 240) }),
);

// Without uv on PATH the routing falls back to the interpreter that was already first on
// PATH (upstream exits 127 there). pip stays blocked, because that is the policy itself.
// The shim directory must be named explicitly: `PATH=x cmd` resolves cmd with the new PATH.
const noUvPath = `PATH=${JSON.stringify(shimDir)}:/usr/bin:/bin`;
const shimmedPip = String(await uvFailure(`${noUvPath} bash -c 'pip install requests'`));
let uvReachable = true;
try {
	uvReachable = String(execFileSync("bash", ["-c", `${noUvPath} command -v uv`], { encoding: "utf8" })).trim().length > 0;
} catch {
	uvReachable = false;
}
let fallbackText = "";
let groundTruthText = "";
try {
	fallbackText = String(
		(await run("bash", { command: `${noUvPath} python3 -c 'import sys; print("fallback:", sys.executable)'` }))
			.content[0].text,
	);
	groundTruthText = String(
		(await run("bash", { command: `${noUvPath} /usr/bin/python3 -c 'import sys; print("fallback:", sys.executable)'` }))
			.content[0].text,
	);
} catch (error) {
	fallbackText = `THREW: ${error?.message}`;
}
check(
	"without uv on PATH python3 falls back to the real interpreter, pip stays blocked",
	uvReachable ||
		(fallbackText === groundTruthText &&
			fallbackText.includes("fallback:") &&
			!fallbackText.includes("command not found") &&
			/Use uv instead/.test(shimmedPip)),
	JSON.stringify({ uvReachable, fallbackText, groundTruthText, shimmedPip: shimmedPip.trim() }),
);

// ── 3c. The environment uv picks is the environment the shim runs on ────────
// Handing uv the interpreter that happens to sit next to the shim is not a routing
// choice: inside a project uv rebuilds that project's .venv around the interpreter it is
// handed, so a model running plain `python3` wipes what was installed in the environment.
// The mismatch is the point, so the check needs a project environment built on a different
// interpreter than the first python3 on PATH; with only one interpreter there is nothing to
// see, and the check is skipped rather than reported as a pass it did not earn.
const realPythons = (() => {
	const seen = [];
	try {
		const listed = execFileSync("bash", ["-c", "type -aP python3; type -aP python"], { encoding: "utf-8" });
		for (const line of listed.split("\n")) {
			const candidate = line.trim();
			if (!candidate) continue;
			let resolved = "";
			try {
				resolved = execFileSync("readlink", ["-f", candidate], { encoding: "utf-8" }).trim();
			} catch {
				continue;
			}
			// This harness may itself run under a shell whose PATH carries the shim.
			if (!resolved || resolved.startsWith(`${shimDir}/`) || seen.includes(resolved)) continue;
			seen.push(resolved);
		}
	} catch {
		/* no python3 on PATH at all */
	}
	return seen;
})();
const uvProject = join(WORK_DIR, "uv-project");
const uvProjectVenv = join(uvProject, ".venv");
const uvProjectCheckable = hasUv && realPythons.length > 1;
let projectRunText = "";
let projectVenvBefore = "";
let projectVenvAfter = "";
try {
	if (uvProjectCheckable) {
		mkdirSync(uvProject, { recursive: true });
		writeFileSync(
			join(uvProject, "pyproject.toml"),
			'[project]\nname = "uv-project"\nversion = "0.0.0"\nrequires-python = ">=3.8"\n',
		);
		execFileSync("uv", ["venv", uvProjectVenv, "--python", realPythons[1], "-q"], { stdio: "pipe" });
		// A package only this environment has: a rebuild starts from the manifest and loses it.
		const sitePackages = execFileSync(
			"bash",
			["-c", `ls -d ${JSON.stringify(join(uvProjectVenv, "lib"))}/python*/site-packages`],
			{ encoding: "utf-8" },
		).trim();
		mkdirSync(join(sitePackages, "verify_marker"), { recursive: true });
		writeFileSync(join(sitePackages, "verify_marker", "__init__.py"), 'VALUE = "survived"\n');
		projectVenvBefore = execFileSync("readlink", ["-f", join(uvProjectVenv, "bin", "python")], {
			encoding: "utf-8",
		}).trim();
		const projectRun = await run("bash", {
			command: `cd ${JSON.stringify(uvProject)} && python3 -c 'import sys, verify_marker; print("project:", sys.executable, verify_marker.VALUE)'`,
		});
		projectRunText = String(projectRun.content[0].text);
		projectVenvAfter = execFileSync("readlink", ["-f", join(uvProjectVenv, "bin", "python")], {
			encoding: "utf-8",
		}).trim();
	}
} catch (error) {
	projectRunText = `THREW: ${error?.message}`;
}
check(
	"the shim runs a project on the project's own environment, without rebuilding it",
	!uvProjectCheckable ||
		(projectRunText.includes(`${uvProjectVenv}/bin/python`) &&
			projectRunText.includes("survived") &&
			projectVenvBefore === realPythons[1] &&
			projectVenvAfter === projectVenvBefore),
	JSON.stringify({ realPythons, projectVenvBefore, projectVenvAfter, projectRun: projectRunText.slice(0, 300) }),
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
		String(quickCard?.content).split("\n").at(-1) === "Status: completed",
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
		peekText.split("\n").at(-1) === "Status: still running after 0s (not a failure; the task is unaffected)",
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
		boundedText.split("\n").at(-1) === "Status: still running after 1s (not a failure; the task is unaffected)" &&
		cardsFor(snapshotId).length === 1 &&
		String(laterCard?.content).split("\n").at(-1) === "Status: completed",
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
		afterLines.at(-1) === "Status: completed" &&
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
		cancelledText.split("\n").at(-1) === "Status: wait cancelled after 0s; still running, unaffected" &&
		cancelledText.includes("cancel-me") &&
		cancelledText.includes("Log: ") &&
		cardsFor(cancelId).length === 1 &&
		String(cancelCard?.content).split("\n").at(-1) === "Status: completed",
	JSON.stringify({ id: cancelId, wait: cancelledText, cards: cardsFor(cancelId).length, card: cancelCard?.content }),
);

// ── 5e. Escape on a foreground command kills it (built-in bash parity) ─────
const fgPidFile = join(HOME, "foreground-pid");
const fgController = new AbortController();
const pendingForeground = run("bash", { command: `echo $$ > ${fgPidFile}; sleep 30` }, fgController.signal);
const fgPid = (await until(() => {
	try {
		return readFileSync(fgPidFile, "utf-8").trim().length > 0;
	} catch {
		return false;
	}
}, 4_000))
	? Number(readFileSync(fgPidFile, "utf-8").trim())
	: 0;
const fgWasAlive = fgPid > 0 && isAlivePid(fgPid);
// Still inside the 2s quick-completion window, so the abort lands where the tool would
// otherwise keep polling.
await new Promise((resolve) => setTimeout(resolve, 1_200));
fgController.abort();
let fgError;
try {
	await pendingForeground;
} catch (error) {
	fgError = error;
}
await until(() => fgPid > 0 && !isAlivePid(fgPid), 3_000);
check(
	"aborting a foreground command kills it and reports Command aborted",
	fgWasAlive && /Command aborted/.test(String(fgError?.message)) && !isAlivePid(fgPid),
	JSON.stringify({ pid: fgPid, alive: isAlivePid(fgPid), error: String(fgError?.message).slice(0, 160) }),
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
		killLines.at(-1) === `Status: killed by user: ${KILL_REASON}` &&
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
		successLines.at(-1) === "Status: completed",
	JSON.stringify({ lines: successLines }),
);

const failedTask = await run("bash", { command: "sleep 2.5; echo boom; exit 3", run_in_background: true });
const failedId = idOf(failedTask.content[0].text);
const failedCard = failedId ? (await until(() => cardsFor(failedId).length > 0), cardsFor(failedId)[0]) : undefined;
check(
	"a failure card ends with the exit code and keeps the larger failure budget",
	failedId !== undefined &&
		String(failedCard?.content).includes("boom") &&
		String(failedCard?.content).split("\n").at(-1) === "Status: failed (exit 3)",
	JSON.stringify({ id: failedId, card: failedCard?.content }),
);

// ── 6c-bis. Excerpt shape: head and tail, middle named, size bounded ───────
// Far more output than any tier's budget, with a marker at each end so a head-only
// or tail-only excerpt fails the check.
const wide = (tag) =>
	`sleep 2.5; echo HEAD-${tag}; for i in $(seq 1 4000); do echo "pad-$i-xxxxxxxxxxxxxxxxxxxxxxxx"; done; echo TAIL-${tag}`;

const failedWide = await run("bash", { command: `${wide("FAIL")}; exit 3`, run_in_background: true });
const failedWideId = idOf(failedWide.content[0].text);
const failedWideCard = failedWideId
	? (await until(() => cardsFor(failedWideId).length > 0), cardsFor(failedWideId)[0])
	: undefined;
check(
	"a truncated failure excerpt keeps the first line and the last line, and names the omission",
	failedWideId !== undefined &&
		String(failedWideCard?.content).includes("HEAD-FAIL") &&
		String(failedWideCard?.content).includes("TAIL-FAIL") &&
		String(failedWideCard?.content).includes("…(middle omitted)"),
	JSON.stringify({ id: failedWideId, card: String(failedWideCard?.content).slice(0, 300) }),
);

const okWide = await run("bash", { command: wide("OK"), run_in_background: true });
const okWideId = idOf(okWide.content[0].text);
const okWideCard = okWideId ? (await until(() => cardsFor(okWideId).length > 0), cardsFor(okWideId)[0]) : undefined;
check(
	"a success card gets the 1 KB head-and-tail excerpt, and drops the middle",
	okWideId !== undefined &&
		String(okWideCard?.content).includes("HEAD-OK") &&
		String(okWideCard?.content).includes("TAIL-OK") &&
		String(okWideCard?.content).includes("…(middle omitted)") &&
		!String(okWideCard?.content).includes("pad-2000-"),
	JSON.stringify({ id: okWideId, card: String(okWideCard?.content).slice(0, 300) }),
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
		(tools.get("background_task").promptGuidelines ?? []).length === 0 &&
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
		autoLines.at(-1) === "Status: completed" &&
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
const bothAlive = pids.length === 2 && pids.every(isAlivePid);
await handlers.get("session_shutdown")();
await new Promise((resolve) => setTimeout(resolve, 1_000));
check(
	"shutdown kills every task of this session, explicit and auto-backgrounded alike",
	bothAlive && pids.every((pid) => !isAlivePid(pid)),
	JSON.stringify({ pids, bothAlive, alive: pids.map(isAlivePid) }),
);

// ── 10. The completion notice as a card, not raw text ───────────────────────
// pi hands a custom renderer's component straight to the transcript and wraps it in
// nothing, which is where "it looks like a message typed into my conversation" came from.
// Render the component here and assert on the lines it produces.
const { initTheme } = await import("@earendil-works/pi-coding-agent");
let themeReady = true;
try {
	initTheme();
} catch {
	themeReady = false;
}
const messageRenderer = messageRenderers.get("background-bash-completion");
// `bg` is required now: the card builds its own Box, so the renderer calls theme.bg.
const fakeTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };
const renderCard = (message, expanded) =>
	messageRenderer
		? String(messageRenderer(message, { expanded, outputPad: 1 }, fakeTheme).render(100).join("\n"))
		: "";
const synthetic = {
	customType: "background-bash-completion",
	content: "raw fallback text",
	details: {
		taskId: "bg-12345678",
		status: "completed",
		command: "echo hi",
		durationMs: 1500,
		logPath: "/tmp/example.log",
		tail: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
	},
};
const collapsed = renderCard(synthetic, false);
const expanded = renderCard(synthetic, true);
check(
	"the completion card is a card: Status title, command row, collapsed body, log footer",
	Boolean(messageRenderer) &&
		/⏵ bg-12345678 · Status: completed/.test(collapsed) &&
		collapsed.includes("$ echo hi") &&
		collapsed.includes("Log: /tmp/example.log") &&
		(!themeReady || /\(7 earlier lines,/.test(collapsed)) &&
		!/^line 1$/m.test(collapsed),
	JSON.stringify({ themeReady, collapsed: collapsed.slice(0, 400) }),
);
check(
	"expanding the card drops the hint and shows the whole tail",
	expanded.includes("line 12") &&
		(!themeReady || !/earlier lines/.test(expanded)) &&
		expanded.split("\n").length > collapsed.split("\n").length,
	JSON.stringify({ expanded: expanded.slice(0, 400) }),
);
// pi skips its own customMessageBg box as soon as a renderer is registered, so the frame
// has to be drawn by the renderer. Tag the background and require it on every line: that
// is a whole frame — no line of the card left outside it, top and bottom padding included.
const bgTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	bg: (_color, text) => `<bg>${text}</bg>`,
};
const framed = messageRenderer
	? String(messageRenderer(synthetic, { expanded: false, outputPad: 1 }, bgTheme).render(100).join("\n")).split("\n")
	: [];
check(
	"the card draws its own frame: every line sits inside the background box",
	framed.length > 0 && framed.every((line) => line.startsWith("<bg>") && line.endsWith("</bg>")),
	JSON.stringify(framed.slice(0, 3)),
);
// The frame's colour follows the outcome, by the tool cards' own rule. Read the colour off
// the theme instead of the lines, so the check survives a theme where two panels are close.
const frameKeys = (message) => {
	const seen = new Set();
	const keyTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (color, text) => (seen.add(color), text) };
	messageRenderer(message, { expanded: false, outputPad: 1 }, keyTheme).render(100);
	return [...seen].join(",");
};
const withStatus = (status) => ({ ...synthetic, details: { ...synthetic.details, status } });
check(
	"the frame colour follows the outcome, as pi's tool cards do",
	frameKeys(synthetic) === "toolSuccessBg" &&
		frameKeys(withStatus("failed (exit 1)")) === "toolErrorBg" &&
		frameKeys(withStatus("killed by user: swapped branch")) === "toolSuccessBg" &&
		frameKeys({ ...synthetic, details: { taskId: "bg-x" } }) === "customMessageBg",
	JSON.stringify({
		completed: frameKeys(synthetic),
		failed: frameKeys(withStatus("failed (exit 1)")),
		killed: frameKeys(withStatus("killed by user: swapped branch")),
		stale: frameKeys({ ...synthetic, details: { taskId: "bg-x" } }),
	}),
);
check(
	"an entry written before the card existed still renders its text",
	renderCard({ content: "old card\nStatus: completed", details: { taskId: "bg-x" } }, false).includes("old card"),
	"fallback path",
);
const notice = cards().find((m) => m.details?.status === "completed" && m.details?.logPath);
check(
	"the completion notice carries what the card needs (status, command, log, tail)",
	Boolean(notice) &&
		typeof notice.details.command === "string" &&
		typeof notice.details.durationMs === "number" &&
		typeof notice.details.tail === "string" &&
		notice.details.tail.length > 0,
	JSON.stringify(notice?.details ?? null).slice(0, 300),
);

// ── 8b. then_run: a change and the command that follows it, in one turn ─────
const editTool = tools.get("edit");
const writeTool = tools.get("write");
const propsOf = (tool) => Object.keys(tool?.parameters?.properties ?? {});
const requiredOf = (tool) => tool?.parameters?.required ?? [];

check(
	"edit and write are re-registered as the built-in tools plus an optional then_run",
	propsOf(editTool).join(",") === "path,edits,then_run" &&
		propsOf(writeTool).join(",") === "path,content,then_run" &&
		requiredOf(editTool).join(",") === "path,edits" &&
		requiredOf(writeTool).join(",") === "path,content",
	JSON.stringify({ edit: propsOf(editTool), write: propsOf(writeTool), editRequired: requiredOf(editTool) }),
);

const fusedPath = join(WORK_DIR, "fused.txt");
writeFileSync(fusedPath, "before\n");
const fused = await run("edit", {
	path: fusedPath,
	edits: [{ oldText: "before", newText: "after" }],
	then_run: { command: `cat ${fusedPath}` },
});
const fusedText = fused.content.map((block) => block.text).join("\n");
check(
	"a change with then_run lands first, then runs the command, in one result",
	// The command cats the file back, so reading "after" proves the change landed before
	// the command started — the ordering the two-turn baseline got from the round trip.
	fused.content.length === 2 &&
		/^Successfully replaced/.test(fused.content[0].text) &&
		fused.content[1].text.trim() === "after" &&
		fused.details?.thenRun?.command === `cat ${fusedPath}`,
	JSON.stringify({ content: fused.content, thenRun: fused.details?.thenRun }),
);

// A command that fails is an error, the same as it is for bash. The change is not rolled
// back though, so the file still carries the edit and its confirmation leads the message.
const failedCommand = await run("edit", {
	path: fusedPath,
	edits: [{ oldText: "after", newText: "after-2" }],
	then_run: { command: "exit 3" },
}).then(
	() => undefined,
	(error) => error.message,
);
check(
	"a failing command is an error that still carries the change, and the change is not rolled back",
	typeof failedCommand === "string" &&
		/^Successfully replaced/.test(failedCommand) &&
		/exited with code 3/.test(failedCommand) &&
		readFileSync(fusedPath, "utf-8") === "after-2\n",
	JSON.stringify({ message: failedCommand?.slice(0, 300), file: readFileSync(fusedPath, "utf-8") }),
);

const marker = join(WORK_DIR, "skipped-marker.txt");
const failedChange = await run("edit", {
	path: join(WORK_DIR, "no-such-file.txt"),
	edits: [{ oldText: "a", newText: "b" }],
	then_run: { command: `touch ${marker}` },
}).then(
	() => "resolved",
	(error) => `threw: ${error.message}`,
);
check(
	"a change that fails skips the command entirely",
	failedChange.startsWith("threw:") && !existsSync(marker),
	JSON.stringify({ failedChange: failedChange.slice(0, 160), markerExists: existsSync(marker) }),
);

const plain = await run("edit", { path: fusedPath, edits: [{ oldText: "after-2", newText: "plain" }] });
check(
	"an edit with no then_run is exactly the built-in result, diff and all",
	plain.content.length === 1 &&
		/^Successfully replaced/.test(plain.content[0].text) &&
		typeof plain.details?.diff === "string" &&
		plain.details?.thenRun === undefined,
	JSON.stringify({ content: plain.content, details: Object.keys(plain.details ?? {}) }),
);

const blockedCommand = await run("edit", {
	path: fusedPath,
	edits: [{ oldText: "plain", newText: "plain-2" }],
	then_run: { command: "pip install requests" },
}).then(
	() => undefined,
	(error) => error.message,
);
check(
	"a follow-up the uv policy refuses is an error that still carries the change",
	typeof blockedCommand === "string" &&
		/^Successfully replaced/.test(blockedCommand) &&
		/uv/.test(blockedCommand) &&
		readFileSync(fusedPath, "utf-8") === "plain-2\n",
	JSON.stringify(blockedCommand?.slice(0, 300)),
);

const wroteFused = await run("write", {
	path: join(WORK_DIR, "written.txt"),
	content: "written-by-fuse\n",
	then_run: { command: `cat ${join(WORK_DIR, "written.txt")}` },
});
const wroteText = wroteFused.content.map((block) => block.text).join("\n");
check(
	"write fuses the same way, keeping the built-in parameters and prompt text",
	wroteText.includes("Successfully wrote to") && wroteText.includes("written-by-fuse"),
	JSON.stringify(wroteText.slice(0, 300)),
);

// A follow-up that outruns the foreground window must end up on the same card any other
// long command does: still running, with the three ways out. Otherwise a fused turn would
// hand the model a handle it could not act on — a worse outcome than not fusing at all.
const longFused = await run("edit", {
	path: fusedPath,
	edits: [{ oldText: "plain-2", newText: "plain-3" }],
	then_run: { command: "sleep 5" },
});
const longText = longFused.content.map((block) => block.text).join("\n");
check(
	"a follow-up that outruns the foreground window auto-backgrounds with the three ways out",
	longText.includes("Successfully replaced") &&
		/auto-backgrounded after \d+s/.test(longText) &&
		/background_task wait /.test(longText) &&
		/background_task kill /.test(longText),
	JSON.stringify(longText.slice(0, 400)),
);

// The card: edit renders only its diff and write renders only errors, so a fused call needs
// the wrapper or the command's output reaches the model and never the person watching.
const renderContext = { state: {}, args: {}, lastComponent: undefined, isError: false, outputPad: 0 };
const themeStub = { fg: (_color, text) => text ?? "", bold: (text) => text ?? "" };
const thenRunDetails = { thenRun: { command: "cat x.py", text: "the-command-output" } };
const editCard = editTool.renderResult({ content: [], details: thenRunDetails }, {}, themeStub, renderContext);
const editCardPlain = editTool.renderResult({ content: [], details: undefined }, {}, themeStub, renderContext);
const writeCard = writeTool.renderResult({ content: [], details: thenRunDetails }, {}, themeStub, renderContext);
check(
	"the card shows the follow-up command and its output, and adds nothing when there was none",
	editCard.render(100).join("\n").includes("the-command-output") &&
		editCard.render(100).join("\n").includes("cat x.py") &&
		writeCard.render(100).join("\n").includes("the-command-output") &&
		editCardPlain.render(100).join("\n").trim() === "",
	JSON.stringify({
		edit: editCard.render(100).join("\n").slice(0, 200),
		editPlain: editCardPlain.render(100).join("\n"),
	}),
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
