import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch as watchSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync, fstatSync, readSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionUIContext,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Constants ──────────────────────────────────────────────────────────────
const ROOT_DIR = join(tmpdir(), "pi-background-bash");
const LOG_DIR = "/tmp/pi-bg";
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_LINES = 200;
const AUTO_BG_TIMEOUT_MS = 120_000;
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
  // File-based task fields (explicit background via runner.sh)
  directory?: string;
  watcher?: FSWatcher;
  reporting?: boolean;
  // Direct spawn fields (auto-backgrounded)
  proc?: ChildProcess;
  logPath?: string;
  exit?: Promise<number | null>;
  done?: boolean; // marked when completed
};

// ── File helpers (explicit background via runner.sh) ───────────────────────
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const taskRoot = (sessionId: string): string =>
  join(ROOT_DIR, Buffer.from(sessionId).toString("base64url"));

const taskPath = (sessionId: string, taskId: string): string => join(taskRoot(sessionId), taskId);

const fileTaskOutput = (task: Task): string => join(task.directory!, "output.log");

const isFileTaskDone = (task: Task): boolean => {
  if (!task.directory) return false;
  if (existsSync(join(task.directory, "reported"))) return true;
  if (existsSync(join(task.directory, "cancelled"))) return true;
  return existsSync(join(task.directory, "done"));
};

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeTaskFiles(taskDirectory: string, command: string): Promise<void> {
  const commandPath = join(taskDirectory, "command.sh");
  const outputPath = join(taskDirectory, "output.log");
  const exitCodePath = join(taskDirectory, "exit-code");
  const exitCodeTemporaryPath = `${exitCodePath}.tmp`;
  const donePath = join(taskDirectory, "done");
  const doneTemporaryPath = `${donePath}.tmp`;
  const runnerPath = join(taskDirectory, "runner.sh");

  await writeFile(commandPath, command, { mode: 0o700 });
  await writeFile(
    runnerPath,
    `#!/usr/bin/env bash
set +e
/bin/bash ${shellQuote(commandPath)} >${shellQuote(outputPath)} 2>&1
status=$?
printf '%s\n' "$status" >${shellQuote(exitCodeTemporaryPath)}
mv ${shellQuote(exitCodeTemporaryPath)} ${shellQuote(exitCodePath)}
: >${shellQuote(doneTemporaryPath)}
mv ${shellQuote(doneTemporaryPath)} ${shellQuote(donePath)}
exit "$status"
`,
    { mode: 0o700 },
  );
}

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

// ── Formatting ──────────────────────────────────────────────────────────────
function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

function makeHeader(task: Task, exitCode: number): string {
  const dur = formatDuration(Date.now() - task.startedAt);
  const label = task.command.length > 60 ? task.command.slice(0, 57) + "..." : task.command;
  const display = `"${label}"`;
  if (exitCode === 0) return `✓ ${display} (${dur}, ${task.id})`;
  return `✗ ${display} (${dur}, ${task.id}, exit ${exitCode})`;
}

/** Suppress notification for tasks that finish very quickly (<2s) —
 *  the "started" message is still fresh, no need for a duplicate. */
function shouldNotify(task: Task): boolean {
  return Date.now() - task.startedAt >= 2_000;
}

function makeFailureDetails(output: string): string {
  const result = truncateTail(output, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES });
  return result.content || "";
}

// ── Status bar ──────────────────────────────────────────────────────────────
let sidebarLastKey: string | undefined;
let sidebarTicker: NodeJS.Timeout | undefined;

function renderSidebar(tasks: Map<string, Task>, ui: ExtensionUIContext): void {
  const running: Task[] = [];
  let doneCount = 0;
  let failCount = 0;
  for (const task of tasks.values()) {
    if (task.directory) {
      if (isFileTaskDone(task)) {
        if (task.exitCode !== undefined && task.exitCode !== 0) failCount++;
        else doneCount++;
      } else running.push(task);
    } else if (task.done) {
      if (task.exitCode !== undefined && task.exitCode !== 0) failCount++;
      else doneCount++;
    } else {
      running.push(task);
    }
  }

  if (running.length === 0 && doneCount === 0 && failCount === 0) {
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

  // ── File-based task lifecycle ────────────────────────────────────────────
  const stopWatching = (task: Task): void => {
    task.watcher?.close();
    task.watcher = undefined;
  };

  const completeFileTask = async (task: Task, ui: ExtensionUIContext): Promise<void> => {
    if (task.reporting || !task.directory) return;
    const done = existsSync(join(task.directory, "done"));
    const cancelled = existsSync(join(task.directory, "cancelled"));
    if (!done && !cancelled) return;

    if (cancelled) {
      task.reporting = true;
      stopWatching(task);
      renderSidebar(tasks, ui);
      return;
    }

    task.reporting = true;
    stopWatching(task);

    try {
      const exitCode = Number.parseInt(await readFile(join(task.directory, "exit-code"), "utf8"), 10);
      const output = await readFile(fileTaskOutput(task), "utf8");
      if (!Number.isInteger(exitCode)) throw new Error("invalid exit code");

      task.exitCode = exitCode;
      await writeFile(join(task.directory, "reported"), "", { flag: "wx", mode: 0o600 });

      if (sessionStale) return;
      const header = makeHeader(task, exitCode);
      if (shouldNotify(task)) {
        pi.sendMessage(
          {
            customType: "background-bash-completion",
            content: header,
            details: {
              exitCode,
              taskId: task.id,
              output: exitCode !== 0 ? makeFailureDetails(output) : undefined,
            },
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      }
      renderSidebar(tasks, ui);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      task.reporting = false;
    }
  };

  const watchFileTask = (task: Task, ui: ExtensionUIContext): void => {
    if (!task.directory || task.watcher) return;
    task.watcher = watchSync(task.directory, () => void completeFileTask(task, ui));
    void completeFileTask(task, ui);
  };

  // ── Direct task completion ───────────────────────────────────────────────
  const completeDirectTask = (task: Task, code: number | null, ui: ExtensionUIContext): void => {
    const logPath = task.logPath!;
    let output = "(no output)";
    try {
      output = readTail(logPath, MAX_OUTPUT_BYTES);
    } catch { /* best-effort */ }

    task.exitCode = code ?? 1;
    task.done = true;

    if (sessionStale) return;
    const exitCode = code ?? 1;
    const header = makeHeader(task, exitCode);
    pi.sendMessage(
      {
        customType: "background-bash-completion",
        content: header,
        details: {
          exitCode,
          taskId: task.id,
          output: exitCode !== 0 ? makeFailureDetails(output) : undefined,
        },
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    renderSidebar(tasks, ui);
  };

  // ── Session recovery ─────────────────────────────────────────────────────
  const recoverFileTasks = async (ui: ExtensionUIContext, sessionManager: { getSessionId: () => string }): Promise<void> => {
    const root = taskRoot(sessionManager.getSessionId());
    if (!existsSync(root)) return;

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || tasks.has(entry.name)) continue;
      const taskDir = join(root, entry.name);
      if (existsSync(join(taskDir, "reported"))) continue;
      try {
        const metaRaw = await readFile(join(taskDir, "meta.json"), "utf8");
        const meta = JSON.parse(metaRaw) as { id: string; pid: number; cwd: string; startedAt: number };
        const task: Task = {
          id: meta.id,
          pid: meta.pid,
          command: "",
          cwd: meta.cwd,
          startedAt: meta.startedAt,
          directory: taskDir,
        };
        try {
          task.command = (await readFile(join(taskDir, "command.sh"), "utf8")).trim();
        } catch { /* best-effort */ }
        tasks.set(task.id, task);
        if (!isFileTaskDone(task)) watchFileTask(task, ui);
        else void completeFileTask(task, ui);
      } catch { /* skip corrupt entry */ }
    }
  };

  // ── Foreground execution with auto-background ────────────────────────────
  const runForeground = async (
    command: string,
    ui: ExtensionUIContext,
    cwd: string,
    onUpdate?: (update: { content: { type: "text"; text: string }[]; details: undefined }) => void,
  ): Promise<{ content: { type: "text"; text: string }[]; details?: undefined }> => {
    const id = `bg-${randomBytes(4).toString("hex")}`;
    const logPath = join(LOG_DIR, `${id}.log`);

    const { proc, pid, exit } = spawnWithFileOutput(command, cwd, logPath);

    const task: Task = { id, command, pid, startedAt: Date.now(), cwd, proc, logPath, exit };
    tasks.set(id, task);
    renderSidebar(tasks, ui);

    // Quick completion window (2s)
    const quickResult = await Promise.race([
      exit.then((code) => ({ source: "exit" as const, code })),
      new Promise<{ source: "timeout" }>((r) => {
        const t = setTimeout(() => r({ source: "timeout" }), QUICK_COMPLETION_MS);
        t.unref();
      }),
    ]);

    if (quickResult.source === "exit") {
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
      new Promise<{ source: "timeout" }>((r) => {
        const t = setTimeout(() => r({ source: "timeout" }), AUTO_BG_TIMEOUT_MS);
        t.unref();
      }),
    ]);

    if (pollTimer) clearInterval(pollTimer);

    if (raceResult.source === "exit") {
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
    proc.unref();
    exit.then((code) => completeDirectTask(task, code, ui));

    return {
      content: [{
        type: "text",
        text: `Auto-backgrounded as ${id} (pid ${pid}). Will notify on completion.\nCommand: ${command}\nOutput: ${logPath}`,
      }],
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
    action: StringEnum(["list", "kill", "wait", "output"] as const),
    taskId: Type.Optional(Type.String({ description: "Task ID" })),
  });

  // ── Register tools ───────────────────────────────────────────────────────

  // bash — override with auto-background
  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Run a bash command. Foreground commands auto-background after 120s and keep running; " +
      "completion is reported via notification — commands never fail from timeout. " +
      "Set run_in_background=true to start in background immediately. " +
      "Use background_task to list or kill running tasks.",
    promptSnippet: "Run shell commands; long-running commands auto-background after 120s or use run_in_background=true",
    promptGuidelines: [
      "Foreground commands auto-background after 120s and keep running — commands never fail from timeout.",
      "Use run_in_background=true for commands expected to run long.",
      "Never `sleep N` to wait for something — use background_task wait <id> or an until loop.",
      "Use background_task to list or kill running tasks.",
    ],
    parameters: bashParamSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { command: string; run_in_background?: boolean; description?: string };
      const ui = ctx.ui;

      if (p.run_in_background) {
        // Explicit background — use runner.sh (file-based)
        const sessionId = ctx.sessionManager.getSessionId();
        const id = randomBytes(8).toString("hex");
        const directory = taskPath(sessionId, id);
        await ensureDirectory(directory);
        await writeTaskFiles(directory, p.command);

        let task: Task | undefined;
        try {
          const child = spawn(join(directory, "runner.sh"), [], {
            cwd: ctx.cwd,
            detached: true,
            stdio: "ignore",
          });
          if (!child.pid) throw new Error("background process did not start");
          child.unref();
          task = { id, pid: child.pid, command: p.command, cwd: ctx.cwd, startedAt: Date.now(), directory };
          await writeFile(join(directory, "meta.json"), JSON.stringify({
            id, pid: child.pid, cwd: ctx.cwd, startedAt: task.startedAt,
          }), { mode: 0o600 });
          tasks.set(id, task);
          watchFileTask(task, ui);
          renderSidebar(tasks, ui);
        } catch (error) {
          if (task) {
            stopWatching(task);
            tasks.delete(task.id);
            try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
          }
          throw error;
        }

        return {
          content: [{
            type: "text" as const,
            text: `Started detached background task ${id} (pid ${task?.pid}). Completion will be reported automatically.`,
          }],
          details: undefined,
        };
      }

      // Foreground with auto-background
      return runForeground(p.command, ui, ctx.cwd, onUpdate);
    },
  });

  // background_task — list / kill
  pi.registerTool({
    name: "background_task",
    label: "background_task",
    description: "List, stop, wait for, or read output of background tasks.",
    promptSnippet: "Manage background tasks: list, kill, wait, output",
    promptGuidelines: [
      "Use background_task to list, kill, wait for, or read output of a background task.",
      "Background tasks auto-notify on completion — don't poll. Use wait to block until a task finishes.",
      "Completions report status only (success: no output; failure: truncated tail). Use output <id> to read the FULL log when you need the details.",
    ],
    parameters: taskSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ui = ctx.ui;

      if (params.action === "list") {
        const lines: string[] = [];
        for (const task of tasks.values()) {
          const running = task.directory ? !isFileTaskDone(task) : !task.done;
          if (!running) continue;
          const seconds = Math.floor((Date.now() - task.startedAt) / 1000);
          const kind = task.directory ? "bg" : "auto";
          lines.push(`${task.id} ${kind} ${seconds}s`);
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

        const isRunning = (): boolean => task.directory ? !isFileTaskDone(task) : !task.done;
        if (!isRunning()) {
          return {
            content: [{ type: "text" as const, text: `Task ${task.id} already finished (exit ${task.exitCode ?? "?"}).` }],
            details: undefined,
          };
        }

        // Block until the task completes — replaces polling
        while (isRunning()) {
          await new Promise(r => setTimeout(r, 500));
        }

        const dur = formatDuration(Date.now() - task.startedAt);
        const label = task.command.length > 40 ? task.command.slice(0, 37) + "..." : task.command;
        const status = task.exitCode === 0 ? "completed" : task.exitCode !== undefined ? `failed (exit ${task.exitCode})` : "done";
        return {
          content: [{ type: "text" as const, text: `Task ${task.id} ${status} (${dur}): ${label}` }],
          details: undefined,
        };
      }

      if (params.action === "output") {
        if (!params.taskId) throw new Error("taskId is required for output.");
        const t = tasks.get(params.taskId)
          ?? [...tasks.values()].find(j => j.id === params.taskId || j.id.endsWith(params.taskId));
        if (!t) throw new Error(`Unknown background task: ${params.taskId}`);

        let output: string;
        if (t.directory) {
          const p = fileTaskOutput(t);
          if (!existsSync(p)) return { content: [{ type: "text" as const, text: "No output yet." }], details: undefined };
          output = (await readFile(p, "utf8")) || "(empty)";
        } else if (t.logPath) {
          try {
            output = (await readFile(t.logPath, "utf8")) || "(empty)";
          } catch {
            return { content: [{ type: "text" as const, text: "No output yet." }], details: undefined };
          }
        } else {
          return { content: [{ type: "text" as const, text: "No output available." }], details: undefined };
        }
        return {
          content: [{ type: "text" as const, text: `Full output of ${t.id}:\n${output}` }],
          details: undefined,
        };
      }

      if (!params.taskId) throw new Error("taskId is required for kill.");
      const task = tasks.get(params.taskId);
      if (!task) throw new Error(`Unknown background task: ${params.taskId}`);

      if (task.directory) {
        const done = existsSync(join(task.directory, "done"));
        const cancelled = existsSync(join(task.directory, "cancelled"));
        if (done || cancelled) {
          return {
            content: [{ type: "text" as const, text: `Task ${task.id} is already finished.` }],
            details: undefined,
          };
        }
        stopWatching(task);
        try { process.kill(-task.pid, "SIGTERM"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await writeFile(join(task.directory, "cancelled"), "", { flag: "wx", mode: 0o600 });
      } else {
        try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
        try { if (task.logPath) unlinkSync(task.logPath); } catch { /* ok */ }
        tasks.delete(task.id);
      }
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
        const running = [...tasks.values()].filter(t => {
          if (t.directory) return !isFileTaskDone(t);
          return !t.done;
        }).sort((a, b) => b.startedAt - a.startedAt);
        const terminal = [...tasks.values()].filter(t => {
          if (t.directory) return isFileTaskDone(t);
          return t.done;
        }).sort((a, b) => b.startedAt - a.startedAt);
        const all = [...running, ...terminal];

        if (all.length === 0) {
          ui.notify("No background tasks", "info");
          return;
        }

        const items = all.map(t => {
          const isTerminal = t.done || (t.directory && isFileTaskDone(t));
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
        const isRunning = task.directory ? !isFileTaskDone(task) : !task.done;

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
            if (task.directory) {
              const p = fileTaskOutput(task);
              output = await readFile(p, "utf8") || "(empty)";
            } else if (task.logPath) {
              output = await readFile(task.logPath, "utf8") || "(empty)";
            }
          } catch { /* best-effort */ }
          const dur = formatDuration(Date.now() - task.startedAt);
          const meta = `Command: ${task.command}\nPID: ${task.pid} · Duration: ${dur}\nLog: ${task.logPath || task.directory}`;
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
          if (task.directory) {
            stopWatching(task);
            try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
            await writeFile(join(task.directory, "cancelled"), "", { flag: "wx", mode: 0o600 });
          } else {
            try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
            try { if (task.logPath) unlinkSync(task.logPath); } catch { /* ok */ }
            tasks.delete(task.id);
          }
          renderSidebar(tasks, ui);
          const cmdLabel = task.command.length > 60 ? task.command.slice(0, 57) + "..." : task.command;
          const reasonSuffix = reason.trim() ? `: ${reason.trim()}` : "";
          pi.sendMessage(
            {
              customType: "background-bash-completion",
              content: `⊘ ${cmdLabel} (${task.id}) — killed by user${reasonSuffix}`,
              details: { taskId: task.id, reason: reason.trim() || undefined },
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
          continue;
        }

        if (action === "Remove") {
          stopWatching(task);
          try { if (task.logPath) unlinkSync(task.logPath); } catch { /* ok */ }
          tasks.delete(task.id);
          renderSidebar(tasks, ui);
          ui.notify(`Removed ${label}`, "info");
          continue;
        }
      }
    },
  });

  // ── Event hooks ───────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    await recoverFileTasks(ctx.ui, ctx.sessionManager);
    renderSidebar(tasks, ctx.ui);
  });

  pi.on("session_shutdown", () => {
    sessionStale = true;
    stopSidebarTicker();
    for (const task of tasks.values()) {
      stopWatching(task);
      if (task.proc && !task.directory) {
        try { process.kill(-task.pid, "SIGTERM"); } catch { /* best-effort */ }
      }
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
  const quoted = shellQuote("a'b");
  if (quoted !== "'a'\"'\"'b'") throw new Error("shellQuote self-check failed");

  const lines = new Text("x".repeat(308), 0, 0).render(95);
  if (lines.some((line) => visibleWidth(line) > 95)) {
    throw new Error("completion renderer self-check failed");
  }

  if (formatDuration(0) !== "0s") throw new Error("formatDuration 0");
  if (formatDuration(5000) !== "5s") throw new Error("formatDuration 5s");
  if (formatDuration(65000) !== "1m5s") throw new Error("formatDuration 65s");

  console.log("All self-checks passed.");
}