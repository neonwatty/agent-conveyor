# T011 Worker Receipt: Dispatch Lease Tuning

Result: done

Closed the final Judge-identified rough edge: command lease-duration tunability.

Changed files:
- `workerctl/cli.py`
- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`

Behavior shipped:
- `workerctl dispatch` now exposes `--lease-seconds N`.
- The value is clamped to at least one second and passed through to the existing `worker_db.claim_next_dispatch_command(..., lease_seconds=...)` support.
- README documents that `--lease-seconds` controls when attempted command claims become recoverable.

Verification:
- `python3 -m unittest tests.test_workerctl.DispatchTests.test_dispatch_cli_help_exposes_watch_iterations tests.test_workerctl.DispatchTests.test_dispatch_cli_lease_seconds_controls_command_claim_expiry tests.test_workerctl.DispatchTests.test_dispatch_recovers_stale_claim_without_side_effect_by_requeueing -v`
  - Result: pass, 3 tests.
- `python3 -m unittest tests.test_workerctl -v`
  - Result: pass, 435 tests.
- `npm test`
  - Result: pass, 17 tests.
- `npm run build`
  - Result: pass.
- `python3 -m py_compile workerctl/*.py`
  - Result: pass.
- `git diff --check`
  - Result: pass.

No follow-up issue is needed for this rough edge because the local CLI tunable is implemented and verified.
