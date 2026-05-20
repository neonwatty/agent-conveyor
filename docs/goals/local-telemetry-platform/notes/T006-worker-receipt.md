# T006 Worker Receipt

## Result

Done.

## Summary

Instrumented evidence and lifecycle telemetry for the local telemetry platform:

- transcript and terminal captures emit structured receipt events without storing transcript text in telemetry attributes
- transcript segments emit structured segment metadata with capture correlation
- Codex event ingest and tail reads emit summarized telemetry instead of duplicating rollout content
- worker handoffs emit summary metadata and payload key names
- acceptance criteria additions and updates emit criterion transition telemetry
- finish-task and stop-task emit task lifecycle telemetry and close active runs as finished or abandoned
- run completion emits run finish telemetry

## Files Changed

- `workerctl/db.py`
- `workerctl/commands.py`
- `workerctl/ingest.py`
- `workerctl/lifecycle.py`
- `tests/test_workerctl.py`
- `docs/goals/local-telemetry-platform/state.yaml`

## Verification

- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.CliTests tests.test_workerctl.IngestCliTests tests.test_workerctl.AcceptanceCriteriaCliTests -v`
- `/opt/homebrew/bin/python3.13 -m unittest discover -s tests -v`
- `git diff --check`
