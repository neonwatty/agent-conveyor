# T001 Scout Map

## Summary

The current code strongly supports starting with #115, the manager permission taxonomy, before Dispatch. The existing `manager_configs` table already stores `permissions_json` as JSON, so the first slice can be largely additive and compatibility-preserving. The CLI and tests are clustered around the current three flat permission booleans, making #115 a bounded first Worker package with clear verification.

## Issue Surface Map

### #115 Categorized Permissions

- `workerctl/db.py` defines `manager_configs.permissions_json` with no separate tools field.
- `workerctl/db.py` has `upsert_manager_config(...)` and `manager_config(...)`, both passing permissions through as a JSON object.
- `workerctl/commands.py` defines `MANAGER_PERMISSION_ACTIONS`, `MANAGER_PERMISSION_ALIASES`, `normalize_manager_permissions(...)`, and `normalize_manager_permission_overrides(...)` for only `create_pr`, `merge_green_pr`, and `worker_compact_clear`.
- `workerctl/commands.py` wires these helpers in both `command_manager_config(...)` and `command_pair(...)`.
- `workerctl/cli.py` exposes `manager-config --allow-pr`, `--allow-merge-green`, `--allow-worker-compact-clear`, and `--permissions-json`; `manager-permission` only accepts the three flat action choices.
- Tests around `tests/test_workerctl.py` already cover round-trip, alias normalization, interactive clearing, permission checks, and handoff-required behavior. These are the natural tests to extend for taxonomy, `--permit`, `--tool`, aliases, and denied category behavior.

Recommendation: implement #115 first using compatibility helpers that can read either legacy flat permission JSON or the new taxonomy. Preserve legacy keys in accepted input; return a canonical taxonomy plus enough compatibility output for existing callers/tests to keep passing.

### #114 Worker/Manager Acks

- No `task_acknowledgements` table exists.
- `cycle` currently includes `manager_context.manager_config`, `manager_context.worker_handoff`, acceptance criteria, and criteria negotiation. This is the right place to add latest `worker_ack` and `manager_ack`.
- `worker_handoffs` already provides a nearby pattern: table, `insert_worker_handoff`, `latest_worker_handoff`, task audit inclusion, and tests.
- Replay currently renders commands, manager decisions, acceptance criteria events, manager cycles, captures, and transcript entries, but not handshakes.

Recommendation: use the worker handoff pattern for #114. Add an additive table and DB helpers, then CLI commands `worker-ack` and `manager-ack`. Wire latest rows into cycle context and task audit/replay.

### #113 Dispatch

- `cycle` already ingests worker rollout JSONL, computes state from `codex_events`, and exposes `last_event_subtype` plus `task_completed`.
- `codex_events` has autoincrement `id`, `session_id`, `timestamp`, `type`, `subtype`, payload, byte offset, and ingest timestamp. This satisfies the issue requirement that dedupe include source event identity.
- There is no `routed_notifications` table and no `dispatch` CLI.
- `commands` exists with states `pending`, `attempted`, `succeeded`, and `failed`, plus idempotency key and result/error fields. It does not have lease/claim fields, attempts, dispatcher id, or `correlation_id`.
- `mark_command_attempted(...)` is a conditional update from `pending` to `attempted`, but it does not prove atomic claim ownership for multiple dispatchers.
- `TELEMETRY_ACTORS` currently excludes `dispatch`/`dispatcher`, so dispatch telemetry either needs an actor expansion or must use `workerctl` with dispatcher attributes.
- `tmux.py` has the low-level text send path; `session-nudge` is still direct behavior in command handlers.

Recommendation: keep #113 Phase 1 narrow. Add `routed_notifications` and `workerctl dispatch --once` for completion routing from `codex_events`, with dedupe on `codex_events.id` and no manager decision/task state writes. Defer atomic command claiming/watch mode until after the routing foundation.

### #116 Epilogue

- No `epilogue_runs` table or `epilogue` CLI exists.
- `manager_config` currently lacks `tools` and `epilogue` fields; #116 depends on #115 for `manager_config.tools`.
- `finish-task` already supports `--require-criteria-audit`, so it has the right gating surface for `--require-epilogue`.
- Audit/replay do not yet include epilogue rows.

Recommendation: after #115 and #113 Phase 1, add minimal named epilogue persistence and finish gating. Avoid a plugin system. If `run-tools` cannot safely execute all configured tools immediately, represent unsupported execution honestly instead of faking success.

### #117 Dual What's Next

- No `task_continuations`, `continuation_reviews`, `continuation submit`, `nudge_on_completion`, or reviewer-spawning command exists.
- #117 depends on #115 for `context.spawn_reviewer` and #116 for `subagent-review`.
- The board should not approve implementation until ordering enforcement and reviewer isolation are concrete.

Recommendation: keep #117 behind a Judge checkpoint after #115, #116, and #113 Phase 1. The likely first slice is persistence and CLI ordering enforcement before any real external subagent execution.

## Migration Risks

- `SCHEMA_VERSION` is currently 9. Any new tables or columns must update `REQUIRED_TABLES` / `REQUIRED_INDEXES` and schema verification expectations.
- Existing `manager_configs.permissions_json` rows contain flat booleans. #115 must read and normalize old rows without destructive migration.
- Adding `manager_config.tools` can be either a new JSON column or folded into an existing JSON shape. A column is clearer but requires an additive migration.
- Adding `dispatch` telemetry as an actor requires expanding `TELEMETRY_ACTORS` and tests that validate actors.
- Dispatch command claiming is not safe with the current `mark_command_attempted(...)` alone. Later #113 queue work needs a real claim helper, probably with additive lease columns or a `command_attempts` table.

## Existing Tests To Extend

- `test_manager_config_round_trips`
- `test_manager_config_command_records_policy`
- `test_manager_config_permissions_json_normalizes_allow_aliases`
- `test_manager_config_permissions_json_alias_can_clear_existing_permission`
- `test_manager_config_questions_prints_setup_schema`
- `test_manager_config_interactive_records_answers_from_stdin`
- `test_manager_config_interactive_can_clear_existing_permissions`
- `test_manager_permission_checks_saved_policy`
- `test_manager_permission_can_require_handoff`
- `test_command_lifecycle_records_result`
- telemetry snapshot tests around commands/cycles
- replay/audit tests around task audit output

## Recommended First Worker Package

Implement #115 as the first Worker package.

Candidate allowed files:

- `workerctl/cli.py`
- `workerctl/commands.py`
- `workerctl/db.py`
- `workerctl/supervise_cycle.py`
- `tests/test_workerctl.py`
- `docs/goals/dispatch-supervision-control-plane/state.yaml`

Candidate verify commands:

- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`

Stop if:

- Existing flat permission rows cannot round-trip.
- `manager-permission` cannot support both legacy actions and `category.action`.
- Schema changes require destructive migration.
- Unknown permission keys would be silently accepted.
