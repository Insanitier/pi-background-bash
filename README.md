# pi-herdr-bash

Pi extension replacing `bash` with native foreground Bash plus detached background tasks.

## Install

```bash
pi install git:github.com/Insanitier/pi-herdr-bash
```

Run long commands with `background: true`. The extension launches a detached local process, returns a task ID immediately, and sends one completion message with exit code and a bounded log tail. It creates no Herdr pane.

`herdr_task` supports `list` and `kill`; it intentionally has no progress/output polling command.


Foreground `bash` calls keep Pi native behavior. Background logs persist under `/tmp/pi-herdr-bash/`.
