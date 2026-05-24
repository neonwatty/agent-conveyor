# T003 Worker Receipt

Result: done

## Summary

Implemented broader continuation-reviewer containment by adding the active `.codex-workers` state root to the reviewer-command sandbox deny list. The existing bound rollout and active DB/WAL/SHM denial remains in place. Reviewer commands still run from a temporary cwd with a stripped environment and receive allowed context through stdin.

## Changed Files

- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`

## Implementation

- `workerctl/commands.py` now resolves the active state root as a forced directory path and adds it as a `subpath` read-denial for `continuation-reviewer` reviewer-command sandbox profiles.
- The sandbox profile label now reflects broader state-root denial.
- Existing explicit rollout and active DB sidecar path denial remains, preserving the targeted #130 behavior inside the broader boundary.

## Tests Added

- `test_continuation_reviewer_runner_sandbox_denies_state_root_artifacts`
  - creates representative `.codex-workers` legacy session artifacts: `config.json`, `status.json`, `events.jsonl`, `transcript.txt`, `capture-meta.json`;
  - creates representative task export artifacts under `artifacts/tasks/.../export` and adjacent `export.zip`;
  - proves reviewer-command direct reads are denied;
  - proves allowed stdin context still reaches the reviewer;
  - asserts recognizable artifact secret content is absent from the persisted review JSON.

## README Update

README now distinguishes:

- targeted denial of bound worker/manager rollout files plus active workerctl DB and sidecars;
- broader denial of direct reads under the active `.codex-workers` state root;
- allowed reviewer context still arriving on stdin;
- replay/audit/export/telemetry generation remaining outside the reviewer subprocess sandbox.

## Verification

- `python3 -m unittest tests.test_workerctl.PairCommandTests -v`: pass, 43 tests.
- `python3 -m py_compile workerctl/*.py`: pass.
- `git diff --check`: pass.
- First parallel run of `python3 -m unittest tests.test_workerctl -v` and `./scripts/rc-check`: failed due shared `.codex-workers` test-state interference from running both broad stateful suites at the same time.
- `WORKERCTL_STATE_ROOT="$(mktemp -d)/.codex-workers" python3 -m unittest tests.test_workerctl -v`: pass, 442 tests.
- `WORKERCTL_STATE_ROOT="$(mktemp -d)/.codex-workers" ./scripts/rc-check`: pass.

## Remaining Risks

- Broader denial depends on macOS `sandbox-exec`, matching the existing reviewer hard-isolation implementation.
- The denial is intentionally scoped to reviewer-command subprocess execution; direct CLI replay/audit/export reads remain allowed.
