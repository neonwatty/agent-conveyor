# TypeScript Migration CLI Contract

This contract records the archived Python CLI surface from before the
TypeScript migration. The TypeScript CLI must preserve this surface unless a
Judge receipt explicitly approves and documents a diff.

## Public Entry Points

- `conveyor` package-installed command from `package.json`.
- `workerctl` package-installed compatibility command from `package.json`.
- `bin/conveyor` local wrapper.
- `bin/workerctl` local wrapper.
- `scripts/workerctl` repository-local entry point.

Program name behavior must preserve both `conveyor` and `workerctl`.

## Command Inventory

Source of truth: `scripts/workerctl --help` and the archived command inventory
at `docs/archive/python-runtime/cli-command-inventory.json`.

The top-level command inventory to preserve is:

```text
create
start
start-test
dashboard
dispatch
enqueue-notify-manager
enqueue-nudge-worker
enqueue-continue-iteration
loop-templates
loop-status
loop-triggers
loop-evidence
ralph-loop-presets
doctor
doctor-self
qa-plan
qa-run
create-disposable-binding
install-skills
db-doctor
import-compat
tasks
criteria
criteria-plan
handoff
worker-ack
manager-ack
runs
telemetry
manager-config
manager-permission
epilogue
continuation
continuation-reviewer
record-decision
register-worker
start-worker
start-manager
pair
register-manager
deregister
sessions
discover
search
bind
unbind
ingest
tail
session-inbox
manager-inbox
worker-inbox
session-nudge
session-interrupt
request-worker-compact
compact-worker
cycle
divergences
commands
prune
stop-task
finish-task
reconcile
transcript-capture
transcript-show
transcript-prune
audit
mutation-audit
replay
export-task
list
capture
status
update-status
idle-check
events
classify
interrupt
nudge
open
open-worker
open-manager
stop
```

`discover` and `search` are aliases and must remain compatible.

## Behavioral Requirements

- Preserve existing exit codes for success, argparse usage errors, and
  `WorkerError`/`CodexSessionError`/`IngestError` failure paths.
- Preserve JSON output shapes for commands that currently offer `--json`.
- Preserve plain-text first lines for `conveyor --help` and `workerctl --help`:
  `usage: conveyor` and `usage: workerctl`.
- Preserve direct argv execution style. Do not route user-provided command text
  through shell interpolation.
- Preserve local `PATH` installer assumptions that `bin/conveyor` and
  `bin/workerctl` are executable.
- Preserve `--path` database override semantics on commands that currently
  accept it.
- Preserve `--dry-run` behavior on mutating or side-effecting commands that
  currently expose dry-run.
- Preserve no-judgment Dispatch boundary: Dispatch routes mechanical side
  effects and must not decide task success, merge readiness, or acceptance
  criteria truth.

## Contract Drift Disproof Gate

Before switching public entry points to TypeScript, run or produce an equivalent
artifact for:

```bash
scripts/workerctl --help
CONVEYOR_CLI_PROG=conveyor scripts/workerctl --help
CONVEYOR_CLI_PROG=workerctl scripts/workerctl --help
node scripts/ts-migration-audit.mjs --require-zero-python
```

The TypeScript implementation must have an adjudicated command/flag diff against
the archived Python surface. Unreviewed missing commands, missing aliases,
changed JSON shape, or changed help program name block migration completion.
