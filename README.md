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
Log: /tmp/pi-background-bash/<session>/48c840e0001f2d19/output.log
completed
```

Tails are sanitized (escape sequences and control characters are stripped) and capped at 2 KB / 20 lines for success and user-killed tasks, and at 32 KB / 200 lines for failures. The model reads the log with `bash` when it needs more than the tail.


Foreground `bash` calls return the last 4 KB once the command exits within 2s; longer calls stream progress and auto-background after 120s. Explicit `run_in_background` tasks keep their log in `/tmp/pi-background-bash/<session>/<id>/output.log`; auto-backgrounded ones in `/tmp/pi-bg/<id>.log`.

A card that leaves a task running — the 120s auto-background, or an explicit `run_in_background` — ends with the three decisions that are actually open: does the next step depend on this result (`wait`), do you need a progress check (`wait 0` or read the log), and is there evidence the task is wrong or unwanted (`kill`)? A quiet log is not evidence of a hung job, so nothing pushes you towards killing one.

Escape during a `wait` returns that wait cancelled and still leaves the completion card to deliver the outcome. Logs of tasks killed on purpose survive; only `/bg` → Remove deletes them.

A completion notice rides along with the current turn (`steer`) rather than ending it, and every background task reports its outcome however quickly it finished. Only a `wait` that actually saw the task end suppresses the card, because that wait's own result already carries the outcome. Work a command detaches by hand (`nohup`, `setsid`, a trailing `&`) is deliberately outside all of this: keep long work in the submitted shell's foreground, or let `run_in_background` detach the tool.

`npm test` runs the regression net (`verify.mjs`): module load, the background guidance, the card shape and ordering, sanitized tails, the completion rules above, deliberate stops, and the widget clearing.
