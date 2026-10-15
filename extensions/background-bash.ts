import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync, fstatSync, readSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  keyHint,
  truncateToVisualLines,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Constants ──────────────────────────────────────────────────────────────
const ROOT_DIR = join(tmpdir(), "pi-background-bash");
// Every excerpt is the head and the tail of the log, split evenly, so a table's header
// survives next to the error at the end. Failure cards carry evidence — a traceback or an
// error block — so they get a larger budget than the other cards, which are pointers to a
// log the model can read. The sizes come from real command output: an 8 KB failure excerpt
// covers 97% of it whole, and the 32 KB it replaced only reached 99%.
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_OUTPUT_LINES = 100;
const CARD_EXCERPT_CHARS = 1024;
const CARD_EXCERPT_LINES = 20;
// How long `wait` may block before handing control back with a snapshot. The point is
// that a wait must never be able to hide the model from a task for 40 minutes.
const WAIT_DEFAULT_SECONDS = 30;
const WAIT_MAX_SECONDS = 60;
// Overridable so the verify script can exercise the auto-background path.
const AUTO_BG_TIMEOUT_MS = Number(process.env.BACKGROUND_BASH_AUTO_BG_MS ?? 120_000);
const QUICK_COMPLETION_MS = 2_000;
// The foreground return is the only view of a command that finished — its log is deleted
// right after — so this tier is not a pointer and must not be sized like one. 4 KB is the
// knee of the coverage curve: 91% of real command output fits whole, against 60% at 1 KB.
const FOREGROUND_EXCERPT_BYTES = 4_096;
const FOREGROUND_EXCERPT_LINES = 80;
const PREVIEW_CHARS = 40;
// Python tooling is routed through uv, the way mitsuhiko/agent-stuff's uv extension does
// it: a PATH shim for anything the model types, plus a spawn-time check for explicit paths
// (`.venv/bin/python -m pip`) that a PATH shim cannot see. Unconditional, as upstream: no
// setting, no env var.
const SHIM_DIR = join(ROOT_DIR, "shims");

// ── Types ──────────────────────────────────────────────────────────────────
type Task = {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  cwd: string;
  exitCode?: number;
  proc: ChildProcess;
  logPath: string;
  exit: Promise<number | null>;
  done?: boolean; // marked when completed
  cancelled?: boolean; // stopped on purpose: it must not also report completion
};

/** One directory per session, holding one log file per task. Keyed by session so two Pi
 *  sessions never share a path. Nothing is restored from it: a task's process is killed on
 *  shutdown, so after a reload its log file is all that is left. */
const logDir = (sessionId: string): string =>
  join(ROOT_DIR, Buffer.from(sessionId).toString("base64url"));

// ── Direct spawn helper ────────────────────────────────────────────────────
function spawnWithFileOutput(command: string, cwd: string, logPath: string): {
  proc: ChildProcess;
  pid: number;
  exit: Promise<number | null>;
} {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  // The single spawn exit, so the shims cover the foreground and the explicit background
  // path alike. The card still shows the command the model asked for, not this prefix.
  const shellCommand = `export PATH=${JSON.stringify(SHIM_DIR)}:"$PATH"\n${command}`;
  let proc: ChildProcess;
  try {
    proc = spawn("bash", ["-c", shellCommand], {
      stdio: ["ignore", fd, fd],
      cwd,
      detached: true,
      env: { ...process.env },
    });
  } finally {
    closeSync(fd);
  }

  if (!proc.pid) {
    try { unlinkSync(logPath); } catch { /* ok */ }
    throw new Error("Failed to spawn process");
  }

  const exit = new Promise<number | null>((resolve) => {
    proc.on("close", (code) => resolve(code));
    proc.on("error", () => resolve(1));
  });

  return { proc, pid: proc.pid, exit };
}

/** Kill a task's whole process group, the way the built-in bash tool does on abort.
 *  SIGKILL, not SIGTERM: an interrupted foreground command is meant to be gone now. */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** What a killed foreground command reports: the tail it managed to print, then where the rest is. */
function abortMessage(tail: string, logPath: string): string {
  return ["Command aborted.", tail.trim(), `Log: ${logPath}`].filter(Boolean).join("\n");
}

/* No uv on PATH? The two halves differ on purpose. `python`/`python3` are a routing
 * choice, so the shim falls back to the interpreter that was already first on PATH —
 * a machine without uv keeps a working python. Blocking pip is the policy itself, so it
 * stays blocked (the error names the uv command to use instead), exactly like upstream. */

/** Python tooling uv replaces, refused before anything is spawned. Mirrors the checks in
 *  mitsuhiko/agent-stuff's uv extension, including explicit interpreter paths. */
function uvBlockedMessage(command: string): string | null {
  const at = String.raw`(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?`;
  const python = String.raw`python(?:3(?:\.\d+)?)?\b[^\n;|&]*`;
  const pip = (name: string): string => [
    `Error: ${name} is disabled. Use uv instead:`,
    "",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
  ].join("\n");
  const rules: Array<[RegExp, string]> = [
    [new RegExp(`${at}pip\\s*(?:$|\\s)`, "m"), pip("pip")],
    [new RegExp(`${at}pip3\\s*(?:$|\\s)`, "m"), pip("pip3")],
    [new RegExp(`${at}poetry\\s*(?:$|\\s)`, "m"), [
      "Error: poetry is disabled. Use uv instead:",
      "",
      "  To initialize a project: uv init",
      "  To add a dependency: uv add PACKAGE",
      "  To sync dependencies: uv sync",
      "  To run commands: uv run COMMAND",
    ].join("\n")],
    [new RegExp(`${at}${python}(?:\\s-m\\s*pip\\b|\\s-mpip\\b)`, "m"), pip("'python -m pip'")],
    [new RegExp(`${at}${python}(?:\\s-m\\s*venv\\b|\\s-mvenv\\b)`, "m"), [
      "Error: 'python -m venv' is disabled. Use uv instead:",
      "",
      "  To create a virtual environment: uv venv",
    ].join("\n")],
    [new RegExp(`${at}${python}(?:\\s-m\\s*py_compile\\b|\\s-mpy_compile\\b)`, "m"), [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
    ].join("\n")],
  ];
  for (const [pattern, message] of rules) if (pattern.test(command)) return message;
  return null;
}

/** The shim scripts, written once into SHIM_DIR. PATH interception is what makes the
 *  redirect robust: `xargs python3`, a pipeline, a nested `bash -c` all hit the shim. */
function shimScripts(): Record<string, string> {
  const refuse = (title: string, lines: string[]): string =>
    `#!/usr/bin/env bash\n` +
    `echo "Error: ${title} is disabled. Use uv instead:" >&2\n` +
    lines.map((line) => `echo "  ${line}" >&2\n`).join("") +
    "exit 1\n";
  const interpreter = (name: string): string => `#!/usr/bin/env bash
# Run the real interpreter through uv, skipping this shim directory when resolving it.
shim_dir="$(cd "$(dirname "$0")" && pwd)"
real=""
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  [ "$(cd "$(dirname "$candidate")" && pwd)" = "$shim_dir" ] && continue
  real="$candidate"
  break
done < <(type -aP python3 2>/dev/null || type -aP python 2>/dev/null)
# Redirect through uv; without uv, fall back to the interpreter so nothing gets worse.
if command -v uv >/dev/null 2>&1; then
  if [ -n "$real" ]; then
    exec uv run --python "$real" python "$@"
  fi
  exec uv run python "$@"
fi
if [ -n "$real" ]; then
  exec "$real" "$@"
fi
echo "Error: neither uv nor a real ${name} interpreter was found on PATH." >&2
exit 1
`;
  return {
    pip: refuse("pip", [
      "To install a package for a script: uv run --with PACKAGE python script.py",
      "To add a dependency to the project: uv add PACKAGE",
    ]),
    pip3: refuse("pip3", [
      "To install a package for a script: uv run --with PACKAGE python script.py",
      "To add a dependency to the project: uv add PACKAGE",
    ]),
    poetry: refuse("poetry", [
      "To initialize a project: uv init",
      "To add a dependency: uv add PACKAGE",
      "To sync dependencies: uv sync",
      "To run commands: uv run COMMAND",
    ]),
    python: interpreter("python"),
    python3: interpreter("python3"),
  };
}

let shimsReady = false;
async function ensureShims(): Promise<void> {
  if (shimsReady) return;
  mkdirSync(SHIM_DIR, { recursive: true });
  // Always rewrite: skipping existing files would freeze the first version ever written,
  // so a shim fix in a later release would never take effect.
  for (const [name, body] of Object.entries(shimScripts())) {
    await writeFile(join(SHIM_DIR, name), body, { mode: 0o755 });
  }
  shimsReady = true;
}

// ── Output reading ─────────────────────────────────────────────────────────
/** One end of a log, read as bytes. It distinguishes "nothing to show" from "could not read
 *  it", because an unreadable log must never be reported as an empty command. */
type LogSlice = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

function errnoOf(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : "unknown error";
}

function readEnd(logPath: string, from: "start" | "end", maxChars: number): LogSlice {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch (error) {
    return { ok: false, reason: errnoOf(error) };
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return { ok: true, text: "" };
    const toRead = Math.min(size, maxChars);
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, from === "end" ? Math.max(0, size - toRead) : 0);
    return { ok: true, text: buf.toString("utf-8") };
  } catch (error) {
    return { ok: false, reason: errnoOf(error) };
  } finally {
    closeSync(fd);
  }
}

/** Strip terminal escapes and control characters; keep tabs and newlines.
 *  Without this a progress bar or a colouring library floods the card. */
function sanitize(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) {
        i += 1;
        while (i + 1 < text.length && (text.charCodeAt(++i) < 0x40 || text.charCodeAt(i) > 0x7e)) { /* skip */ }
      } else if (next === 0x5d) {
        i += 1;
        while (i + 1 < text.length) {
          const c = text.charCodeAt(++i);
          if (c === 0x07) break;
          if (c === 0x1b && text.charCodeAt(i + 1) === 0x5c) { i += 1; break; }
        }
      } else {
        i += 1;
      }
      continue;
    }
    if (code === 0x0a || code === 0x09) out += text[i];
    else if (code === 0x0d) out += "\n";
    else if (code >= 0x20 && code !== 0x7f) out += text[i];
  }
  return out;
}

/** Whole lines from one end of a chunk, stopping before the budget rather than cutting a
 *  line in half. One over-long line is still kept, then clamped, rather than dropped. */
function completeLines(text: string, maxLines: number, maxChars: number, fromEnd: boolean): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const ordered = fromEnd ? [...lines].reverse() : lines;
  const kept: string[] = [];
  let used = 0;
  for (const line of ordered) {
    const cost = Buffer.byteLength(line, "utf8") + (kept.length === 0 ? 0 : 1);
    if (kept.length > 0 && (kept.length >= maxLines || used + cost > maxChars)) break;
    kept.push(line);
    used += cost;
  }
  const joined = (fromEnd ? kept.reverse() : kept).join("\n");
  return Buffer.byteLength(joined, "utf8") <= maxChars
    ? joined
    : fromEnd ? joined.slice(-maxChars) : joined.slice(0, maxChars);
}

/** Head and tail of a log — sanitized, whole lines, bounded — so the top of the output and
 *  the bottom of it both reach the model. Says so whenever it is not the whole story, and
 *  says why when there is nothing to show at all. */
function excerptLines(logPath: string, maxLines: number, maxChars: number): string {
  const headChars = Math.ceil(maxChars / 2);
  const tailChars = maxChars - headChars;
  const headLines = Math.ceil(maxLines / 2);
  const tailLines = maxLines - headLines;
  // Over-read both windows so whole-line trimming still has lines left to drop.
  const head = readEnd(logPath, "start", headChars * 2);
  const tail = readEnd(logPath, "end", tailChars * 2);
  if (!head.ok) return `…(excerpt unavailable: ${head.reason})`;
  if (!tail.ok) return `…(excerpt unavailable: ${tail.reason})`;
  if (head.text === "" && tail.text === "") return "";
  const cleanHead = sanitize(head.text);
  const cleanTail = sanitize(tail.text);
  // Both windows saw the same bytes, so the log fits in one window: show it whole.
  if (cleanHead === cleanTail) return completeLines(cleanHead, maxLines, maxChars, false);
  const headText = completeLines(cleanHead, headLines, headChars, false);
  const tailText = completeLines(cleanTail, tailLines, tailChars, true);
  if (headText === "" || tailText === "") return headText || tailText;
  return `${headText}\n…(middle omitted)\n${tailText}`;
}

// ── Formatting ──────────────────────────────────────────────────────────────
function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

const shortCommand = (command: string): string =>
  command.length > 60 ? `${command.slice(0, 57)}...` : command;

/** Every card has the same shape: description (command, id) → tail → log → outcome last. */
function taskCard(task: Task, opts: { tail?: string; logPath?: string; status: string; duration?: number }): string {
  const shown = opts.duration ?? Date.now() - task.startedAt;
  const lines = [`"${shortCommand(task.command)}" (${formatDuration(shown)}, ${task.id})`];
  if (opts.tail) lines.push(opts.tail);
  if (opts.logPath) lines.push(`Log: ${opts.logPath}`);
  lines.push(`Status: ${opts.status}`);
  return lines.join("\n");
}

/** The three decisions a running task actually poses, on every card that leaves one running.
 *  Deliberately not "looks stuck → kill": a quiet log is not evidence of a hung job. */
function runningHints(id: string): string {
  return [
    `Depends on this result? → background_task wait ${id} [seconds] — status, tail, log path; the task keeps running`,
    `Need a progress check? → background_task wait ${id} 0, or read the log path above`,
    `Decided it is wrong or unwanted? → background_task kill ${id}`,
  ].join("\n");
}

/** A task that just moved to the background: what it is, what it printed so far, how to leave it. */
function backgroundCard(task: Task, logPath: string): string {
  const tail = excerptLines(logPath, CARD_EXCERPT_LINES, CARD_EXCERPT_CHARS);
  const seconds = Math.max(1, Math.round(AUTO_BG_TIMEOUT_MS / 1000));
  return [
    `⟳ "${shortCommand(task.command)}" (${task.id}) — auto-backgrounded after ${seconds}s; still running; full log: ${logPath}`,
    ...(tail ? [tail] : []),
    runningHints(task.id),
  ].join("\n");
}

/** A task started in the background on purpose: nothing has been printed yet. */
function startCard(task: Task, logPath: string): string {
  return [
    `▶ "${shortCommand(task.command)}" (${task.id}) — running in the background; full log: ${logPath}`,
    runningHints(task.id),
  ].join("\n");
}



// ── Status bar ──────────────────────────────────────────────────────────────
let sidebarLastKey: string | undefined;
let sidebarTicker: NodeJS.Timeout | undefined;

function renderSidebar(tasks: Map<string, Task>, ui: ExtensionUIContext): void {
  const running: Task[] = [];
  let doneCount = 0;
  let failCount = 0;
  for (const task of tasks.values()) {
    if (task.done) {
      if (task.exitCode !== undefined && task.exitCode !== 0) failCount++;
      else doneCount++;
    } else {
      running.push(task);
    }
  }

  // Finished tasks only feed the counts: once nothing runs, the widget and status line
  // go away instead of lingering for the rest of the session.
  if (running.length === 0) {
    if (sidebarTicker) {
      clearInterval(sidebarTicker);
      sidebarTicker = undefined;
    }
    if (sidebarLastKey !== undefined) {
      sidebarLastKey = undefined;
      ui.setWidget("background-tasks", undefined);
      ui.setStatus("background-tasks", undefined);
    }
    return;
  }

  const pills: string[] = [];
  for (const t of running) {
    const dur = formatDuration(Date.now() - t.startedAt);
    pills.push(`▶ ${t.id.slice(-6)}: ${t.command.slice(0, PREVIEW_CHARS)} (${dur})`);
  }

  const parts: string[] = [];
  if (running.length > 0) parts.push(`${running.length} running`);
  if (doneCount > 0) parts.push(`${doneCount} done`);
  if (failCount > 0) parts.push(`${failCount} failed`);
  const statusText = `▶ ${parts.join(", ")}`;
  const key = `${pills.join("\n")}|${statusText}`;
  if (key !== sidebarLastKey) {
    sidebarLastKey = key;
    ui.setWidget("background-tasks", pills);
    ui.setStatus("background-tasks", statusText);
  }

  if (!sidebarTicker) {
    sidebarTicker = setInterval(() => renderSidebar(tasks, ui), 1000);
    sidebarTicker.unref();
  }
}

function stopSidebarTicker(): void {
  if (sidebarTicker) {
    clearInterval(sidebarTicker);
    sidebarTicker = undefined;
  }
}

// ── The card the user sees ───────────────────────────────────────────────────
// pi hands a custom renderer's component straight to the transcript and wraps it in
// nothing. It also skips its own customMessageBg box here: a registered renderer is taken
// to handle its own styling, so the frame is this renderer's job, not pi's. Hence a Box
// around the shape the built-in tool cards use: a title row, muted metadata, a body that
// collapses to a preview behind the real "ctrl+o to expand" hint, and a muted footer. Its
// colour follows the outcome by the tool cards' own rule — a failure gets toolErrorBg,
// anything else toolSuccessBg — and a card with no outcome keeps customMessageBg. `details` carries the pieces; `content` stays the model-facing
// text, and it remains the fallback for entries written before this renderer existed, so
// replaying an old session still works.
interface CompletionCardDetails {
  taskId: string;
  status?: string;
  exitCode?: number;
  reason?: string;
  command?: string;
  durationMs?: number;
  logPath?: string;
  tail?: string;
}

/** Visual lines a collapsed card shows, the same count the built-in bash card uses. */
const CARD_PREVIEW_LINES = 5;

// ── Extension entry ──────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer<CompletionCardDetails>(
    "background-bash-completion",
    (message, options, theme) => {
      const d = message.details;
      const pad = Math.max(0, options.outputPad ?? 1);
      // The frame lives here, not in pi — see the comment above. Padding comes from the
      // Box, so nothing below indents by hand and every child renders at the inner width.
      // `killed by user` is not a failure: the kill that did it reports success, and so
      // does this card, which is why the test is the status text and not an exit code.
      const status = d?.status;
      const frameBg = !status
        ? "customMessageBg"
        : status.startsWith("failed")
          ? "toolErrorBg"
          : "toolSuccessBg";
      const card = new Box(pad, 1, (line) => theme.bg(frameBg, line));
      // No details: an entry from before this card existed. Render its text as it was.
      if (!d?.status) {
        card.addChild(new Text(message.content, 0, 0));
        return card;
      }

      const muted = (text: string): string => theme.fg("muted", text);
      // One row, cut to the width so a long command cannot wrap the card out of shape.
      const row = (text: string) => ({
        render: (width: number) => [truncateToWidth(text, Math.max(1, width), "…")],
        invalidate: () => {},
      });

      card.addChild(
        new Text(theme.fg("toolTitle", theme.bold(`⏵ ${d.taskId} · Status: ${d.status}`)), 0, 0),
      );
      if (d.command) card.addChild(row(muted(`$ ${d.command}`)));

      const tail = (d.tail ?? "").trimEnd();
      if (tail) {
        const styled = tail
          .split("\n")
          .map((line) => theme.fg("toolOutput", line))
          .join("\n");
        if (options.expanded) {
          card.addChild(new Text(styled, 0, 0));
        } else {
          card.addChild({
            render: (width: number) => {
              const preview = truncateToVisualLines(styled, CARD_PREVIEW_LINES, Math.max(1, width));
              if (!preview.skippedCount) return preview.visualLines;
              const hint =
                muted(`... (${preview.skippedCount} earlier lines,`) +
                ` ${keyHint("app.tools.expand", "to expand")}` +
                muted(")");
              return [hint, ...preview.visualLines];
            },
            invalidate: () => {},
          });
        }
      }

      if (d.logPath) {
        const took = d.durationMs !== undefined ? ` · took ${formatDuration(d.durationMs)}` : "";
        card.addChild(new Text(muted(`Log: ${d.logPath}${took}`), 0, 0));
      }
      return card;
    },
  );

  const tasks = new Map<string, Task>();
  let sessionStale = false;
  // Tasks with a `background_task wait` in flight: that waiter hands the same outcome
  // to the model itself, so a completion card for it would only repeat it.
  const waitInFlight = new Set<string>();

  // ── Direct task completion ───────────────────────────────────────────────
  const completeDirectTask = (task: Task, code: number | null, ui: ExtensionUIContext): void => {
    const logPath = task.logPath;
    task.exitCode = code ?? 1;
    task.done = true;

    if (sessionStale) return;
    // Stopped on purpose, or already handed to a waiter: no completion card.
    if (task.cancelled || waitInFlight.has(task.id)) {
      renderSidebar(tasks, ui);
      return;
    }
    const exitCode = code ?? 1;
    const failed = exitCode !== 0;
    const status = failed ? `failed (exit ${exitCode})` : "completed";
    const tail = excerptLines(logPath, failed ? MAX_OUTPUT_LINES : CARD_EXCERPT_LINES,
      failed ? MAX_OUTPUT_BYTES : CARD_EXCERPT_CHARS);
    // One duration for both the text and the card, so they cannot disagree.
    const shown = Date.now() - task.startedAt;
    const details: CompletionCardDetails = {
      taskId: task.id,
      status,
      exitCode,
      command: task.command,
      durationMs: shown,
      logPath,
      tail,
    };
    pi.sendMessage(
      {
        customType: "background-bash-completion",
        content: taskCard(task, { tail, logPath, status, duration: shown }),
        details,
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    renderSidebar(tasks, ui);
  };

  // ── Foreground execution with auto-background ────────────────────────────
  const runForeground = async (
    command: string,
    ui: ExtensionUIContext,
    cwd: string,
    logDirPath: string,
    signal: AbortSignal | undefined,
    onUpdate?: (update: { content: { type: "text"; text: string }[]; details: undefined }) => void,
  ): Promise<{ content: { type: "text"; text: string }[]; details?: undefined }> => {
    if (signal?.aborted) throw new Error("Command aborted.");

    const id = `bg-${randomBytes(4).toString("hex")}`;
    const logPath = join(logDirPath, `${id}.log`);

    const { proc, pid, exit } = spawnWithFileOutput(command, cwd, logPath);

    const task: Task = { id, command, pid, startedAt: Date.now(), cwd, proc, logPath, exit };
    tasks.set(id, task);
    renderSidebar(tasks, ui);

    // Escape during a foreground command kills it, like the built-in bash tool. Both races
    // below carry the same arm, so either window aborts through this one path.
    let stopListening = (): void => { /* no signal, nothing to remove */ };
    const aborted = new Promise<{ source: "abort" }>((resolve) => {
      if (!signal) return; // an arm that never settles
      const onAbort = (): void => {
        killTree(pid);
        resolve({ source: "abort" });
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        stopListening = () => signal.removeEventListener("abort", onAbort);
      }
    });
    const finishAborted = (): never => {
      stopListening();
      tasks.delete(id);
      renderSidebar(tasks, ui);
      throw new Error(
        abortMessage(excerptLines(logPath, FOREGROUND_EXCERPT_LINES, FOREGROUND_EXCERPT_BYTES), logPath),
      );
    };

    // Quick completion window (2s)
    const quickResult = await Promise.race([
      exit.then((code) => ({ source: "exit" as const, code })),
      aborted,
      new Promise<{ source: "timeout" }>((r) => {
        const t = setTimeout(() => r({ source: "timeout" }), QUICK_COMPLETION_MS);
        t.unref();
      }),
    ]);

    if (quickResult.source === "abort") finishAborted();

    if (quickResult.source === "exit") {
      stopListening();
      tasks.delete(id);
      renderSidebar(tasks, ui);
      const output = excerptLines(logPath, FOREGROUND_EXCERPT_LINES, FOREGROUND_EXCERPT_BYTES);
      try { unlinkSync(logPath); } catch { /* ok */ }
      if (quickResult.code !== 0 && quickResult.code !== null) {
        throw new Error(output || `Command exited with code ${quickResult.code}`);
      }
      return { content: [{ type: "text", text: output || "(no output)" }], details: undefined };
    }

    // Still running — poll progress
    let pollTimer: NodeJS.Timeout | undefined;
    let lastPollSize = 0;
    const startPolling = () => {
      pollTimer = setInterval(() => {
        try {
          const fd = openSync(logPath, "r");
          const { size } = fstatSync(fd);
          closeSync(fd);
          if (size === lastPollSize) return;
          lastPollSize = size;
          const tail = excerptLines(logPath, FOREGROUND_EXCERPT_LINES, FOREGROUND_EXCERPT_BYTES);
          onUpdate?.({ content: [{ type: "text", text: tail }], details: undefined });
        } catch { /* file not ready */ }
      }, 1000);
      pollTimer.unref();
    };
    startPolling();

    // Race: completion vs auto-background timeout
    const raceResult = await Promise.race([
      exit.then((code) => ({ source: "exit" as const, code })),
      aborted,
      new Promise<{ source: "timeout" }>((r) => {
        const t = setTimeout(() => r({ source: "timeout" }), AUTO_BG_TIMEOUT_MS);
        t.unref();
      }),
    ]);

    if (pollTimer) clearInterval(pollTimer);

    if (raceResult.source === "abort") finishAborted();

    if (raceResult.source === "exit") {
      stopListening();
      tasks.delete(id);
      renderSidebar(tasks, ui);
      const output = excerptLines(logPath, FOREGROUND_EXCERPT_LINES, FOREGROUND_EXCERPT_BYTES);
      try { unlinkSync(logPath); } catch { /* ok */ }
      if (raceResult.code !== 0 && raceResult.code !== null) {
        throw new Error(output || `Command exited with code ${raceResult.code}`);
      }
      return { content: [{ type: "text", text: output || "(no output)" }], details: undefined };
    }

    // Auto-background: detach process, notify on completion
    stopListening();
    proc.unref();
    exit.then((code) => completeDirectTask(task, code, ui));

    return {
      content: [{ type: "text", text: backgroundCard(task, logPath) }],
      details: undefined,
    };
  };

  // ── Schema ───────────────────────────────────────────────────────────────
  const bashParamSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    run_in_background: Type.Optional(Type.Boolean({
      description: "Start in background immediately (fire-and-forget)",
    })),
    description: Type.Optional(Type.String({
      description: "Optional human-readable label for the task",
    })),
  });

  const taskSchema = Type.Object({
    action: StringEnum(["list", "kill", "wait"] as const),
    taskId: Type.Optional(Type.String({ description: "Task ID" })),
    seconds: Type.Optional(Type.Number({
      description: "wait only: how long to block before returning a snapshot (default 30, max 60, 0 = look now)",
    })),
  });

  // ── Register tools ───────────────────────────────────────────────────────

  // bash — override with auto-background
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Run a bash command. Long-running foreground commands auto-background after 120s and keep running.",
    promptSnippet: "Run shell commands (long-running ones auto-background after 120s)",
    parameters: bashParamSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { command: string; run_in_background?: boolean; description?: string };
      const ui = ctx.ui;

      await ensureShims();
      const blocked = uvBlockedMessage(p.command);
      if (blocked) throw new Error(blocked);

      if (p.run_in_background) {
        // Explicit background: the same detached-process shape as the auto-background
        // path, only the log lives under this session's log directory.
        const id = randomBytes(8).toString("hex");
        const logPath = join(logDir(ctx.sessionManager.getSessionId()), `${id}.log`);
        const { proc, pid, exit } = spawnWithFileOutput(p.command, ctx.cwd, logPath);

        const task: Task = {
          id, command: p.command, pid, startedAt: Date.now(), cwd: ctx.cwd, proc, logPath, exit,
        };
        tasks.set(id, task);
        renderSidebar(tasks, ui);
        proc.unref();
        exit.then((code) => completeDirectTask(task, code, ui));

        return {
          content: [{ type: "text" as const, text: startCard(task, logPath) }],
          details: undefined,
        };
      }

      // Foreground with auto-background
      return runForeground(p.command, ui, ctx.cwd, logDir(ctx.sessionManager.getSessionId()), signal, onUpdate);
    },
  });

  // ── then_run: fuse a change and the command that follows it ────────────────
  // "Change the file, then run it" costs two model turns: the change has to land before
  // the command starts, and two tool calls cannot be ordered against each other. `then_run`
  // collapses the pair — the change runs, and if it landed the command runs in the same
  // call, both results in one observation. When the change fails the command is skipped,
  // which needs no code of its own: the failure throws before the command is reached.
  //
  // The command goes through `runForeground`, the same path `bash` uses, so it keeps the uv
  // shims, the 2s quick window, the streaming poll, and the 120s auto-background with its
  // three-decision card. One way a command runs in this package, not two.
  //
  // A command that did not run, or did not succeed, is an error — the same as it is for
  // `bash`. The change itself already landed and is not rolled back, so its confirmation
  // rides in front of the reason rather than being replaced by it.
  //
  // There is no timeout parameter on purpose: the foreground semantics above already are
  // this package's answer to "how long is too long", and a second, parallel timeout would be
  // a rule to remember rather than a behaviour to rely on.
  const thenRunSchema = Type.Optional(
    Type.Object(
      {
        command: Type.String({
          description:
            "Command to run on this file once the change lands — run it, build it, start or restart it, install it, or check it. Skipped if the change itself fails; a non-zero exit is reported but the change is kept.",
        }),
      },
      { description: "Run this command on the file once the change lands" },
    ),
  );

  /** The command the model asked to run after the change, if it asked for one. */
  const thenRunCommand = (input: unknown): string | undefined => {
    const asked = (input as { then_run?: { command?: unknown } } | null)?.then_run?.command;
    return typeof asked === "string" && asked.trim() ? asked.trim() : undefined;
  };

  /** Run it, and return what the model should read. Throws when the command did not run or
   *  did not succeed: `runForeground` returns on completion and on auto-background, and
   *  throws for everything else, so the two cases need no classifying here. */
  const runThenRun = async (
    command: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: { type: "text"; text: string }[]; details: undefined }) => void) | undefined,
  ): Promise<string> => {
    await ensureShims();
    const blocked = uvBlockedMessage(command);
    if (blocked) throw new Error(blocked);
    const result = await runForeground(
      command,
      ctx.ui,
      ctx.cwd,
      logDir(ctx.sessionManager.getSessionId()),
      signal,
      onUpdate,
    );
    return result.content.map((block) => block.text).join("\n").trim() || "(no output)";
  };

  /** The built-in definitions capture their cwd in a closure, so keep one per directory
   *  instead of rebuilding them on every call and every redraw. */
  const memoizeByCwd = <T>(make: (cwd: string) => T): ((cwd: string) => T) => {
    const cache = new Map<string, T>();
    return (cwd) => {
      const hit = cache.get(cwd);
      if (hit) return hit;
      const made = make(cwd);
      cache.set(cwd, made);
      return made;
    };
  };
  const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd));
  const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd));

  // edit and write, each with the optional follow-up command. Everything else — the schema,
  // the prompt text, the argument shims, the renderers — is inherited from the built-in
  // definitions, so this stays a superset of the tool the model already knew.
  for (const base of [baseEdit, baseWrite]) {
    const template = base(process.cwd());
    const renderResult = template.renderResult;
    pi.registerTool({
      ...template,
      parameters: Type.Object({
        ...(template.parameters as unknown as { properties: Record<string, unknown> }).properties,
        then_run: thenRunSchema,
      }),
      async execute(toolCallId, input, signal, onUpdate, ctx) {
        const { then_run: _followUp, ...change } = input as Record<string, unknown>;
        // The change first. When it throws the command is never reached, which is the
        // "skipped if the change failed" rule.
        const result = await base(ctx.cwd).execute(toolCallId, change, signal, onUpdate, ctx);
        const command = thenRunCommand(input);
        if (!command) return result;
        try {
          const text = await runThenRun(command, ctx, signal, onUpdate);
          return {
            content: [...result.content, { type: "text" as const, text }],
            details: { ...(result.details as object | undefined), thenRun: { command, text } },
          };
        } catch (error) {
          const changeText = result.content.map((block) => block.text).join("\n");
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error([changeText, reason].filter(Boolean).join("\n\n"));
        }
      },
      renderResult(result, options, theme, context) {
        const rendered = renderResult?.(result, options, theme, context);
        const fused = (result.details as { thenRun?: { command: string; text: string } } | undefined)?.thenRun;
        if (!rendered || !fused) return rendered;
        // edit renders only its diff and write renders only errors, so without this the
        // command's output would reach the model and never the person watching.
        const container = new Container();
        container.addChild(rendered);
        container.addChild(new Text(`\n$ ${fused.command}\n${fused.text}`, 0, 0));
        return container;
      },
    });
  }

  // background_task — list / kill
  pi.registerTool({
    name: "background_task",
    label: "background_task",
    // The snippet names the three actions; a description that only reordered them said
    // nothing the list had not, so it carries what the list cannot: what each one does.
    description: "List, kill, or wait for background tasks. wait blocks for a while, then reports status, a fresh tail and the log path — the task keeps running; kill stops one and keeps its log.",
    promptSnippet: "Manage background tasks: list, kill, wait",
    parameters: taskSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ui = ctx.ui;

      if (params.action === "list") {
        const lines: string[] = [];
        for (const task of tasks.values()) {
          if (task.done) continue;
          const seconds = Math.floor((Date.now() - task.startedAt) / 1000);
          lines.push(`${task.id} ${seconds}s`);
        }
        renderSidebar(tasks, ui);
        return {
          content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No running background tasks." }],
          details: { tasks: lines.length },
        };
      }

      if (params.action === "wait") {
        if (!params.taskId) throw new Error("taskId is required for wait.");
        const task = tasks.get(params.taskId);
        if (!task) throw new Error(`Unknown background task: ${params.taskId}`);

        const isRunning = (): boolean => !task.done;
        const seconds = Math.min(WAIT_MAX_SECONDS, Math.max(0, params.seconds ?? WAIT_DEFAULT_SECONDS));
        const deadline = Date.now() + seconds * 1_000;

        // Registered only while this wait is live AND hands the outcome over: on timeout
        // the registration is dropped again, because then the completion card is the only
        // thing left that can deliver the outcome. Never claimed after a timeout or an
        // abort — a wait that did not see the end must not suppress the card that did.
        let handedOver = !isRunning();
        if (!handedOver) {
          waitInFlight.add(task.id);
          try {
            while (isRunning()) {
              if (signal?.aborted || Date.now() >= deadline) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            handedOver = !isRunning();
          } finally {
            if (!handedOver) waitInFlight.delete(task.id);
          }
        }

        const waited = formatDuration(Date.now() - (deadline - seconds * 1_000));
        const logPath = task.logPath;
        const tail = excerptLines(logPath, CARD_EXCERPT_LINES, CARD_EXCERPT_CHARS);
        const status = handedOver
          ? task.exitCode === 0 ? "completed" : `failed (exit ${task.exitCode ?? "?"})`
          : signal?.aborted
            ? `wait cancelled after ${waited}; still running, unaffected`
            : `still running after ${waited} (not a failure; the task is unaffected)`;
        return {
          content: [{
            type: "text" as const,
            text: taskCard(task, { tail, logPath, status, duration: Date.now() - task.startedAt }),
          }],
          details: undefined,
        };
      }

      // Cards carry the output the model needs; the log path on each card is the way
      // back to the rest. Fail loudly instead of falling into the kill branch.
      if (params.action !== "kill") throw new Error(`Unsupported action: ${params.action}`);
      if (!params.taskId) throw new Error("taskId is required for kill.");
      const task = tasks.get(params.taskId);
      if (!task) throw new Error(`Unknown background task: ${params.taskId}`);
      if (task.done) {
        return {
          content: [{ type: "text" as const, text: `Task ${task.id} is already finished.` }],
          details: undefined,
        };
      }
      // Signal first: a kill that fails must leave the task reporting, not silently vanish.
      try { process.kill(-task.pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      task.cancelled = true;
      // The log stays: the card names it, and a kill is exactly the case where the output
      // is worth reading afterwards. /bg → Remove still deletes it.
      tasks.delete(task.id);
      renderSidebar(tasks, ui);
      return {
        content: [{ type: "text" as const, text: `Stopped background task ${task.id}.` }],
        details: undefined,
      };
    },
  });

  // ── /bg command — interactive task manager ────────────────────────────────
  pi.registerCommand("bg", {
    description: "Open the interactive background task manager",
    handler: async (_args, ctx) => {
      const ui = ctx.ui as ExtensionUIContext;

      while (true) {
        const running = [...tasks.values()].filter(t => !t.done)
          .sort((a, b) => b.startedAt - a.startedAt);
        const terminal = [...tasks.values()].filter(t => t.done)
          .sort((a, b) => b.startedAt - a.startedAt);
        const all = [...running, ...terminal];

        if (all.length === 0) {
          ui.notify("No background tasks", "info");
          return;
        }

        const items = all.map(t => {
          const isTerminal = t.done;
          const failed = t.exitCode !== undefined && t.exitCode !== 0;
          const icon = failed ? "✗" : isTerminal ? "✓" : "▶";
          const cmd = t.command.length > 40 ? t.command.slice(0, 37) + "..." : t.command;
          const status = isTerminal ? (failed ? "failed" : "done") : `running (${formatDuration(Date.now() - t.startedAt)})`;
          return `${icon} ${t.id.slice(-8)}: ${cmd} · ${status}`;
        });

        const choice = await ui.select("Background Tasks", items);
        if (choice === undefined) return;

        const idx = items.indexOf(choice);
        const task = all[idx];
        if (!task) return;

        // Show actions for selected task
        const label = task.id.slice(-8);
        const isRunning = !task.done;

        const actions = isRunning
          ? ["Show Output", "Kill", "← Back"]
          : ["Show Output", "Remove", "← Back"];

        const cmdTitle = task.command.length > 40 ? task.command.slice(0, 37) + "..." : task.command;
        const action = await ui.select(`▶ ${label}: ${cmdTitle}`, actions);
        if (action === undefined) return;

        if (action === "← Back") continue;

        if (action === "Show Output") {
          let output = "(no output)";
          try {
            output = await readFile(task.logPath, "utf8") || "(empty)";
          } catch { /* best-effort */ }
          const dur = formatDuration(Date.now() - task.startedAt);
          const meta = `Command: ${task.command}\nPID: ${task.pid} · Duration: ${dur}\nLog: ${task.logPath}`;
          await ui.editor(`Output: ${label}`, `${meta}\n\n--- OUTPUT ---\n${output}`);
          continue;
        }

        if (action === "Kill") {
          // Ask for a reason so the agent isn't left guessing why
          const reason = await ui.input(
            `Kill task ${label}?`,
            "Reason (sent to agent, optional)",
          );
          if (reason === undefined) continue; // cancelled — abort kill
          const killedLogPath = task.logPath;
          const killedTail = excerptLines(killedLogPath, CARD_EXCERPT_LINES, CARD_EXCERPT_CHARS);
          task.cancelled = true;
          try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
          // The log stays: the card above names it, and a kill is exactly the case where
          // the output is worth reading afterwards. Remove still deletes it.
          tasks.delete(task.id);
          renderSidebar(tasks, ui);
          const trimmed = reason.trim();
          const killStatus = trimmed ? `killed by user: ${trimmed}` : "killed by user";
          const killShown = Date.now() - task.startedAt;
          const killDetails: CompletionCardDetails = {
            taskId: task.id,
            status: killStatus,
            reason: trimmed || undefined,
            command: task.command,
            durationMs: killShown,
            logPath: killedLogPath,
            tail: killedTail,
          };
          pi.sendMessage(
            {
              customType: "background-bash-completion",
              content: taskCard(task, {
                tail: killedTail,
                logPath: killedLogPath,
                status: killStatus,
                duration: killShown,
              }),
              details: killDetails,
              display: true,
            },
            // Same reason as the completion notice: followUp can be dropped before the
            // run would stop, and this message is the only way the typed reason reaches
            // the model.
            { deliverAs: "steer", triggerTurn: true },
          );
          continue;
        }

        if (action === "Remove") {
          try { unlinkSync(task.logPath); } catch { /* ok */ }
          tasks.delete(task.id);
          renderSidebar(tasks, ui);
          ui.notify(`Removed ${label}`, "info");
          continue;
        }
      }
    },
  });

  // ── Event hooks ───────────────────────────────────────────────────────────
  pi.on("session_shutdown", () => {
    sessionStale = true;
    stopSidebarTicker();
    // Nothing is restored on the next start: a reload kills what this session started.
    for (const task of tasks.values()) {
      try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
    }
    tasks.clear();
  });

  pi.on("agent_start", async (_event, ctx) => {
    renderSidebar(tasks, ctx.ui);
  });

  pi.on("agent_end", async (_event, ctx) => {
    renderSidebar(tasks, ctx.ui);
  });
}

// ── Self-tests ──────────────────────────────────────────────────────────────
if (process.env.BACKGROUND_BASH_SELF_TEST === "1") {
  const lines = new Text("x".repeat(308), 0, 0).render(95);
  if (lines.some((line) => visibleWidth(line) > 95)) {
    throw new Error("completion renderer self-check failed");
  }

  const stripped = sanitize("\u001b[31mred\u001b[0m\tplain\u0007done");
  if (stripped !== "red\tplaindone") throw new Error(`sanitize self-check failed: ${JSON.stringify(stripped)}`);

  if (uvBlockedMessage("echo hi") !== null) throw new Error("uv self-check: plain command blocked");
  if (uvBlockedMessage("pip install requests") === null) throw new Error("uv self-check: pip not blocked");
  if (uvBlockedMessage(".venv/bin/python -m pip install requests") === null) {
    throw new Error("uv self-check: explicit interpreter path not blocked");
  }
  if (uvBlockedMessage("python3 train.py --epochs 6") !== null) {
    throw new Error("uv self-check: a plain python3 run must be redirected, not blocked");
  }

  if (formatDuration(0) !== "0s") throw new Error("formatDuration 0");
  if (formatDuration(5000) !== "5s") throw new Error("formatDuration 5s");
  if (formatDuration(65000) !== "1m5s") throw new Error("formatDuration 65s");

  console.log("All self-checks passed.");
}