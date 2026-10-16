# pi-background-bash

Pi extension replacing `bash` with native foreground Bash plus detached background tasks.

## Install

```bash
pi install git:github.com/Insanitier/pi-background-bash
```

Run long commands with `run_in_background: true`. The extension launches a detached local process, returns a task ID immediately, and reports the outcome once with a bounded log tail.

`background_task` supports `list`, `kill`, and `wait`. Completion is reported automatically, so there is no need to poll. `wait <id> [seconds]` blocks for a bounded while (default 30s, max 60s, `0` looks now) and then returns the status, a fresh tail and the log path — the task itself is never affected, and a wait that timed out leaves the completion card to do its job. Never busy-poll with `list` or `sleep`.

Every card has the same shape — description (command, task ID), a bounded tail of the output, the log path, then the outcome on the last line:

```
"sleep 30; echo ready" (1m02s, 48c840e0001f2d19)
Epoch 1/6  loss=2.31
Epoch 2/6  loss=1.98
Log: /tmp/pi-background-bash/<session>/48c840e0001f2d19.log
completed
```

Excerpts are sanitized (escape sequences and control characters are stripped) and take the first and last whole lines, split evenly, so a table's header survives alongside the error at the end. Success and user-killed cards get 1 KB / 20 lines; failures get 8 KB / 100 lines, because that is where the evidence is. Those sizes come from real command output: 8 KB covers 97% of it whole, and 4 KB — the foreground budget, which cannot fall back on anything — covers 91%. The model reads the log with `bash` when it needs more than a card's excerpt.


Foreground `bash` calls return a head-and-tail excerpt of up to 4 KB once the command exits within 2s; longer calls stream progress and auto-background after 120s. Escape while one runs kills it — SIGKILL to its process group, the same as the built-in `bash` tool — and reports `Command aborted.` with the tail it printed and its log path (that log is kept, unlike the one from a command that finished).

There is one kind of task, not two: an explicit `run_in_background` and a 120s auto-background both end up as a single detached process with a single log at `/tmp/pi-background-bash/<session>/<id>.log`. Exiting Pi kills the tasks that session started — nothing is restored on the next start — and their log files are all that is left. A long job that must outlive Pi belongs in whatever submits it remotely (an `ssh` job), not in this extension.

A card that leaves a task running — the 120s auto-background, or an explicit `run_in_background` — ends with the three decisions that are actually open: does the next step depend on this result (`wait`), do you need a progress check (`wait 0` or read the log), and is there evidence the task is wrong or unwanted (`kill`)? A quiet log is not evidence of a hung job, so nothing pushes you towards killing one.

Escape during a `wait` returns that wait cancelled and still leaves the completion card to deliver the outcome. Logs of tasks killed on purpose survive; only `/bg` → Remove deletes them.

A completion notice rides along with the current turn (`steer`) rather than ending it, and every background task reports its outcome however quickly it finished. Only a `wait` that actually saw the task end suppresses the card, because that wait's own result already carries the outcome. Work a command detaches by hand (`nohup`, `setsid`, a trailing `&`) is deliberately outside all of this: keep long work in the submitted shell's foreground, or let `run_in_background` detach the tool.

## uv mode (always on)

Python tooling is routed through [uv](https://docs.astral.sh/uv/), absorbing the interception design from [mitsuhiko/agent-stuff's uv extension](https://github.com/mitsuhiko/agent-stuff). Like upstream it is unconditional: there is no setting and no env var.

- `pip`, `pip3`, `poetry` and `python -m pip|venv|py_compile` are refused, with the uv equivalent in the error, explicit interpreter paths (`.venv/bin/python -m pip`) included, which a PATH shim alone cannot see.
- `python` and `python3` run through `uv run` on the environment uv itself would have chosen — a project's `.venv`, an activated venv, `.python-version` — so `sys.prefix` and `sys.executable` are that environment's. Without uv they fall back to the interpreter that was already first on `PATH`, so a machine without uv keeps a working python (upstream exits 127 there).
- Which interpreter that is stays uv's call, not the shim's: `--python` with whatever `python3` sat next to the shim did not merely pick an interpreter, it made uv rebuild the environment around that one and throw away what was installed in a project's `.venv`. The shim asks `uv python find` instead and hands that answer back — with the shim directory off `PATH` for that one call, because uv identifies an interpreter by running it and a probe that lands on the shim re-enters uv.
- Blocking pip is the policy rather than a routing choice, so it stays blocked even without uv.
- Nothing else is touched: the shim directory is only prepended to `PATH` inside the spawned shell.

`npm test` runs the regression net (`verify.mjs`): module load, the background guidance, the card shape and ordering, sanitized tails, the completion rules above, deliberate stops, and the widget clearing.
