# Codex Terminal Manager

A Mac-first prototype for letting one Codex session supervise and gently steer
another Codex session running in a terminal.

The goal is not full autonomy. The goal is lightweight supervision for Codex
tasks that mostly need progress checks, occasional nudges, test reruns, or
clean stop/resume handling.

## Motivating Principles

- **Project workflows often need nudging.** Some Codex tasks do not need a
  second implementer; they need a manager that keeps watching, asks for status
  at the right time, unblocks predictable terminal prompts, and gently steers
  the worker back toward the user's goal.
- **Useful acceptance criteria often emerge during the work.** Even when the
  user starts with a plan, implementation reveals new edge cases, missing tests,
  unclear polish requirements, and follow-up decisions. The manager should help
  discover, record, defer, satisfy, and audit these emergent acceptance criteria
  instead of assuming the whole checklist can be known up front.
- **Supervision should be durable and replayable.** Manager observations,
  nudges, interrupts, handoffs, compaction requests, and final decisions should
  leave enough structured history to understand why the worker was pushed and
  what evidence supported finishing or continuing the task.

## Architecture

Supervision is built on three primitives: **sessions**, **tasks**, and
**bindings**.

- **Worker session.** A Codex session running inside a named `tmux` session.
  Workers own a rollout JSONL on disk (`~/.codex/sessions/.../rollout-*.jsonl`)
  which `workerctl` ingests for state inference.
- **Manager session.** A Codex session running anywhere — Ghostty, iTerm2,
  Terminal.app, or a web terminal. The manager does not need to run inside
  tmux. Its job is to call `workerctl` commands, read their JSON output, and
  decide whether to nudge, interrupt, finish, or wait.
- **Task.** A unit of supervised work. A task has a goal and optional
  summary/manager instructions.
- **Binding.** A row that ties one worker session and one manager session to
  one task. Bindings are explicit and durable.

The manager Codex drives the supervision loop by calling
`workerctl cycle <task>` repeatedly. Each cycle ingests new events from the
worker's rollout, captures the worker's tmux pane as a shadow signal, and
returns structured JSON. The manager reads that JSON and decides what to do.

`tmux` owns the worker PTY. Ghostty, iTerm2, Terminal.app, or `ttyd` can be
viewers, but they should not be the source of truth for orchestration.

```text
manager terminal
  Codex manager session
    |
    | runs workerctl commands (cycle, session-nudge, ...)
    v
tmux session: codex-worker-a
  pane 1: Codex worker session
  pane 2: optional dev server, tests, or logs

.codex-workers/
  workerctl.db         <- authoritative SQLite control plane
  worker-a/            <- ignored runtime artifacts
    status.json
    transcript.txt
    events.jsonl
```

## Non-Goals

- Cross-platform support.
- Browser-first orchestration.
- Full terminal emulator automation.
- Autonomous merging or destructive git actions.
- Managing many workers at once.

## Install

From the repo root:

```bash
scripts/install-local --write
export PATH="$PWD/bin:$PATH"
workerctl doctor
```

`scripts/install-local --write` updates future shells and installs the
`manage-codex-workers` skill into `$CODEX_HOME/skills` or `~/.codex/skills`.
The `export` line makes `workerctl` available in the current shell.

`workerctl doctor` reports local dependency health (tmux, codex, etc.).
`workerctl db-doctor` initializes and checks the SQLite control-plane
database.

## Quickstart

The fastest way to start a worker and register it is a single command:

```bash
# One command: spawn codex in tmux, wait for it to come up, register as worker
workerctl start-worker --name foo --cwd "$PWD" --task "Refactor auth"

# Register a manager. Managers do not need to run inside tmux.
MGR_PID=$$   # if your current shell is the manager; otherwise find its pid
workerctl register-manager --name foo-mgr --pid $MGR_PID --cwd "$PWD"

# Create a task and bind the pair to it.
workerctl tasks --create my-task --goal "Refactor auth"
workerctl bind --task my-task --worker foo --manager foo-mgr

# One observation cycle. Returns JSON.
workerctl cycle my-task

# Optionally nudge the worker through its tmux pane.
workerctl session-nudge foo "What's your current state?"

# When the task is complete:
workerctl finish-task my-task --reason "auth refactor merged"
workerctl unbind --task my-task
workerctl deregister foo
workerctl deregister foo-mgr
```

For manual registration of a pre-existing Codex session:

```bash
# Start a Codex worker inside a fresh tmux session.
tmux new-session -d -s codex-foo
tmux send-keys -t codex-foo "codex" Enter
# (Wait a moment for codex to come up.)
WORKER_PID=$(pgrep -f "codex.*--sandbox" | head -1)

# Register the worker. lsof auto-discovers the rollout JSONL from the pid.
workerctl register-worker --name foo --pid $WORKER_PID \
  --cwd "$PWD" --tmux-session codex-foo
```

If `lsof` discovery fails (e.g. the codex session was started ephemerally),
pass the rollout path explicitly with `--codex-session
~/.codex/sessions/.../rollout-...-<uuid>.jsonl`.

To register a manager session that's already running:

```bash
# If the codex is already running and you know its pid:
workerctl register-manager --name my-mgr --pid 28975

# register-manager runs `lsof -p <pid>` to find the rollout JSONL.
# If the codex hasn't written its rollout yet (no input typed),
# you'll get a hint asking you to type something in the codex prompt and retry.

# Or pass --codex-session explicitly to bypass the lsof probe:
workerctl register-manager --name my-mgr --pid 28975 \
    --codex-session /path/to/rollout.jsonl
```

Note: `lsof` is the canonical pid→rollout lookup. `find -newermt` is unreliable because
filesystem mtime resolution and parsing of "X minutes ago" varies — `lsof` reads the open fd directly.

For low-risk verification without a real task, `workerctl start-test
<name>` creates a worker, asks it to update only its ignored
`status.json`, and leaves the tmux session attached:

```bash
workerctl start-test live-test --cwd "$PWD" --accept-trust --open
tmux attach -t codex-live-test
```

## Commands

### Sessions and binding

- `start-worker --name N [--cwd D] [--task "..."] [--sandbox SANDBOX] [--ask-for-approval ASK_FOR_APPROVAL] [--timeout-seconds N]` —
  Spawn Codex in a fresh tmux session and register it as a worker in one call.
  The fastest way to start a supervised worker. Internally: `tmux new-session`
  + `codex` + poll for rollout + `register-worker`.
- `start-manager --name N [--cwd D] [--sandbox SANDBOX] [--ask-for-approval ASK_FOR_APPROVAL] [--timeout-seconds N]` —
  Spawn Codex in a fresh tmux session and register it as a manager in one call.
  Mirrors `start-worker` but uses a manager bootstrap prompt instead of a worker
  task prompt. The bootstrap opens Codex rollout metadata reliably and tells the
  manager to run `manager-config <task> --questions` before supervising when a
  task is known.
- `pair --task T --worker-name W --manager-name M [--cwd D] [--task-prompt PROMPT] [--task-goal GOAL] [--task-summary S] [--sandbox SANDBOX] [--ask-for-approval ASK_FOR_APPROVAL] [--timeout-seconds N]` —
  One-shot: spawn worker + manager and bind to a task in a single command. Combines
  `start-worker` + `start-manager` + `bind`. The task is looked up or created (if
  `--task-goal` is provided); if the task does not exist and no goal is given, an
  error is raised with a hint. The worker receives the optional `--task-prompt` as
  its initial Codex prompt; the manager receives a manager bootstrap prompt with
  the task, goal, worker name, `manager-config --questions`, and `cycle` commands.
  If the manager or bind fails after the worker is spawned, the worker remains
  registered and can be cleaned up with `workerctl deregister`.
- `register-worker --name N [--pid P | --codex-session PATH] [--cwd D] [--tmux-session S]` —
  Register an already-running Codex session as a worker. Rollout JSONL is
  auto-discovered from the pid via `lsof` unless `--codex-session` is given.
- `register-manager --name N ...` — Same arguments; tmux is not required.
- `deregister <name>` — Mark a session gone. Refuses if the session is bound
  to an active task.
- `sessions [--role worker|manager] [--state active|gone|all] [--include-legacy]` — List registered sessions.
  By default, `sessions` shows active registered sessions and hides Phase 1 backfill rows (legacy pre-redesign workers/managers, identified by `pid IS NULL`) plus rows marked `state='gone'`. Pass `--state all` to show every row, or `--state gone` to inspect only gone rows:
  ```bash
  workerctl sessions                    # active registered sessions only
  workerctl sessions --state active     # explicit equivalent of the default
  workerctl sessions --state gone       # gone sessions only
  workerctl sessions --state all        # active, gone, and legacy rows
  ```
- `tasks [--create NAME --goal G --summary S]` — List or create tasks.
- `handoff <task> --summary S [--next-step N ...] [--payload-json JSON]` —
  Persist a compact worker handoff for the task. Use this when a worker is
  becoming managed or before a long context transition so the manager can read
  progress and likely next steps from SQLite.
- `manager-config <task> [--mode light|guided|strict] [--objective O]
  [--guideline G ...] [--acceptance A ...] [--reference R ...]
  [--allow-pr] [--allow-merge-green] [--allow-worker-compact-clear]` —
  Persist the manager's supervision contract: what to check against, how
  structured the loop should be, acceptance criteria, source references, and
  high-level permissions. With no recorded config it creates the default guided
  config; with no mutating flags after that it prints the current config.
  Use `--questions` from a manager Codex session to get a stable JSON question
  schema to ask the user in chat, then save the answers with noninteractive
  flags. Use `--interactive` only as a terminal fallback when a human is
  running `workerctl` directly.
- `criteria <task>` — Track emergent acceptance criteria discovered during
  supervision. Managers should add useful proposed criteria, accept must-have
  items, defer follow-ups, and mark criteria satisfied only when worker
  receipts and verification cover them.
  ```bash
  scripts/workerctl criteria my-task --list
  scripts/workerctl criteria my-task --list --status accepted
  scripts/workerctl criteria my-task --add --criterion "..." --source worker_proposed --status proposed
  scripts/workerctl criteria my-task --accept 12 --rationale "Must-have for this task"
  scripts/workerctl criteria my-task --satisfy <id> --evidence-json '{"command":"...","status":"pass"}'
  scripts/workerctl criteria my-task --defer 13 --rationale "Follow-up after this task"
  scripts/workerctl criteria my-task --reject 14 --rationale "Duplicate or out of scope"
  ```
  Replace placeholder `...` values with the actual criterion and verification
  command. To add a criterion and satisfy that same row after verification:
  ```bash
  criterion_id=$(scripts/workerctl criteria my-task --add --criterion "Targeted prompt tests pass" --source worker_proposed --status proposed | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')
  scripts/workerctl criteria my-task --satisfy "$criterion_id" --evidence-json '{"command":"python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v","status":"pass"}'
  ```
- `manager-permission <task> <create_pr|merge_green_pr|worker_compact_clear>
  [--require] [--require-handoff]` — Check and audit whether the saved manager
  config allows a high-level action. Use `--require` when a manager command
  should fail closed. Use `--require-handoff` before worker compact/clear style
  instructions so visible context is persisted first.
- `record-decision <task> <wait|nudge|interrupt|escalate|stop|inspect>
  --reason R [--cycle-id N] [--payload-json JSON]` — Persist a manager
  decision and print its id. Use this before strict mutating commands that
  require `--decision-id`.
- `compact-worker <task> --reason R [--clear] [--prompt-only]` — Convenience
  wrapper that records a `nudge` manager decision, then sends Codex `/compact`
  to the worker through the same strict audited path as
  `request-worker-compact`. Use `--clear` to send `/clear`.
- `request-worker-compact <task> --decision-id N --strict-decisions` — Send
  Codex `/compact` to the worker through the audited path. Use `--clear` to
  send `/clear`, or `--prompt-only` to send an explanatory prompt instead.
  Fails closed unless `worker_compact_clear` is enabled in manager config and
  a worker handoff exists. Records a durable command and audit events
  before/after sending the worker instruction.
- `bind --task T --worker W --manager M` — Create the task binding.
- `unbind --task T` — End the active binding for a task.
- `finish-task <task> [--reason R] [--require-criteria-audit] [--stop-manager]
  [--stop-worker]` — Mark a task done. Leaves the manager terminal open by
  default for review. With `--require-criteria-audit`, fails before finishing
  if any acceptance criteria for the task are still `accepted`; `proposed`,
  `satisfied`, `deferred`, and `rejected` criteria do not block.
- `stop-task <task> [--stop-worker]` — Force-stop a task's manager (and
  optionally the worker).

### Observation

- `cycle <task> [--busy-wait-seconds N]` — One observation cycle. Idempotent. Runs `ingest`, computes
  worker state from the JSON event stream, captures the tmux pane as a shadow
  signal, writes a `manager_cycles` row, and returns a JSON dict the manager
  Codex consumes. The `status_payload` includes:
  - `worker_alive` / `manager_alive` — booleans computed by probing the registered session pids (`os.kill(pid, 0)`). `False` when the session's pid is `NULL` (legacy backfill) or the process has exited — useful for detecting silently-dead workers between cycles.
  - `last_event_subtype` — the subtype of the most recent `codex_events` row for the worker, or `null` if no events exist.
  - `task_completed` — `true` iff `last_event_subtype` is `"task_complete"`. Disambiguates "worker finished cleanly" from "worker idle but never started."
  - `manager_context` — the latest `manager-config`, `handoff`, and
    `acceptance_criteria` records for the task, so each manager loop can
    reference the saved objective, living acceptance criteria, permissions,
    worker progress, and next steps. `manager_context.acceptance_criteria`
    groups criteria by status, includes summary counts, and exposes `open` as
    accepted criteria that still need proof before finishing.
  
  The `cycle` subcommand accepts `--busy-wait-seconds N` (default: 90) to tune the pane-signal classifier's stuck-busy threshold. Lower values flag stalls faster but increase false positives on long-running real work:
  ```bash
  workerctl cycle my-task                          # default 90s threshold
  workerctl cycle my-task --busy-wait-seconds 30   # tighter detection
  ```
- `ingest <session>` — Pull new events from a session's rollout JSONL into
  the `codex_events` table. Tracks a byte offset, so subsequent runs only
  pick up new events.
- `tail <session> [--limit N] [--subtype T]` — Print the most recent events
  for a session, newest first. Filter by `event_msg` subtype.
- `divergences <task> [--limit N]` — Cycles whose shadow pane signal flagged
  a notable pattern (trust prompt, rate-limit prompt, approval prompt, etc.).
  Useful for auditing the shadow signal against the JSON state.

### Actuation

- `session-nudge <name> "<text>" [--dry-run]` — Send text plus Enter to the
  session's tmux pane. Requires the session to have been registered with
  `--tmux-session`. Managers running outside tmux cannot receive nudges; only
  workers do.
- `session-interrupt <name> [--key K] [--followup T] [--dry-run]` — Send an
  interrupt key (default `C-c`). Optional `--followup` text after the
  interrupt.

### Audit

- `audit <task>` — Events history for a task. Lists `events`-table rows only.
- `replay <task> [--format compact|timeline|transcript|full-transcript]
  [--role all|worker|manager] [--limit N]` — Render a chronological,
  human-readable reconstruction of the task. Cycle entries include
  `[pane pattern: <pattern_id>]` when the shadow signal flagged something.
- `mutation-audit <task>` — Manager decisions and their consequences.
- `events <name>` — Worker events log.
- `commands [--task T] [--type T] [--state S]` — Durable side-effect commands
  log.
- `export-task <task> [--zip]` — Dump task status, audit, prompts, and
  transcript metadata into an export bundle.

### Administration

- `doctor` — Local dependency and tmux health check.
- `doctor-self` — Verify the current Codex session can self-register.
- `db-doctor` — SQLite schema health check.
- `reconcile [--apply] [--stale-cycles-seconds N]` — Report (and optionally
  fix) dead-pid sessions, dangling bindings, and stuck tasks. Default
  stale-cycle threshold is 3600 seconds (1h); override with
  `--stale-cycles-seconds N` to catch tasks where the manager has been silent
  for shorter intervals. JSON output.
- `prune [--keep-latest N] [--dry-run]` — Drop old transcript content while
  preserving metadata.
- `transcript-prune <task> [--keep-latest N]` — Same, scoped to a task.
- `transcript-capture <task> [--role R] [--mode M]` — Capture deduplicated
  transcript segments.
- `transcript-show <task> [--role R]` — Show stored transcript segments.
- `qa-plan <name>` — Print a repeatable manual QA checklist.
- `import-compat` — Dry-run or import existing `.codex-workers/<worker>/`
  artifacts into SQLite.

### Worker setup

- `create <name> --cwd D --task "..."` — Full worker creation: spawn a tmux
  session, start Codex, send the initial worker contract.
- `start <name> --cwd D` — Start a plain Codex session inside tmux without
  registering a worker. Useful when you want to register it manually later.
- `start-test <name>` — Low-risk verification worker that only updates its
  ignored `status.json`.

### Terminal helpers

- `open <name>` — Open a macOS terminal window attached to a registered
  worker.
- `open-worker <task>` — Open a terminal window for a task's worker without
  spelling raw tmux session names.
- `open-manager <task>` — Same, for the task's manager.

### Low-level worker actions (legacy worker-name-keyed)

These commands operate against workers by name and predate the manual-binding
path. They remain useful for direct access against backfilled workers and for
debugging.

- `list` — List known workers.
- `status <name>` — Print worker status as JSON.
- `idle-check <name>` — Classify worker freshness and recommend an action.
- `capture <name>` — Capture recent terminal output.
- `nudge <name> "<text>"` — Send text into the worker terminal.
- `interrupt <name>` — Send an explicit interrupt key.
- `stop <name>` — Stop a worker tmux session.
- `update-status <name>` — Update a worker status contract.
- `classify --text "..."` — Debug the busy-wait pattern classifier.

## Manager Loop Pattern

A manager Codex drives supervision by calling `workerctl cycle <task>`
repeatedly. Each call:

1. Runs `ingest` against the worker's rollout JSONL (idempotent; picks up only
   new bytes since the last cycle).
2. Computes the worker's current state from the JSON event stream
   (`busy`, `idle`, or `unknown`). `task_started`/`user_message` set the
   session to `busy`; `task_complete` sets it to `idle`; everything else does
   not change state.
3. Captures the worker's tmux pane (if attached) and runs the legacy
   pattern detector — surfaces `trust_prompt`, `rate_limit_prompt`,
   `enter_to_confirm`, etc. as `notable_pane_pattern`. This is the shadow
   signal: best-effort and supplementary.
4. Writes a row to `manager_cycles` so the full observation history is
   replayable via `workerctl replay <task>`.
5. Returns a structured JSON dict.

The manager parses the JSON, decides whether to act, and optionally calls
`workerctl session-nudge` / `session-interrupt`. Then it loops.

```bash
workerctl cycle auth-refactor
# {
#   "kind": "session_cycle",
#   "task": "auth-refactor",
#   "worker_session": "auth-worker",
#   "manager_session": "auth-mgr",
#   "ingest": { "new_events": 3, "new_offset": 12345 },
#   "state": "busy",
#   "last_state_event_at": "2026-05-11T14:32:11Z",
#   "staleness_seconds": 4.2,
#   "notable_pane_pattern": "trust_prompt",
#   "pane_signal": {
#     "captured": true,
#     "classifier": { "pattern": "trust_prompt", ... },
#     "notable_pattern": "trust_prompt"
#   },
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
#     }
#   },
#   "cycle_id": 17,
#   ...
# }
```

If `notable_pane_pattern` is set the manager can branch on it directly —
e.g., on `trust_prompt` send Enter via `session-nudge` rather than waiting on
`staleness_seconds`. On `IngestError` (rollout missing or rotated), `cycle`
records a `state='failed'` row before re-raising so the audit trail still
captures the attempt.

**Audit convention.** Mutating commands (`session-nudge`,
`session-interrupt`) write to the `events` table. Observation and
dedicated-table commands (`cycle`, `ingest`) write to their own tables
(`manager_cycles`, `codex_events`) — those tables ARE the audit trail. The
plain-text `workerctl audit <task>` lists `events` rows only; cycle
observations show up via `workerctl replay <task>` and the `manager_cycles`
table.

## Phase 6 Polish

Recent additions to streamline worker setup and observability:

- `start-worker` convenience command for spawn-and-register in one call.
- `reconcile --stale-cycles-seconds N` to customize the stale-cycle threshold.
- Observability: `terminal_capture_error` / `terminal_fresh` fields in
  status/idle JSON; `rollback_error` in nudge/interrupt audit payloads;
  `skipped_lines` in `cycle` output's `ingest` field; stderr warnings on
  malformed event lines and audit-insert failures.

## Phase 7 polish (2026-05-11)

Three quality-of-life additions following Phase 6 dogfood:

- **`sessions --state`** — by default, `workerctl sessions` now hides Phase 1 backfill rows (`pid IS NULL`) and rows marked `state='gone'`. Use `--state all` to inspect every row, `--state gone` for completed/dead registrations, or `--state active` for the default view.
- **`worker_alive` / `manager_alive` in cycle output** — every `workerctl cycle` JSON now includes these booleans, computed by `os.kill(pid, 0)` against the registered session pids. Surfaces silently-dead workers between cycles.
- **`cycle --busy-wait-seconds N`** — exposes the pane-signal classifier's stuck-busy threshold (previously hard-coded at 90s) as a per-cycle flag.

## Phase 8 classifier improvements (2026-05-12)

- **Recent event suppression for `long_running_interruptible`** — the classifier now weighs `recent_event_count` (from `ingest.new_events`) alongside `status_age_seconds`. When a worker is actively emitting events (>= 10/cycle), the `long_running_interruptible` flag is suppressed—the worker is healthy despite stale status.json. This stops false positives on long-running tools (e.g. test suites, large file reads) that stay busy but quiet on status updates.

## Schema

SQLite database at `.codex-workers/workerctl.db`. Key tables:

- `sessions` — Unified worker/manager registration.
- `bindings` — Task ↔ worker session ↔ manager session.
- `tasks` — Task records.
- `codex_events` — Per-session JSONL events ingested from rollout files.
- `manager_cycles` — One row per `cycle` invocation, with the full JSON
  payload as `status_json`.
- `events` — Actuation audit log (`session_nudged`, `session_interrupted`,
  etc.).
- `commands` — Durable side-effect command log.
- `workers`, `managers` — Legacy tables retained for read-only history.

`workerctl db-doctor` reports schema health. `workerctl reconcile` reports
runtime drift (dead-pid sessions, dangling bindings, stuck tasks); add
`--apply` to fix.

## Migration from the Legacy Path

Earlier prototypes used a worker-first promotion flow where a worker was
created first and a manager was then spawned to supervise it. Those legacy
commands have been retired. The new path inverts the model: register two
already-running Codex sessions, create a task, bind them, and let the manager
Codex drive observation via `cycle`.

The legacy database tables (`workers`, `managers`) remain readable via
`audit`, `replay`, and `export-task` for historical reference, but no kept
CLI command writes to them. To resume work on a legacy task, call
`finish-task` on it and start fresh via `register-worker` +
`register-manager` + `bind`.

## Tests

Run the dependency-free test suite:

```bash
python3 -m unittest discover -s tests -v
```

GitHub Actions runs the same suite and a `py_compile` check on every push
and pull request.

When `tmux`, `codex`, and `rg` are available, the optional live smoke test
creates unique `codex-smoke-*` sessions and cleans them up on exit:

```bash
scripts/live-smoke
```
