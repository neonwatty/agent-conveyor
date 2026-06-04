# Investigation Summary

## Scouts Used

Four independent read-only scouts completed before this board was created:

- Python architecture: mapped `workerctl` CLI, entry shims, SQLite schema, tmux/Codex/session integration, compatibility files, and hidden coupling.
- QA/test surface: mapped Python unittest, ResourceWarning, py_compile, dashboard tests/build, shell syntax, package/release smoke, live smoke, manual QA, CI, and evidence-playbook requirements.
- TypeScript/dashboard patterns: mapped root ESM, `tsx`, `node:test`, explicit argv arrays, `spawn` without shell interpolation, PTY safety checks, and dashboard-local constraints.
- Packaging/release: mapped PyPI/Python package authority, `pipx` docs, wheel/sdist smoke, npm metadata gaps, CI publish workflow, and skill asset install contracts.

## Baseline Verification Run Before Board Creation

- `python3 -m unittest discover -s tests -v`: pass, 645 tests.
- `scripts/check-resource-warnings`: pass, 645 tests with ResourceWarning gate.
- `python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py`: pass.
- `npm test -- --runInBand`: pass, 40 dashboard tests.
- `npm run build`: pass.
- `bash -n scripts/live-smoke scripts/live-smoke-repeat scripts/package-smoke scripts/release-check scripts/rc-check`: pass.
- `npm whoami`: pass, `neonwatty`.
- `npm view agent-conveyor name version --json`: 404, package not present on npm at check time.

## Contract Facts To Preserve

- Public entry points include `bin/conveyor`, `bin/workerctl`, `scripts/workerctl`, Python module entry, and package-installed console scripts.
- Program name behavior depends on `CONVEYOR_CLI_PROG` and invocation name, and must preserve both `conveyor` and `workerctl`.
- CLI command surface is broad: sessions, tasks, bind/unbind, cycle, dispatch, inboxes, QA, loop evidence, telemetry, criteria, lifecycle, replay, export, dashboard, install-skills, doctor, and compatibility commands.
- State is dual-model: SQLite `.codex-workers/workerctl.db` plus JSON compatibility files such as `config.json`, `status.json`, `events.jsonl`, `transcript.txt`, and `capture-meta.json`.
- SQLite schema version is 22 with required tables, indexes, triggers, constraints, WAL, busy timeout, and migration behavior.
- `INVOCATION_CWD` is captured at import time in Python and affects default state root and CLI default cwd.
- tmux integration uses `has-session`, `list-panes`, `capture-pane`, `send-keys`, `set-buffer`, `paste-buffer`, `delete-buffer`, `new-session`, and `kill-session`, with pane id safeguards.
- Codex integration discovers native Codex process and rollout JSONL through pid child walking, `lsof`, and first `session_meta` record.
- JSONL ingest tracks offsets, skips malformed or partial trailing lines, maps event subtypes to busy/idle, and must not reprocess lines.
- Dispatch push mode uses tmux; pull-required mode uses manager/worker/session inbox consumption and telemetry.
- Skill installation must preserve `manage-codex-workers` and `codex-review` assets plus executable mode for `codex-review/scripts/codex-review`.

## Packaging Facts

- Current `pyproject.toml` is authoritative for Python/PyPI package `agent-conveyor`.
- Current `package.json` is `private: true` and dashboard-only; it lacks npm `name`, `version`, `bin`, `files`, `engines`, `publishConfig`, and CLI package identity.
- Current CI runs Node 24 but still validates Python release shape with `scripts/rc-check --skip-live-smoke-repeat` and `scripts/package-smoke`.
- Current publish workflow is PyPI/TestPyPI with trusted publishing, not npm.
- The migration must add npm tarball install smoke before replacing Python wheel smoke.

## Recommended Package Decision

Use npm package name `agent-conveyor` for continuity with PyPI. The package was not found in npm registry during investigation. Publishing is intentionally not authorized for autonomous overnight work.
