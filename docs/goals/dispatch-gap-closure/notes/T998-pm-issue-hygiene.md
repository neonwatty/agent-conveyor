# T998 PM Receipt: Issue Hygiene

Result: done

Updated GitHub issues after local evidence and verification were available.

Closed issues:
- #127: Telemetry failures view needs recency or active-task scoping for operator triage
  - URL: https://github.com/neonwatty/codex-terminal-manager/issues/127
  - Evidence comment: https://github.com/neonwatty/codex-terminal-manager/issues/127#issuecomment-4526680378
- #128: Pane classifier can falsely report approval_prompt from historical transcript text
  - URL: https://github.com/neonwatty/codex-terminal-manager/issues/128
  - Evidence comment: https://github.com/neonwatty/codex-terminal-manager/issues/128#issuecomment-4526680376
- #129: Pair should seed acceptance criteria ledger from manager acceptance config
  - URL: https://github.com/neonwatty/codex-terminal-manager/issues/129
  - Evidence comment: https://github.com/neonwatty/codex-terminal-manager/issues/129#issuecomment-4526680379

Created follow-up:
- #130: Implement hard isolation for continuation reviewer execution
  - URL: https://github.com/neonwatty/codex-terminal-manager/issues/130
  - Reason: T007 approved structured continuation-review telemetry now and explicitly deferred true hard sandbox/process/filesystem isolation.

Verification immediately before issue hygiene:
- `python3 -m unittest tests.test_workerctl -v`
  - Result: pass, 434 tests.
- `npm test`
  - Result: pass, 17 tests.
- `npm run build`
  - Result: pass.
- `python3 -m py_compile workerctl/*.py`
  - Result: pass.
- `git diff --check`
  - Result: pass.

Additional evidence added during issue hygiene:
- `tests.test_workerctl.PairCommandTests.test_pair_seeds_manager_config_before_manager_spawn` now directly verifies pair-seeded manager acceptance criteria suppress cycle criteria negotiation with reason `active_criteria_present`, matching #129's requested verification.

Verified external state:
- #127 state: closed.
- #128 state: closed.
- #129 state: closed.
- #130 state: open.
