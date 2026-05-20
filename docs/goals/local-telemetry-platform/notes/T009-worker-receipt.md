# T009 Worker Receipt

## Result

Done.

## Summary

Documented the local telemetry workflow and realistic QA drill playbook:

- README command reference now includes `workerctl telemetry` and telemetry export artifacts
- `docs/local-telemetry-workflow.md` describes run inspection, JSON evidence capture, export artifacts, and drill checklist commands
- `docs/manual-qa-checklist.md` includes telemetry summary, timeline, and search checks
- a docs drift test verifies the README, checklist, and workflow doc keep the required commands and artifacts visible

## Files Changed

- `README.md`
- `docs/local-telemetry-workflow.md`
- `docs/manual-qa-checklist.md`
- `tests/test_workerctl.py`
- `docs/goals/local-telemetry-platform/state.yaml`

## Verification

- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v`
- `/opt/homebrew/bin/python3.13 -m unittest discover -s tests -v`
- `git diff --check`
