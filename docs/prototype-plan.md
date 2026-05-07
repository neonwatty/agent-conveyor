# Prototype Plan

## Purpose

Create a Mac-only prototype where one Codex session can supervise another Codex session running in a terminal. The manager should be able to inspect worker progress, detect likely inactivity or blocked states, send small nudges, and stop or summarize the worker when needed.

This is a coordination tool, not an autonomous multi-agent framework. The first version should stay understandable, scriptable, and reversible.

## Design Principles

- Use `tmux` as the durable control boundary.
- Treat terminal scrollback as a fallback signal, not the full state model.
- Prefer explicit worker-written state files over brittle prompt detection.
- Make manager actions auditable through an event log.
- Keep commands small enough that the manager can reason about them.
- Avoid destructive actions by default.

## Core Components

### 1. Worker Session

The worker is a normal Codex session launched inside a named `tmux` session.

Example session name:

```text
codex-worker-a
```

The worker receives an initial contract telling it to keep a status file current:

```json
{
  "state": "planning | editing | running_tests | blocked | waiting | done",
  "current_task": "short description",
  "last_update": "ISO-8601 timestamp",
  "next_action": "short description",
  "blocker": null
}
```

### 2. Worker State Directory

Each worker gets a local state directory:

```text
.codex-workers/
  worker-a/
    status.json
    transcript.txt
    events.jsonl
    config.json
```

`status.json` is the primary coordination file.

`transcript.txt` stores captured terminal output snapshots or append-only captures.

`events.jsonl` records manager actions:

```json
{"time":"2026-05-07T15:30:00Z","type":"nudge","message":"Please summarize progress and next step."}
```

`config.json` records the tmux target, working directory, and idle thresholds.

### 3. `workerctl`

`workerctl` is a small command-line tool used by the manager Codex.

Initial commands:

```bash
workerctl create worker-a --cwd /path/to/repo
workerctl status worker-a
workerctl tail worker-a
workerctl capture worker-a
workerctl nudge worker-a "Please summarize current progress and next step."
workerctl stop worker-a
workerctl list
```

Nice-to-have commands after the first pass:

```bash
workerctl idle-check worker-a
workerctl open worker-a
workerctl attach worker-a
workerctl event-log worker-a
```

## Tracking Worker Activity

The manager should combine three signals.

### Signal A: Explicit Status

Read `.codex-workers/<worker>/status.json`.

Useful fields:

- `state`
- `last_update`
- `current_task`
- `next_action`
- `blocker`

Fresh status means the worker is probably healthy. Stale status means the manager should inspect the terminal.

### Signal B: Terminal Output Changes

Use:

```bash
tmux capture-pane -p -S -200 -t codex-worker-a
```

Hash the output and compare it with the previous snapshot.

If output changed recently, assume the worker is active.

If output has not changed for a threshold, inspect the process state and visible prompt.

### Signal C: Process State

Use macOS process inspection to understand whether the pane has active child processes. The first prototype can keep this simple:

```bash
tmux display-message -p -t codex-worker-a '#{pane_pid}'
pgrep -P <pane_pid>
```

Later versions can recursively inspect descendants and sample CPU time.

## Idle Policy

Initial thresholds:

- 30 seconds with output changes: active, do nothing.
- 2 minutes with no output and fresh `status.json`: probably active, do nothing.
- 2 minutes with no output and stale `status.json`: ask for a short status update.
- 5 minutes with no output and no status update: send a stronger nudge.
- 10 minutes with no output after nudges: mark as `needs_human`.

Example nudge:

```text
Please pause and write a concise status update: current task, what changed, whether you are blocked, and the next command you plan to run.
```

## Worker Prompt Contract

The manager should start workers with instructions like:

```text
You are a worker Codex session supervised by a manager Codex session.

Keep `.codex-workers/worker-a/status.json` updated whenever you start a new phase, become blocked, begin long-running verification, or finish.

Use these state values only:
planning, editing, running_tests, blocked, waiting, done.

Do not perform destructive git actions unless the user explicitly asks.
If you are blocked or need direction, set state to blocked and explain the blocker.
```

## Safety Constraints

The manager should not:

- Send repeated nudges faster than the configured cooldown.
- Approve privileged actions blindly.
- Run destructive git commands.
- Continue a worker that reports `blocked` without reading the blocker.
- Infer success from quiet terminal output.

The manager should:

- Log every nudge and stop command.
- Prefer asking for a status update before issuing task-specific instructions.
- Preserve worker transcripts.
- Keep human-readable state files.

## Prototype Implementation Plan

### Phase 1: Manual `tmux` Control

- Create worker state directories.
- Start a worker manually in `tmux`.
- Use shell commands to capture output and send nudges.
- Validate that Codex behaves reasonably with the worker prompt contract.

Success criteria:

- Manager can see recent worker output.
- Manager can nudge the worker.
- Worker updates `status.json`.

### Phase 2: `workerctl` MVP

- Implement `workerctl list`.
- Implement `workerctl create`.
- Implement `workerctl capture`.
- Implement `workerctl status`.
- Implement `workerctl nudge`.
- Implement `workerctl stop`.

Success criteria:

- A manager Codex can operate a worker without remembering raw `tmux` commands.
- All manager actions are written to `events.jsonl`.

### Phase 3: Idle Detection

- Store last terminal capture hash.
- Track last observed output change.
- Compare status freshness with output freshness.
- Report `active`, `stale`, `blocked`, `waiting`, or `unknown`.

Success criteria:

- Manager gets a concise status summary from one command.
- False positives are acceptable, but the tool should avoid aggressive nudging.

### Phase 4: Real Task Trial

- Pick a low-risk repo task.
- Start one worker Codex.
- Let the manager inspect status every few minutes.
- Record where the heuristics fail.

Success criteria:

- The worker can complete a small task or reach a clear blocker.
- Manager intervention is limited to status checks and small nudges.

## Open Questions

- Should `workerctl` be Bash, Python, or Node?
- Should transcript capture be snapshot-based or append-only?
- How often should workers be required to update `status.json`?
- Should the manager run a background watcher, or should checks be manager-initiated?
- Should there be a tiny local web UI later, or is terminal-only enough?

## Recommended First Technical Choice

Use Python for `workerctl`.

Reasoning:

- Good standard library support for JSON, subprocesses, timestamps, and file locking.
- Easier to grow into a small daemon if needed.
- More readable than Bash once process inspection and state updates get real.

Use `tmux` for PTY control.

Reasoning:

- Stable and scriptable.
- Independent of Ghostty, iTerm2, Terminal.app, or `ttyd`.
- Easy to inspect and control from a manager Codex session.
