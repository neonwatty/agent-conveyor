Must-have current-task criteria:

1. README command coverage is understood well enough to identify the QA surface: worker/manager setup, binding, cycle observation, criteria tracking, audit/replay, and cleanup.
2. workerctl help is checked through a valid entrypoint, with any entrypoint issue recorded separately from product behavior. Current note: root ./workerctl is a package directory, not an executable; bin/workerctl and scripts/workerctl are executable.
3. QA execution remains status-only for this slice: no tracked files are edited, reformatted, or regenerated.

Deferred follow-up criteria:

1. Run a live qa-plan scenario, likely emergent-criteria, against a disposable worker/manager pair and capture the audit/replay evidence.
2. Verify install/path behavior so workerctl --help works after documented setup, not only through repo-local wrappers.
