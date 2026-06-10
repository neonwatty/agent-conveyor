---
name: manage-codex-workers
description: Use when the user asks to set up an Agent Conveyor Ralph loop, register an existing Codex session as a worker or manager, create a supervised task, bind a pair, run observation cycles, send nudges, interrupt busy-waits, finish a task, or audit/replay supervision history.
---

# Manage Codex Workers

Use `conveyor ...` as the primary CLI. It is installed by the `agent-conveyor`
Node/TypeScript package. The legacy `workerctl` command remains a compatibility
alias, but skill-driven flows should prefer `conveyor`.

## One-Prompt Codex App Ralph Loop

This is the preferred entry point when the user has installed Agent Conveyor
and wants to use another Codex app session without learning the low-level
command sequence.

User prompt:

```text
Use the manage-codex-workers skill.

Set up a Codex app Ralph loop for issue CTL.
Worker session: <worker-name or choose one>
Manager session: <manager-name or choose one>
Template: <template name, or choose the best one>
Max iterations: <number, default 3>
Require adversarial proof before another worker iteration.
```

Skill behavior:

1. Work from `/Users/neonwatty/Desktop/codex-terminal-manager`.
2. Run `conveyor doctor` and `conveyor db-doctor`; fix or
   report blockers.
3. Choose concise task, worker, manager, and run names when the user does not
   provide them. Do not ask the user to invent generated names.
4. If running in the Codex app and thread tools are available, create a fresh
   same-project worker thread with `create_thread`, name it with
   `set_thread_title`, and keep the returned thread id/title. Use
   `create_thread` for this flow; do not use `fork_thread` unless the user
   explicitly asks to fork or resume this exact conversation.
5. Create the no-tmux binding with `conveyor create-disposable-binding`
   using `--template` when a template is known, `--adversarial`, a bounded
   `--max-iterations`, and `--json`. When step 4 produced a worker thread id,
   pass it through `--worker-codex-app-thread-id` and
   `--worker-codex-app-thread-title` so Conveyor can surface the app identity
   in `sessions`, `discover`, and setup JSON. If app thread tools are not
   available, create the binding without those flags and ask the user to open a
   separate Codex app worker session manually.
6. Ensure Dispatch is running or tell the user the single command to start it:
   `conveyor dispatch --watch --dispatcher-id dispatch-local`.
7. Read the returned `communication` blocks. A worker or manager with
   `session_kind=tmux` and `receive_style=push` can receive direct tmux pushes;
   one with `session_kind=codex_app` and `receive_style=pull` must poll the
   printed inbox command.
8. Give the worker Codex app session the generated `worker_handoff` prompt.
   If step 4 created a fresh worker thread, use `send_message_to_thread` only
   to deliver that bootstrap prompt. Durable manager/worker communication still
   goes through Dispatch and `worker-inbox`/`manager-inbox`; direct app-thread
   messages are not Dispatch receipts. The worker should keep polling
   `conveyor worker-inbox <task> --consume-next --wait --timeout 60 --json`
   through the bounded loop until no inbox item remains or `max_iterations` is
   reached. Consuming a `continue_iteration` inbox item advances the Ralph-loop
   run's durable `current_iteration` and writes `ralph_loop_iteration_advanced`
   telemetry.
9. After each worker pass, require concrete evidence and structured
   `loop-evidence adversarial-check` proof before queueing another
   `enqueue-continue-iteration`.
10. Use `conveyor loop-status <task> --run <run> --json` and telemetry/audit
   receipts before declaring the loop ready for manager review.

Idle polling rule for Codex app/no-tmux sessions:

- When a worker has `session_kind=codex_app` or `receive_style=pull`, its
  idle/check-in command is
  `conveyor worker-inbox <task> --consume-next --wait --timeout 60 --json`.
- When a manager has `session_kind=codex_app` or `receive_style=pull`, its
  idle/check-in command is
  `conveyor manager-inbox <task> --consume-next --wait --timeout 60 --json`.
- Repeat the appropriate command whenever the session is idle, after finishing
  a received instruction, and before deciding there is nothing more to do.
  A timeout is not completion; it is only a quiet poll interval.
- Keep `conveyor dispatch --watch --dispatcher-id dispatch-local` running so
  Dispatch can route new messages into those inboxes.
- For bounded Ralph loops, treat `ralph_loop_iteration_advanced` telemetry as
  the receipt that a worker actually consumed and began the requested
  iteration.

Reference docs:

- `README.md` command reference
- `docs/qa/ralph-loop-operator-guide.md`
- `docs/agent-evidence-playbook.md`

## Supervision Model

Supervision is built on three primitives: **sessions**, **tasks**, and
**bindings**.

- A **worker session** is a Codex session registered with Agent Conveyor. It may be a
  tmux-backed session or a Codex app/no-tmux session. Its rollout JSONL on disk
  (`~/.codex/sessions/.../rollout-*.jsonl`, or a disposable rollout file) is
  the source of truth for ingest.
- A **manager session** is a Codex session that can run anywhere — Ghostty,
  iTerm2, Terminal.app, a web terminal. The manager does not need tmux. Its
  job is to call `conveyor` commands, read their JSON output, and decide what
  to do next.
- Registration, `sessions`, `discover`, and disposable binding JSON include a
  `communication` block. Use it to decide the receive style for both worker and
  manager: tmux sessions are push-capable, while Codex app/no-tmux sessions
  receive through `manager-inbox` or `worker-inbox` polling.
- App-assisted setup may also record optional `codex_app_thread_id` and
  `codex_app_thread_title` metadata. This identifies the human-readable Codex
  app thread; it does not replace rollout ingest or Dispatch inbox receipts.
- A **task** is a unit of supervised work with a goal.
- A **binding** ties one worker session and one manager session to one task.

The manager Codex drives the supervision loop by calling
`conveyor cycle <task>` repeatedly. Each cycle ingests new rollout events,
captures the worker's tmux pane as a shadow signal, persists a `manager_cycles`
row, and returns structured JSON. The manager reads that JSON and decides.

Dispatch is core infrastructure for supervised pairs. The `pair` workflow starts
a detached Dispatch watch process by default after worker/manager setup and
bind. For manually bound pairs, keep Dispatch running in another shell with:

```bash
conveyor dispatch --watch --dispatcher-id dispatch-local
```

Dispatch wakes the bound manager on worker completion and executes queued
`notify_manager` / `nudge_worker` commands. It does not decide whether the task
is correct or finished.

## Preflight

1. Work from the control repo:
   ```bash
   cd /Users/neonwatty/Desktop/codex-terminal-manager
   ```
2. Verify dependencies:
   ```bash
   conveyor doctor
   ```
3. Verify the SQLite control plane is healthy:
   ```bash
   conveyor db-doctor
   ```
4. From the current Codex session, check whether it can register itself:
   ```bash
   conveyor doctor-self
   ```
   `supported: true` means the session is inside a live tmux session and can
   be registered as a worker. A non-tmux session can still be registered as a
   manager.

## Discovery For Q&A

When the user asks which worker, manager, task, or binding to connect, search
the control plane first and present likely choices instead of asking for
generated names:

```bash
conveyor discover <query>
conveyor search <query>
```

Use an empty query to list active candidates. Add `--all` only when the user is
looking for completed tasks or gone sessions. The JSON output includes
`tasks`, `sessions`, `bindings`, `telemetry`, and `suggestions`; use
`suggestions` to offer concise next steps such as a `conveyor bind` command or
the prompt to register a missing worker or manager.

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
   conveyor cycle <task-name>
   conveyor criteria <task-name> --list
   conveyor telemetry --summary --task <task-name>
   conveyor telemetry --task <task-name>
   conveyor replay <task-name>
   ```
   For `pair`-started workflows, Dispatch is started automatically unless
   `--no-dispatch` is passed. For manually bound pairs, keep
   `conveyor dispatch --watch --dispatcher-id dispatch-local` running
   in a separate shell while the pair is active, or run a bounded verification
   pass with `conveyor dispatch --watch --watch-iterations 2 --dry-run
   --json`.

The skill should translate those prompts into explicit `conveyor` commands.
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
conveyor to spawn both sessions in one automated command.

## Register Sessions

Register an already-running Codex worker (rollout JSONL is auto-discovered
from the pid via `lsof`):

```bash
conveyor register-worker --name foo --pid <WORKER_PID> \
  --cwd "$PWD" --tmux-session codex-foo
```

When a Codex app tool created or identified the thread, preserve that identity
with optional metadata flags:

```bash
conveyor register-worker --name foo --pid <WORKER_PID> \
  --cwd "$PWD" --codex-app-thread-id <THREAD_ID> \
  --codex-app-thread-title "Human readable title"
```

If `lsof` discovery fails, pass the rollout path explicitly:

```bash
conveyor register-worker --name foo --pid <WORKER_PID> \
  --cwd "$PWD" --tmux-session codex-foo \
  --codex-session ~/.codex/sessions/.../rollout-...-<uuid>.jsonl
```

Register a manager (tmux not required):

```bash
conveyor register-manager --name foo-mgr --pid <MGR_PID> --cwd "$PWD"
```

For new manager sessions started by Agent Conveyor, prefer `start-manager` or
`pair`. These send a manager bootstrap prompt to Codex so the rollout JSONL is
opened during startup and the manager has setup context. In `pair`, the manager
prompt includes the task name, goal, worker session, `manager-config
<task> --questions`, and `cycle <task>`.

For late attach, pass the known task context directly:

```bash
conveyor start-manager --name foo-mgr --cwd "$PWD" \
  --task foo-task --task-goal "..." --worker foo-worker
```

That bootstrap starts with concrete `manager-config`, `cycle`, `manager-ack`,
and `worker-ack` commands instead of `<task>` placeholders. If manager config
has already been recorded for the task, the bootstrap tells the manager to start
with `cycle`.

List registered sessions:

```bash
conveyor sessions
conveyor sessions --role worker
conveyor sessions --role manager
```

## Create A Task And Bind

For automated bootstrap of a fresh supervised worker/manager pair, use `pair`
instead of manually starting and binding sessions:

```bash
conveyor pair \
  --task <task-slug> \
  --worker-name <worker-name> \
  --manager-name <manager-name> \
  --dispatcher-id dispatch-pair \
  --cwd <target-repo> \
  --codex-profile yolo \
  --manager-mode strict \
  --task-goal "<one-line goal>" \
  --task-prompt "<worker prompt>" \
  --manager-objective "<manager objective>" \
  --manager-acceptance "<finish criterion>"
```

Use `--no-dispatch` only for isolated tests or manual Dispatch supervision.

Use this for external dogfood runs. Keep the control repo as the command cwd,
but set `--cwd` to the downstream project:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
export DOGFOOD_CWD="/path/to/external/project"
export TASK="external-dogfood-$(date +%Y%m%d)"
export WORKER="dogfood-worker-$(date +%Y%m%d)"
export MANAGER="dogfood-manager-$(date +%Y%m%d)"

conveyor pair \
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
conveyor cycle "$TASK"
conveyor criteria "$TASK" --list
conveyor telemetry --summary --task "$TASK"
conveyor telemetry --task "$TASK"
conveyor telemetry --search manager --task "$TASK"
conveyor replay "$TASK"
```

Finish and export evidence:

```bash
conveyor finish-task "$TASK" \
  --capture-transcript-before-stop \
  --require-transcript-segment \
  --require-criteria-audit \
  --stop-manager \
  --stop-worker

conveyor export-task "$TASK" \
  --output "/tmp/$TASK-export" \
  --zip \
  --include-transcripts

conveyor sessions --state active
conveyor reconcile --stale-cycles-seconds 1
```

```bash
conveyor tasks --create my-task --goal "Refactor auth"
conveyor handoff my-task \
  --summary "Worker explored the current auth flow and found middleware drift." \
  --next-step "Implement the middleware cleanup from docs/auth-plan.md"
conveyor manager-config my-task \
  --mode guided \
  --objective "Keep the worker aligned to docs/auth-plan.md" \
  --reference docs/auth-plan.md \
  --acceptance "Tests pass" \
  --guideline "Nudge only when the worker is idle, stale, or blocked"
conveyor bind --task my-task --worker foo --manager foo-mgr
```

`tasks` lists or creates rows. `bind` ties the worker and manager sessions to
the task. The task is now active.

Use `handoff` before or during management promotion to save the worker's
compact progress summary and likely next steps in SQLite. Use `manager-config`
to save what the manager should check against, how structured supervision
should be, acceptance criteria, planning/PRD/mockup references, and permissions
such as `--allow-pr`, `--allow-merge-green`, and
`--allow-worker-compact-clear`.

## Manager Recipes

When the user's setup request is broad or freeform, resolve it to one named
manager recipe before starting supervision, or explicitly label it `custom`.
Use `docs/manager-recipes.md` as the canonical reference, and use
`conveyor manager-recipes --list --json` or
`conveyor manager-recipes --show <recipe> --json` for stable setup metadata.

First-draft recipes:

- `GoalBuddy Conveyor` — one parent board, one active child board, PR/CI/merge
  or `satisfied_on_main` proof, and parent receipt update before the next child.
- `Test Coverage Loop` — require test coverage evidence plus structured
  adversarial proof before another worker pass.
- `UX Polish Loop` — require browser/screenshot/visual-diff evidence plus
  structured adversarial proof before another visual pass.
- `Nudge / What's Next Manager` — observe, ask status and criteria questions,
  nudge sparingly, and keep permissions minimal.
- `PR/CI/Merge Ralph Loop` — manage PR readiness, CI, fixes, merge, handoff,
  and compact/clear receipts.

Support patterns:

- `Inbox / No-Tmux App Loop` — use `manager-inbox` and `worker-inbox` for
  Codex app sessions that cannot receive tmux pushes.
- `Recovery / Resume / Handoff` — inspect saved config, handoff, replay, audit,
  telemetry, and inbox state before continuing a task.

Before saving config or cutting the manager loose, show a locked setup summary
with the selected recipe, mode, permissions, tools, epilogues, cleanup policy,
evidence gates, disallowed actions, and whether the user confirmed it. Then
persist the settings with `conveyor manager-config`.

When setting up a manager from inside a manager Codex session, prefer:

```bash
conveyor manager-config my-task --questions
```

Read the JSON question schema, ask the user those questions in the manager
conversation, then persist the answers with `manager-config` flags. This keeps
the human interaction in the Codex chat where the user is already working and
keeps SQLite writes explicit. Use `manager-config --interactive` only as a
terminal fallback for a human running `conveyor` directly.

Before instructing high-level actions such as PR creation, green PR merge, or
worker compact/clear, check the saved policy:

```bash
conveyor manager-permission my-task worker_compact_clear \
  --require-handoff --require
```

Use `--require` for fail-closed behavior. Use `--require-handoff` before
compact/clear so the worker's visible progress is saved first.

To request worker compaction/clear through the audited path, prefer the
one-command wrapper:

```bash
conveyor compact-worker my-task \
  --reason "Worker context should be compacted after handoff"
```

Use `--clear` for `/clear`. For lower-level control, first record a `nudge`
manager decision, then run:

```bash
decision_id=$(conveyor record-decision my-task nudge \
  --reason "Worker context should be compacted after handoff" \
  | node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).id)')
conveyor request-worker-compact my-task \
  --decision-id "$decision_id" --strict-decisions
```

This command checks `worker_compact_clear`, requires a saved handoff, records a
durable command, and sends Codex `/compact` to the worker's tmux pane. Use
`--clear` for `/clear`, or `--prompt-only` to send the conservative
verify/update-handoff prompt instead of a slash command.

## Manager Loop Pattern

The manager Codex drives supervision by calling `conveyor cycle <task>` in a
loop. Each cycle is idempotent: it ingests only new bytes from the rollout
JSONL, computes worker state from the JSON event stream, captures the worker
tmux pane, and returns a JSON dict.

Before declaring work complete, try to disprove the change. Identify the
strongest realistic failure mode, verify it with a command, test, trace,
screenshot, audit record, diff, or direct inspection, and include that evidence
in the handoff. Do not accept worker claims, passing happy-path tests, generated
summaries, or optimistic UI as proof by themselves. Treat unverified assumptions
as blockers or explicit follow-ups.

When the repository being managed is CTM, see
`docs/agent-evidence-playbook.md` for CTM-specific evidence choices and final
handoff format.

Natural-language requests such as "run this as an adversarially gated loop",
"require adversarial proof before another worker iteration", or "do not finish
until you have tried to disprove it" should be treated as operational gate
requests only after `conveyor loop-triggers --classify "<prompt>"
--json` matches a controlled trigger. For Ralph-loop work, create or use a loop
policy whose `required_before_continue` includes `adversarial_check`, then
record each proof receipt with `conveyor loop-evidence
adversarial-check <task> --loop-run <run-id> --iteration <n> --failure-mode ...
--check ... --result ...`. For final completion, use `conveyor
finish-task <task> --require-adversarial-proof` so the task cannot be marked
done until structured proof exists. Use `conveyor qa-run
adversarial-triggers --receipt-output /tmp/adversarial-triggers-receipt.json
--json` to verify the controlled trigger path.

Natural-language requests such as "create an autonomous GoalBuddy conveyor" or
"split this into vertical-slice child GoalBuddy boards and continue until all
are merged or proven satisfied" should be treated as conveyor requests, not as a
flat task list. Use `conveyor qa-plan goalbuddy-conveyor` to retrieve
the reusable starter prompt, authority boundaries, acceptance criteria,
correlation markers, and negative QA checks. The manager should keep exactly one
child board active, require PR/CI/merge or `satisfied_on_main` proof before
marking a child done, and update the parent receipt before activating the next
child.

```bash
conveyor cycle my-task
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
  result = conveyor cycle <task>           # observe
  interpret result.state, result.staleness_seconds, result.notable_pane_pattern
  decide:
    - "wait"      -> sleep, then loop
    - "nudge"     -> conveyor session-nudge <worker> "<text>"
    - "interrupt" -> conveyor session-interrupt <worker>
    - "escalate"  -> conveyor finish-task <task> --reason "<why>"
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
- Use `conveyor criteria` to accept, satisfy, defer, or reject
  criteria as evidence accumulates.
- Before finishing, compare the worker's receipts and verification against all
  accepted open criteria.

Criteria command examples:

```bash
conveyor criteria my-task --list
conveyor criteria my-task --add --criterion "..." --source worker_proposed --status proposed
conveyor criteria my-task --accept 12 --rationale "Must-have for this task"
conveyor criteria my-task --satisfy 12 --evidence-json '{"command":"npm test -- --runInBand","status":"pass"}'
conveyor criteria my-task --defer 13 --rationale "Follow-up after this task"
conveyor criteria my-task --reject 14 --rationale "Duplicate or out of scope"
```

Replace placeholder `...` values with the actual criterion and verification
command. To add a criterion and satisfy that same row after verification:

```bash
criterion_id=$(conveyor criteria my-task --add --criterion "Targeted prompt tests pass" --source worker_proposed --status proposed | node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).affected_criterion.id)')
conveyor criteria my-task --satisfy "$criterion_id" --evidence-json '{"command":"npm test -- --runInBand","status":"pass"}'
```

When making multiple criteria changes, use each mutation response's
`affected_criterion` as the row receipt, then run `conveyor criteria
<task> --list` before finishing or making an audit decision.

Sample nudge:

```bash
conveyor session-nudge foo \
  "Your latest progress exposed extra edge cases. Please propose acceptance criteria split into must-have for this task versus follow-up, and include the verification you expect for each."
```

## Actuation

Nudge the worker (sends text plus Enter to the worker's tmux pane). Only
worker sessions can be nudged this way; managers running outside tmux cannot:

```bash
conveyor session-nudge foo "Please update status and continue."
conveyor session-nudge foo "Status?" --dry-run
```

Send an interrupt key (default `C-c`):

```bash
conveyor session-interrupt foo
conveyor session-interrupt foo --key C-c --followup "continue with the smaller refactor"
```

## Inspect, Replay, Audit

```bash
conveyor tail foo --limit 30
conveyor tail foo --subtype agent_message
conveyor divergences my-task --limit 20
conveyor audit my-task
conveyor replay my-task
conveyor replay my-task --format transcript --limit 40
conveyor replay my-task --format full-transcript --include-content --limit 40 > /tmp/my-task-full-transcript.txt
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
conveyor finish-task my-task --reason "auth refactor merged"
conveyor finish-task my-task --reason "..." --require-criteria-audit
conveyor finish-task my-task --reason "..." --stop-manager
conveyor finish-task my-task --reason "..." --stop-worker
```

`finish-task` marks the task done and leaves both sessions running by default.
Use `--require-criteria-audit` when final acceptance criteria should be enforced:
it fails before finishing if any task criteria remain `accepted`; `proposed`,
`satisfied`, `deferred`, and `rejected` criteria do not block.
Add `--stop-manager` / `--stop-worker` only when the user explicitly wants the
tmux session torn down.

Clean up the binding and session registrations:

```bash
conveyor unbind --task my-task
conveyor deregister foo
conveyor deregister foo-mgr
```

`deregister` refuses if a session is still bound to an active task; run
`unbind` first.

## Reconcile Runtime Drift

If something looks wrong — a worker process exited, a manager left a session
behind, a task has stopped getting cycle rows — run reconcile:

```bash
conveyor reconcile
conveyor reconcile --apply
```

Without `--apply` it prints a JSON report of dead-pid sessions, dangling
bindings, and stuck tasks. With `--apply` it marks dead-pid sessions
`state='gone'` and dangling bindings `state='invalid'`, writing audit events
for each mutation. Stuck tasks are reported but never auto-closed.

For schema-level checks (legacy `workers`/`managers` tables, missing tables,
etc.) run `conveyor db-doctor --live`.

## Natural-Language Command Mapping

- "set up a Codex app Ralph loop": if the current session has Codex app thread
  tools, call `create_thread` for a fresh same-project worker, call
  `set_thread_title`, run `conveyor create-disposable-binding` with
  `--worker-codex-app-thread-id` and `--worker-codex-app-thread-title`, then
  send the returned `worker_handoff` using `send_message_to_thread`. If those
  tools are unavailable, run `create-disposable-binding` without thread
  metadata and give the user the `worker_handoff` prompt to paste into a
  manually opened worker. Keep Dispatch as the source of durable communication,
  and make both Codex app sessions repeat their role-specific inbox poll while
  idle.
- "register this Codex session as the worker for dashboard setup <CODE>":
  derive `dashboard-<CODE>-worker`, run `conveyor doctor-self`, then
  `conveyor register-worker --name dashboard-<CODE>-worker --pid <PID> --cwd <CWD> --tmux-session <SESSION>`.
- "register this session as the manager for dashboard setup <CODE>":
  derive `dashboard-<CODE>-manager`, run
  `conveyor register-manager --name dashboard-<CODE>-manager --pid <PID> --cwd <CWD>`.
- "register this Codex session as a worker": choose a concise worker name if
  none was provided, then run `conveyor doctor-self` and `register-worker`.
- "register a manager": choose a concise manager name if none was provided,
  then run `conveyor register-manager`.
- "create a task and bind these sessions":
  `conveyor tasks --create <TASK> --goal "<goal>"` then
  `conveyor bind --task <TASK> --worker <W> --manager <M>`.
- "watch the worker", "supervise this task", "run a cycle":
  `conveyor cycle <TASK>` (in a loop).
- "send a nudge", "ask the worker something":
  `conveyor session-nudge <WORKER> "<text>"`.
- "interrupt the worker": `conveyor session-interrupt <WORKER>`.
- "what happened in this task", "show the replay":
  `conveyor replay <TASK>` (optionally with `--format`).
- "finish this task": `conveyor finish-task <TASK> --reason "<why>"`.
- "unbind", "deregister this session": `conveyor unbind --task <TASK>`
  followed by `conveyor deregister <NAME>` per session.
- "reconcile drift", "something looks stale":
  `conveyor reconcile` (add `--apply` if the dry-run report looks correct).

## QA Plan

For a repeatable end-to-end checklist:

```bash
conveyor qa-plan self-management
conveyor qa-plan self-management --json
conveyor qa-plan emergent-criteria
conveyor qa-plan emergent-criteria --json
conveyor qa-plan tmux-errors
conveyor qa-plan tmux-errors --json
```

Use `emergent-criteria` when validating a real worker/manager pair through
criteria negotiation, audited finish gating, replay/export, and
`--stop-manager --stop-worker` cleanup.

Use `tmux-errors` when validating read-only JSON degradation, mutating command
failures, pane capture degradation, stop failures, and reconcile recovery for
disposable tmux failure scenarios.
