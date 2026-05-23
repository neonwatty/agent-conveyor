# T002 Judge Receipt

Result: done

Decision: approved.

Rationale: approve T001's direction and make T003 the first Worker. T003 is the largest clearly safe first vertical slice: it changes user-visible behavior, tests, and docs without giving Dispatch any judgment authority.

## Ordered Activation Plan

1. T003: #129 acceptance ledger seeding.
2. T004: #128 classifier precision.
3. T005: #127 telemetry failure scoping.
4. T006: dispatch CLI/command observability polish.
5. T007: Judge continuation-review scope.
6. T008: continuation-review implementation only if approved.
7. T009: Scout correlation grouping.
8. T010: grouping implementation only if bounded.
9. T998: issue hygiene.
10. T999: final audit.

## First Worker

Objective: implement #129 by seeding `acceptance_criteria` from manager acceptance config at pair start without overwriting user-authored criteria.

Allowed files:

- `workerctl/cli.py`
- `workerctl/commands.py`
- `workerctl/db.py`
- `workerctl/supervise_cycle.py`
- `tests/test_workerctl.py`
- `README.md`

Verify:

- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`

Stop if:

- Ledger semantics are ambiguous.
- User-authored criteria would be overwritten.
- Files outside `allowed_files` are needed.
- Verification fails twice with unrelated failures.

## Parallel Safety

Do not parallelize current queued Worker tasks as-is. T003-T006 share `tests/test_workerctl.py` and some command/CLI/db/docs surfaces, so separate boards alone would not make simultaneous writes safe.

Potential safe lanes if the board is revised:

- Lane A, #129 acceptance ledger: current T003 scope.
- Lane B, #128 classifier precision: can run in parallel only if narrowed to `workerctl/classify.py`, `workerctl/shadow_state.py`, `tests/fixtures`, and a separate `tests/test_classifier.py`, avoiding `commands.py` and the broad test file.
- Lane C, #127 telemetry scoping: not parallel-safe yet because it shares CLI/commands/db/test/docs.
- Lane D, dispatch CLI polish: not parallel-safe with C or A as currently scoped.

## Risks Requiring Later Judge Review

- T006 duplicate notify-manager result-key cleanup should not proceed unless reproduced or reframed as a no-op verification note.
- T007 must decide continuation-review scope before T008; do not claim hard isolation from context-only boundaries.
- T009 must scout correlation grouping before T010.
- Judge review is required before lease tuning, hard isolation claims, or any behavior that lets Dispatch decide success, strategy, merge readiness, or criteria truth.
