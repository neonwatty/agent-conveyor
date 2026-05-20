# T003 Worker Receipt

Result: done

Implemented the local telemetry foundation hardening:

- Added `runs`, `telemetry_events`, and `telemetry_events_fts` schema support with indexes and one-active-run-per-task enforcement.
- Added run helpers for create/list/show/finish and active-run lookup.
- Added telemetry event helper validation for actor, severity, object-shaped correlation/attributes, unknown task/run references, and run/task mismatches.
- Confirmed FTS rows are inserted and queryable for telemetry events.

Verification:

- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.DatabaseTests tests.test_workerctl.CliTests.test_runs_cli_create_show_list_and_finish tests.test_workerctl.PairCommandTests -v`
- `/opt/homebrew/bin/python3.13 -m py_compile workerctl/db.py workerctl/commands.py workerctl/cli.py`
