import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch as watchSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type BashToolDetails,
  createBashTool,
  type ExtensionAPI,
  type ExtensionContext,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ROOT_DIR = join(tmpdir(), "pi-herdr-bash");
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_LINES = 200;

type Task = {
  cwd: string;
  directory: string;
  id: string;
  paneId: string;
  startedAt: number;
  watcher?: FSWatcher;
  reporting?: boolean;
};

type TaskMetadata = Omit<Task, "watcher" | "reporting">;

type HerdrResponse<T> = { result: T };

type SplitResponse = HerdrResponse<{ pane: { pane_id: string } }>;

const taskSchema = Type.Object({
  action: StringEnum(["list", "kill"] as const),
  taskId: Type.Optional(Type.String({ description: "Task ID required by kill" })),
});

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  background: Type.Optional(
    Type.Boolean({ description: "Run in a Herdr pane and return immediately" }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Foreground timeout in seconds; unsupported for background commands" }),
  ),
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const taskRoot = (sessionId: string): string =>
  join(ROOT_DIR, Buffer.from(sessionId).toString("base64url"));

const taskPath = (sessionId: string, taskId: string): string => join(taskRoot(sessionId), taskId);

const taskStatus = (task: Task): "cancelled" | "finished" | "running" => {
  if (existsSync(join(task.directory, "cancelled"))) return "cancelled";
  return existsSync(join(task.directory, "done")) ? "finished" : "running";
};

const taskOutput = (task: Task): string => join(task.directory, "output.log");

const taskMetadata = (task: Task): TaskMetadata => ({
  cwd: task.cwd,
  directory: task.directory,
  id: task.id,
  paneId: task.paneId,
  startedAt: task.startedAt,
});

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function runHerdr(pi: ExtensionAPI, args: string[]): Promise<string> {
  const result = await pi.exec("herdr", args);
  if (result.code !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

async function writeTaskFiles(taskDirectory: string, command: string, token: string): Promise<void> {
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
printf '%s\\n' "$status" >${shellQuote(exitCodeTemporaryPath)}
mv ${shellQuote(exitCodeTemporaryPath)} ${shellQuote(exitCodePath)}
: >${shellQuote(doneTemporaryPath)}
mv ${shellQuote(doneTemporaryPath)} ${shellQuote(donePath)}
printf '%s %s\\n' ${shellQuote(token)} "$status"
exit "$status"
`,
    { mode: 0o700 },
  );
}

async function readTask(taskDirectory: string): Promise<Task | undefined> {
  try {
    const metadata = JSON.parse(await readFile(join(taskDirectory, "meta.json"), "utf8")) as TaskMetadata;
    if (
      typeof metadata.id !== "string" ||
      typeof metadata.paneId !== "string" ||
      typeof metadata.cwd !== "string" ||
      typeof metadata.startedAt !== "number" ||
      metadata.directory !== taskDirectory
    ) {
      return undefined;
    }
    return metadata;
  } catch {
    return undefined;
  }
}

function completionText(task: Task, exitCode: number, output: string): string {
  const result = truncateTail(output, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES });
  const title = exitCode === 0 ? "Background bash finished" : "Background bash failed";
  const header = `${title}: ${task.id} (exit ${exitCode})\nFull output: ${taskOutput(task)}`;
  if (!result.content) return header;

  const truncation = result.truncated
    ? `\n\n[Output truncated. Full output: ${taskOutput(task)}]`
    : "";
  return `${header}\n\n\`\`\`\n${result.content}\n\`\`\`${truncation}`;
}

export default function (pi: ExtensionAPI) {
  const tasks = new Map<string, Task>();

  const stopWatching = (task: Task): void => {
    task.watcher?.close();
    task.watcher = undefined;
  };

  const completeTask = async (task: Task): Promise<void> => {
    if (task.reporting || taskStatus(task) !== "finished") return;
    task.reporting = true;
    stopWatching(task);

    try {
      const exitCode = Number.parseInt(await readFile(join(task.directory, "exit-code"), "utf8"), 10);
      const output = await readFile(taskOutput(task), "utf8");
      if (!Number.isInteger(exitCode)) throw new Error("invalid exit code");

      await writeFile(join(task.directory, "reported"), "", { flag: "wx", mode: 0o600 });
      pi.sendMessage(
        {
          customType: "herdr-bash-completion",
          content: completionText(task, exitCode, output),
          details: { exitCode, taskId: task.id },
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      try {
        await runHerdr(pi, ["pane", "close", task.paneId]);
      } catch {
        // ponytail: completion is durable even if Herdr already closed task pane.
      }
      tasks.delete(task.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      task.reporting = false;
    }
  };

  const watchTask = (task: Task): void => {
    if (taskStatus(task) !== "running" || task.watcher) return;
    task.watcher = watchSync(task.directory, () => void completeTask(task));
    void completeTask(task);
  };

  const recoverTasks = async (ctx: ExtensionContext): Promise<void> => {
    const root = taskRoot(ctx.sessionManager.getSessionId());
    if (!existsSync(root)) return;

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || tasks.has(entry.name)) continue;
      const task = await readTask(join(root, entry.name));
      if (!task) continue;
      tasks.set(task.id, task);
      if (taskStatus(task) === "finished") void completeTask(task);
      else watchTask(task);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await recoverTasks(ctx);
  });

  pi.on("session_shutdown", () => {
    for (const task of tasks.values()) stopWatching(task);
    tasks.clear();
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute Bash. Set background: true to run in an unfocused Herdr pane and receive one completion message with exit code and final log tail. Foreground output uses Pi's native Bash behavior. Background commands do not support timeout.",
    promptSnippet: "Execute Bash commands; run long commands with background: true",
    promptGuidelines: [
      "Use bash with background: true for long commands; wait for its completion message instead of polling output.",
    ],
    parameters: bashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!params.background) {
        const nativeBash = createBashTool(ctx.cwd);
        return nativeBash.execute(
          toolCallId,
          params.timeout === undefined || params.timeout <= 0
            ? { command: params.command }
            : { command: params.command, timeout: params.timeout },
          signal,
          onUpdate,
        );
      }
      if (params.timeout !== undefined && params.timeout > 0) {
        throw new Error("Background bash does not support timeout; omit timeout and use herdr_task kill if needed.");
      }
      if (process.env.HERDR_ENV !== "1") {
        throw new Error("Background bash requires Pi to run inside a Herdr pane (HERDR_ENV=1).");
      }

      await recoverTasks(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      const id = randomBytes(8).toString("hex");
      const directory = taskPath(sessionId, id);
      const token = `__PI_HERDR_DONE_${id}__`;
      await ensureDirectory(directory);
      await writeTaskFiles(directory, params.command, token);

      let task: Task | undefined;
      try {
        const split = JSON.parse(
          await runHerdr(pi, ["pane", "split", "--current", "--direction", "right", "--cwd", ctx.cwd, "--no-focus"]),
        ) as SplitResponse;
        const paneId = split.result?.pane?.pane_id;
        if (typeof paneId !== "string") throw new Error("herdr pane split returned no pane ID");

        task = { cwd: ctx.cwd, directory, id, paneId, startedAt: Date.now() };
        await writeFile(join(directory, "meta.json"), JSON.stringify(taskMetadata(task)), {
          mode: 0o600,
        });
        tasks.set(id, task);
        watchTask(task);
        await runHerdr(pi, ["pane", "run", paneId, shellQuote(join(directory, "runner.sh"))]);
      } catch (error) {
        if (task) {
          stopWatching(task);
          tasks.delete(task.id);
          try {
            await runHerdr(pi, ["pane", "close", task.paneId]);
          } catch {
            // ponytail: launch cleanup is best-effort; Herdr may already have closed pane.
          }
        }
        throw error;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Started background task ${id} in Herdr pane ${task.paneId}. Completion will be reported automatically.`,
          },
        ],
        details: undefined as BashToolDetails | undefined,
      };
    },
  });

  pi.registerTool({
    name: "herdr_task",
    label: "herdr_task",
    description: "List or stop background Bash tasks started in this Pi session. Does not expose task output.",
    promptSnippet: "List or stop Herdr background Bash tasks",
    promptGuidelines: [
      "Use herdr_task only to list or stop a background Bash task; do not poll it for progress.",
    ],
    parameters: taskSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await recoverTasks(ctx);
      if (params.action === "list") {
        const lines = [...tasks.values()]
          .filter((task) => taskStatus(task) === "running")
          .map((task) => {
            const seconds = Math.floor((Date.now() - task.startedAt) / 1000);
            return `${task.id} ${taskStatus(task)} ${seconds}s pane=${task.paneId} cwd=${task.cwd}`;
          });
        return {
          content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No background tasks." }],
          details: { tasks: lines.length },
        };
      }

      if (!params.taskId) throw new Error("taskId is required for kill.");
      const task = tasks.get(params.taskId);
      if (!task) throw new Error(`Unknown background task: ${params.taskId}`);
      if (taskStatus(task) !== "running") {
        return {
          content: [{ type: "text" as const, text: `Task ${task.id} is already ${taskStatus(task)}.` }],
          details: undefined,
        };
      }

      stopWatching(task);
      await writeFile(join(task.directory, "cancelled"), "", { flag: "wx", mode: 0o600 });
      await runHerdr(pi, ["pane", "close", task.paneId]);
      return {
        content: [{ type: "text" as const, text: `Stopped background task ${task.id}.` }],
        details: undefined,
      };
    },
  });
}

if (process.env.HERDR_BASH_SELF_TEST === "1") {
  const quoted = shellQuote("a'b");
  if (quoted !== "'a'\"'\"'b'") throw new Error("shellQuote self-check failed");
}
