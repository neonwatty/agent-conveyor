---
name: manage-codex-workers
description: Start, supervise, nudge, inspect, interrupt, and stop tmux-backed Codex worker sessions using the codex-terminal-manager workerctl tool. Use when the user asks to create or manage another Codex terminal/session, make the current Codex session managed, launch a manager for the current session, watch or supervise a worker, send a nudge, attach to a worker terminal, inspect worker status/capture/events, interrupt busy-wait states, or clean up worker sessions.
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

For a repeatable managed-worker QA checklist:

```bash
scripts/workerctl qa-plan self-management
```

## Inspect And Supervise

Use these from the manager session:

```bash
scripts/workerctl manager-observe <task> --compact --json
scripts/workerctl manager-decision <task> --decision inspect --reason "<why>"
scripts/workerctl status <name>
scripts/workerctl capture <name> --lines 120
scripts/workerctl events <name> --limit 20
scripts/workerctl watch <name> --interval 10 --max-cycles 3 --dry-run
scripts/workerctl idle-check <name> --busy-wait-seconds 10
```

Prefer `manager-observe` at the start of each managed-task loop. It persists
task health, worker capture, manager capture, and status into SQLite so
manager-visible errors are auditable after the terminal scrollback changes.
Use `--compact --json` for normal loops; full captures are still stored in
SQLite, but the returned payload is smaller.
Record non-trivial choices with `manager-decision` before nudging,
interrupting, escalating, or stopping.
When you run a mutating task command from manager context, pass the returned
`decision_id` with `--decision-id --strict-decisions`. Without strict mode,
workerctl still runs the command but records a warning that
`workerctl mutation-audit <task> --json` or
`workerctl task-health <task> --audit-decisions --json` can surface later.
Do not run mutating commands merely because they are available. Use
`task-nudge` only when the worker is stale, waiting for input, or explicitly
needs direction. Use `task-interrupt` only for a clear busy-wait/interruptible
state or an explicit user request. Use `finish-task` when work is complete and
the task should close with an audit record.

Interpret worker health as follows:

- `active`: wait, watch, or inspect recent capture.
- `done`: review status, capture, and events.
- `blocked`: read the blocker before deciding the next action.
- `stale`: use `supervise` or send a status nudge.
- `busy_wait`: inspect capture; interrupt only when appropriate.

## Worker Self-Management

Use these when you are running inside the worker session itself.

If the user asks you to become managed, launch a manager with the command
template from your startup prompt. In a plain Codex session without a startup
prompt, first run:

```bash
workerctl doctor-self
```

If `doctor-self` reports `can_promote_in_place: true`, use its
`become_managed_command_template`. Ask for missing worker name, task name, or
goal values before running it unless the user explicitly supplied them or asked
you to choose names. `become-managed` opens the manager terminal by default; use
`--no-open-manager` only if the user does not want a visible manager.

If the flow is unclear or you need compact command mappings, run:

```bash
workerctl explain-managed-flow --json
```

Natural-language command mapping:

- "become managed", "manage yourself", "create a manager", "launch a manager":
  run `workerctl doctor-self`, then `workerctl become-managed` when promotion
  is possible and required values are known.
- "stop supervising me", "stop managing me", "take back manual control",
  "unmanage this worker": run `workerctl unmanage`.
- "resume supervision", "restart management", "get a manager again": run
  `workerctl remanage --open-manager`.
- "finish this managed task", "close this task", "mark this task done": run
  `workerctl finish-task <task> --reason "<reason>"`.
- "show me the manager" or "open the manager terminal": run
  `workerctl open-manager <task>`.
- "show me the worker" or "open the worker terminal": run
  `workerctl open-worker <task>`.

If `doctor-self` reports `can_promote_in_place: false`, explain that this
Codex process is not running inside a tmux session and cannot be promoted
in-place as a tmux-backed worker. Offer to start a managed-capable tmux Codex
session with:

```bash
workerctl start <session-name> --cwd "$PWD" -- --sandbox danger-full-access --ask-for-approval never
```

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
scripts/workerctl remanage --open-manager
```

To show task-bound terminals without raw tmux commands:

```bash
scripts/workerctl task-health <task> --json
scripts/workerctl task-capture <task> --role manager --json
scripts/workerctl finish-task <task> --reason "<reason>"
scripts/workerctl open-manager <task>
scripts/workerctl open-worker <task>
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
