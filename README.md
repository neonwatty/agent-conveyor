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

## Burden Of Proof

Before declaring work complete, try to disprove the change. Identify the
strongest realistic failure mode, verify it with a command, test, trace,
screenshot, audit record, diff, or direct inspection, and include that evidence
in the final handoff. Treat `done`, `tests passed`, worker claims, passing
happy-path tests, generated summaries, and optimistic UI as claims, not proof.
Treat unverified assumptions as blockers or explicit follow-ups.

See `docs/agent-evidence-playbook.md` for the repo-specific evidence ladder,
receipt options, and final handoff shape agents should use when closing out
work.

## Architecture

Supervision is built on three primitives: **sessions**, **tasks**, and
**bindings**.

- **Worker session.** A Codex session running inside a named `tmux` session.
  Workers own a rollout JSONL on disk (`~/.codex/sessions/.../rollout-*.jsonl`)
  which Agent Conveyor ingests for state inference.
- **Manager session.** A Codex session running anywhere — Ghostty, iTerm2,
  Terminal.app, or a web terminal. The manager does not need to run inside
  tmux. Its job is to call `conveyor` commands, read their JSON output, and
  decide whether to nudge, interrupt, finish, or wait.
- **Task.** A unit of supervised work. A task has a goal and optional
  summary/manager instructions.
- **Binding.** A row that ties one worker session and one manager session to
  one task. Bindings are explicit and durable.

The manager Codex drives the supervision loop by calling
`conveyor cycle <task>` repeatedly. Each cycle ingests new events from the
worker's rollout, captures the worker's tmux pane as a shadow signal, and
returns structured JSON. The manager reads that JSON and decides what to do.

`tmux` owns the worker PTY. Ghostty, iTerm2, Terminal.app, or `ttyd` can be
viewers, but they should not be the source of truth for orchestration.

```text
manager terminal
  Codex manager session
    |
    | runs conveyor commands (cycle, session-nudge, ...)
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

For users, install the published Agent Conveyor package with npm:

```bash
npm install -g agent-conveyor
conveyor install-skills
conveyor doctor
```

The package name is `agent-conveyor`. The installed CLI exposes both
`conveyor` and the compatibility command `workerctl`. `conveyor install-skills`
installs the `manage-codex-workers` and `codex-review` skills into
`$CODEX_HOME/skills` or `~/.codex/skills`. The `codex-review` install includes
the guarded review helper used by the QA and PR closeout flows.

For contributors working from this checkout, use the local installer instead:

```bash
scripts/install-local --write
export PATH="$PWD/bin:$PATH"
```

To test unreleased packaging changes before publish, install a local npm
tarball into a temporary prefix:

```bash
npm run build
npm pack
tmp_prefix="$(mktemp -d)"
npm install -g --prefix "$tmp_prefix" ./agent-conveyor-*.tgz
PATH="$tmp_prefix/bin:$PATH" conveyor --help
PATH="$tmp_prefix/bin:$PATH" workerctl --help
```

`conveyor doctor --json` reports local dependency health (tmux, codex, etc.),
package/bin resolution, Codex home, installed operator plugin version, installed
operator skills, and an `operator_ready` summary for Codex app manager/worker
setup.
`conveyor db-doctor` initializes and checks the SQLite control-plane
database.
On Node versions where `node:sqlite` is still marked experimental, SQLite
commands can also print an `ExperimentalWarning` to stderr while returning
successful JSON. Treat that warning as expected Node runtime noise when the
command exits 0 and the JSON result reports `"ok": true`.
Before publishing `agent-conveyor` to npm, use
[`docs/package-release.md`](docs/package-release.md).
The preferred publish path is the manual GitHub Actions `publish.yml` workflow
with npm Trusted Publishing enabled for the `npm-production` environment. Use
`publish=false` for artifact review and `publish=true` only for an approved
release version that is not already on npm.

For common manager setups, start with
[`docs/manager-recipes.md`](docs/manager-recipes.md). It maps natural-language
requests such as GoalBuddy conveyor runs, test coverage loops, UX polish loops,
what-next nudging, PR/CI/merge Ralph loops, and autonomous ship-it loops to
concrete `manager-config` settings, permissions, evidence gates, cleanup
behavior, and example
manager/Dispatch/worker interactions. Use `conveyor manager-recipes --list`
or `conveyor manager-recipes --show goalbuddy-conveyor --json` for a
machine-readable setup preview.
For a package-facing overview of these modes, open
[`docs/landing-page.html`](docs/landing-page.html) locally or host it as a
static landing page. From the repo, `npm run docs:landing` serves it at
`http://127.0.0.1:8765/`.
The GitHub Pages version lives at
[`neonwatty.github.io/agent-conveyor`](https://neonwatty.github.io/agent-conveyor/).
Pages deploys from the protected `landing-page` branch through the
`Pages` GitHub Actions workflow; propose public landing-page edits against
that branch rather than relying on ordinary `main` package PRs to publish the
site.
Pull requests into `landing-page` run the `Landing Page PR` workflow, which
checks linting, unused exports/files, tests, build output, the landing-page
screenshot gate, and a diff-scoped max-lines guard for changed text files.
Use `node scripts/check-landing-page.mjs` for a docs-only desktop/mobile
screenshot gate; this does not run the full package release smoke.

### Codex Operator Plugin

Agent Conveyor also ships Codex-app-only operator scaffolding for visible
manager/worker sessions from any project. Install the package, then install
and inspect the plugin:

```bash
npm install -g agent-conveyor
conveyor install-plugin
conveyor doctor --json
```

The per-project default ledger for operator sessions is
`.codex-workers/workerctl.db`. The included skills are
`conveyor-app-wake-relay`, `conveyor-smoke-app-connections`,
`conveyor-create-pair`, `conveyor-create-worker-set`,
`conveyor-check-status`, `conveyor-setup-bundle`, and
`conveyor-whats-next-nudger`.

After install, the intended Codex app entry point is natural language. Open a
new Codex app session in the target repo and say:

```text
Use the conveyor-create-pair skill.

Set up a Codex app Ralph loop for issue CTL.
Require adversarial proof before another worker iteration.
```

For multiple workers, start with `Use the conveyor-create-worker-set skill`.
The installed plugin skill should call the `conveyor` CLI, choose names, create
the no-tmux binding with `create-disposable-binding`, point the worker at
`worker-inbox`, and use `loop-status` plus telemetry receipts before reporting
that the loop is ready. Pair and worker-set skills run
`conveyor-smoke-app-connections` before real task work by default. Required
smoke first checks package/plugin/ledger/thread metadata, then starts a
nonce-scoped `app-smoke` session and blocks real work until the worker has
accepted smoke and delivered the manager report, then the manager validates
that report. Both roles need visible app-thread send receipts, fresh app
heartbeats, durable received/accepted acknowledgements, and an
`app-smoke status` result with `real_work_allowed=true`. The plain CLI records
and evaluates receipts; the Codex app skill/operator layer must perform live
`send_message_to_thread` delivery and record `sent`, `blocked`, or
skipped/advisory evidence. If a smoke role blocks and later succeeds, the later
accepted receipt for the same smoke id/nonce becomes the current terminal role
state. After required smoke passes, pair and worker-set skills start
`app-autopilot` before real work so the just-proved sessions keep polling. A
setup is autonomous only when the emitted heartbeat automation specs have been
applied and recorded with `app-autopilot record-automation`, or explicitly
deferred as `manual-poll only`; smoke-passed by itself only proves connection
plumbing at that moment.
When the manager is itself running in the Codex app and
thread tools are available, the skill should first call `create_thread` for a
fresh same-project worker, name it with `set_thread_title`, pass the returned
thread identity through `--worker-codex-app-thread-id` and
`--worker-codex-app-thread-title`, and use `send_message_to_thread` only to
deliver the generated `worker_handoff` bootstrap prompt. The raw terminal
`conveyor` CLI does not create Codex app threads by itself; if app thread tools
are unavailable, open a separate Codex app worker manually and paste the
`worker_handoff` prompt. After a worker consumes a manager instruction, its
completion or blocker report must go back through the generated
`enqueue-notify-manager` command and a bounded Dispatch watch tick; a direct
Codex app final answer is not a durable manager receipt.
The live manager and worker sessions should also be readable as the primary
operator transcript: after consuming an inbox item, the consuming session must
print `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, and
`DISPATCH` sections while the turn is happening. SQLite/replay/status output is
audit proof, not a replacement for the live session story. Idle polls may be a
single `CONVEYOR IDLE` line.

#### Known-Good Operator Smoke Recipe

Use this recipe when proving that a global install and plugin can control
visible Codex app manager/worker sessions from a target project before any real
work starts. It is a plumbing test only: do not inspect product code, private
content, or edit target files.

1. From the target project, prove the operator install:

```bash
conveyor doctor --json
```

The install is ready only when the JSON reports `ok=true`,
`operator_ready=true`, the package and installed plugin versions match, and the
expected operator skills are installed.

2. Create two disposable Codex app threads in the same target project:
   a worker and a manager. Give them smoke-only names, such as
   `operator smoke worker` and `operator smoke manager`.

3. Bind those thread ids to a disposable task ledger:

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/operator-smoke.db"
TASK="operator-smoke"

conveyor create-disposable-binding "$TASK" \
  --goal "Disposable operator smoke; do no product work." \
  --summary "Prove Agent Conveyor app-thread smoke plumbing only." \
  --worker "$TASK-worker" \
  --manager "$TASK-manager" \
  --worker-codex-app-thread-id "<worker-thread-id>" \
  --worker-codex-app-thread-title "<worker-thread-title>" \
  --manager-codex-app-thread-id "<manager-thread-id>" \
  --manager-codex-app-thread-title "<manager-thread-title>" \
  --cwd "$PWD" \
  --path "$LEDGER" \
  --json
```

4. Run required connection smoke with the
   `conveyor-smoke-app-connections` skill from the operator session:

```bash
conveyor app-smoke preflight "$TASK" --mode required --scope pair --path "$LEDGER" --json
conveyor app-smoke start "$TASK" --mode required --scope pair --path "$LEDGER" --json
```

The skill must send the worker smoke prompt with native Codex app thread tools,
record `app-smoke ... --status sent`, wait for the worker to consume the smoke
inbox item, then send the manager smoke prompt only after the worker report is
in the manager inbox.

5. Treat this as the pass receipt:

```bash
conveyor app-smoke status "$TASK" --smoke-id "<smoke-id>" --path "$LEDGER" --json
```

The smoke passes only when the JSON reports `ok=true`,
`real_work_allowed=true`, fresh manager and worker app heartbeats, matching
nonce-scoped send receipts, and durable received/accepted receipts. A final
answer in either app thread is not proof by itself.

6. Clean up the disposable proof:
   archive only the manager and worker threads created for this smoke, then
   remove the disposable ledger if it was created solely for the test:

```bash
rm -rf .codex-workers
```

Never archive a thread unless its id came from the binding or the thread
creation receipt for this exact smoke run.

For bounded follow-up passes after the first worker result, use
`Use the conveyor-whats-next-nudger skill`.

For stale Codex app roles, use `Use the conveyor-app-wake-relay skill`. It
runs `app-wakeup-dispatch`, sends only prepared `send_ready=true` prompts with
Codex app thread tools, and records `sent`, `skipped`, or `blocked` delivery
receipts with `app-wakeup-record-delivery`. The app-thread prompt wakes the
session to poll; it is not durable task truth.

Dispatch is core infrastructure for supervised worker/manager pairs. The
`pair` workflow starts a detached Dispatch watch process by default so worker
completion is routed to the bound manager mechanically. For manually bound
pairs, run Dispatch in a separate shell:

```bash
conveyor dispatch --watch --dispatcher-id dispatch-local
```

Use `conveyor qa-plan dispatch-completion` for a bounded verification flow, or
`conveyor qa-plan ralph-loop` for the repeated PR/CI/merge/context-clear
dogfood loop.
Use `conveyor qa-plan adversarial-triggers` to verify natural-language
manager prompts activate Ralph-loop adversarial gates.
Use `conveyor qa-plan goalbuddy-conveyor` when a broad request should become
sequential GoalBuddy child boards with PR/CI/merge receipts.
Use `conveyor qa-plan ship-it-loop` when a manager is allowed to push a branch,
open a PR, monitor CI, resolve bounded conflicts, and merge only after explicit
manager-owned merge evidence.
Before cutting a manager loose, have it resolve the freeform setup request to a
named recipe from `docs/manager-recipes.md` or an explicit `custom` setup, then
show the saved mode, permissions, evidence gates, cleanup policy, and disallowed
actions.
For manual QA, launch the dashboard with Dispatch enforcement so the page can
show live proof:

```bash
conveyor dashboard --task <task> --ensure-dispatch --dispatcher-id qa-dispatch-dashboard
```

## Quickstart

The fastest way to start a worker and register it is a single command:

```bash
# One command: spawn codex in tmux, wait for it to come up, register as worker
conveyor start-worker --name foo --cwd "$PWD" --task "Refactor auth"

# Register a manager. Managers do not need to run inside tmux.
MGR_PID=$$   # if your current shell is the manager; otherwise find its pid
conveyor register-manager --name foo-mgr --pid $MGR_PID --cwd "$PWD"

# Create a task and bind the pair to it.
conveyor tasks --create my-task --goal "Refactor auth"
conveyor bind --task my-task --worker foo --manager foo-mgr

# Start Dispatch in another shell so worker completion wakes the manager.
conveyor dispatch --watch --dispatcher-id dispatch-local

# One observation cycle. Returns JSON.
conveyor cycle my-task

# Optionally nudge the worker through its tmux pane.
conveyor session-nudge foo "What's your current state?"

# When the task is complete:
conveyor finish-task my-task --reason "auth refactor merged" --capture-transcript-before-stop --stop-manager --stop-worker
conveyor unbind --task my-task
conveyor deregister foo
conveyor deregister foo-mgr
```

For manual registration of a pre-existing Codex session:

```bash
# Start a Codex worker inside a fresh tmux session.
tmux new-session -d -s codex-foo
tmux send-keys -t codex-foo "codex" Enter
# (Wait a moment for codex to come up.)
WORKER_PID=$(pgrep -f "codex.*--sandbox" | head -1)

# Register the worker. lsof auto-discovers the rollout JSONL from the pid.
conveyor register-worker --name foo --pid $WORKER_PID \
  --cwd "$PWD" --tmux-session codex-foo
```

If `lsof` discovery fails (e.g. the codex session was started ephemerally),
pass the rollout path explicitly with `--codex-session
~/.codex/sessions/.../rollout-...-<uuid>.jsonl`.

To register a manager session that's already running:

```bash
# If the codex is already running and you know its pid:
conveyor register-manager --name my-mgr --pid 28975

# register-manager runs `lsof -p <pid>` to find the rollout JSONL.
# If the codex hasn't written its rollout yet (no input typed),
# you'll get a hint asking you to type something in the codex prompt and retry.

# Or pass --codex-session explicitly to bypass the lsof probe:
conveyor register-manager --name my-mgr --pid 28975 \
    --codex-session /path/to/rollout.jsonl
```

Note: `lsof` is the canonical pid→rollout lookup. `find -newermt` is unreliable because
filesystem mtime resolution and parsing of "X minutes ago" varies — `lsof` reads the open fd directly.

For low-risk verification without a real task, `conveyor start-test
<name>` creates a worker, asks it to update only its ignored
`status.json`, and leaves the tmux session attached:

```bash
conveyor start-test live-test --cwd "$PWD" --accept-trust --open
tmux attach -t codex-live-test
```

## Commands

### Campaigns

- `campaign create --name C --objective TEXT [--metadata-json JSON] [--json]` —
  Create a campaign record for a multi-worker initiative.
- `campaign add-slot --name C --slot-key K --role-label TEXT [--channel CH] [--session-id S] [--thread-id ID] [--thread-title TITLE] [--state planned|active|idle|blocked|archived] [--metadata-json JSON] [--json]` —
  Add a named worker slot to a campaign. If `--session-id` is supplied, the
  runtime verifies that it is a registered worker session.
- `campaign attach-slot --name C --slot SLOT_ID [--session-id S] [--thread-id ID] [--thread-title TITLE] [--state planned|active|idle|blocked|archived] [--metadata-json JSON] [--json]` —
  Attach or refresh worker-session and Codex app thread metadata for an existing
  campaign slot. Supplying `--session-id` requires a registered worker session.
- `campaign rotate-slot --name C --slot SLOT_ID --expected-thread-id OLD --thread-id NEW [--thread-title TITLE] [--session-id S] [--state planned|active|idle|blocked|archived] [--json]` —
  Record a campaign-owned worker slot rotation. The command refuses to update
  the slot unless `OLD` matches the slot's current Codex app thread id.
- `campaign archive-slot --name C --slot SLOT_ID --expected-thread-id CURRENT [--json]` —
  Mark a campaign worker slot archived only when the expected current thread id
  matches the slot record.
- `campaign brief --name C --channel CH --brief-json JSON [--json]` —
  Upsert the structured brief for a channel.
- `campaign assign --name C --slot SLOT_ID --title TEXT --instructions TEXT [--status queued|active|blocked|done|cancelled] [--metadata-json JSON] [--json]` —
  Create a slot-scoped assignment.
- `campaign asset --name C --slot SLOT_ID --asset-type image|video|hyperframes|copy|audio|other --title TEXT [--assignment ASSIGNMENT_ID] [--channel CH] [--status draft|needs_review|approved|rejected|published] [--prompt-summary TEXT] [--artifact-path PATH] [--metadata-json JSON] [--review-notes TEXT] [--allow-additional-receipt] [--json]` —
  Record a structured creative asset receipt. Assignment-scoped receipts are
  one-per-assignment by default; use `--allow-additional-receipt` only for
  intentional variants or revisions.
- `campaign status --name C [--json]` —
  Show campaign metadata, worker slots, channel briefs, assignment counts, and
  asset receipt counts.
- `campaign dashboard --name C [--json]` —
  Show a manager-oriented campaign aggregate: worker slot lifecycle states,
  blockers, approval counts, and the next recommended manager action. This is
  also the supported way to inspect asset receipts and per-slot receipt counts;
  there is no separate `campaign assets` subcommand.
- `campaign closeout --name C [--failure-mode TEXT] [--json]` —
  Produce a read-only closeout report from the campaign dashboard, including
  verdict, worker thread ids, blockers, receipt counts by assignment, proof
  checks, and the strongest realistic failure mode evidence to carry into a
  manager/operator handoff.

Creative Ops Campaign manager loop:

```bash
conveyor campaign create --name "$CAMPAIGN" \
  --objective "Produce reviewable channel assets." --json
conveyor campaign add-slot --name "$CAMPAIGN" --slot-key tiktok \
  --role-label "TikTok worker" --channel tiktok \
  --thread-id "$TIKTOK_THREAD_ID" --thread-title "TikTok Worker" \
  --state active --json
conveyor campaign brief --name "$CAMPAIGN" --channel tiktok \
  --brief-json '{"format":"9:16","review_gate":"human approval before publish"}' --json
conveyor campaign assign --name "$CAMPAIGN" --slot "$SLOT_ID" \
  --title "Draft TikTok hooks" \
  --instructions "Create reviewable draft copy only; do not publish." \
  --status active --json
conveyor campaign asset --name "$CAMPAIGN" --slot "$SLOT_ID" \
  --assignment "$ASSIGNMENT_ID" --asset-type copy \
  --title "TikTok hooks v1" --status needs_review \
  --prompt-summary "Sanitized prompt summary only." --json
conveyor campaign dashboard --name "$CAMPAIGN" --json
conveyor dashboard --campaign "$CAMPAIGN" --ensure-dispatch
```

Use `campaign rotate-slot` or `campaign archive-slot` only with the exact
current `--expected-thread-id` for that campaign slot. Public publishing,
scheduling, posting, external account access, private phone content, raw audio,
tokens, JWTs, keys, archives, and IPAs require explicit human approval or must
stay out of receipts.

### Sessions and binding

- `start-worker --name N [--cwd D] [--task "..."] [--sandbox SANDBOX] [--ask-for-approval ASK_FOR_APPROVAL] [--accept-trust] [--timeout-seconds N]` —
  Spawn Codex in a fresh tmux session and register it as a worker in one call.
  The fastest way to start a supervised worker. Internally: `tmux new-session`
  + `codex` + poll for rollout + `register-worker`.
- `start-manager --name N [--cwd D] [--task T] [--task-goal G] [--worker W] [--sandbox SANDBOX] [--ask-for-approval ASK_FOR_APPROVAL] [--accept-trust] [--timeout-seconds N]` —
  Spawn Codex in a fresh tmux session and register it as a manager in one call.
  Mirrors `start-worker` but uses a manager bootstrap prompt instead of a worker
  task prompt. When `--task`, `--task-goal`, and `--worker` are supplied, the
  bootstrap is ready for late attach: it names the task, goal, worker session,
  and concrete `manager-config`, `cycle`, `manager-ack`, and `worker-ack`
  commands. If manager config has already been recorded for the task, the
  bootstrap tells the manager to start with `cycle` instead of asking setup
  questions again. Without those flags, the bootstrap asks the manager to
  collect the missing supervision details before cycling.
- `pair --task T --worker-name W --manager-name M [--cwd D] [--task-prompt PROMPT] [--task-goal GOAL] [--task-summary S] [--manager-objective O] [--manager-guideline G ...] [--manager-acceptance A ...] [--sandbox SANDBOX] [--ask-for-approval ASK_FOR_APPROVAL] [--accept-trust] [--timeout-seconds N] [--dispatcher-id ID] [--no-dispatch]` —
  One-shot: spawn worker + manager and bind to a task in a single command. Combines
  `start-worker` + `start-manager` + `bind`. The task is looked up or created (if
  `--task-goal` is provided); if the task does not exist and no goal is given, an
  error is raised with a hint. The worker receives the optional `--task-prompt` as
  its initial Codex prompt; the manager receives a manager bootstrap prompt with
  the task, goal, worker name, manager configuration status, and `cycle` commands.
  `pair` records a default guided manager config before launching the manager, so
  retries against an existing task do not fall back into setup-question mode.
  If manager config flags are supplied (`--manager-mode`,
  `--manager-objective`, repeated `--manager-guideline`,
  `--manager-acceptance`, `--manager-reference`, or manager permission flags),
  those values are merged into the seeded config and the bootstrap tells the
  manager to start supervising with `cycle` instead of asking setup questions
  first. Manager acceptance entries are also seeded into the living
  acceptance criteria ledger when they do not already exist for the task. By
  default `pair` starts a detached `dispatch --watch` process after successful
  worker/manager setup, bind, and run creation. Use `--dispatcher-id` to set its
  identity or `--no-dispatch` for isolated/manual workflows. A live dispatch
  heartbeat is reused only when it has the same dispatcher id; otherwise `pair`
  starts the requested dispatcher so audit receipts keep the configured
  identity.
  If the manager or bind fails after the worker is spawned, the worker remains
  registered and can be cleaned up with `conveyor deregister`.
  Use `--accept-trust` only for directories you intentionally trust; it retries
  Enter during startup discovery so fresh workspaces do not stall before
  registration.
- `register-worker --name N [--pid P | --codex-session PATH] [--cwd D] [--tmux-session S] [--codex-app-thread-id ID] [--codex-app-thread-title TITLE]` —
  Register an already-running Codex session as a worker. Rollout JSONL is
  auto-discovered from the pid via `lsof` unless `--codex-session` is given.
  The optional Codex app thread flags are metadata supplied by the Codex app
  skill/tool layer; they help humans identify the app thread but do not change
  rollout ingest or Dispatch delivery.
- `register-manager --name N ...` — Same arguments; tmux is not required.
  Both registration commands print a `communication` object. When
  `--tmux-session` is present, `communication.session_kind='tmux'`,
  `receive_style='push'`, and `delivery_mode='push'`; without tmux but with a
  Codex rollout identity, `session_kind='codex_app'`, `receive_style='pull'`,
  and `delivery_mode='pull_required'`, with the role-specific inbox polling
  command template. The generated command may include a local
  `PATH=.../bin:$PATH conveyor` prefix; preserve that prefix when sending the
  command to a Codex app thread.
- `deregister <name>` — Mark a session gone. Refuses if the session is bound
  to an active task.
- `sessions [--role worker|manager] [--state active|gone|all] [--include-legacy]
  [--name N ...] [--redact-identity-token]` — List registered sessions.
  By default, `sessions` shows active registered sessions and hides Phase 1 backfill rows (legacy pre-redesign workers/managers, identified by `pid IS NULL`) plus rows marked `state='gone'`. Pass `--state all` to show every row, or `--state gone` to inspect only gone rows:
  ```bash
  conveyor sessions                    # active registered sessions only
  conveyor sessions --state active     # explicit equivalent of the default
  conveyor sessions --state gone       # gone sessions only
  conveyor sessions --state all        # active, gone, and legacy rows
  conveyor sessions --name <session> --redact-identity-token
  ```
  For shareable QA evidence, prefer repeating `--name` for just the sessions in
  scope and include `--redact-identity-token`; unfiltered output can include
  unrelated active sessions and their registration tokens.
  Each session row includes the same `communication` block emitted by
  registration, so managers can detect whether a worker or manager is
  tmux-push capable or must poll its mailbox.
- `tasks [--create NAME --goal G --summary S]` — List or create tasks.
- `create-disposable-binding TASK [--worker NAME] [--manager NAME] [--template TEMPLATE | --required-before-continue TYPE] [--adversarial] [--worker-codex-app-thread-id ID] [--worker-codex-app-thread-title TITLE] [--manager-codex-app-thread-id ID] [--manager-codex-app-thread-title TITLE]` —
  Create a no-tmux manager/worker binding for real Ralph-loop slices. The
  helper creates the task when missing, marks it managed, writes valid Codex
  rollout JSONL files, registers worker and manager sessions with
  `tmux_session=null`, binds them, optionally creates a template-backed or
  custom Ralph-loop policy run, and prints replay commands for Dispatch,
  `loop-status`, per-session `communication` metadata, plus a `worker_handoff`
  prompt that tells Codex app workers to keep polling their worker inbox
  through the bounded loop using the exact generated command. For pull-required
  Codex app sessions, the JSON output also includes
  `heartbeat_recommendations` with role-specific poll prompts; Dispatch can
  deliver into those inboxes, but a heartbeat or operator wake-up is still
  required to make an idle app thread poll autonomously. The worker handoff and
  worker heartbeat prompt also include the exact durable
  `enqueue-notify-manager` and one-iteration `dispatch --watch` commands that a
  worker must run after completing or blocking on a consumed item. Those prompts
  require live session transcript blocks for consumed items, so the operator can
  inspect the actual Codex app sessions and see the same flow the durable inbox
  later proves. Those
  recommendations also include `wakeup_dispatch_command` and
  `delivery_receipt_commands` for
  app-thread wake recovery. Use them to record sent, skipped, and blocked wake
  outcomes after `app-wakeup-dispatch`; an app-thread send is not task
  completion. The recommendations include a `teardown_policy`: an idle poll is
  only a quiet interval, not a reason to delete or pause heartbeat automation;
  heartbeat teardown belongs to the manager/operator after terminal closeout or
  explicit operator instruction. For same-thread Codex app visible-session
  dogfood, prefer `--template app_visible_build_loop` or a custom adversarial
  gate; reserve cleanup-gated templates such as `build_then_clear` for flows
  that create a fresh worker context or can record a real cleanup receipt
  between iterations.
  The optional
  Codex app thread metadata is normally supplied after a Codex app manager has
  used `create_thread` and `set_thread_title`; terminal-only users can omit it
  and still use the manual no-tmux handoff.
- `app-heartbeat TASK --role manager|worker [--dispatcher-id ID]
  [--stale-after N] [--json]` — Record a Codex app/no-tmux manager or worker
  heartbeat for the active binding and return that role's next poll commands.
  Use this as the recurring heartbeat command for pull-required app sessions.
- `app-loop-status TASK [--dispatcher-id ID] [--stale-after N] [--json]` —
  Summarize manager lease, worker lease, Dispatch heartbeat, and next required
  actions for an app-native Conveyor loop.
- `app-wakeup-plan TASK [--dispatcher-id ID] [--stale-after N] [--json]` —
  Emit exact manager and worker thread wake prompts, including app thread ids
  and titles when present, for an operator or Codex app automation to send.
- `app-wakeup-dispatch TASK [--dispatcher-id ID] [--stale-after N] [--json]` —
  Prepare adapter-ready Codex app wake actions and record a telemetry receipt
  for prepared, skipped, and blocked role wakeups. This command does not send
  `send_message_to_thread`; the Codex app/operator layer sends prompts whose
  actions report `send_ready=true`.
- `app-wakeup-record-delivery TASK --role manager|worker --dispatch-receipt ID
  --delivery-status sent|skipped|blocked [--thread-id ID] [--reason TEXT]
  [--json]` — Record what the Codex app/operator layer did with a wake action.
  `sent` is accepted only when the referenced `app-wakeup-dispatch` receipt has
  a matching `ready_to_send` action with `send_ready=true` and the same thread
  id; healthy roles must be recorded as `skipped`; missing-thread blockers and
  failed app-thread sends must be recorded as `blocked` with a reason.
- `app-autopilot start|stop|status|record-automation TASK [--dispatcher-id ID]
  [--interval SECONDS] [--watch-iterations N] [--stale-after N]
  [--quiet-after N] [--role manager|worker --automation-id ID] [--json]` —
  Manage the pair-level app-native heartbeat policy for the active
  manager/worker binding. `start` and `stop` write telemetry receipts and emit
  the exact manager/worker Codex app heartbeat automation specs plus the
  bounded Dispatch watch command. A plain shell CLI cannot call Codex app
  thread tools, so create/pause those heartbeat automations from a Codex app
  operator session using the emitted specs, then run `record-automation` once
  per created role automation. Conveyor remains the durable source of truth
  through Dispatch, inboxes, automation-applied receipts, wake receipts, and app
  heartbeat status. `status` reports `plan.readiness`; do not call a loop
  autonomous unless `plan.readiness.autonomous_ready=true`.
  `status` also reports `plan.quiescence`: when the loop is healthy, has no
  `next_actions`, and both roles have produced `--quiet-after` paired
  heartbeats since the last command or inbox-consumption receipt, it recommends
  `stop_autopilot` so operators can quiesce blocked/no-progress loops instead
  of repeating idle pulses.
- `app-smoke preflight|start|record|status TASK [--mode required|advisory|skip]
  [--scope pair|worker-set] [--smoke-id ID] [--nonce NONCE]
  [--role manager|worker] [--status sent|skipped|received|accepted|blocked]
  [--thread-id ID] [--notification-id N] [--worker-count N] [--from-stdin]
  [--json]` —
  Record and evaluate the durable side of Codex app connection smoke. Required
  mode blocks real work until the active binding has bound app thread ids,
  nonce-matching send receipts, fresh app heartbeats after smoke start, worker
  `received`, and manager/worker `accepted` receipts. Advisory mode reports the
  same blockers without blocking, and skip mode records an explicit bypass. The
  CLI does not call Codex app thread tools; use the
  `conveyor-smoke-app-connections` plugin skill from a Codex app operator
  session for live `send_message_to_thread` delivery. A smoke-passed operator
  flow should immediately run `app-autopilot start` and handle the emitted
  automation specs before sending real task prompts.
- `app-worker-rotation-plan TASK --old-worker-thread-id ID [--require-handoff]
  [--reason TEXT] [--json]` — Prepare a Codex app fresh-worker rotation. The
  CLI verifies that `ID` exactly matches the active bound worker session before
  emitting adapter-ready actions to create a replacement worker thread and
  archive the old worker thread. Blocked plans contain no archive action.
- `app-worker-rotation-record TASK --old-worker-thread-id OLD
  --new-worker-thread-id NEW [--new-worker-thread-title TITLE]
  --archive-status archived|blocked [--reason TEXT] [--json]` — Record the
  result after the Codex app layer creates the replacement worker thread and
  archives, or blocks on archiving, the old thread. The command re-checks active
  binding ownership before updating the worker session to the new app thread id,
  so a stale plan cannot archive or replace an unrelated thread.
- `discover [QUERY] [--all] [--limit N]` / `search [QUERY]` — Search tasks,
  registered sessions, active bindings, and recent telemetry in one JSON result.
  Use this for conversational setup when a manager or Codex session needs to
  present likely worker/manager/task connection options instead of asking the
  user for generated names:
  ```bash
  conveyor discover dashboard
  conveyor search "auth refactor"
  ```
  The output includes `tasks`, `sessions`, `bindings`, `telemetry`, and
  `suggestions`; suggestions may include a ready-to-run `conveyor bind`
  command or next-step prompts to register the missing worker or manager.
- `handoff <task> --summary S [--next-step N ...] [--payload-json JSON]` —
  Persist a compact worker handoff for the task. Use this when a worker is
  becoming managed or before a long context transition so the manager can read
  progress and likely next steps from SQLite.
- `manager-config <task> [--mode light|guided|strict] [--objective O]
  [--guideline G ...] [--acceptance A ...] [--reference R ...]
  [--permit CATEGORY.ACTION ...] [--tool TOOL ...]
  [--epilogue STEP ...] [--nudge-on-completion MODE] [--require-acks]
  [--allow-pr] [--allow-merge-green] [--allow-worker-compact-clear]` —
  Persist the manager's supervision contract: what to check against, how
  structured the loop should be, acceptance criteria, source references, and
  categorized permissions. With no recorded config it creates the default
  guided config; with no mutating flags after that it prints the current config.
  Use `--questions` from a manager Codex session to get a stable JSON question
  schema to ask the user in chat, then save the answers with noninteractive
  flags. Use `--interactive` only as a terminal fallback when a human is
  running `conveyor` directly.
  `--permit` grants taxonomy permissions such as `repo.open_pr`,
  `repo.push_branch`, `repo.monitor_ci`, `repo.resolve_conflicts`,
  `repo.merge_green_pr`, `verification.run_pytest`, `context.spawn_reviewer`,
  `communication.notify_operator`, or `worker_session.compact`. Use `--tool`
  to record expected verification/context tools, `--epilogue` for required
  built-in finish steps (`run-tools`, `draft-pr`, `subagent-review`,
  `record-handoff`), `--nudge-on-completion` for continuation review behavior
  (`off`, `ask-operator`, `auto-review`, `auto-proceed`), and `--require-acks`
  when `cycle`/`finish-task` should fail closed until both sides acknowledge.
  Legacy flat flags and `--permissions-json` keys (`create_pr`,
  `merge_green_pr`, `worker_compact_clear`, plus older `allow_*` aliases) are
  still accepted and normalized into the categorized taxonomy.
- `criteria <task>` — Track emergent acceptance criteria discovered during
  supervision. Managers should add useful proposed criteria, accept must-have
  items, defer follow-ups, and mark criteria satisfied only when worker
  receipts and verification cover them.
  ```bash
  conveyor criteria my-task --list
  conveyor criteria my-task --list --status accepted
  conveyor criteria my-task --add --criterion "..." --source worker_proposed --status proposed
  conveyor criteria my-task --add --criterion "..." --source manager_inferred --status accepted
  conveyor criteria my-task --accept 12 --rationale "Must-have for this task"
  conveyor criteria my-task --satisfy <id> --evidence-json '{"command":"...","status":"pass"}'
  conveyor criteria my-task --defer 13 --rationale "Follow-up after this task"
  conveyor criteria my-task --reject 14 --rationale "Duplicate or out of scope"
  ```
  Replace placeholder `...` values with the actual criterion and verification
  command. Use `worker_proposed` for criteria proposed by the worker. Use
  `manager_inferred` for criteria inferred from manager config, cycle evidence,
  or manager inspection; `manager_config` is not a valid criteria source.
  To add a criterion and satisfy that same row after verification:
  ```bash
  criterion_id=$(conveyor criteria my-task --add --criterion "Targeted prompt tests pass" --source worker_proposed --status proposed | node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).affected_criterion.id)')
  conveyor criteria my-task --satisfy "$criterion_id" --evidence-json '{"command":"npm test -- --runInBand","status":"pass"}'
  ```
  For mutation responses, treat `affected_criterion` as the authoritative
  receipt for the row changed by that command. When a manager applies multiple
  criteria changes, run `criteria <task> --list` before final audit or other
  decisions; the list command is the canonical task-level criteria state.
- `criteria-plan <task> --from-text ...|--from-worker-response PATH|--from-stdin
  [--json]` — Draft reviewed `criteria --add` commands from a worker response
  that separates must-have current-task criteria from deferred follow-ups. This
  helper is read-only: it resolves the task and prints suggestions, but does not
  mutate acceptance criteria, events, or commands. If a proposed criterion
  appears to describe manager closeout mechanics such as `finish-task`,
  `--require-criteria-audit`, heartbeat teardown, or final manager reporting,
  the helper emits a non-blocking warning and classifies that suggestion as
  manager closeout proof. Keep that proof in the manager final report, audit,
  replay, or epilogue evidence instead of accepted worker/task criteria unless
  the task is explicitly Conveyor closeout QA.
  ```bash
  conveyor criteria-plan my-task --from-worker-response response.md --json
  ```
- `manager-permission <task> <CATEGORY.ACTION|CATEGORY> [--list]
  [--require] [--require-handoff]` — Check and audit whether the saved manager
  config allows a categorized action, or list granted actions in a category.
  Use `--require` when a manager command should fail closed. Use
  `--require-handoff` before worker compact/clear style instructions so visible
  context is persisted first.
- `manager-recipes --list|--show RECIPE [--json]` — List or show built-in
  manager setup recipes. Recipe JSON includes the supervision mode,
  permissions, expected tools, epilogues, evidence gates, cleanup behavior,
  disallowed actions, locked setup summary template, and suggested
  `manager-config` command. Use this before cutting a manager loose.
  `campaign-duplicate-guard-dogfood` is the recipe for visible creative
  campaign dogfoods that prove accidental duplicate assignment receipts are
  rejected unless a worker explicitly uses `--allow-additional-receipt`.
- `worker-ack <task> --from-stdin|--json [--correlation-id ID]` /
  `manager-ack <task> --from-stdin|--json [--correlation-id ID]` — Persist or
  read the latest structured acknowledgement from the worker or manager. Acks
  are revisioned and exposed to `cycle`, `replay`, and `audit` so startup
  contract drift can be distinguished from later drift.
- `continuation <task> --submit worker|manager --from-stdin
  [--correlation-id ID]` — Record independent worker/manager "what's next"
  proposals for a completion turn. The worker proposal must be written first,
  and manager-side reads are redacted until the manager submits its own
  proposal.
- `continuation <task> --review --from-stdin [--correlation-id ID]` — Record a
  structured reviewer verdict over the paired continuation proposals. This
  requires `context.spawn_reviewer` permission and reviewer separation metadata
  (`subagent_run.reviewer_session_id` distinct from the manager and
  `manager_rollout_access=false`). Divergent reviews are routed for operator
  attention unless `--nudge-on-completion auto-proceed` is configured.
- `continuation-reviewer <task> --correlation-id ID --reviewer-session-id ID
  --manager-session-id ID --reviewer-command ...` — Run a reviewer command with
  the allowed read-only context on stdin, capture reviewer metadata, and persist
  the structured review. The context includes paired proposals, acceptance
  criteria, manager config summary, diff metadata, and recent PR metadata; it
  does not include manager rollout context. Reviewer commands run from an
  isolated temporary cwd with a stripped environment and, on macOS, through
  `sandbox-exec`. The sandbox keeps the targeted denial of bound
  worker/manager rollout files plus the active control database and sidecars,
  and also denies direct reads of the active `.codex-workers` state root so
  legacy session files, transcripts, capture metadata, task state, and exports
  are not available through filesystem reads. The allowed reviewer context still
  arrives on stdin, and replay/audit/export commands outside this reviewer
  subprocess are unchanged. Sandbox setup failures, reviewer command failures,
  timeouts, or invalid JSON are recorded as `verdict=stop`, not silent approvals.
  Use `--dry-run` to inspect the exact context without running the command.
- `continuation <task> --list [--as-role all|worker|manager|reviewer]
  [--include-payload]` — List continuation proposals and reviews with
  role-aware payload redaction.
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
  before/after sending the worker instruction. `--dry-run` still records the
  command in `commands`, `replay`, and `mutation-audit` with `dry_run: true`
  and `sent: false`.
  In Codex app threads, remote `/compact` or `/clear` sent through
  `send_message_to_thread` is prompt text, not an executable slash command. Use
  `app-worker-rotation-plan` plus Codex app `create_thread` and
  `set_thread_archived` when fresh context is required for app-native workers.
- `bind --task T --worker W --manager M` — Create the task binding.
- `unbind --task T` — End the active binding for a task.
- `finish-task <task> [--reason R] [--require-criteria-audit]
  [--require-acks] [--require-epilogue] [--require-adversarial-proof]
  [--stop-manager] [--stop-worker]
  [--capture-transcript-before-stop]` — Mark a task done.
  Leaves the manager terminal open by default for review. With
  `--require-criteria-audit`, fails before finishing if any acceptance criteria
  for the task are still `accepted`; `proposed`, `satisfied`, `deferred`, and
  `rejected` criteria do not block. With `--require-acks`, fails if worker or
  manager acknowledgement is missing. With `--require-epilogue`, fails if any
  configured epilogue step is not succeeded. With `--require-adversarial-proof`,
  fails before finishing unless the task has at least one satisfied criterion
  with `evidence_type=adversarial_check` and non-empty `failure_mode`, `check`,
  and `result` fields; use this when `tests passed` is not enough by itself.
  With `--capture-transcript-before-stop`, captures transcript segments for any
  worker/manager sessions being stopped before killing tmux sessions; capture
  failure fails before stop side effects.
- `stop-task <task> [--reason R] [--stop-worker]` — Force-stop a task's
  manager (and optionally the worker), recording the reason in the audit
  payload.
- `stop <session>` — Stop a tmux-backed worker or manager session by name. This
  works for both legacy worker records and session-table workers/managers. For a
  completed task with an active binding, prefer an idempotent cleanup pass with
  `finish-task <task> --stop-manager --stop-worker` so the task audit records
  the cleanup against the binding.

### Observation

- `dashboard [--task T] [--campaign C] [--ensure-dispatch] [--dispatcher-id ID]
  [--host 127.0.0.1] [--port 8797]` — Launch the
  local live supervision cockpit. The dashboard binds to loopback by default,
  uses the TypeScript backend to shell out to `conveyor` JSON commands, and
  attaches interactive terminals to tmux-backed worker/manager sessions through
  a WebSocket PTY bridge. It includes browser bootstrap controls for creating a
  task, starting a worker/manager pair with `conveyor pair`, auto-attaching the
  terminals, attach/bind controls, and audited action receipts for cycle,
  nudge, interrupt, finish, and export. With `--campaign`, the observation rail
  also shows campaign slot lifecycle, blockers, approval counts, and the next
  manager action. With `--ensure-dispatch`, launch also ensures a Dispatch watch
  process using the supplied `--dispatcher-id` when provided, reusing only a
  fresh heartbeat from that same dispatcher id. Use `--dry-run --json` to
  inspect the launch command.
- `cycle <task> [--busy-wait-seconds N]` — One observation cycle. Idempotent. Runs `ingest`, computes
  worker state from the JSON event stream, captures the tmux pane as a shadow
  signal, writes a `manager_cycles` row, and returns a JSON dict the manager
  Codex consumes. The `status_payload` includes:
  - `worker_alive` / `manager_alive` — booleans computed by probing the registered session pids (`os.kill(pid, 0)`). `False` when the session's pid is `NULL` (legacy backfill) or the process has exited — useful for detecting silently-dead workers between cycles.
  - `last_event_subtype` — the subtype of the most recent `codex_events` row for the worker, or `null` if no events exist.
  - `task_completed` — `true` iff `last_event_subtype` is `"task_complete"`. Disambiguates "worker finished cleanly" from "worker idle but never started."
  - `manager_context` — the latest `manager-config`, worker/manager
    acknowledgements, `handoff`, and `acceptance_criteria` records for the
    task, so each manager loop can reference the saved objective, living
    acceptance criteria, categorized permissions, expected tools, acked
    contract, worker progress, and next steps.
    `manager_context.acceptance_criteria`
    groups criteria by status, includes summary counts, and exposes `open` as
    accepted criteria that still need proof before finishing.
    `manager_context.criteria_negotiation` is advisory: when `needed` is true,
    the manager should ask the worker for must-have current-task criteria versus
    follow-up criteria, then record the result with `conveyor criteria`. The
    field does not send nudges or mutate criteria automatically.
  
  The `cycle` subcommand accepts `--busy-wait-seconds N` (default: 90) to tune the pane-signal classifier's stuck-busy threshold. Lower values flag stalls faster but increase false positives on long-running real work:
  ```bash
  conveyor cycle my-task                          # default 90s threshold
  conveyor cycle my-task --busy-wait-seconds 30   # tighter detection
  ```
- `ingest <session>` — Pull new events from a session's rollout JSONL into
  the `codex_events` table. Tracks a byte offset, so subsequent runs only
  pick up new events.
- `tail <session> [--limit N] [--subtype T] [--include-content]` — Print the
  most recent events for a session, newest first. Text payload fields are
  redacted by default; use `--include-content` only when stdout is redirected
  or verbatim text is intentionally needed.
- `divergences <task> [--limit N]` — Cycles whose shadow pane signal flagged
  a notable pattern (trust prompt, rate-limit prompt, approval prompt, etc.).
  Useful for auditing the shadow signal against the JSON state.
- `dispatch [--once|--watch] [--limit N] [--interval SECONDS]
  [--dispatcher-id ID] [--type notify_manager|nudge_worker|worker_task_complete]
  [--watch-iterations N] [--lease-seconds N] [--dry-run] [--json]` — Run
  Dispatch, the mechanical routing/actuation role.
  `worker_task_complete` routing reads from `codex_events`, records
  deduplicated `routed_notifications` keyed by the source event, and notifies
  the bound manager without deciding task success. Explicit `notify_manager`
  and `nudge_worker` command rows are atomically claimed, executed, and recorded
  through `command_attempts` with conservative side-effect metadata. `--watch`
  repeats polling with heartbeat telemetry; `--watch-iterations` bounds a watch
  run for scripts and verification; `--lease-seconds` tunes command claim
  recovery; `--once` performs one pass.
- `enqueue-notify-manager <task> --message "..." [--correlation-id C]
  [--required-permission P] [--idempotency-key K] [--json]` — Queue a `notify_manager` command row for
  Dispatch to claim and deliver to the bound manager. Codex app/no-tmux
  workers must use this route for completion and blocker reports after
  consuming a manager instruction; direct app-thread final answers are local
  text, not manager inbox receipts.
- `enqueue-nudge-worker <task> --message "..." [--correlation-id C]
  [--required-permission P] [--idempotency-key K] [--json]` — Queue a `nudge_worker` command row for
  Dispatch to claim and deliver to the bound worker. Use this dispatcher-backed
  route instead of `session-nudge` when the worker is registered without tmux;
  the worker then receives the message through `worker-inbox`.
- `session-inbox <session> [--consume-next] [--wait] [--timeout N]
  [--interval N] [--limit N] [--json]` — List or consume unconsumed routed
  notifications addressed to a registered session. Text output includes the
  pending count, signal type, delivery mode, source/target sessions, delivered
  timestamp, and correlation id. Use `--consume-next --wait --json` for Codex
  app long-polling; consumed items emit `dispatch_inbox_consumed` telemetry.
- `manager-inbox <task> [--consume-next] [--wait] [--timeout N] [--interval N]
  [--limit N] [--json]` — Resolve the task's bound manager session and read its
  dispatcher inbox.
- `worker-inbox <task> [--consume-next] [--wait] [--timeout N] [--interval N]
  [--limit N] [--json]` — Resolve the task's bound worker session and read its
  dispatcher inbox.
- `inbox-ack <task> --notification-id N [--json]` — Read durable
  role-authored acknowledgement history for one routed notification.
- `inbox-ack <task> --notification-id N --role manager|worker
  --status received|accepted|blocked --from-stdin [--correlation-id C]
  [--json]` — Record that the addressed role saw a delivered notification and
  either received, accepted, or blocked on it. `received` requires delivery;
  `accepted` and `blocked` require consumption. Use this after visible Codex app
  sessions print `CONVEYOR RECEIVED`; do not use direct app-thread text as the
  durable receipt. `--from-stdin` expects a JSON object, for example
  `printf '%s\n' '{"summary":"accepted","evidence":["consumed notification"],"blockers":[]}' | conveyor inbox-ack ... --from-stdin`.

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
  `audit --json` redacts stored terminal/transcript content unless
  `--include-content` is passed.
- `replay <task> [--format compact|timeline|transcript|full-transcript]
  [--role all|worker|manager] [--limit N] [--include-content]` — Render a
  chronological, human-readable reconstruction of the task. Cycle entries
  include `[pane pattern: <pattern_id>]` when the shadow signal flagged
  something. `full-transcript` is blocked unless `--include-content` is passed.
- `mutation-audit <task>` — Manager decisions and their consequences.
- `events <name>` — Worker events log.
- `commands [--task T] [--type T] [--state S] [--attempts]` — Durable
  side-effect commands log. Use `--attempts` to include per-dispatcher attempt
  history.
- `epilogue <task> --step run-tools|draft-pr|subagent-review|record-handoff
  [--json] [--correlation-id ID]` — Run one configured epilogue step and record
  its durable state. Use `--list` or `--status` to inspect configured steps and
  latest run results.
- `telemetry [--run RUN] [--task TASK] [--search QUERY] [--summary] [--json]`
  — Query local structured telemetry events, search them with SQLite FTS, or
  print aggregate counts for a run/task. `telemetry snapshot --task <task>
  --json` prints the task-scoped dashboard overview contract.
- `telemetry task <task> --json` — Print a task-scoped telemetry triage view:
  recent cycle history, last successful cycle, worker/manager liveness,
  decisions, commands, failed cycles/commands, ingest skipped/error summaries,
  pane capture failures and notable patterns, open criteria counts, telemetry
  counts, and retained storage counts. Raw transcript, pane, prompt, criterion,
  command payload, and command result bodies are not included.
- `telemetry failures --json` — Print an operator failure triage view across
  tasks: recent failed cycles, failed commands, ingest errors/skipped lines,
  pane capture failures, open accepted criteria, active task/session health, and
  retained storage counts without raw transcript or prompt content. Use `--task`,
  `--run`, `--active-only`, or `--window 2h` to narrow the failure view for
  recency or active-task triage.
- `telemetry metrics --window 24h --json` — Print bounded JSON rollups for
  local telemetry and related tables: active tasks/sessions, cycle and command
  success/failure counts, ingest/skipped-line totals, criteria counts,
  reconcile drift counts, export counts, and retained capture/transcript bytes.
- `export-task <task> [--zip] [--include-transcripts]
  [--include-full-transcripts]` — Dump task status, audit, prompts, transcript
  metadata, and optional transcript segments/full transcript replay into an
  export bundle. Exports include
  `telemetry-events.json`, `telemetry-summary.json`, and
  `telemetry-report.md`; see `docs/local-telemetry-workflow.md`.

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
  transcript segments. JSON output redacts raw captured terminal output by
  default.
- `transcript-show <task> [--role R] [--include-content]` — Show stored
  transcript segment metadata. Segment text is redacted unless
  `--include-content` is passed.
- `qa-plan <self-management|emergent-criteria|tmux-errors|dispatch-completion|ralph-loop|adversarial-triggers|goalbuddy-conveyor|setup-bundle-dogfood|ship-it-loop>` — Print a
  repeatable manual QA checklist.
- `qa-run <ralph-loop-guardrails|generic-loop-template|generic-loop-template-browser|test-coverage-loop|adversarial-triggers|build-clear-loop|setup-bundle-dogfood|setup-bundle-live-sandbox|ship-it-loop> --receipt-output RECEIPT.json [--path DB]` —
  Run a deterministic no-tmux QA harness and save a JSON receipt.
  `ralph-loop-guardrails` proves max-iteration cutoff, missing-evidence
  cutoff, fresh retry delivery after structured `adversarial_check` evidence,
  and the `pr_ci_merge_loop` preset evidence gate. `generic-loop-template`
  proves the `visual_diff_loop` template blocks before visual evidence,
  rejects unstructured adversarial evidence, and delivers only after required
  visual receipts plus structured adversarial proof exist.
  `generic-loop-template-browser` runs the same `visual_diff_loop` gate proof
  with a browser-rendered static HTML candidate screenshot, recording browser
  backend, viewport, candidate HTML, screenshot, visual diff, and structured
  adversarial evidence in the saved receipt. It uses the repo's Node
  Playwright dependency and requires Chromium to be installed and launchable;
  when unavailable, it fails with the browser-backed QA helper message.
  `test-coverage-loop` proves the `test_coverage_loop` template blocks before
  coverage evidence, rejects malformed adversarial evidence, and delivers only
  after a structured coverage receipt plus adversarial proof exist.
  `build-clear-loop` proves the non-coverage `build_then_clear` template
  blocks before `build_passed` and `cleanup` receipts, still blocks after build
  evidence alone, and delivers only after both build and cleanup evidence exist.
  `ship-it-loop` proves push, PR, and merge commands fail closed until their
  permissions are granted, then proves the `ship_it_loop` lifecycle blocks
  before branch, PR, CI, mergeability, manager decision, merge, post-merge, and
  adversarial receipts exist.
  `setup-bundle-dogfood` proves setup-bundle preview/apply/show rails with temp
  ledgers, temp Codex homes, and a disposable local fixture repo. It is CI-safe:
  no GitHub side effects and no manager/worker session launch. For the live
  sandbox drill, see `docs/qa/setup-bundle-dogfood.md`.
  `setup-bundle-live-sandbox` is an executable preflight for the live sandbox
  drill. It requires `--allow-github-side-effects`, the allowlisted sandbox
  repo, `dogfood/` branch prefix, max PRs, max iterations, and max runtime, then
  writes a receipt without running `gh`, pushing, opening a PR, merging, or
  launching sessions.
- `loop-triggers --list|--classify PROMPT [--json]` — List the controlled
  natural-language loop triggers or classify a manager/operator prompt before
  creating a loop policy or continuation gate. Approved trigger phrases include
  the adversarial Ralph-loop, iteration, finish, worker-directed proof, and
  manager-created adversarial criteria gates; generic caution like "be careful
  and run tests" intentionally does not arm those gates.
- `loop-templates --list|--show TEMPLATE|--create-run TASK --template TEMPLATE` —
  List generic loop templates or create a template-backed loop policy run.
  Template-backed runs use the same Dispatch guardrails as Ralph-loop presets:
  `max_iterations` prevents over-looping, and `required_before_continue`
  evidence blocks a manager continuation before worker delivery until matching
  satisfied criterion evidence exists. `ralph-loop-presets` remains as a
  compatibility alias for the current Ralph-loop QA flows. The built-in
  `app_visible_build_loop` template requires `build_passed` plus structured
  `adversarial_check` evidence, but no cleanup evidence, so visible Codex app
  threads can continue without pretending that same-thread context was cleared.
  The built-in
  `visual_diff_loop` template requires `reference_artifact`,
  `candidate_screenshot`, `visual_diff_report`, `diff_below_threshold`, and
  `adversarial_check` evidence before a manager-requested next visual pass can
  reach the worker. Quality-oriented templates (`app_visible_build_loop`,
  `pr_ci_merge_loop`, `ship_it_loop`, `test_coverage_loop`, and
  `visual_diff_loop`) also expose an
  `artifact_requirements["adversarial_check"]` object requiring
  `failure_mode`, `check`, and `result` fields.
- `loop-status TASK --run RUN [--json]` — Summarize a Ralph-loop run for manager
  review: policy template, iteration bounds, command states, routed
  notifications, worker inbox backlog, evidence types, consumed-inbox
  and iteration-advanced telemetry, failure counts, and a recommendation.

For real vertical slices, start with the Ralph loop operator guide in
`docs/qa/ralph-loop-operator-guide.md`. It explains the controlled
natural-language triggers, Dispatch authority model, worker inbox polling,
required evidence, adversarial proof, `loop-status`, and telemetry review pass
bar.
Use `create-disposable-binding` when the manager and worker are Codex app or
other no-tmux sessions and you want the same Dispatch rails without manual
task/session/bind setup. In a Codex app manager session, prefer a fresh
same-project `create_thread` worker plus `set_thread_title` before creating the
binding, then pass the worker thread id/title into Conveyor. Use `fork_thread`
only when the user explicitly asks to fork or resume this conversation. If app
thread tools are unavailable, create the binding anyway and paste the returned
`worker_handoff` prompt into a manually opened worker session. The handoff
requires a worker to report completion/blockers through
`enqueue-notify-manager` plus a bounded Dispatch watch run before treating the
manager as notified, and to print the live `CONVEYOR POLL` / `CONVEYOR
RECEIVED` / `WORK` / `CONVEYOR SEND` / `DISPATCH` transcript in the worker
session for any consumed item.
- `enqueue-continue-iteration TASK --loop-run RUN --requested-iteration N` —
  Queue a manager-requested next loop pass for Dispatch. The command refuses
  same/current iteration requests before they become pending queue rows, while
  Dispatch also blocks any stale same/current iteration command that reaches
  the queue. Max-iteration and missing-evidence refusals remain Dispatch policy receipts.
  JSON output includes `loop_policy`; delivered manager/worker inbox payloads
  include the same `loop_policy` plus enriched `ralph_loop` metadata so tmux and
  Codex app sessions can see the template, cleanup policy, required evidence,
  artifact requirements, and recommended tools.
- `loop-evidence add TASK --loop-run RUN --iteration N --evidence-type TYPE` —
  Record a run-qualified evidence receipt for a loop policy. Use
  `loop-evidence build-passed TASK --loop-run RUN --iteration N` as the
  friendly alias for the common `evidence_type=build_passed` receipt. Use
  `loop-evidence visual-diff` to compare PNG screenshots, write an optional
  diff/report artifact, and record `visual_diff_report` plus
  `diff_below_threshold` as satisfied only when the computed score is within
  threshold.
- `loop-evidence adversarial-check TASK --loop-run RUN --iteration N --failure-mode F --check C --result R` —
  Record first-class adversarial proof for a loop iteration. Use it when a
  manager or worker tried to disprove the iteration before continuing. The
  receipt is stored as `evidence_type=adversarial_check` with structured
  `failure_mode`, `check`, and `result` metadata and can satisfy Ralph-loop
  continuation policy. See `docs/qa/adversarial-proof.md` for the receipt
  shape and how it maps to manager prompts, Ralph-loop evidence, Dispatch
  blocking, and audited finish.
- `qa-plan goalbuddy-conveyor` — Print the reusable natural-language starter
  prompt and QA contract for autonomous GoalBuddy conveyor runs. Use it when a
  manager should split broad work into one parent board plus sequential
  vertical-slice child boards with PR/CI/merge receipts, satisfied-on-main
  proof, and adversarial review gates. See `docs/qa/goalbuddy-conveyor.md`.
- `ralph-loop-presets --list|--show PRESET|--create-run TASK --preset PRESET` —
  List saved Ralph-loop guardrail templates or create a preset-backed
  `ralph_loop` policy run.
- `import-compat` — Dry-run or import existing `.codex-workers/<worker>/`
  artifacts into SQLite.

### Worker setup

- `create <name> --cwd D --task "..."` — Full worker creation: spawn a tmux
  session, start Codex, send the initial worker contract.
- `start <name> --cwd D` — Start a plain Codex session inside tmux without
  registering a worker. Useful when you want to register it manually later.
- `start-test <name>` — Low-risk verification worker that only updates its
  ignored `status.json`.

### QA Plans

Print repeatable live QA checklists from the CLI:

```bash
conveyor qa-plan self-management
conveyor qa-plan emergent-criteria
conveyor qa-plan emergent-criteria --json
conveyor qa-plan tmux-errors
conveyor qa-plan dispatch-completion
conveyor qa-plan ralph-loop
conveyor qa-plan adversarial-triggers
conveyor qa-plan goalbuddy-conveyor
conveyor qa-plan setup-bundle-dogfood
conveyor qa-plan ship-it-loop
conveyor qa-run ralph-loop-guardrails --receipt-output /tmp/ralph-loop-guardrails-receipt.json --json
conveyor qa-run generic-loop-template --receipt-output /tmp/generic-loop-template-receipt.json --json
conveyor qa-run generic-loop-template-browser --receipt-output /tmp/generic-loop-template-browser-receipt.json --json
conveyor qa-run test-coverage-loop --receipt-output /tmp/test-coverage-loop-receipt.json --json
conveyor qa-run adversarial-triggers --receipt-output /tmp/adversarial-triggers-receipt.json --json
conveyor qa-run build-clear-loop --receipt-output /tmp/build-clear-loop-receipt.json --json
conveyor qa-run setup-bundle-dogfood --receipt-output /tmp/setup-bundle-dogfood-receipt.json --json
conveyor qa-run setup-bundle-live-sandbox --allow-github-side-effects --github-repo neonwatty/agent-conveyor-dogfood-sandbox --branch-prefix dogfood/ --max-prs 1 --max-iterations 2 --max-runtime-minutes 30 --receipt-output /tmp/setup-bundle-live-sandbox-receipt.json --json
conveyor qa-run ship-it-loop --receipt-output /tmp/ship-it-loop-receipt.json --json
conveyor loop-triggers --classify "Run this as an adversarially gated Ralph loop." --json
conveyor loop-templates --list --json
conveyor loop-templates --show ship_it_loop --json
conveyor loop-templates --show visual_diff_loop --json
conveyor loop-evidence visual-diff qa-task --loop-run "$RUN_ID" --iteration 1 --reference reference.png --candidate candidate.png --threshold 0.02 --report-output visual-diff.json --diff-output visual-diff.png
conveyor ralph-loop-presets --list --json
```

General loop templates let operators create policy-backed runs without adding
bespoke Dispatch behavior for each loop shape. For example,
`conveyor loop-templates --create-run qa-task --template visual_diff_loop`
creates a visual-diff loop run whose `required_before_continue` evidence must
be recorded before the manager's next visual pass can reach the worker.
Existing `ralph-loop-presets` commands remain compatible aliases over the same
template-backed guardrails.

For natural-language control, run `conveyor loop-triggers --classify
"<manager prompt>" --json` before automatically creating policy or
continuation gates. Only a matched controlled trigger should create a
Ralph-loop policy, require `adversarial_check` before continuation, require
`finish-task --require-adversarial-proof`, or record worker-proposed
adversarial proof. The executable receipt check is
`conveyor qa-run adversarial-triggers --receipt-output
/tmp/adversarial-triggers-receipt.json --json`.

The `emergent-criteria` scenario covers a real worker/manager pair, criteria
negotiation, audited finish gating, replay/export evidence, and
`--stop-manager --stop-worker` cleanup verification. It also includes an
optional `criteria-plan` step for drafting reviewed criteria commands from the
worker's separated must-have and follow-up response.

The `tmux-errors` scenario covers read-only JSON degradation, mutating command
failures, pane capture degradation, stop failures, and reconcile recovery when
tmux is unavailable or a disposable tmux target disappears.

The `dispatch-completion` scenario covers the issue #113 completion-routing
flow: a worker `task_complete` signal is read from `codex_events`, Dispatch
records and deduplicates a routed notification, the bound manager receives a
mechanical wake-up, duplicate-route races emit suppressed telemetry without an
extra send, and audit/replay/dashboard surfaces show readable, chronological
dispatch evidence.

The `ralph-loop` scenario covers the issue #152 managed delivery loop: the
manager runs the same seed prompt through at least two iterations, requires
criteria and epilogue evidence, gates PR creation, CI monitoring/fixing, green
merge, handoff, and worker clear on explicit permissions, and proves the second
iteration starts after audited clear in fresh-worker isolation. Replay iterations
start with an inspect-first guard: if the previous iteration's work is already
merged, the worker records that state and stops without making replacement edits
or opening another PR unless something is actually missing. The same QA plan
also covers preset-backed guardrails such as `pr_ci_merge_loop`, where Dispatch
blocks another worker iteration until required `pr_url`, `ci_green`, `merge`,
and `adversarial_check` evidence exists.

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
- `capture <name> [--include-content]` — Capture recent terminal output.
  Default output is metadata only; pass `--include-content` only when verbatim
  pane text is intentionally needed.
- `nudge <name> "<text>"` — Legacy worker-directory nudge. For managed
  session pairs, prefer `session-nudge <name> "<text>"`; `nudge` falls back to
  session-name delivery when no legacy worker directory exists.
- `interrupt <name>` — Send an explicit interrupt key.
- `stop <name>` — Stop a worker tmux session.
- `update-status <name>` — Update a worker status contract.
- `classify --text "..."` — Debug the busy-wait pattern classifier.

## Manager Loop Pattern

A manager Codex drives supervision by calling `conveyor cycle <task>`
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
   replayable via `conveyor replay <task>`.
5. Returns a structured JSON dict.

The manager parses the JSON, decides whether to act, and optionally calls
`conveyor session-nudge` / `session-interrupt`. Then it loops.

```bash
conveyor cycle auth-refactor
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
#     },
#     "criteria_negotiation": {
#       "needed": true,
#       "reason": "no_criteria",
#       "prompt": "Please propose 2-4 acceptance criteria for the current slice...",
#       "suggested_actions": [...]
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
plain-text `conveyor audit <task>` lists `events` rows only; cycle
observations show up via `conveyor replay <task>` and the `manager_cycles`
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

- **`sessions --state`** — by default, `conveyor sessions` now hides Phase 1 backfill rows (`pid IS NULL`) and rows marked `state='gone'`. Use `--state all` to inspect every row, `--state gone` for completed/dead registrations, or `--state active` for the default view.
- **`worker_alive` / `manager_alive` in cycle output** — every `conveyor cycle` JSON now includes these booleans, computed by `os.kill(pid, 0)` against the registered session pids. Surfaces silently-dead workers between cycles.
- **`cycle --busy-wait-seconds N`** — exposes the pane-signal classifier's stuck-busy threshold (previously hard-coded at 90s) as a per-cycle flag.

## Phase 8 classifier improvements (2026-05-12)

- **Recent event suppression for `long_running_interruptible`** — the classifier now weighs `recent_event_count` (from `ingest.new_events`) alongside `status_age_seconds`. When a worker is actively emitting events (>= 10/cycle), the `long_running_interruptible` flag is suppressed—the worker is healthy despite stale status.json. This stops false positives on long-running tools (e.g. test suites, large file reads) that stay busy but quiet on status updates.

## Dispatch and completion contracts

Dispatch is the mechanical core infrastructure between workers and managers. It
routes facts and executes queued side effects; it does not decide whether work
is correct, finish tasks, satisfy criteria, choose strategy, merge PRs, or route
to human operators.

Current dispatch state:

- `dispatch --once` routes bound worker `task_complete` signals from
  `codex_events`, not the pane classifier.
- Routed completion notifications are deduplicated by source event id, recorded
  in `routed_notifications`, and threaded with `correlation_id`.
- The session inbox is the same `routed_notifications` stream addressed by
  `target_session_id`: tmux push is optional transport. Codex app-based sessions
  should run `app-heartbeat` as their recurring heartbeat, using the direct
  `communication.poll_command` only as a fallback or when returned in heartbeat
  guidance. For disposable Ralph loops, use the generated `worker_handoff`
  prompt so the worker keeps polling until no inbox item remains or the loop
  reaches `max_iterations`. For no-tmux Codex app sessions, treat
  `communication.requires_polling=true` as requiring a heartbeat/wake layer:
  a delivered pull inbox item does not by itself wake an idle app thread. Do
  not delete or pause heartbeats because an inbox poll is idle. Use generated
  `heartbeat_recommendations.wakeup_dispatch_command` and
  `heartbeat_recommendations.delivery_receipt_commands` for stale-thread wake
  recovery receipts. A terminal manager decision should be followed by
  `finish-task --require-criteria-audit` or by an explicit blocker explaining
  why the task/binding still appears active.
- `register-worker`, `register-manager`, `sessions`, `discover`, and
  `create-disposable-binding --json` expose a `communication` block per
  session. Treat `session_kind='tmux'` plus `receive_style='push'` as direct
  tmux-delivery capable; treat `session_kind='codex_app'` plus
  `receive_style='pull'` as mailbox polling required for that worker or
  manager.
- App-assisted setup may also expose `codex_app_thread_id` and
  `codex_app_thread_title` for sessions created or identified by Codex app
  thread tools. Treat those fields as human/app navigation metadata; the
  durable communication record is still `routed_notifications` plus inbox
  consumption telemetry.
- Template-backed `continue_iteration` deliveries include `loop_policy` in the
  inbox payload, with template name, current/max iteration, cleanup policy,
  required evidence, artifact requirements, and recommended tools. Codex
  app-based workers receive the same policy context by polling that tmux workers
  receive by push.
- A target with a tmux session records `delivery_mode='push'` after successful
  tmux delivery. A target without tmux records `delivery_mode='pull_required'`
  and remains unconsumed until the addressed session polls and consumes it.
- Consuming a mailbox item records `dispatch_inbox_consumed` telemetry with the
  notification id, signal type, delivery mode, target session role, and poll
  count, so manager/worker dispatcher handoffs are visible in audit evidence.
  When the item is `continue_iteration`, Conveyor also advances the run
  metadata's durable `current_iteration` to the requested iteration and records
  `ralph_loop_iteration_advanced` telemetry keyed to the run, notification,
  command, and consuming session.
- If `doctor-self --json` reports `workerctl_on_path=false` inside a Codex app
  session, run `conveyor ...` from the repository root or install the
  local wrapper with `scripts/install-local --write`. Its `inside_tmux` check
  describes the shell running `doctor-self`; for Codex app evidence, prefer the
  rollout JSONL path, `lsof` lookup, and the registration role.
- When a live drill ingests a whole rollout, Dispatch may route older completion
  signals before the target proof turn. Either ingest after the target worker
  turn or have the manager consume/review older completion signals before
  deciding on the current one.
- Explicit `notify_manager` and `nudge_worker` command rows can be processed by
  Dispatch with atomic claim/lease metadata, durable `command_attempts`,
  invalid-payload failure before side effects, and conservative tmux
  side-effect started/completed flags.
- `dispatch --watch` continuously repeats the same mechanical polling loop with
  dispatcher identity and heartbeat telemetry; `--watch-iterations N` bounds the
  run and `--lease-seconds N` controls when attempted command claims become
  recoverable.
- Replay/audit surfaces include routed notifications, command attempts, and
  correlation chains where the data exists. Routed notification replay includes
  delivery mode, source/target sessions, delivered timestamp, consumed-by
  session, and consumed timestamp. The dashboard groups bound-task dispatch
  correlation chains with command state, attempt counts, notification counts,
  inbox pending/consumed counts, decision/cycle ids, source event ids,
  suppressed-signal visibility, chronological ordering, and side-effect risk.
- Dashboard manual QA should use
  `conveyor dashboard --task <task> --ensure-dispatch --dispatcher-id qa-dispatch-dashboard`
  and visually confirm the Dispatch active banner, dispatcher id, heartbeat age,
  iteration, processed count, dry-run/live state, completion/routing/cycle
  conversation lane entries, command claim/attempt/delivery entries, inbox
  pending/consumed counts, pull-required notification evidence where applicable,
  and stale or not-observed warnings.

The adjacent completion-contract surfaces are separate from Dispatch:

- Worker and manager acknowledgements persist the startup contract and can gate
  `cycle`/`finish-task`.
- Epilogues are named post-completion steps that can gate `finish-task`.
- Continuations persist worker-first and manager-independent "what's next"
  proposals plus a recorded reviewer verdict. The CLI enforces ordering,
  redaction, permission checks, reviewer separation metadata, and can run an
  independent restricted-context reviewer command through
  `continuation-reviewer`. Reviewer execution is additionally isolated with a
  temporary cwd, stripped environment, and macOS `sandbox-exec` denial of bound
  rollout/database reads plus direct reads under the active `.codex-workers`
  state root. That broader state-root denial applies only to the
  `continuation-reviewer` subprocess; normal replay, audit, export, and
  telemetry generation paths remain outside that sandbox.

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
- `commands` — Durable side-effect command log, including Dispatch claim/lease
  metadata for queued command execution.
- `command_attempts` — Per-dispatcher command execution attempts with
  side-effect started/completed flags and result/error payloads.
- `routed_notifications` — Mechanical worker/manager routed facts and command
  delivery records, deduped and linked by `correlation_id`.
- `task_acknowledgements` — Revisioned worker/manager startup contract
  acknowledgements.
- `epilogue_runs` — Durable state for configured post-completion epilogue
  steps.
- `task_continuations` / `continuation_reviews` — Worker/manager continuation
  proposals and reviewer verdicts for "what's next" review flows.
- `workers`, `managers` — Legacy tables retained for read-only history.

`conveyor db-doctor` reports schema health. On Node releases that still mark
`node:sqlite` experimental, the command may emit an `ExperimentalWarning` to
stderr even when the schema check succeeds. `conveyor reconcile` reports runtime
drift (dead-pid sessions, dangling bindings, stuck tasks); add `--apply` to
fix.

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

Release-candidate deterministic gate:

```bash
scripts/rc-check --skip-live-smoke-repeat
```

Full local release-candidate gate:

```bash
scripts/rc-check --with-live-smoke-repeat
```

Underlying deterministic checks:

```bash
scripts/check-resource-warnings -- npm test -- --runInBand
npm run build
npm run migration:audit:final
scripts/package-smoke
scripts/release-check
```

For local parallel experiments, prefer:

```bash
npm test
```

The standard CI job remains serial.

GitHub Actions runs `scripts/rc-check --skip-live-smoke-repeat` and
`scripts/package-smoke` on every push and pull request. The live smoke repeat
remains local/manual because hosted runners may not have `codex`.
The ResourceWarning gate intentionally fails on any `ResourceWarning` text in
test output so finalization-time resource warnings cannot be hidden by a zero
test exit status.

Live local smoke gate:

```bash
scripts/live-smoke
```

The live smoke requires macOS, `tmux`, `codex`, and `rg`. It starts disposable
Codex worker/manager sessions, exercises `pair`, `cycle`, `session-nudge`,
criteria mutation, transcript capture before stop, replay, mutation audit, and
export, then verifies cleanup with `sessions --state active` and `reconcile`.
It writes evidence under `docs/live-qa-artifacts/` and should leave no active
smoke sessions, tmux panes, dangling bindings, or stuck tasks.

For the focused manual coverage pass, use
[docs/manual-qa-checklist.md](docs/manual-qa-checklist.md).
