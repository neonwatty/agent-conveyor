# T001 Scout Receipt

Result: done

## Summary

Current reviewer containment is targeted to bound rollout JSONL plus active workerctl DB/WAL/SHM, with temporary cwd and stripped environment. Broader `.codex-workers` artifacts exist for legacy/session state, transcripts/capture metadata, task exports, telemetry/audit/replay data, and boards/docs. Existing tests cover current denial, redaction, failure routing, cwd/env, and DB sidecars, but not broader `.codex-workers` runtime/export artifacts from reviewer commands.

## Artifact Inventory

- Rollout files: registered sessions store `codex_session_path`, usually under `~/.codex/sessions/.../rollout-*.jsonl`; current reviewer denial covers bound worker and manager rollout paths.
- Active workerctl DB sidecars: `.codex-workers/workerctl.db`, `workerctl.db-wal`, and `workerctl.db-shm`; current reviewer denial covers active DB and sidecars.
- Legacy session state: `.codex-workers/<name>/config.json`, `status.json`, `events.jsonl`, `transcript.txt`, and `capture-meta.json`.
- DB-persisted task state: tasks, sessions, bindings, Codex events, manager cycle status JSON, events, commands, command attempts, continuations/reviews, and transcript tables live in `workerctl.db`.
- Transcripts and captures: raw/metadata transcript and terminal capture data are primarily DB tables; legacy `transcript.txt` and `capture-meta.json` can exist under `.codex-workers/<name>/`.
- Exports: `.codex-workers/artifacts/tasks/<task_id>/export` and optional `.zip` contain audit/replay/telemetry/prompts/transcript metadata and optionally transcript content.
- Boards/docs: GoalBuddy boards live under `docs/goals/...`, not `.codex-workers`, but may contain exported evidence or prompts.

## Current Boundary

`continuation-reviewer` consumes allowed JSON context on stdin, executes reviewer commands from a temporary cwd, strips environment to `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`, `TMPDIR`, and `PYTHONIOENCODING`, and on macOS denies `file-read*` for bound rollout files plus active DB/WAL/SHM. It does not deny the `.codex-workers` root or task export artifacts unless those paths are the active DB paths.

## Allowed Context Dependencies

- Worker/manager continuation payloads from DB are intentionally available through stdin context.
- Acceptance criteria, manager config summary, diff metadata, and recent PR metadata are intentionally available.
- Replay/audit/export/transcript commands intentionally read `workerctl.db` and export artifacts outside reviewer subprocess execution.
- `continuation-reviewer --dry-run` intentionally prints the exact allowed context.
- Reviewer commands do not need direct filesystem reads of `.codex-workers` artifacts when allowed context is complete.

## Boundary Options

- No-code: keep targeted denial and document broader `.codex-workers` artifacts as out of guarantee. Risk: #133 remains a conscious tradeoff, not containment improvement.
- Deny `.codex-workers` root for reviewer subprocess while relying entirely on stdin allowed context. Strongest containment; risk is future reviewer commands that expect local artifacts.
- Deny selected `.codex-workers` subtrees/classes: legacy per-session dirs and `artifacts/tasks` exports, plus active DB sidecars. Balanced but easier to miss new artifact classes.
- Deny active state root scoped only to reviewer command; replay/audit/export remain unaffected because they run outside the sandbox.

## Recommended Next Step

Judge should choose between a documented targeted-boundary no-code decision and reviewer-subprocess denial for the `.codex-workers` state root. Scout recommends broad state-root subpath denial scoped only to the reviewer command because legitimate reviewer context is already delivered through stdin and replay/audit/export run outside the sandbox.

## Candidate Files And Tests

- `workerctl/commands.py`: implementation site for broader denied path construction/profile labeling.
- `tests/test_workerctl.py`: existing `PairCommandTests` continuation-reviewer test home.
- `README.md`: documentation site for precise containment guarantee.
- Focused tests should deny `.codex-workers/<session>/transcript.txt`, `status.json`, `capture-meta.json`, `events.jsonl`, and `.codex-workers/artifacts/tasks/<task>/export` files/zip; preserve allowed stdin context; and assert attempted secret content remains redacted.

## Stop If

- Implementation would require changing reviewer allowed context instead of only filesystem denial.
- Judge chooses broad denial but cannot define whether exports/artifacts/tasks are in scope.
- Tests reveal `sandbox-exec` cannot deny the state root subpath without breaking reviewer temp cwd or command startup.
- Required implementation touches files outside Worker allowed files without PM/Judge expansion.
