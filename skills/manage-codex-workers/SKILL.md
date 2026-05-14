---
name: manage-codex-workers
description: Supervise a tmux-backed Codex worker session from a manager Codex session using the codex-terminal-manager workerctl tool. Use when the user asks to register an existing Codex session as a worker or manager, create a supervised task, bind the pair, run observation cycles, send nudges, interrupt busy-waits, finish a task, or audit/replay supervision history.
---

# Manage Codex Workers

Use `/Users/neonwatty/Desktop/codex-terminal-manager` as the control repo unless
the user specifies another checkout. Prefer the repo script path
(`scripts/workerctl ...`); after `scripts/install-local --write` the plain
`workerctl` command works too.

## Supervision Model

Supervision is built on three primitives: **sessions**, **tasks**, and
**bindings**.

- A **worker session** is a Codex session running inside a named tmux session.
  Its rollout JSONL on disk (`~/.codex/sessions/.../rollout-*.jsonl`) is the
  source of truth for ingest.
- A **manager session** is a Codex session that can run anywhere — Ghostty,
  iTerm2, Terminal.app, a web terminal. The manager does not need tmux. Its
  job is to call `workerctl` commands, read their JSON output, and decide what
  to do next.
- A **task** is a unit of supervised work with a goal.
- A **binding** ties one worker session and one manager session to one task.

The manager Codex drives the supervision loop by calling
`workerctl cycle <task>` repeatedly. Each cycle ingests new rollout events,
captures the worker's tmux pane as a shadow signal, persists a `manager_cycles`
row, and returns structured JSON. The manager reads that JSON and decides.

## Preflight

1. Work from the control repo:
   ```bash
   cd /Users/neonwatty/Desktop/codex-terminal-manager
   ```
2. Verify dependencies:
   ```bash
   scripts/workerctl doctor
   ```
3. Verify the SQLite control plane is healthy:
   ```bash
   scripts/workerctl db-doctor
   ```
4. From the current Codex session, check whether it can register itself:
   ```bash
   workerctl doctor-self
   ```
   `supported: true` means the session is inside a live tmux session and can
   be registered as a worker. A non-tmux session can still be registered as a
   manager.

## Register Sessions

Register an already-running Codex worker (rollout JSONL is auto-discovered
from the pid via `lsof`):

```bash
scripts/workerctl register-worker --name foo --pid <WORKER_PID> \
  --cwd "$PWD" --tmux-session codex-foo
```

If `lsof` discovery fails, pass the rollout path explicitly:

```bash
scripts/workerctl register-worker --name foo --pid <WORKER_PID> \
  --cwd "$PWD" --tmux-session codex-foo \
  --codex-session ~/.codex/sessions/.../rollout-...-<uuid>.jsonl
```

Register a manager (tmux not required):

```bash
scripts/workerctl register-manager --name foo-mgr --pid <MGR_PID> --cwd "$PWD"
```

For new manager sessions started by workerctl, prefer `start-manager` or
`pair`. These send a manager bootstrap prompt to Codex so the rollout JSONL is
opened during startup and the manager has setup context. In `pair`, the manager
prompt includes the task name, goal, worker session, `manager-config
<task> --questions`, and `cycle <task>`.

List registered sessions:

```bash
scripts/workerctl sessions
scripts/workerctl sessions --role worker
scripts/workerctl sessions --role manager
```

## Create A Task And Bind

```bash
scripts/workerctl tasks --create my-task --goal "Refactor auth"
scripts/workerctl handoff my-task \
  --summary "Worker explored the current auth flow and found middleware drift." \
  --next-step "Implement the middleware cleanup from docs/auth-plan.md"
scripts/workerctl manager-config my-task \
  --mode guided \
  --objective "Keep the worker aligned to docs/auth-plan.md" \
  --reference docs/auth-plan.md \
  --acceptance "Tests pass" \
  --guideline "Nudge only when the worker is idle, stale, or blocked"
scripts/workerctl bind --task my-task --worker foo --manager foo-mgr
```

`tasks` lists or creates rows. `bind` ties the worker and manager sessions to
the task. The task is now active.

Use `handoff` before or during management promotion to save the worker's
compact progress summary and likely next steps in SQLite. Use `manager-config`
to save what the manager should check against, how structured supervision
should be, acceptance criteria, planning/PRD/mockup references, and permissions
such as `--allow-pr`, `--allow-merge-green`, and
`--allow-worker-compact-clear`.

When setting up a manager from inside a manager Codex session, prefer:

```bash
scripts/workerctl manager-config my-task --questions
```

Read the JSON question schema, ask the user those questions in the manager
conversation, then persist the answers with `manager-config` flags. This keeps
the human interaction in the Codex chat where the user is already working and
keeps SQLite writes explicit. Use `manager-config --interactive` only as a
terminal fallback for a human running `workerctl` directly.

Before instructing high-level actions such as PR creation, green PR merge, or
worker compact/clear, check the saved policy:

```bash
scripts/workerctl manager-permission my-task worker_compact_clear \
  --require-handoff --require
```

Use `--require` for fail-closed behavior. Use `--require-handoff` before
compact/clear so the worker's visible progress is saved first.

To request worker compaction/clear through the audited path, prefer the
one-command wrapper:

```bash
scripts/workerctl compact-worker my-task \
  --reason "Worker context should be compacted after handoff"
```

Use `--clear` for `/clear`. For lower-level control, first record a `nudge`
manager decision, then run:

```bash
decision_id=$(scripts/workerctl record-decision my-task nudge \
  --reason "Worker context should be compacted after handoff" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
scripts/workerctl request-worker-compact my-task \
  --decision-id "$decision_id" --strict-decisions
```

This command checks `worker_compact_clear`, requires a saved handoff, records a
durable command, and sends Codex `/compact` to the worker's tmux pane. Use
`--clear` for `/clear`, or `--prompt-only` to send the conservative
verify/update-handoff prompt instead of a slash command.

## Manager Loop Pattern

The manager Codex drives supervision by calling `workerctl cycle <task>` in a
loop. Each cycle is idempotent: it ingests only new bytes from the rollout
JSONL, computes worker state from the JSON event stream, captures the worker
tmux pane, and returns a JSON dict.

```bash
scripts/workerctl cycle my-task
# {
#   "kind": "session_cycle",
#   "task": "my-task",
#   "state": "busy" | "idle" | "unknown",
#   "staleness_seconds": 4.2,
#   "notable_pane_pattern": "trust_prompt" | null,
#   "pane_signal": { "captured": true, "classifier": {...} },
#   "manager_context": {
#     "manager_config": {...},
#     "worker_handoff": {...}
#   },
#   "ingest": { "new_events": 3, "new_offset": 12345 },
#   "cycle_id": 17,
#   ...
# }
```

Loop pseudo-pattern:

```
while task is active:
  result = workerctl cycle <task>           # observe
  interpret result.state, result.staleness_seconds, result.notable_pane_pattern
  decide:
    - "wait"      -> sleep, then loop
    - "nudge"     -> workerctl session-nudge <worker> "<text>"
    - "interrupt" -> workerctl session-interrupt <worker>
    - "escalate"  -> workerctl finish-task <task> --reason "<why>"
```

Interpretation guidance:

- `state: "busy"` and recent activity: wait.
- `state: "idle"` and the worker is at a prompt: send a `session-nudge` with
  the next instruction.
- `notable_pane_pattern` is non-null: branch on it directly. For example, a
  `trust_prompt` or `enter_to_confirm` may want a single Enter sent via
  `session-nudge "" ` (Enter is always appended).
- Long `staleness_seconds` with no notable pattern: send a status nudge before
  interrupting.
- Clear busy-wait pattern or explicit user request: `session-interrupt`.

## Actuation

Nudge the worker (sends text plus Enter to the worker's tmux pane). Only
worker sessions can be nudged this way; managers running outside tmux cannot:

```bash
scripts/workerctl session-nudge foo "Please update status and continue."
scripts/workerctl session-nudge foo "Status?" --dry-run
```

Send an interrupt key (default `C-c`):

```bash
scripts/workerctl session-interrupt foo
scripts/workerctl session-interrupt foo --key C-c --followup "continue with the smaller refactor"
```

## Inspect, Replay, Audit

```bash
scripts/workerctl tail foo --limit 30
scripts/workerctl tail foo --subtype agent_message
scripts/workerctl divergences my-task --limit 20
scripts/workerctl audit my-task
scripts/workerctl replay my-task
scripts/workerctl replay my-task --format transcript --limit 40
scripts/workerctl replay my-task --format full-transcript --limit 40
```

- `tail` prints recent ingested rollout events for a session.
- `divergences` lists cycles where the shadow pane signal flagged a notable
  pattern (trust prompt, rate-limit prompt, approval prompt, ...).
- `audit` lists `events` rows for the task; cycle observations show up via
  `replay` and the `manager_cycles` table.
- `replay` reconstructs the task chronologically. Use `--format compact` for
  decisions and side effects, `--format transcript` for deduplicated terminal
  excerpts, `--format full-transcript` only for debugging.

## Finish, Unbind, Deregister

When the task is complete:

```bash
scripts/workerctl finish-task my-task --reason "auth refactor merged"
scripts/workerctl finish-task my-task --reason "..." --stop-manager
scripts/workerctl finish-task my-task --reason "..." --stop-worker
```

`finish-task` marks the task done and leaves both sessions running by default.
Add `--stop-manager` / `--stop-worker` only when the user explicitly wants the
tmux session torn down.

Clean up the binding and session registrations:

```bash
scripts/workerctl unbind --task my-task
scripts/workerctl deregister foo
scripts/workerctl deregister foo-mgr
```

`deregister` refuses if a session is still bound to an active task; run
`unbind` first.

## Reconcile Runtime Drift

If something looks wrong — a worker process exited, a manager left a session
behind, a task has stopped getting cycle rows — run reconcile:

```bash
scripts/workerctl reconcile
scripts/workerctl reconcile --apply
```

Without `--apply` it prints a JSON report of dead-pid sessions, dangling
bindings, and stuck tasks. With `--apply` it marks dead-pid sessions
`state='gone'` and dangling bindings `state='invalid'`, writing audit events
for each mutation. Stuck tasks are reported but never auto-closed.

For schema-level checks (legacy `workers`/`managers` tables, missing tables,
etc.) run `scripts/workerctl db-doctor --live`.

## Natural-Language Command Mapping

- "register this Codex session as a worker": `workerctl doctor-self` then
  `workerctl register-worker --name <NAME> --pid <PID> --cwd <CWD> --tmux-session <SESSION>`.
- "register a manager": `workerctl register-manager --name <NAME> --pid <PID> --cwd <CWD>`.
- "create a task and bind these sessions":
  `workerctl tasks --create <TASK> --goal "<goal>"` then
  `workerctl bind --task <TASK> --worker <W> --manager <M>`.
- "watch the worker", "supervise this task", "run a cycle":
  `workerctl cycle <TASK>` (in a loop).
- "send a nudge", "ask the worker something":
  `workerctl session-nudge <WORKER> "<text>"`.
- "interrupt the worker": `workerctl session-interrupt <WORKER>`.
- "what happened in this task", "show the replay":
  `workerctl replay <TASK>` (optionally with `--format`).
- "finish this task": `workerctl finish-task <TASK> --reason "<why>"`.
- "unbind", "deregister this session": `workerctl unbind --task <TASK>`
  followed by `workerctl deregister <NAME>` per session.
- "reconcile drift", "something looks stale":
  `workerctl reconcile` (add `--apply` if the dry-run report looks correct).

## QA Plan

For a repeatable end-to-end checklist:

```bash
scripts/workerctl qa-plan self-management
scripts/workerctl qa-plan self-management --json
```
