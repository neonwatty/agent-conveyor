# T004 Worker Receipt

Result: done

Implemented run and pair lifecycle telemetry:

- Added `workerctl runs` CLI for creating, listing, showing, and finishing local QA telemetry runs.
- `workerctl pair` now creates an active telemetry run and includes `run_id` in its JSON response.
- `workerctl pair` emits structured telemetry for pair start, task resolution/creation, manager config seeding, worker spawn, manager spawn, binding creation, run creation, and partial-spawn failure.
- Pair telemetry includes available task, run, binding, session, worker, manager, source command, and failure context fields.

Verification:

- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.DatabaseTests tests.test_workerctl.CliTests.test_runs_cli_create_show_list_and_finish tests.test_workerctl.PairCommandTests -v`
- `/opt/homebrew/bin/python3.13 -m py_compile workerctl/db.py workerctl/commands.py workerctl/cli.py`
