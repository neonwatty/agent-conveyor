# TypeScript Migration SQLite And State Contract

This contract freezes the current Python state model and SQLite compatibility
surface before TypeScript migration.

## State Root

- Default state root is `.codex-workers` under the invocation cwd.
- `WORKERCTL_STATE_ROOT` overrides the default root.
- Current Python code captures invocation cwd at import time; any TypeScript
  replacement must preserve the observable default cwd behavior or record a
  Judge-approved intentional diff.

## Compatibility Files

The SQLite database is the richer source of truth, but legacy compatibility
files remain part of the contract:

- `config.json`
- `status.json`
- `events.jsonl`
- `transcript.txt`
- `capture-meta.json`

The status read path must preserve the current fallback behavior: prefer SQLite
status rows when available, but tolerate JSON-only legacy status fixtures.

## SQLite Contract

Current schema version: `22`.

The TypeScript implementation must preserve:

- `PRAGMA foreign_keys = ON`
- WAL journal mode behavior
- busy timeout behavior
- refusal to open a database with a future unsupported schema version
- migration self-healing behavior covered by the Python test suite
- required tables, indexes, triggers, check constraints, and foreign keys

Required table groups include:

- sessions and workers/managers
- tasks and bindings
- statuses and terminal/transcript captures
- prompts, acknowledgements, handoffs, continuations, and configs
- manager cycles and phase spans
- runs, telemetry events, and telemetry FTS
- durable commands, attempts, routed notifications, and command budgets
- acceptance criteria
- Codex events and ingest offsets
- audit/export/replay support tables

## Parity Evidence Required

Before TypeScript owns database creation or migration, create a Python-empty DB
and a TypeScript-empty DB in temp state roots and compare:

- `PRAGMA user_version`
- `.schema`
- table names
- index names
- trigger names
- critical PRAGMAs

Unreviewed diffs block the migration. A schema v23 bump is allowed only as a
separate Judge-approved migration task with backwards-compatibility tests.

## Fixture Requirements

The TypeScript port needs deterministic fixtures for:

- JSON-only status fallback.
- Existing SQLite status preferred over stale JSON status.
- Future schema version rejection.
- v4/v5/v6/v21-style migration cases currently covered in Python tests.
- `WORKERCTL_STATE_ROOT` isolation.
- Append-only events behavior.
- Acceptance criteria uniqueness and status/source constraints.

## Contract Drift Disproof Gate

Useful commands:

```bash
WORKERCTL_STATE_ROOT="$(mktemp -d)" scripts/workerctl db-doctor --json
python3 -m unittest tests.test_workerctl.DatabaseTests tests.test_workerctl.SessionsSchemaTests tests.test_workerctl.CodexEventsSchemaTests -v
python3 -m py_compile workerctl/*.py
```

Completion is blocked if the TypeScript-created schema differs from the
Python-created schema without a recorded Judge decision.
