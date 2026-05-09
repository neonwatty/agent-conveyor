---
name: manage-codex-workers
description: Start, supervise, nudge, inspect, interrupt, and stop tmux-backed Codex worker sessions using the codex-terminal-manager workerctl tool. Use when the user asks to create or manage another Codex terminal/session, watch or supervise a worker, send a nudge, attach to a worker terminal, inspect worker status/capture/events, interrupt busy-wait states, or clean up worker sessions.
---

# Manage Codex Workers

Use `/Users/neonwatty/Desktop/codex-terminal-manager` as the control repo unless the user specifies another checkout.

## Preflight

1. Work from the control repo:
   ```bash
   cd /Users/neonwatty/Desktop/codex-terminal-manager
   ```
2. Prefer the repo script path, which does not depend on shell profile setup:
   ```bash
   scripts/workerctl doctor
   ```
3. Check for existing workers before choosing a name:
   ```bash
   scripts/workerctl list
   tmux list-sessions 2>/dev/null | rg '^codex-' || true
   ```

## Start A Worker

Use a fresh worker name unless the user explicitly wants to reuse prior state.

For a manual startup check, prefer `start-test`. It verifies that the worker can
update its ignored status file and leaves the tmux session running for attach:

```bash
scripts/workerctl start-test <name> \
  --cwd <target-repo> \
  --accept-trust \
  --open
```

The command prints the attach and stop commands. Do not stop a manual test worker
unless the user asks or you pass `--stop-after`.

Guardrail: `workerctl` refuses to open a second terminal window for the same
worker after one terminal launch attempt, even if the first app launch did not
visibly work. Do not use `--force` or `--force-open` unless the user explicitly
re-prompts and asks for another terminal window.

```bash
scripts/workerctl create <name> \
  --cwd <target-repo> \
  --task "<specific task and constraints>" \
  --wait-ready \
  --accept-trust \
  --verify \
  --open
```

For low-risk tests, constrain the worker to an ignored status file:

```bash
scripts/workerctl start-test live-worker \
  --cwd "$PWD" \
  --accept-trust \
  --open
```

## Inspect And Supervise

Use these from the manager session:

```bash
scripts/workerctl status <name>
scripts/workerctl capture <name> --lines 120
scripts/workerctl events <name> --limit 20
scripts/workerctl watch <name> --interval 10 --max-cycles 3 --dry-run
scripts/workerctl idle-check <name> --busy-wait-seconds 10
```

Interpret worker health as follows:

- `active`: wait, watch, or inspect recent capture.
- `done`: review status, capture, and events.
- `blocked`: read the blocker before deciding the next action.
- `stale`: use `supervise` or send a status nudge.
- `busy_wait`: inspect capture; interrupt only when appropriate.

## Worker Self-Management

Use these when you are running inside the worker session itself.

If the user asks you to become managed, launch a manager with the command
template from your startup prompt. Ask for missing worker name, task name, or
goal values before running it.

If the user asks to take back manual control, stop supervising me, pause my
manager, stop managing me, or unmanage this worker, run:

```bash
scripts/workerctl unmanage
```

This stops only the manager session and leaves the worker session running. If
`unmanage` cannot infer the task from the current tmux session, ask the user for
the missing task/session value. When the task is known, the fallback is:

```bash
scripts/workerctl pause-manager <task>
```

If the user asks for your current worker/manager state, run:

```bash
scripts/workerctl my-status
```

If the user asks to restart management, resume supervision, or get a manager
again after the task is paused, run:

```bash
scripts/workerctl remanage
```

## Nudge

```bash
scripts/workerctl nudge <name> "Please update status.json with your current state, blocker if any, and next action."
```

`workerctl` submits the nudge automatically. If a future manual test shows text pasted but not submitted, run:

```bash
tmux send-keys -t codex-<name> C-m
```

Then inspect `workerctl/tmux.py`, because `send_text` should submit with `C-m`.

## Interrupt Busy Waits

Prefer an explicit manager decision before interrupting:

```bash
scripts/workerctl interrupt <name> --dry-run
scripts/workerctl interrupt <name>
```

Opt-in supervise interruption:

```bash
scripts/workerctl supervise <name> --interrupt-busy-wait --dry-run
scripts/workerctl supervise <name> --interrupt-busy-wait
```

## Attach And Detach

Attach from any directory:

```bash
tmux attach -t codex-<name>
```

On macOS, open a new terminal window attached to a running worker:

```bash
scripts/workerctl open <name>
scripts/workerctl open <name> --terminal ghostty
scripts/workerctl open <name> --terminal terminal
```

If the first open did not work and the user explicitly asks to try again:

```bash
scripts/workerctl open <name> --force
```

Detach without stopping:

```text
Ctrl-b then d
```

## Stop And Verify Cleanup

For disposable smoke tests, pass `--stop-after` or stop the worker explicitly:

```bash
scripts/workerctl stop <name>
tmux list-sessions 2>/dev/null | rg '^codex-<name>' || true
git status --short
```

Expected cleanup:

- no matching tmux session remains
- tracked git status is clean for status-only tests
- worker runtime remains under ignored `.codex-workers/<name>/`
