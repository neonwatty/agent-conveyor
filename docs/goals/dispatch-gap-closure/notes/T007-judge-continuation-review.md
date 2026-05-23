# T007 Judge Receipt

Result: done

Decision: approved, split scope.

Rationale: structured telemetry for continuation reviews is local and low risk because continuation review already records compact events and `telemetry_events` already supports task/correlation attributes. Hard isolation is not currently evidenced: the reviewer command runs as a subprocess with restricted stdin context and metadata checks, not an OS/process/filesystem sandbox.

## Approved T008 Scope

Objective: emit structured telemetry for continuation reviews using existing `telemetry_events`, preserve redaction, expose enough attributes for audit/triage, and update CLI/README wording so continuation-reviewer is described as independent restricted-context review rather than hard isolation.

Allowed files:

- `workerctl/commands.py`
- `workerctl/cli.py`
- `tests/test_workerctl.py`
- `README.md`
- `docs/goals/dispatch-gap-closure/notes`

Verify:

- `python3 -m unittest tests.test_workerctl.DatabaseTests.test_continuations_and_reviews_round_trip_through_audit tests.test_workerctl.CliTests.test_continuation_cli_enforces_ordering_review_isolation_and_divergent_routing tests.test_workerctl.CliTests.test_continuation_reviewer_runner_records_isolated_review tests.test_workerctl.CliTests.test_continuation_reviewer_runner_failure_records_stop -v`
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`

Stop if:

- Structured telemetry requires a schema migration or files outside allowed files.
- Telemetry would store raw continuation payloads, rationale bodies, stdout/stderr content, prompts, or transcript text.
- Implementation starts adding sandbox/process/filesystem isolation instead of recording the approved follow-up.
- Wording continues to claim hard isolation without an enforced sandbox primitive.
- Verification fails twice with unrelated failures.

## Hard-Isolation Follow-Up

Title: Implement hard isolation for continuation reviewer execution

Body: Continuation-reviewer currently enforces independent session metadata, `manager_rollout_access=false`, permission checks, and restricted stdin context, but the reviewer command still runs as a normal subprocess in the project environment. Implement real hard isolation before documenting sandbox guarantees. Acceptance criteria: reviewer execution uses an enforced sandbox or equivalent process/filesystem/environment isolation; tests prove manager rollout/session artifacts are inaccessible except through allowed context; failures route to stop/operator review; docs distinguish metadata isolation from hard isolation.
