# T002 Judge Receipt: Taxonomy Validation and First Slice Selection

## Decision

`accepted_with_blocker`

The Scout taxonomy is directionally sound and suitable for the full local telemetry package. It is intentionally milestone-oriented rather than raw-log-oriented, which matches the goal oracle: reconstruct a manager/worker QA run without shipping noisy full terminal content into telemetry attributes.

## Accepted Taxonomy Adjustments

- Keep `command_created` as optional/debug-level instrumentation. The first implementation slices should prioritize attempted/succeeded/failed milestones at command boundaries that already produce durable command rows.
- Do not emit one telemetry row per raw Codex rollout event. Use `codex_events` for raw detail and emit summarized `codex_events_ingested` telemetry with counts, offsets, skipped lines, and errors.
- Keep terminal text out of telemetry attributes. Link to terminal capture, transcript segment, command, decision, and cycle ids instead.
- Use `workerctl` as the actor for system-mediated events unless the action is clearly a manager decision or worker handoff.
- Attach active `run_id` by task where available, but do not fail non-run workflows just because no active run exists.

## First Worker Objective

Start with T003 foundation hardening:

> Harden telemetry foundation helpers and validation required by later emitters.

This is the largest safe first implementation slice because later instrumentation will be repeated across many command paths. The helpers need to be reliable before adding broad emitters.

## Allowed Files

- `workerctl/db.py`
- `tests/test_workerctl.py`

## Acceptance Criteria

- `emit_telemetry_event` validates actor and severity before touching SQLite.
- `emit_telemetry_event` validates `correlation` and `attributes` are JSON objects.
- If `run_id` is provided, it must resolve to an existing run and infer `task_id` when missing.
- If `task_id` is provided without `run_id`, the helper attaches the active run when one exists.
- If both `run_id` and `task_id` are provided, mismatches fail cleanly.
- FTS rows are inserted for telemetry events and remain queryable by summary/attributes terms.
- Helper output remains stable enough for upcoming CLI/report tasks.
- No replay/export behavior changes.

## Verify

```bash
python3 -m unittest \
  tests.test_workerctl.DatabaseTests.test_run_helpers_create_list_finish_and_enforce_one_active_run_per_task \
  tests.test_workerctl.DatabaseTests.test_telemetry_event_helpers_attach_active_run_and_index_search_text \
  -v

python3 -m py_compile workerctl/db.py
```

After local repo access is restored, the PM should first re-run:

```bash
git status --short --branch
python3 -m unittest tests.test_workerctl.DatabaseTests -v
```

This establishes the actual current worktree before any edit.

## Stop If

- The canonical repo remains unreadable with `Operation not permitted`.
- Local diff contradicts the assumed foundation state.
- Any needed edit falls outside `workerctl/db.py` or `tests/test_workerctl.py`.
- Verification fails twice.

## Blocker

Implementation cannot start safely because the canonical repo at `/Users/neonwatty/Desktop/codex-terminal-manager` is still unreadable to command-line tools. The board should keep T003 queued or active-but-blocked until local access is restored.
