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

```bash
scripts/workerctl create <name> \
  --cwd <target-repo> \
  --task "<specific task and constraints>" \
  --wait-ready \
  --accept-trust
```

For low-risk tests, constrain the worker to an ignored status file:

```bash
scripts/workerctl create live-worker \
  --cwd "$PWD" \
  --task "Read README.md and update only .codex-workers/live-worker/status.json with a short summary. Do not edit tracked files." \
  --wait-ready \
  --accept-trust
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

Detach without stopping:

```text
Ctrl-b then d
```

## Stop And Verify Cleanup

Always stop workers created for tests unless the user asks to leave them running:

```bash
scripts/workerctl stop <name>
tmux list-sessions 2>/dev/null | rg '^codex-<name>' || true
git status --short
```

Expected cleanup:

- no matching tmux session remains
- tracked git status is clean for status-only tests
- worker runtime remains under ignored `.codex-workers/<name>/`
