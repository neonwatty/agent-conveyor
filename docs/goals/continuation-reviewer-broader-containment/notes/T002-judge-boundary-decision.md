# T002 Judge Boundary Decision

Result: done

Decision: implementation required, broader denial approved.

## Rationale

Approve broader reviewer-subprocess denial for the `.codex-workers` state root. Reviewer commands already receive legitimate context through stdin, while legacy sessions, exports, transcripts, capture metadata, and task state are directly readable today. A no-code decision would leave issue #133 as a documented risk rather than a containment improvement.

## Scope In

- Reviewer command subprocess direct filesystem reads under the active `.codex-workers` state root.
- Legacy per-session files: `.codex-workers/<name>/config.json`, `status.json`, `events.jsonl`, `transcript.txt`, `capture-meta.json`.
- Task export artifacts: `.codex-workers/artifacts/tasks/<task_id>/export` and adjacent zip/export files.
- Active `workerctl.db`, `workerctl.db-wal`, and `workerctl.db-shm`, which remain denied as part of state-root and existing sidecar coverage.
- Future `.codex-workers` runtime/session/export artifacts reached by direct reviewer-command file reads.

## Scope Out

- Allowed reviewer context intentionally supplied on stdin, including acceptance criteria, manager config summary, diff metadata, PR metadata, and continuation payloads.
- Replay, audit, export, and telemetry generation commands outside `continuation-reviewer` subprocess execution.
- GoalBuddy boards and docs under `docs/goals` unless separately exported into `.codex-workers` artifacts.
- Replacing macOS `sandbox-exec` with a broad deny-all filesystem model.
- Changing allowed-context construction unless tests prove denial cannot work without it.

## Approved Design

Deny the active `.codex-workers` state root as a read-prohibited subpath only inside `continuation-reviewer` reviewer-command sandbox execution. Preserve temporary cwd, stripped environment, existing rollout path denial, active DB sidecar denial, and stdin allowed-context behavior. Keep replay/audit/export code paths outside this sandbox unchanged.

## Test Strategy

- Add direct `PairCommandTests` coverage that reviewer commands cannot read representative files under `.codex-workers/<session>/transcript.txt`, `status.json`, `capture-meta.json`, `events.jsonl`, and `artifacts/tasks/<task_id>/export` or export zip.
- Assert allowed stdin context still reaches reviewer commands after broader denial.
- Assert normal continuation-reviewer failure routing remains actionable while denied artifact content is not exposed.
- Run focused `PairCommandTests` first, then full `tests.test_workerctl`.

## Documentation Strategy

Update README to distinguish the original targeted rollout/database guarantee from the new reviewer-command `.codex-workers` state-root denial. Explicitly note that allowed context is still provided through stdin while replay/audit/export flows are outside that subprocess boundary.

## Redaction Strategy

Use recognizable secret strings in denied artifacts and confirm they do not appear in stdout, stderr, failure summaries, telemetry-like captured output, or reviewer result text. Do not hide command failure existence or useful denial diagnostics.

## Worker Contract

Allowed files:

- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`
- `docs/goals/continuation-reviewer-broader-containment/notes/`

Verify:

- `python3 -m unittest tests.test_workerctl.PairCommandTests -v`
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`
- `./scripts/rc-check`

Stop if:

- Implementation needs files outside allowed files.
- Implementation requires changing reviewer allowed context instead of only filesystem denial.
- `sandbox-exec` cannot deny the `.codex-workers` state root subpath without breaking reviewer temp cwd, command startup, or stdin context.
- Replay/audit/export behavior is affected by the reviewer-command sandbox change.
- Tests cannot prove denied artifact contents remain redacted from failure output.
