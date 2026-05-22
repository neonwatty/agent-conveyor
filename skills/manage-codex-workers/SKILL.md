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

## Preferred Manual Handoff Workflow

When the user wants to hand off an already-open Codex session, do not start
with a long `pair` command. Use the skill in each session:

1. In the intended worker session, ask Codex:
   ```text
   Use the manage-codex-workers skill.

   Register this current Codex session as the worker for this dashboard setup.

   Dashboard setup code: <setup-code>
   Working directory: <target-repo>

   Let the skill derive the task and session names from the setup code. Do not
   ask me to type generated worker, manager, or task names.

   After registration, wait for the manager. Do not start work until the
   manager has created or bound the task and provided acceptance criteria.
   ```
2. In a separate manager session, ask Codex:
   ```text
   Use the manage-codex-workers skill.

   Register this current Codex session as the manager for this dashboard setup.

   Dashboard setup code: <setup-code>
   Working directory: <target-repo>
   Goal: <goal>

   Let the skill derive the task and session names from the setup code, find
   the matching worker, create/configure the task if needed, and bind the
   worker and manager.

   Run cycles, inspect criteria and telemetry, nudge only when useful, require
   evidence, and finish/export the task when done.
   ```
3. The manager session should then drive the loop with:
   ```bash
   scripts/workerctl cycle <task-name>
   scripts/workerctl criteria <task-name> --list
   scripts/workerctl telemetry --summary --task <task-name>
   scripts/workerctl telemetry --task <task-name>
   scripts/workerctl replay <task-name>
   ```

The skill should translate those prompts into explicit `workerctl` commands.
For the worker, run `doctor-self`; if supported, register the current session
with `register-worker`. For the manager, register the current session with
`register-manager`, create/configure the task if needed, then `bind`.

When the prompt includes a dashboard setup code, derive names without asking the
user:

```text
task:    dashboard-<setup-code>
worker:  dashboard-<setup-code>-worker
manager: dashboard-<setup-code>-manager
```

If there is already a registered worker for the derived worker name, reuse it
when binding the manager. If the derived name collides with an active unrelated
session, append a short suffix yourself and continue; do not ask the user to
invent names.

If the prompt has no setup code and no explicit names, choose concise names from
the task goal or current date yourself. Ask the user only when the target repo or
goal is missing or ambiguous.

This is the ergonomic manual workflow. Use `pair` only when the user wants
workerctl to spawn both sessions in one automated command.

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

For automated bootstrap of a fresh supervised worker/manager pair, use `pair`
instead of manually starting and binding sessions:

```bash
scripts/workerctl pair \
  --task <task-slug> \
  --worker-name <worker-name> \
  --manager-name <manager-name> \
  --cwd <target-repo> \
  --codex-profile yolo \
  --manager-mode strict \
  --task-goal "<one-line goal>" \
  --task-prompt "<worker prompt>" \
  --manager-objective "<manager objective>" \
  --manager-acceptance "<finish criterion>"
```

Use this for external dogfood runs. Keep the control repo as the command cwd,
but set `--cwd` to the downstream project:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
export DOGFOOD_CWD="/path/to/external/project"
export TASK="external-dogfood-$(date +%Y%m%d)"
export WORKER="dogfood-worker-$(date +%Y%m%d)"
export MANAGER="dogfood-manager-$(date +%Y%m%d)"

scripts/workerctl pair \
  --task "$TASK" \
  --worker-name "$WORKER" \
  --manager-name "$MANAGER" \
  --cwd "$DOGFOOD_CWD" \
  --codex-profile yolo \
  --manager-mode strict \
  --task-goal "Complete one small real task in the external project." \
  --task-prompt "Pick one small, concrete improvement. Keep changes scoped. Run verification. Report files changed and commands run." \
  --manager-objective "Supervise the worker, request acceptance criteria and evidence, and finish only when verified." \
  --manager-acceptance "The task is complete, verified, and summarized with files changed and commands run."
```

During external dogfood, review telemetry every few cycles:

```bash
scripts/workerctl cycle "$TASK"
scripts/workerctl criteria "$TASK" --list
scripts/workerctl telemetry --summary --task "$TASK"
scripts/workerctl telemetry --task "$TASK"
scripts/workerctl telemetry --search manager --task "$TASK"
scripts/workerctl replay "$TASK"
```

Finish and export evidence:

```bash
scripts/workerctl finish-task "$TASK" \
  --capture-transcript-before-stop \
  --require-transcript-segment \
  --require-criteria-audit \
  --stop-manager \
  --stop-worker

scripts/workerctl export-task "$TASK" \
  --output "/tmp/$TASK-export" \
  --zip \
  --include-transcripts

scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
```

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
#     "worker_handoff": {...},
#     "acceptance_criteria": {
#       "summary": {"proposed": 1, "accepted": 2, "satisfied": 0, "deferred": 1, "rejected": 0},
#       "open": [...],
#       "proposed": [...],
#       "satisfied": [...],
#       "deferred": [...],
#       "rejected": [...]
#     },
#     "criteria_negotiation": {
#       "needed": true,
#       "reason": "no_criteria",
#       "prompt": "Please propose 2-4 acceptance criteria for the current slice...",
#       "suggested_actions": [...]
#     }
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

Acceptance criteria are living supervision state, not just setup text. Inspect
`manager_context.acceptance_criteria` every cycle:

- Treat `open` as accepted criteria that still need worker proof before the
  task can finish.
- Inspect `manager_context.criteria_negotiation` every cycle. When `needed` is
  true, use its `prompt` as the worker nudge or adapt it to the situation before
  recording criteria.
- When worker progress reveals new edge cases, missing tests, polish needs, or
  scope boundaries, ask the worker to propose which criteria are must-have now
  versus follow-up.
- Record current-task criteria as proposed or accepted, and record follow-up
  criteria as deferred.
- Use `scripts/workerctl criteria` to accept, satisfy, defer, or reject
  criteria as evidence accumulates.
- Before finishing, compare the worker's receipts and verification against all
  accepted open criteria.

Criteria command examples:

```bash
scripts/workerctl criteria my-task --list
scripts/workerctl criteria my-task --add --criterion "..." --source worker_proposed --status proposed
scripts/workerctl criteria my-task --accept 12 --rationale "Must-have for this task"
scripts/workerctl criteria my-task --satisfy 12 --evidence-json '{"command":"python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v","status":"pass"}'
scripts/workerctl criteria my-task --defer 13 --rationale "Follow-up after this task"
scripts/workerctl criteria my-task --reject 14 --rationale "Duplicate or out of scope"
```

Replace placeholder `...` values with the actual criterion and verification
command. To add a criterion and satisfy that same row after verification:

```bash
criterion_id=$(scripts/workerctl criteria my-task --add --criterion "Targeted prompt tests pass" --source worker_proposed --status proposed | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')
scripts/workerctl criteria my-task --satisfy "$criterion_id" --evidence-json '{"command":"python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v","status":"pass"}'
```

When making multiple criteria changes, use each mutation response's
`affected_criterion` as the row receipt, then run `scripts/workerctl criteria
<task> --list` before finishing or making an audit decision.

Sample nudge:

```bash
scripts/workerctl session-nudge foo \
  "Your latest progress exposed extra edge cases. Please propose acceptance criteria split into must-have for this task versus follow-up, and include the verification you expect for each."
```

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
scripts/workerctl replay my-task --format full-transcript --include-content --limit 40 > /tmp/my-task-full-transcript.txt
```

- `tail` prints recent ingested rollout events for a session.
- `divergences` lists cycles where the shadow pane signal flagged a notable
  pattern (trust prompt, rate-limit prompt, approval prompt, ...).
- Raw transcript/log content should not be printed inside an active Codex
  terminal. Prefer compact/timeline/transcript summaries; redirect any command
  using `--include-content` to a file.
- `audit` lists `events` rows for the task; cycle observations show up via
  `replay` and the `manager_cycles` table.
- `replay` reconstructs the task chronologically. Use `--format compact` for
  decisions and side effects, `--format transcript` for deduplicated terminal
  excerpts, `--format full-transcript` only for debugging.

## Finish, Unbind, Deregister

When the task is complete:

```bash
scripts/workerctl finish-task my-task --reason "auth refactor merged"
scripts/workerctl finish-task my-task --reason "..." --require-criteria-audit
scripts/workerctl finish-task my-task --reason "..." --stop-manager
scripts/workerctl finish-task my-task --reason "..." --stop-worker
```

`finish-task` marks the task done and leaves both sessions running by default.
Use `--require-criteria-audit` when final acceptance criteria should be enforced:
it fails before finishing if any task criteria remain `accepted`; `proposed`,
`satisfied`, `deferred`, and `rejected` criteria do not block.
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

- "register this Codex session as the worker for dashboard setup <CODE>":
  derive `dashboard-<CODE>-worker`, run `workerctl doctor-self`, then
  `workerctl register-worker --name dashboard-<CODE>-worker --pid <PID> --cwd <CWD> --tmux-session <SESSION>`.
- "register this session as the manager for dashboard setup <CODE>":
  derive `dashboard-<CODE>-manager`, run
  `workerctl register-manager --name dashboard-<CODE>-manager --pid <PID> --cwd <CWD>`.
- "register this Codex session as a worker": choose a concise worker name if
  none was provided, then run `workerctl doctor-self` and `register-worker`.
- "register a manager": choose a concise manager name if none was provided,
  then run `workerctl register-manager`.
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
scripts/workerctl qa-plan emergent-criteria
scripts/workerctl qa-plan emergent-criteria --json
scripts/workerctl qa-plan tmux-errors
scripts/workerctl qa-plan tmux-errors --json
```

Use `emergent-criteria` when validating a real worker/manager pair through
criteria negotiation, audited finish gating, replay/export, and
`--stop-manager --stop-worker` cleanup.

Use `tmux-errors` when validating read-only JSON degradation, mutating command
failures, pane capture degradation, stop failures, and reconcile recovery for
disposable tmux failure scenarios.
