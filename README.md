# Codex Terminal Manager

A Mac-first prototype for letting one Codex session supervise and gently steer another Codex session running in a terminal.

The first prototype uses `tmux` as the control boundary:

- The manager Codex runs wherever the user prefers, such as Ghostty, iTerm2, or a web terminal.
- The worker Codex runs inside a named `tmux` session.
- A small local control script captures worker output, tracks inactivity, reads explicit worker status files, and can send short nudges back into the worker session.

The goal is not full autonomy. The goal is lightweight supervision for Codex tasks that mostly need progress checks, occasional nudges, test reruns, or clean stop/resume handling.

## Prototype Shape

```text
manager terminal
  Codex manager session
    |
    | runs workerctl commands
    v
tmux session: codex-worker-a
  pane 1: Codex worker session
  pane 2: optional dev server, tests, or logs

.codex-workers/
  worker-a/
    status.json
    transcript.txt
    events.jsonl
```

## Initial Milestones

1. Document the control model and safety constraints.
2. Build `workerctl` commands for creating, inspecting, nudging, and stopping a worker session.
3. Add idle detection using `tmux capture-pane`, process checks, and explicit `status.json` timestamps.
4. Define a worker prompt contract so the worker reports `state`, `current_task`, `next_action`, and `blocker`.
5. Test with one real Codex worker on low-risk local tasks.

See [docs/prototype-plan.md](docs/prototype-plan.md) for the detailed plan.

## Non-Goals For The First Prototype

- Cross-platform support.
- Browser-first orchestration.
- Full terminal emulator automation.
- Autonomous merging or destructive git actions.
- Managing many workers at once.

## Working Assumption

`tmux` should own the worker PTY. Ghostty, iTerm2, Terminal.app, or `ttyd` can be viewers, but they should not be the source of truth for orchestration.

## Current MVP Usage

From the repo root:

```bash
scripts/workerctl doctor
scripts/workerctl create worker-a --cwd /path/to/repo --task "Inspect the failing test and report the blocker."
scripts/workerctl list
scripts/workerctl status worker-a
scripts/workerctl idle-check worker-a
scripts/workerctl capture worker-a
scripts/workerctl nudge worker-a "Please summarize current progress and next action."
scripts/workerctl stop worker-a
```

For a lifecycle smoke test without sending the worker prompt into Codex:

```bash
scripts/workerctl create smoke --cwd "$PWD" --task "Smoke test only." --no-send-contract
scripts/workerctl status smoke
scripts/workerctl idle-check smoke
scripts/workerctl stop smoke
```

Worker runtime files are stored under `.codex-workers/` and are intentionally ignored by git.

To have `create` classify the initial Codex screen, use `--wait-ready`:

```bash
scripts/workerctl create worker-a \
  --cwd /path/to/repo \
  --task "Inspect the failing test and report the blocker." \
  --wait-ready
```

If the target directory is one you intentionally trust, `--accept-trust` lets the startup watcher accept Codex's workspace trust prompt:

```bash
scripts/workerctl create worker-a \
  --cwd /path/to/repo \
  --task "Inspect the failing test and report the blocker." \
  --wait-ready \
  --accept-trust
```
