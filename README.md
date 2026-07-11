# pi-herdr-bash

Pi extension replacing `bash` with native foreground Bash plus Herdr-backed background tasks.

## Install

```bash
pi install git:github.com/Insanitier/pi-herdr-bash
```

Run long commands with `background: true`. The extension opens an unfocused Herdr pane, returns a task ID immediately, sends one completion message with exit code and a bounded log tail, then closes its task pane.

`herdr_task` supports `list` and `kill`; it intentionally has no progress/output polling command.

## Requirements

- Pi runs inside a Herdr pane (`HERDR_ENV=1`)
- `herdr` is available on `PATH`

Foreground `bash` calls keep Pi native behavior. Background logs persist under `/tmp/pi-herdr-bash/`.
