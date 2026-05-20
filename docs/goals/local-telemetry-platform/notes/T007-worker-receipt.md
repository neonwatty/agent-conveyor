# T007 Worker Receipt

## Result

Done.

## Summary

Added `workerctl telemetry` for local telemetry inspection:

- default text timeline output for readable event chronology
- `--json` raw event output preserving correlation and attributes
- `--search` backed by the telemetry FTS table
- filters for run, task, actor, event type, and severity
- `--summary` aggregate counts by actor, event type, and severity

## Files Changed

- `workerctl/cli.py`
- `workerctl/commands.py`
- `workerctl/db.py`
- `tests/test_workerctl.py`
- `docs/goals/local-telemetry-platform/state.yaml`

## Verification

- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.CliTests -v`
- `/opt/homebrew/bin/python3.13 -m unittest discover -s tests -v`
- `/opt/homebrew/bin/python3.13 -m py_compile workerctl/db.py workerctl/commands.py workerctl/cli.py`
- `git diff --check`
