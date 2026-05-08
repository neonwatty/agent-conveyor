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

`scripts/install-local --write` updates future shells. The `export` line makes `workerctl` available in the current shell.

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
scripts/workerctl doctor
scripts/workerctl start-test live-test --cwd "$PWD" --accept-trust --open
tmux attach -t codex-live-test
scripts/workerctl create worker-a --cwd /path/to/repo --task "Inspect the failing test and report the blocker."
scripts/workerctl create worker-b --cwd "$PWD" --task "Read README.md and update status.json." --wait-ready --accept-trust --verify --open
scripts/workerctl list
scripts/workerctl list --json
scripts/workerctl status worker-a
scripts/workerctl idle-check worker-a
scripts/workerctl supervise worker-a
scripts/workerctl watch worker-a --interval 60
scripts/workerctl events worker-a --limit 20
scripts/workerctl interrupt worker-a
scripts/workerctl capture worker-a
scripts/workerctl nudge worker-a "Please summarize current progress and next action."
scripts/workerctl stop worker-a
```

## SQLite Worker-Manager Lifecycle

`workerctl` now uses `.codex-workers/workerctl.db` as the authoritative
control-plane store for tasks, workers, managers, bindings, status contracts,
prompts, transcript captures, command intents/results, and audit events. The
JSON files under `.codex-workers/<worker>/` remain compatibility artifacts.

Create a worker, then promote it into a managed task:

```bash
scripts/workerctl create worker-a \
  --cwd "$PWD" \
  --task "Work on the assigned task and report status with workerctl." \
  --no-initial-prompt

scripts/workerctl promote worker-a \
  --task auth-refactor \
  --goal "Finish the auth refactor" \
  --summary "Worker is ready for supervision" \
  --max-nudges 3 \
  -- --model gpt-5.4-mini
```

Inspect and operate the task through task-scoped commands:

```bash
scripts/workerctl task-status auth-refactor --json
scripts/workerctl task-capture auth-refactor --lines 120 --json
scripts/workerctl task-idle-check auth-refactor
scripts/workerctl task-nudge auth-refactor "Please update status and state your next action."
scripts/workerctl task-interrupt auth-refactor
scripts/workerctl audit auth-refactor --json
scripts/workerctl commands --task auth-refactor --json
scripts/workerctl commands --task auth-refactor --type task_nudge --state failed --json
scripts/workerctl task-events auth-refactor --json
```

Pause, resume, reconcile, recover, export, and close the task:

```bash
scripts/workerctl pause-manager auth-refactor
scripts/workerctl resume-manager auth-refactor -- --model gpt-5.4-mini
scripts/workerctl reconcile auth-refactor
scripts/workerctl recover auth-refactor
scripts/workerctl recover auth-refactor --sync-pane-ids
scripts/workerctl export-task auth-refactor --zip
scripts/workerctl stop-task auth-refactor --stop-worker
```

`task-nudge` reserves SQLite budget before sending. Mutating task commands write
durable command intent/result rows, and `audit` shows the resulting timeline.
Use `commands` to inspect durable side-effect command rows directly, including
filtered views by task, type, state, worker ID, or manager ID. Use `task-events`
for a task-scoped event stream when reconstructing what happened.
Before task-scoped text, interrupt, or kill side effects, workerctl verifies the
recorded worker/manager identity, tmux session, and pane ID for the active
binding.
When a live session is intentionally reused and `reconcile` reports a pane
mismatch, `recover --sync-pane-ids` records the repair and updates SQLite to the
current live pane IDs.

Transcript capture content can be pruned while retaining metadata:

```bash
scripts/workerctl prune --keep-latest 20 --dry-run
scripts/workerctl prune --keep-latest 20
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
scripts/workerctl start-test live-test --cwd "$PWD" --accept-trust --open
tmux attach -t codex-live-test
```

`--open` is macOS-only. It opens a terminal window attached to the existing tmux
session, preferring Ghostty when installed and falling back to Terminal.app. You
can also open an already-running worker:

```bash
scripts/workerctl open live-test
scripts/workerctl open live-test --terminal terminal
```

`workerctl` records every terminal launch attempt before opening the app. A
second open for the same worker is refused by default to prevent accidental
terminal-window floods, even if the first app launch did not visibly work:

```bash
scripts/workerctl open live-test --force
scripts/workerctl create worker-b --cwd "$PWD" --task "..." --wait-ready --verify --open --force-open
```

Use `--stop-after` only when you want a disposable smoke test that cleans up the
tmux session automatically.

For a lifecycle smoke test without sending the worker prompt into Codex:

```bash
scripts/workerctl create smoke --cwd "$PWD" --task "Smoke test only." --no-send-contract
scripts/workerctl status smoke
scripts/workerctl idle-check smoke
scripts/workerctl supervise smoke --dry-run
scripts/workerctl stop smoke
```

Worker runtime files are stored under `.codex-workers/` and are intentionally ignored by git.

To run `workerctl` from anywhere, add the local `bin` directory to your shell path:

```bash
export PATH="/Users/neonwatty/Desktop/codex-terminal-manager/bin:$PATH"
```

Or install that PATH line into `~/.zshrc`:

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
scripts/workerctl watch worker-a --interval 60 --max-cycles 3 --dry-run
```

`idle-check`, `supervise`, and `watch` also detect known interactive or busy-wait terminal states, such as Codex MCP startup, trust prompts, plan prompts, and rate-limit prompts. These are reported as `health: "busy_wait"` with an inspect-oriented recommendation.

Busy-wait interruption is explicit by default:

```bash
scripts/workerctl interrupt worker-a
scripts/workerctl supervise worker-a --interrupt-busy-wait --dry-run
```

For debugging classifier behavior directly:

```bash
scripts/workerctl classify --text "Starting MCP servers (2/3)"
```

## Tests

Run the dependency-free test suite with:

```bash
python3 -m unittest discover -s tests -v
```

GitHub Actions runs the same test suite and a `py_compile` check on every push and pull request.

To have `create` classify the initial Codex screen, use `--wait-ready`:

```bash
scripts/workerctl create worker-a \
  --cwd /path/to/repo \
  --task "Inspect the failing test and report the blocker." \
  --wait-ready
```

If the target directory is one you intentionally trust, `--accept-trust` lets the startup watcher accept Codex's workspace trust prompt:

```bash
scripts/workerctl create worker-a \
  --cwd /path/to/repo \
  --task "Inspect the failing test and report the blocker." \
  --wait-ready \
  --accept-trust
```
