# T001 Scout Receipt

Result: done

Summary: reconciled the dispatch gap findings against current code and live issues #127, #128, and #129. All three issues remain open and acceptance gaps are still evidenced. Some rough edges are partly implemented: dispatch has internal `watch_iterations` support and correlation chains exist in audit/replay, but public CLI exposure and grouping are incomplete.

## Gap Matrix

| Gap | Current evidence | Missing behavior | Likely files | Verification |
| --- | --- | --- | --- | --- |
| #129 acceptance ledger seeding | `pair` stores `manager_acceptance` in manager config; criteria negotiation reads active `acceptance_criteria` rows; `acceptance_criteria` has a unique task/source/criterion index. | Seed or merge `--manager-acceptance` into the ledger without overwriting user-authored criteria; cycle should report negotiation not needed. | `workerctl/commands.py`, `workerctl/db.py`, `workerctl/supervise_cycle.py`, `tests/test_workerctl.py`, `README.md` | Add pair `--manager-acceptance` idempotency/no-overwrite tests; run full unittest, py_compile, diff check. |
| #128 classifier false approval prompt | `workerctl/classify.py` scans full pane output for broad approval substrings. | Prefer active prompt/bottom region or stronger UI markers; suppress historical transcript mentions while preserving real active approval prompts. | `workerctl/classify.py`, `workerctl/shadow_state.py`, `workerctl/commands.py`, `tests/test_workerctl.py` | Add negative historical transcript fixture and positive active approval fixture. |
| #127 telemetry failure scoping | Telemetry health/failure output is global; inspected CLI telemetry options expose thresholds but not recency/active filters. | Explicit operator filters by task/run/window/active-only or equivalent, without hiding global failures by default. | `workerctl/cli.py`, `workerctl/commands.py`, `workerctl/db.py`, `workerctl/telemetry.py`, `tests/test_workerctl.py`, `README.md` | Scoped and unscoped telemetry failures tests. |
| Bounded dispatch watch | `command_dispatch` reads `args.watch_iterations` internally; CLI exposes `--watch` and `--interval` but no public iteration flag. | Public bounded iteration flag such as `--watch-iterations` or `--max-iterations`. | `workerctl/cli.py`, `workerctl/commands.py`, `tests/test_workerctl.py`, `README.md` | CLI parser/help test plus bounded watch command test. |
| Lease duration tunability | `claim_next_dispatch_command` supports `lease_seconds=60`; dispatch CLI does not expose tuning in inspected parser path. | Optional CLI lease tuning only if Judge accepts it as worth the retry/claim semantics risk. | `workerctl/cli.py`, `workerctl/commands.py`, `workerctl/db.py`, `tests/test_workerctl.py` | Claim expiry test with custom lease seconds if approved. |
| Command attempt visibility | `command_attempts` exists; `workerctl commands` shows attempt counts but not joined attempt rows. | CLI JSON/text option exposing attempt history per command. | `workerctl/commands.py`, `workerctl/cli.py`, `tests/test_workerctl.py`, `README.md` | `workerctl commands --json` includes attempts when requested; text output summarized. |
| Continuation review evidence/isolation | `continuation_reviews` stores `subagent_run_json`; tests cover contextual isolation and runner evidence, not hard sandbox isolation. | Judge decision: structured telemetry now, hard isolation now, or explicit follow-up. | `workerctl/commands.py`, `workerctl/db.py`, `workerctl/replay.py`, `workerctl/audit.py`, `tests/test_workerctl.py` | Evidence visibility tests; no fake hard-sandbox claim. |
| Dashboard/replay correlation grouping | `correlation_chains` exist and audit/replay tests assert source entries. | T009 should scout whether a small grouping slice is ready or a separate UI tranche is needed. | `workerctl/replay.py`, `workerctl/audit.py`, `workerctl/commands.py`, `README.md`, `tests/test_workerctl.py` | Grouped output test or explicit follow-up issue. |

## Parallelization Map

- Lane A, #129 acceptance ledger: `workerctl/commands.py`, `workerctl/db.py`, `workerctl/supervise_cycle.py`, `tests/test_workerctl.py`, `README.md`; independent and low dispatch-judgment risk.
- Lane B, #128 classifier precision: `workerctl/classify.py`, `workerctl/shadow_state.py`, classifier wrappers, tests; independent from ledger and telemetry except shared test file conflicts.
- Lane C, #127 telemetry scoping: `workerctl/cli.py`, telemetry command/query surfaces, tests/docs; independent but broader output/API design.
- Lane D, dispatch CLI polish: dispatch parser and commands output; can run after or coordinated with telemetry because both touch `cli.py` and `commands.py`.
- Lane E, continuation review: requires T007 Judge decision before implementation.
- Lane F, correlation grouping: requires T009 Scout before implementation.

## Risk Notes

- Classifier precision: broad approval substring gives high recall but low precision; fixes must keep positive active approval prompts covered.
- Acceptance-ledger idempotency: use the existing unique task/source/criterion constraint; do not replace or downgrade user-authored rows.
- Dispatch boundary: dispatch work must remain mechanical routing and observability, not task success, criteria truth, or strategy decisions.
- Continuation review: current tests prove contextual restrictions and runner evidence, not hard sandbox isolation; split structured evidence from sandbox claims.

## Candidate First Worker Packages

1. #129 acceptance ledger seeding. Best first package because issue acceptance is clear, data model support exists, and no-judgment risk is low.
2. #128 classifier precision. Also independent and narrow; safe in parallel if test-file conflicts are managed.
3. #127 telemetry scoping. Operator-visible but broader API/output design than #129/#128.

## Contradictions And Corrections

- T004 listed `workerctl/panes.py`, but the repo has no such file. Classifier surfaces are `workerctl/classify.py` and `workerctl/shadow_state.py`.
- The board correctly says public dispatch watch lacks a bounded flag, but current implementation already supports `args.watch_iterations` internally.
- The duplicate notify-manager result key was not reproduced in the inspected output path and may be historical or elsewhere.

Commands included GoalBuddy file reads, `gh issue view 127/128/129`, targeted source reads, and targeted test/source searches. `rg` is unavailable in this environment, so Scout used `grep` fallback.
