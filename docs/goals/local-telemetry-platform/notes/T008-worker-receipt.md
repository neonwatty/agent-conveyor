# T008 Worker Receipt

## Result

Done.

## Summary

Added local telemetry export/report artifacts to `workerctl export-task`:

- `telemetry-events.json` with task-scoped structured telemetry events
- `telemetry-summary.json` with aggregate telemetry counts
- `telemetry-report.md` with a readable event-type summary and timeline
- manifest and zip archive inclusion for all telemetry artifacts

## Files Changed

- `workerctl/export.py`
- `tests/test_workerctl.py`
- `docs/goals/local-telemetry-platform/state.yaml`

## Verification

- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.CliTests tests.test_workerctl.AcceptanceCriteriaReplayExportTests -v`
- `/opt/homebrew/bin/python3.13 -m unittest discover -s tests -v`
- `/opt/homebrew/bin/python3.13 -m py_compile workerctl/cli.py workerctl/commands.py workerctl/export.py workerctl/db.py`
- `git diff --check`
