# T003 Worker Receipt

Result: done

Objective: implement #129 by seeding `acceptance_criteria` from manager acceptance config at pair start without overwriting user-authored criteria.

Changed files:

- `workerctl/db.py`
- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`

Summary:

- Added `seed_manager_acceptance_criteria`, which creates accepted `manager_inferred` ledger rows from manager config acceptance entries.
- The seeding helper skips empty values, de-duplicates repeated config entries, and skips any criterion already present for the task under any source, preserving user-authored rows without overwrite.
- `command_pair` now seeds living acceptance criteria whenever a manager config exists, emits an event when rows are created, and reports `manager_acceptance_criteria_seeded` in pair output/telemetry attributes.
- Added regression coverage for normal seeding and preservation of an existing `user_requested` criterion.
- Updated README pair docs to state that manager acceptance entries seed the living criteria ledger when absent.

Verification:

- `python3 -m unittest tests.test_workerctl.PairCommandTests.test_pair_seeds_manager_config_before_manager_spawn tests.test_workerctl.PairCommandTests.test_pair_manager_acceptance_seed_preserves_existing_user_criteria tests.test_workerctl.AcceptanceCriteriaDbTests -v`: pass
- `python3 -m py_compile workerctl/*.py`: pass
- `python3 -m unittest tests.test_workerctl -v`: pass, 429 tests
- `git diff --check`: pass

Notes:

- Ledger rows use existing source `manager_inferred`; no schema enum change was needed.
- Existing criteria are skipped by `(task_id, criterion)` regardless of source to avoid duplicating or overriding user-authored criteria.
