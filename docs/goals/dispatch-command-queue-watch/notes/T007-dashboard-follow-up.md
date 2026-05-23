# Dashboard Follow-Up: Dispatch Observation Grouping

T007 decision: defer dashboard observation grouping to a follow-up PR.

Rationale:
- The command queue/watch core is now implemented and verified in the durable DB, CLI, telemetry, and replay surfaces.
- Dashboard UI work should consume the stable `task_audit`/telemetry contract added in this tranche rather than inventing separate truth.
- `dashboard/client/styles.css` was dirty before this goal started. Touching dashboard UI now risks mixing unrelated CSS ownership into the Dispatch command queue/watch implementation.

Recommended follow-up package:
- Add dashboard server data for queued commands, command attempts, routed notifications, watch heartbeats, failures, and correlation chains.
- Add dashboard client grouping by `correlation_id` and command id.
- Surface side-effect-started/side-effect-completed failure risk explicitly.
- Keep the dashboard language observational; do not imply Dispatch made manager decisions or task success decisions.
- Resolve or isolate the pre-existing `dashboard/client/styles.css` changes before editing dashboard UI.

Suggested verification:
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- Dashboard unit/build command already used by the project, once identified in the follow-up.
