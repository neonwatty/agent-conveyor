# T008 Worker Receipt: Continuation Review Telemetry

Result: done

Implemented structured continuation-review telemetry without adding hard isolation claims.

Changed files:
- `workerctl/commands.py`
- `workerctl/cli.py`
- `tests/test_workerctl.py`
- `README.md`

Behavior shipped:
- `_record_continuation_review` now emits a `telemetry_events` row with event type `continuation_review_recorded`.
- Telemetry includes structured audit attributes: agreement, verdict, routing requirement, session separation, reviewer status/return code/duration, allowed context keys, and redaction markers.
- Telemetry correlation includes ids only: correlation id, review id, worker continuation id, and manager continuation id.
- Telemetry intentionally omits raw continuation payloads, rationale text, addendum text, stdout, stderr, prompts, transcripts, and reviewer command output.
- CLI and README wording now describe continuation-reviewer as independent restricted-context review, not a hard process/filesystem sandbox.
- Hard isolation remains the approved follow-up from T007.

Verification:
- `python3 -m unittest tests.test_workerctl.DatabaseTests.test_continuations_and_reviews_round_trip_through_audit tests.test_workerctl.CliTests.test_continuation_cli_enforces_ordering_review_isolation_and_divergent_routing tests.test_workerctl.CliTests.test_continuation_reviewer_runner_records_isolated_review tests.test_workerctl.CliTests.test_continuation_reviewer_runner_failure_records_stop -v`
  - Result: failed because the board used stale class names; the three CLI tests live under `PairCommandTests`, not `CliTests`.
- `python3 -m unittest tests.test_workerctl.DatabaseTests.test_continuations_and_reviews_round_trip_through_audit tests.test_workerctl.PairCommandTests.test_continuation_cli_enforces_ordering_review_isolation_and_divergent_routing tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_records_isolated_review tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_failure_records_stop -v`
  - Result: pass, 4 tests.
- `python3 -m py_compile workerctl/*.py`
  - Result: pass.
- `git diff --check`
  - Result: pass.
- `python3 -m unittest tests.test_workerctl -v`
  - Result: pass, 434 tests.

Stop conditions checked:
- No schema migration was needed.
- No files outside the approved T008 write scope were required.
- No hard sandbox/process/filesystem isolation was added.
- Wording no longer claims hard isolation for the current subprocess runner.
- Regression tests assert raw review rationale, addendum, and proposal payload content are not present in continuation-review telemetry.
