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

## Quickstart: One Managed Worker

From the repo root, install the local shim and check dependencies:

```bash
scripts/install-local --write
export PATH="/Users/neonwatty/Desktop/codex-terminal-manager/bin:$PATH"
workerctl doctor
```

`scripts/install-local --write` updates future shells and installs the
`manage-codex-workers` skill into `$CODEX_HOME/skills` or `~/.codex/skills`.
The `export` line makes `workerctl` available in the current shell.

Start a low-risk worker that only updates its ignored runtime status file:

```bash
workerctl create demo-worker \
  --cwd "$PWD" \
  --task "Read README.md and update only .codex-workers/demo-worker/status.json with a short summary." \
  --wait-ready \
  --accept-trust
```

Run a bounded manager loop:

```bash
workerctl watch demo-worker --interval 10 --max-cycles 3 --dry-run
```

Inspect the worker:

```bash
workerctl status demo-worker
workerctl capture demo-worker
workerctl events demo-worker --limit 20
```

Stop it when finished:

```bash
workerctl stop demo-worker
```

Healthy worker state usually moves through:

```text
waiting -> planning -> editing/running_tests -> done
```

## Current MVP Usage

From the repo root:

```bash
workerctl doctor
workerctl start-test live-test --cwd "$PWD" --accept-trust --open
tmux attach -t codex-live-test
workerctl create worker-a --cwd /path/to/repo --task "Inspect the failing test and report the blocker."
workerctl create worker-b --cwd "$PWD" --task "Read README.md and update status.json." --wait-ready --accept-trust --verify --open
workerctl list
workerctl list --json
workerctl status worker-a
workerctl idle-check worker-a
workerctl supervise worker-a
workerctl watch worker-a --interval 60
workerctl events worker-a --limit 20
workerctl interrupt worker-a
workerctl capture worker-a
workerctl nudge worker-a "Please summarize current progress and next action."
workerctl stop worker-a
```

## Manual-Assignment Primitives (Phase 1)

The new path lets you register an already-running Codex session as a worker or manager
and bind them to a task explicitly. These commands coexist with `promote`/`manage`;
existing supervision still uses the older path until Phase 2 lands the JSON ingester.

```bash
# Register a worker (auto-discovers rollout via lsof on pid)
workerctl register-worker --name auth-worker --pid $WORKER_PID --cwd "$PWD"

# Register a manager — tmux NOT required
workerctl register-manager --name auth-mgr --pid $MGR_PID --cwd "$PWD"

# Create a task (existing command — note the --create flag form)
workerctl tasks --create auth-refactor --goal "Finish the auth refactor"

# Bind them
workerctl bind --task auth-refactor --worker auth-worker --manager auth-mgr

# Observe
workerctl sessions
workerctl sessions --role worker

# Clean up
workerctl unbind --task auth-refactor
workerctl deregister auth-mgr
workerctl deregister auth-worker
```

If `lsof` discovery fails (e.g. the codex session was started with `--ephemeral`), supply
the rollout path explicitly:

```bash
workerctl register-worker --name w --pid $PID \
  --codex-session ~/.codex/sessions/2026/05/11/rollout-...-<uuid>.jsonl
```

**Phase 1 scope:** these primitives create durable DB records only. Supervision still
runs through `promote`/`manage`/`supervise` against the legacy worker/manager records.
The JSON ingester and the manual-binding supervision loop come in Phase 2.

### Phase 2: Ingest + Tail

Once a session is registered, its rollout JSONL can be ingested and queried.
Ingestion is idempotent and tracks a byte offset so subsequent runs only pick up
new events.

```bash
# Run one ingest cycle for a registered session
workerctl ingest auth-worker
# Output: {"session": "auth-worker", "new_events": 42, "new_offset": 12345}

# View the most recent codex events for a session (newest first)
workerctl tail auth-worker --limit 20

# Filter by event_msg subtype
workerctl tail auth-worker --subtype task_started --limit 5
```

The `ingest` command can be called repeatedly (e.g. on a polling interval). Each
run reads from the recorded `last_ingest_offset`, persists new events into the
`codex_events` table keyed by session id, advances the offset, and bumps
`last_heartbeat_at` on the session row. A long-running session ingester / new
supervision loop lands in Phase 3.

**State inference:** `task_started` and `user_message` set the session to `busy`;
`task_complete` sets it to `idle`. Other event subtypes (`agent_message`,
`token_count`, `response_item`) are recorded but do not change the inferred state.

> **Note:** `workerctl tail <name>` previously dumped pane output (`--lines N`)
> from tmux capture. As of Phase 2 it returns structured codex events from the
> DB (`--limit N`, `--subtype T`). Use `workerctl capture <name>` if you need
> the legacy pane-output behavior.

### Phase 3: Observation Cycles + Session Actions

Once a task has an active binding, the manager Codex can drive supervision by
calling `workerctl cycle <task>` to observe the worker, then deciding whether
to nudge, interrupt, finish, or wait. The cycle command is one-shot and stateless;
the manager Codex performs the loop.

```bash
# Observe one cycle (idempotent — runs ingest first, then summarizes state).
workerctl cycle auth-refactor
# Output:
# {
#   "kind": "session_cycle",
#   "task": "auth-refactor",
#   "binding_id": "binding-...",
#   "worker_session": "auth-worker",
#   "manager_session": "auth-mgr",
#   "ingest": { "new_events": 3, "new_offset": 12345 },
#   "state": "busy",
#   "last_state_event_at": "2026-05-11T14:32:11Z",
#   "staleness_seconds": 4.2,
#   "cycle_id": 17,
#   "cycle_started_at": "2026-05-11T14:32:15Z",
#   "cycle_completed_at": "2026-05-11T14:32:15Z"
# }

# Nudge the worker (text + Enter via the worker's tmux pane).
workerctl session-nudge auth-worker "Status update please"
workerctl session-nudge auth-worker "Status update please" --dry-run

# Interrupt the worker (Ctrl-C by default; --followup to send text after).
workerctl session-interrupt auth-worker
workerctl session-interrupt auth-worker --followup "Stop and report progress"
```

**Worker tmux requirement.** `session-nudge` and `session-interrupt` require the
target session to have been registered with `--tmux-session` (workers running in
tmux). They reject sessions without a tmux pane — e.g. managers running in plain
Codex outside tmux. This is intentional: managers don't receive nudges; only
workers do.

**Manager loop pattern.** A manager Codex running outside tmux supervises by:
1. Calling `workerctl cycle <task>` and parsing the JSON output.
2. Deciding based on `state` and `staleness_seconds` whether to act.
3. Optionally calling `workerctl session-nudge`/`session-interrupt` to act.
4. Sleeping or yielding control, then looping.

Each `cycle` invocation writes a `manager_cycles` row with `status_json` so the
full observation history is replayable via the existing `workerctl audit <task>`.
On `IngestError` (rollout file missing or rotated), `cycle` records a
`state='failed'` row with the error message before re-raising, so the audit trail
captures unsuccessful attempts too.

**Audit convention.** Phase 3 commands split audit-trail writes by category:
`session-nudge` and `session-interrupt` actuate the worker (mutate external state
via tmux) and therefore write `session_nudged` / `session_interrupted` rows to
the `events` table. `cycle` and `ingest` write to their own dedicated tables
(`manager_cycles` and `codex_events`) — those tables ARE the audit trail. Don't
add an `events` row when the command already records itself in a dedicated table.

**State inference (recap from Phase 2):** `task_started`/`user_message` → `busy`;
`task_complete` → `idle`; everything else does not change state. `unknown` means
no state-bearing event has been ingested yet.

### Phase 4: Shadow Pane Signal + Divergences

Every `cycle` invocation now also captures the worker's tmux pane (if attached)
and runs the legacy `classify_busy_wait` pattern detector. The results are
included in the cycle output as `pane_signal` and (for easy filtering)
`notable_pane_pattern`. The JSON state remains the primary signal; the pane
signal is supplementary — it surfaces stuck-prompt conditions (trust prompt,
rate-limit prompt, approval prompt, etc.) that the JSON event stream cannot see.

```bash
# A cycle with a notable pane pattern looks like:
workerctl cycle auth-refactor
# {
#   "kind": "session_cycle",
#   "task": "auth-refactor",
#   "state": "busy",
#   "notable_pane_pattern": "trust_prompt",
#   "pane_signal": {
#     "captured": true,
#     "classifier": {
#       "pattern": "trust_prompt",
#       "reason": "terminal is waiting for workspace trust confirmation",
#       "recommended_action": "inspect_or_accept_trust"
#     },
#     "notable_pattern": "trust_prompt",
#     "status_age_seconds": 4,
#     "reason": null
#   },
#   ...
# }

# A session without a tmux pane (e.g. a manager outside tmux) yields a clean
# non-captured signal — the cycle still succeeds with the JSON state:
# "pane_signal": { "captured": false, "reason": "no tmux session attached", ... }

# Audit divergences during the shadow period:
workerctl divergences auth-refactor
workerctl divergences auth-refactor --limit 5
```

**What counts as a "divergence"?** Currently: any cycle whose pane signal flagged
a pattern at all (`notable_pane_pattern` is non-null). This catches stuck-prompt
states the JSON stream cannot detect. The `divergences` command returns those
cycles newest-first along with their full `status_json` payload, so an operator
can decide whether the pane signal was right and the worker needed intervention.

**Operational shape.** A manager Codex driving supervision continues to consume
`workerctl cycle` as its primary observation. It can now also branch on
`notable_pane_pattern` — e.g., if the pattern is `trust_prompt`, the manager
might send a confirmation via `session-nudge` rather than waiting on
`staleness_seconds`. The shadow signal is best-effort: tmux capture failures are
caught and reported in `pane_signal.reason` rather than aborting the cycle.

**Replay parity.** `workerctl replay <task>` and `workerctl audit <task>` both
surface `[pane pattern: <pattern_id>]` in the rendered cycle summary when a
pattern was detected — so historical pattern occurrences are easy to scan
through the same audit surfaces used in Phase 2-3.

## SQLite Worker-Manager Lifecycle

`workerctl` now uses `.codex-workers/workerctl.db` as the authoritative
control-plane store for tasks, workers, managers, bindings, status contracts,
prompts, transcript captures, command intents/results, and audit events. The
JSON files under `.codex-workers/<worker>/` remain compatibility artifacts.
Worker names are human labels; SQLite worker IDs are opaque `worker-<uuid>`
identities. `identity_token` remains a separate contract verification secret.

Create a worker, then promote it into a managed task:

```bash
workerctl create worker-a \
  --cwd "$PWD" \
  --task "Work on the assigned task and report status with workerctl." \
  --no-initial-prompt

workerctl promote worker-a \
  --task auth-refactor \
  --goal "Finish the auth refactor" \
  --summary "Worker is ready for supervision" \
  --max-nudges 3 \
  -- --model gpt-5.4-mini
```

To start a normal Codex session that can later declare itself as a managed
worker, use `start`. This creates a raw tmux session and does not register a
worker yet. By default, `start` gives the raw worker agent a bootstrap prompt
with its session name, the exact `workerctl manage --session ...` command
template, and instructions to ask for missing worker/task/goal values rather
than guessing:

```bash
workerctl start qa-raw --cwd "$PWD" -- --sandbox danger-full-access --ask-for-approval never
tmux attach -t qa-raw
```

From inside that Codex session, natural language like "make yourself managed"
should cause the agent to either run the printed `workerctl become-managed
--session ...` command or ask for missing required values. Full access is
required if the agent itself needs to rename tmux sessions and spawn managers.
When `start` is given Codex args after `--`, the bootstrap prompt carries those
args into the `become-managed` template so the manager gets the same tmux-capable
permissions.
Use `--no-start-prompt` only when you intentionally want a plain Codex session.

Plain Codex sessions can also self-manage if they have the installed skill and
are already running inside tmux. Ask the agent to make itself managed; it should
run:

```bash
workerctl doctor-self
```

`workerctl doctor-self` is a mandatory preflight gate for plain Codex sessions:
the agent should never run `workerctl become-managed` until
`can_promote_in_place` is true. If `can_promote_in_place` is true, it should
prefer the reported `become_managed_recommended_command_template` after asking
for any missing worker name, task name, or goal. Manager launch commands default
to the recommended manager Codex args:

```bash
--sandbox danger-full-access --ask-for-approval never
```

If the current Codex process is not inside tmux, it cannot be
promoted in-place as a tmux-backed worker; start a tmux-backed session with
`workerctl start ...` instead.
Pass explicit manager Codex args after `--` only when intentionally overriding
that default. Use `--no-manager-codex-args` only when you intentionally want a
manager without those defaults; workerctl records
`manager_started_without_codex_args` in that case.

Use `workerctl explain-managed-flow --json` when an agent needs compact command
mappings for phrases like "manage yourself", "stop supervising me", "resume
supervision", or "finish this managed task". Use
`workerctl qa-plan self-management` for the repeatable manual QA checklist for
the plain-worker-to-managed-worker path.

An agent already running inside a tmux session can turn itself into a managed
worker with one command. `become-managed` opens the manager terminal by default.
If the current tmux session is not already named `codex-<worker>`, pass
`--worker` and it will register and rename the session before spawning the
manager:

```bash
workerctl become-managed \
  --worker worker-a \
  --task auth-refactor \
  --goal "Finish the auth refactor" \
  --summary "Worker is ready for manager supervision" \
  -- --model gpt-5.4-mini
```

`manage`, `name-session`, and `self-promote` remain available as lower-level
commands when you intentionally want to separate registration from manager
creation or suppress the visible manager window.

Worker name claims are conservative. `manage` and `name-session` allow an
idempotent claim by the same tmux session, but refuse a name already recorded
for a different session unless `--force-name` / `--force` is explicitly used.
Forced reclaims preserve the old worker row under a replaced name, create a new
worker ID/token for the claimant, and write the replacement to the audit log.

Inspect and operate the task through task-scoped commands:

```bash
workerctl task-status auth-refactor --json
workerctl task-health auth-refactor --audit-decisions --json
workerctl manager-observe auth-refactor --compact --json
workerctl manager-decision auth-refactor --decision inspect --reason "health OK; reading worker output"
workerctl task-capture auth-refactor --lines 120 --json
workerctl task-capture auth-refactor --role manager --lines 120 --json
workerctl task-idle-check auth-refactor
workerctl task-nudge auth-refactor "Please update status and state your next action." --decision-id 123 --strict-decisions
workerctl task-interrupt auth-refactor --decision-id 124 --strict-decisions
workerctl audit auth-refactor --json
workerctl mutation-audit auth-refactor --json
workerctl replay auth-refactor
workerctl replay auth-refactor --format compact
workerctl replay auth-refactor --format transcript --limit 20
workerctl replay auth-refactor --format full-transcript --limit 40
workerctl transcript-capture auth-refactor --role all --mode segment
workerctl transcript-show auth-refactor --role worker
workerctl commands --task auth-refactor --json
workerctl commands --task auth-refactor --type task_nudge --state failed --json
workerctl task-events auth-refactor --json
workerctl open-worker auth-refactor
workerctl open-manager auth-refactor
workerctl close-manager auth-refactor --reason "review complete"
workerctl db-doctor --live
workerctl import-compat
```

Pause, resume, reconcile, recover, export, and close the task:

```bash
workerctl pause-manager auth-refactor --decision-id 125 --strict-decisions
workerctl unmanage
workerctl resume-manager auth-refactor -- --model gpt-5.4-mini
workerctl reconcile auth-refactor
workerctl recover auth-refactor
workerctl recover auth-refactor --sync-pane-ids
workerctl close-stale auth-refactor
workerctl close-stale auth-refactor --apply
workerctl export-task auth-refactor --zip
workerctl finish-task auth-refactor --reason "work is complete" --decision-id 126 --strict-decisions
workerctl close-manager auth-refactor --reason "post-finish review complete"
workerctl finish-task auth-refactor --reason "work is complete" --stop-manager --decision-id 126 --strict-decisions
workerctl stop-task auth-refactor --stop-worker --decision-id 127 --strict-decisions
```

`pause-manager <task>` is the explicit task-scoped operator command. From inside
the managed worker session, `workerctl unmanage` resolves the current tmux
session to its active task, stops only the manager, marks the task `paused`, and
leaves the worker session running for manual control. Natural-language requests
such as "take back manual control", "pause my manager", or "stop managing me"
should map to `workerctl unmanage`.

Worker sessions can also inspect or restart their own management without knowing
the task name:

```bash
workerctl my-status
workerctl remanage --open-manager -- --model gpt-5.4-mini
```

`my-status` prints the current worker, task, task state, manager state, and
suggested next commands. `remanage` is the worker-facing counterpart to
`resume-manager <task>` and restarts supervision for a paused task. Use
`open-manager <task>` or `open-worker <task>` to open task-bound terminals
without spelling raw tmux session names.

`task-nudge` reserves SQLite budget before sending. Mutating task commands write
durable command intent/result rows, and `audit` shows the resulting timeline.
Managers should pass the `decision_id` returned by `manager-decision` to
mutating task commands with `--decision-id --strict-decisions`. Without strict
mode, missing, stale, or incompatible decision links are warning-only and are
visible in `mutation-audit`.
If an active task exhausts its nudge budget, `task-health` reports a budget
warning. Record an `escalate` decision before extending the budget:

```bash
decision_id=$(workerctl manager-decision auth-refactor --decision escalate --reason "nudge budget exhausted but supervised work should continue" | python3 -c 'import json,sys; print(json.load(sys.stdin)["decision_id"])')
workerctl extend-nudge-budget auth-refactor --add-nudges 3 --decision-id "$decision_id" --strict-decisions
```

Use `commands` to inspect durable side-effect command rows directly, including
filtered views by task, type, state, worker ID, or manager ID. Use `task-events`
for a task-scoped event stream when reconstructing what happened.
Use `replay <task>` for a chronological, human-readable reconstruction of the
worker-manager relationship. `--format compact` shows decisions and side
effects only; `--format transcript` includes deduplicated terminal-capture
excerpts; `--format full-transcript` interleaves operational events with
deduplicated raw transcript segments. `--json` returns stable machine-readable
entries. Use `transcript-capture` and `transcript-show` for explicit full
transcript debugging when the operational replay is not enough.
Use `task-health <task> --audit-decisions --json` when you want one task-scoped
integrity view that combines SQLite state, live tmux drift, unfinished commands,
manager decision linkage, and manager
heartbeat warnings.
Managers should start each supervision loop with `manager-observe --compact
--json`; it records full task health, worker and manager terminal captures, and
the current status into SQLite while returning a smaller payload for the
manager context. Use `manager-decision` to record why a manager chose to wait,
inspect, nudge, interrupt, escalate, or stop. Mutating commands such as
`task-nudge`, `task-interrupt`, `finish-task`, and `stop-task` are conditional
tools, not checklist items.
Use `finish-task <task> --reason "<reason>"` when the task is complete and
should be closed while preserving the audit trail. By default it leaves the
manager terminal open for review. Add `--stop-manager` only when the manager
terminal should be closed, and add `--stop-worker` only when the worker session
should be stopped too. If you finish first and review the manager terminal
later, run `close-manager <task> --reason "<reason>"` to close that review
manager and update SQLite. After `finish-task` succeeds, managers should stop
their supervision loop and report the final outcome once. `manager-decision`
rejects decisions on `done` or `failed` tasks unless `--allow-post-terminal` is
supplied for an explicit review-only annotation.
Before task-scoped text, interrupt, or kill side effects, workerctl verifies the
recorded worker/manager identity, tmux session, and pane ID for the active
binding.
When a live session is intentionally reused and `reconcile` reports a pane
mismatch, `recover --sync-pane-ids` records the repair and updates SQLite to the
current live pane IDs.
Use `db-doctor --live` for a read-only combined SQLite health and live tmux
drift check. Live manager heartbeat warnings are reported without failing the
doctor check unless there is actual reconciliation drift or an unfinished
durable command; tune the warning threshold with `--manager-stale-seconds`.
For a finished task, `task-health` treats a stale but still-live review manager
as `review_manager_idle` metadata instead of a health issue; close it with
`close-manager` when review is complete.
Use `close-stale` to dry-run closure of tasks whose recorded worker is missing,
not supervised by a live manager, and has no unfinished durable commands.
`close-stale --apply` marks those tasks `failed`, ends their active bindings,
marks the missing worker/manager records, and writes command/event audit rows.
Use `import-compat` to dry-run import of existing `.codex-workers/<worker>/`
JSON, JSONL, status, and transcript artifacts into SQLite. Add `--apply` after
reviewing the plan; imports are tracked in `data_migrations` so reruns are
idempotent.

Transcript capture content can be pruned while retaining metadata:

```bash
workerctl prune --keep-latest 20 --dry-run
workerctl prune --keep-latest 20
```

Run the optional live lifecycle smoke test when `tmux`, `codex`, and `rg` are
available:

```bash
scripts/live-smoke
```

The smoke script creates unique `codex-smoke-*` sessions and cleans them up on
exit.

`start-test` is the easiest manual startup check. It creates a low-risk worker,
asks it to update only its ignored `.codex-workers/<name>/status.json`, waits for
that status update, and leaves the tmux session running so you can attach:

```bash
workerctl start-test live-test --cwd "$PWD" --accept-trust --open
tmux attach -t codex-live-test
```

`--open` is macOS-only. It opens a terminal window attached to the existing tmux
session, preferring Ghostty when installed and falling back to Terminal.app. You
can also open an already-running worker:

```bash
workerctl open live-test
workerctl open live-test --terminal terminal
```

`workerctl` records every terminal launch attempt before opening the app. A
second open for the same worker is refused by default to prevent accidental
terminal-window floods, even if the first app launch did not visibly work:

```bash
workerctl open live-test --force
workerctl create worker-b --cwd "$PWD" --task "..." --wait-ready --verify --open --force-open
```

Use `--stop-after` only when you want a disposable smoke test that cleans up the
tmux session automatically.

For a lifecycle smoke test without sending the worker prompt into Codex:

```bash
workerctl create smoke --cwd "$PWD" --task "Smoke test only." --no-send-contract
workerctl status smoke
workerctl idle-check smoke
workerctl supervise smoke --dry-run
workerctl stop smoke
```

Worker runtime files are stored under `.codex-workers/` and are intentionally ignored by git.

To run `workerctl` from anywhere, add the local `bin` directory to your shell path:

```bash
export PATH="/Users/neonwatty/Desktop/codex-terminal-manager/bin:$PATH"
```

Or install that PATH line and the Codex skill into `~/.zshrc` / `~/.codex`:

```bash
scripts/install-local --write
```

Then use:

```bash
workerctl doctor
workerctl list
workerctl watch worker-a
```

`supervise` runs one manager cycle. It reads the same freshness signals as `idle-check`, reports an action, and sends a cooldown-protected status nudge only when the worker is stale.

`watch` runs `supervise` repeatedly and prints one JSON line per cycle. Use `--max-cycles` for bounded trials:

```bash
workerctl watch worker-a --interval 60 --max-cycles 3 --dry-run
```

`idle-check`, `supervise`, and `watch` also detect known interactive or busy-wait terminal states, such as Codex MCP startup, trust prompts, plan prompts, and rate-limit prompts. These are reported as `health: "busy_wait"` with an inspect-oriented recommendation.

Busy-wait interruption is explicit by default:

```bash
workerctl interrupt worker-a
workerctl supervise worker-a --interrupt-busy-wait --dry-run
```

For debugging classifier behavior directly:

```bash
workerctl classify --text "Starting MCP servers (2/3)"
```

## Tests

Run the dependency-free test suite with:

```bash
python3 -m unittest discover -s tests -v
```

GitHub Actions runs the same test suite and a `py_compile` check on every push and pull request.

To have `create` classify the initial Codex screen, use `--wait-ready`:

```bash
workerctl create worker-a \
  --cwd /path/to/repo \
  --task "Inspect the failing test and report the blocker." \
  --wait-ready
```

If the target directory is one you intentionally trust, `--accept-trust` lets the startup watcher accept Codex's workspace trust prompt:

```bash
workerctl create worker-a \
  --cwd /path/to/repo \
  --task "Inspect the failing test and report the blocker." \
  --wait-ready \
  --accept-trust
```
