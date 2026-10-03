# pi-background-bash

Pi extension replacing `bash` with native foreground Bash plus detached background tasks.

## Install

```bash
pi install git:github.com/Insanitier/pi-background-bash
```

Run long commands with `run_in_background: true`. The extension launches a detached local process, returns a task ID immediately, and sends one completion message with exit code and a bounded log tail.

`background_task` supports `list`, `kill`, `wait`, and `output`. Completion is reported automatically, so there is no need to poll; `wait <id>` blocks until a task finishes, and `output <id>` returns its full log.


Foreground `bash` calls return the last 4 KB once the command exits within 2s; longer calls stream progress and auto-background after 120s. Detached task logs persist under `/tmp/pi-background-bash/`.
