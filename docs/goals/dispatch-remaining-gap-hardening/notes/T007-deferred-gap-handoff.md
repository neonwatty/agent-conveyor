# T007 Former Deferred Gap Handoff

These gaps were originally deferred during the GoalBuddy run because the data
model did not yet contain the required durable edges. They have since been
implemented in the follow-up hardening slice.

## Notification-Only Cycle Correlation

Resolution:

- `routed_notifications` now records `consumed_manager_cycle_id` and
  `consumed_at`.
- `supervise_cycle.run_cycle` marks delivered notifications for the active
  binding as consumed by the cycle that actually starts.
- `correlation_chains` uses that explicit consumed-cycle edge instead of the
  old "next manager cycle by timestamp" heuristic.
- `DispatchTests.test_dispatch_completion_correlation_uses_consumed_cycle_not_next_cycle_heuristic`
  covers a close decoy cycle and proves the chain links to the consuming cycle.

## Ack Binding And Config Revision Semantics

Resolution:

- `manager_configs` now has a monotonically increasing `revision`.
- `task_acknowledgements` now records the active binding id and current manager
  config revision at acknowledgement time.
- `supervise_cycle.run_cycle` treats required acks as current only when both
  roles acknowledge the active binding and current manager config revision.
- `SuperviseCycleTests.test_run_cycle_rejects_stale_acknowledgements_after_manager_config_revision_changes`
  proves stale acks are rejected after a config revision change.
