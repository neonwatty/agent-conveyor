# T004 Issue And PR Hygiene

Result: done

## Proposed PR Title

Broaden continuation reviewer artifact containment

## Proposed PR Body

## Summary

- deny direct reviewer-command reads under the active `.codex-workers` state root, while preserving the existing bound rollout and active DB sidecar denial
- add direct reviewer-command coverage for legacy session artifacts and task export artifacts under `.codex-workers`
- update README to distinguish targeted rollout/database denial from broader state-root denial scoped to `continuation-reviewer`

## Issue

Closes #133.

## Verification

- `python3 -m unittest tests.test_workerctl.PairCommandTests -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`
- `WORKERCTL_STATE_ROOT="$(mktemp -d)/.codex-workers" python3 -m unittest tests.test_workerctl -v`
- `WORKERCTL_STATE_ROOT="$(mktemp -d)/.codex-workers" ./scripts/rc-check`

## Notes

The broader denial is scoped to reviewer-command subprocess execution. Allowed reviewer context still arrives on stdin, and replay/audit/export/telemetry generation remain outside the sandbox.

## Acceptance Checklist

- Intended containment boundary decided: broader denial is approved for direct reviewer-command reads under the active `.codex-workers` state root.
- Broader denial implemented without changing allowed reviewer context, temp cwd, stripped env, or existing rollout/database denial.
- Direct tests prove representative state-root artifacts are inaccessible:
  - `.codex-workers/<session>/config.json`
  - `.codex-workers/<session>/status.json`
  - `.codex-workers/<session>/events.jsonl`
  - `.codex-workers/<session>/transcript.txt`
  - `.codex-workers/<session>/capture-meta.json`
  - `.codex-workers/artifacts/tasks/<task>/export/...`
  - `.codex-workers/artifacts/tasks/<task>/export.zip`
- Redaction is covered by recognizable secret assertions in the reviewer result JSON.
- README distinguishes targeted rollout/database denial from broader `.codex-workers` state-root denial and names the subprocess boundary.

## Remaining QA

- Final Judge audit should inspect the diff and verify all #133 acceptance criteria are met.
- If creating a PR, use the title/body above and confirm CI matches local verification.

## Merge Readiness

Locally ready for final Judge audit. No remaining implementation blockers found.
