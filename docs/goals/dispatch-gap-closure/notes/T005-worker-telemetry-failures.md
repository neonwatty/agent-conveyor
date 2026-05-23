# T005 Worker Receipt

Result: done

Objective: implement #127 by adding operator-useful scoping to telemetry failures without hiding global failures by default.

Changed files:

- `workerctl/cli.py`
- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`

Summary:

- Added explicit `telemetry failures` scoping through existing `--task` and `--run` selectors plus new `--active-only` and `--window` support.
- Left unscoped `telemetry failures` broad by default, so historical/global failures are not hidden unless an operator asks for scope.
- Scoped failed cycles, failed commands, ingest failures/skipped lines, pane capture failures, open accepted criteria, retained storage, and operator summary blocks where relevant.
- Kept raw payload, transcript, pane, prompt, and criterion bodies redacted.
- Updated README telemetry docs with the new triage filters.

Verification:

- `python3 -m unittest tests.test_workerctl.CliTests.test_telemetry_failures_view_rolls_up_failed_cycles_commands_ingest_and_storage tests.test_workerctl.CliTests.test_telemetry_failures_view_scopes_by_window_and_active_tasks -v`: pass
- `python3 -m py_compile workerctl/*.py`: pass
- `python3 -m unittest tests.test_workerctl -v`: pass, 432 tests
- `git diff --check`: pass

Notes:

- `--run` scopes failures to the run's task for cycle/command surfaces because those tables do not directly carry `run_id`; telemetry ingest events are additionally filtered by `run_id`.
- `--window` is explicit for failures. Metrics still default to `24h`.
