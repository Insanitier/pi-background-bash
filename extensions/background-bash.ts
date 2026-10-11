import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { openSync, closeSync, fstatSync, readSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Constants ──────────────────────────────────────────────────────────────
const ROOT_DIR = join(tmpdir(), "pi-background-bash");
// Failure cards keep the old, larger tail; every other card is deliberately small.
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_LINES = 200;
const CARD_TAIL_CHARS = 2 * 1024;
const CARD_TAIL_LINES = 20;
// How long `wait` may block before handing control back with a snapshot. The point is
// that a wait must never be able to hide the model from a task for 40 minutes.
const WAIT_DEFAULT_SECONDS = 30;
const WAIT_MAX_SECONDS = 60;
// Overridable so the verify script can exercise the auto-background path.
const AUTO_BG_TIMEOUT_MS = Number(process.env.BACKGROUND_BASH_AUTO_BG_MS ?? 120_000);
const QUICK_COMPLETION_MS = 2_000;
const FOREGROUND_TAIL_BYTES = 4_096;
const PREVIEW_CHARS = 40;

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
  let proc: ChildProcess;
  try {
    proc = spawn("bash", ["-c", command], {
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

// ── Output reading ─────────────────────────────────────────────────────────
function readTail(logPath: string, maxChars: number): string {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return "(no output yet)";
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return "(no output yet)";
    const toRead = Math.min(size, maxChars);
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, Math.max(0, size - toRead));
    const body = buf.toString("utf-8");
    return size > maxChars
      ? `...[truncated, showing last ${maxChars} chars]\n${body}`
      : body;
  } catch {
    return "(no output yet)";
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

/** Last lines of a log, sanitized and bounded. Says so whenever it is not the whole story. */
function tailLines(logPath: string, maxLines: number, maxChars: number): string {
  const raw = readTail(logPath, maxChars * 3);
  if (raw === "(no output yet)") return "";
  const all = sanitize(raw).split("\n").filter((line) => line.trim() !== "");
  const kept = all.slice(-maxLines);
  const joined = kept.join("\n");
  const body = joined.length > maxChars ? joined.slice(-maxChars) : joined;
  const cut = raw.includes("...[truncated") || kept.length < all.length || body.length < joined.length;
  return `${cut ? "…(earlier output omitted)\n" : ""}${body}`;
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
  lines.push(opts.status);
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
  const tail = tailLines(logPath, CARD_TAIL_LINES, CARD_TAIL_CHARS);
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

// ── Extension entry ──────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("background-bash-completion", (message) =>
    new Text(message.content, 0, 0),
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
    pi.sendMessage(
      {
        customType: "background-bash-completion",
        content: taskCard(task, {
          tail: tailLines(logPath, failed ? MAX_OUTPUT_LINES : CARD_TAIL_LINES,
            failed ? MAX_OUTPUT_BYTES : CARD_TAIL_CHARS),
          logPath,
          status: failed ? `failed (exit ${exitCode})` : "completed",
        }),
        details: { exitCode, taskId: task.id },
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
      throw new Error(abortMessage(readTail(logPath, FOREGROUND_TAIL_BYTES), logPath));
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
      const output = readTail(logPath, FOREGROUND_TAIL_BYTES);
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
          const tail = readTail(logPath, FOREGROUND_TAIL_BYTES);
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
      const output = readTail(logPath, FOREGROUND_TAIL_BYTES);
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
    promptGuidelines: [
      "Use run_in_background=true for commands expected to run long.",
      "Never `sleep N` to wait for something — use background_task wait <id> or an until loop.",
      "Use background_task to list or kill running tasks.",
    ],
    parameters: bashParamSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { command: string; run_in_background?: boolean; description?: string };
      const ui = ctx.ui;

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

  // background_task — list / kill
  pi.registerTool({
    name: "background_task",
    label: "background_task",
    description: "List, stop, or wait for background tasks.",
    promptSnippet: "Manage background tasks: list, kill, wait",
    promptGuidelines: [
      "Background tasks report their own outcome — never busy-poll with list or sleep. When the next step depends on the result, `wait <id> [seconds]` blocks for a while and returns status, a fresh tail and the log path; it never ends the task.",
      "Every card carries a tail of the output plus its log path; read the log with bash for the rest.",
    ],
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
        const tail = tailLines(logPath, CARD_TAIL_LINES, CARD_TAIL_CHARS);
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
          const killedTail = tailLines(killedLogPath, CARD_TAIL_LINES, CARD_TAIL_CHARS);
          task.cancelled = true;
          try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
          // The log stays: the card above names it, and a kill is exactly the case where
          // the output is worth reading afterwards. Remove still deletes it.
          tasks.delete(task.id);
          renderSidebar(tasks, ui);
          const trimmed = reason.trim();
          pi.sendMessage(
            {
              customType: "background-bash-completion",
              content: taskCard(task, {
                tail: killedTail,
                logPath: killedLogPath,
                status: trimmed ? `killed by user: ${trimmed}` : "killed by user",
              }),
              details: { taskId: task.id, reason: trimmed || undefined },
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

  if (formatDuration(0) !== "0s") throw new Error("formatDuration 0");
  if (formatDuration(5000) !== "5s") throw new Error("formatDuration 5s");
  if (formatDuration(65000) !== "1m5s") throw new Error("formatDuration 65s");

  console.log("All self-checks passed.");
}