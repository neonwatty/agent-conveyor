# T001 Scout Receipt: Local Telemetry Platform

## Result

`done_with_blocker`

The telemetry taxonomy and instrumentation map are drafted from the available evidence. The canonical repo worktree at `/Users/neonwatty/Desktop/codex-terminal-manager` is currently unreadable to local tools (`Operation not permitted` on `git`, `ls`, `cat`, `find`, `cp`, and `xattr`), so this receipt is recorded in the accessible visual-board copy at `/Users/neonwatty/goalbuddy-boards/local-telemetry-platform`. Implementation must wait until the repo permission issue is fixed or the repo is moved/cloned to an accessible path.

## Evidence Used

- GitHub repository: `neonwatty/codex-terminal-manager`, default branch `main`.
- `workerctl/db.py`: current durable tables include `events`, `commands`, `codex_events`, `manager_cycles`, `manager_decisions`, `terminal_captures`, `transcript_segments`, `worker_handoffs`, `acceptance_criteria`, `sessions`, `bindings`.
- `workerctl/commands.py`: task creation/listing, criteria mutation, manager config, command listing, capture/transcript capture, start-worker/start-manager, pair, register/deregister, session actions.
- `workerctl/lifecycle.py`: finish/stop task lifecycle, final criteria audit, manager decision insertion, pre-stop transcript capture.
- `workerctl/ingest.py`: rollout JSONL ingestion into `codex_events`, skipped-line reporting, session staleness state.
- `workerctl/export.py`: export bundle already writes audit, criteria, prompts, transcript/terminal captures, observations, manager cycles/decisions, mutation audit, replay.
- `workerctl/replay.py`: existing replay already turns commands, decisions, acceptance criteria, manager cycles, captures, and transcript segments into timeline entries.

## Current Foundation Summary

The branch intent already established the first local SQLite foundation:

- `runs`: active/finished/failed/abandoned run identity for QA drills.
- `telemetry_events`: local structured event table.
- `telemetry_events_fts`: searchable FTS table.
- `workerctl runs`: create/list/show/finish run lifecycle CLI.
- `workerctl pair`: creates an active run after successful manager/worker binding.

Because the local repo is inaccessible, this could not be re-inspected from the current filesystem. The next Worker should verify the local diff before editing.

## Event Taxonomy

| event_type | actor | severity | source | required correlation | key attributes |
|---|---|---|---|---|---|
| `pair_started` | `workerctl` | `info` | `command_pair` | `task_id?`, `task_name` | worker name, manager name, cwd, codex profile, sandbox, approval |
| `task_resolved` | `workerctl` | `info` | `command_pair`, `command_tasks` | `task_id`, `run_id?` | created bool, task name, goal hash/summary |
| `manager_config_seeded` | `workerctl` | `info` | `command_pair`, `command_manager_config` | `task_id`, `run_id?` | mode, guideline count, criteria count, reference count, permissions keys |
| `session_spawn_started` | `workerctl` | `info` | `_spawn_codex_and_register` | `task_id?`, `run_id?` | role, session name, tmux session, cwd |
| `session_registered` | `workerctl` | `info` | `_spawn_codex_and_register`, register commands | `task_id?`, `run_id?`, `worker_session_id?`, `manager_session_id?` | role, pid, codex session id, rollout path presence |
| `session_spawn_failed` | `workerctl` | `error` | `_spawn_codex_and_register` | `task_id?`, `run_id?` | role, session name, error type/message, recovery hint |
| `binding_created` | `workerctl` | `info` | `command_pair`, bind command | `task_id`, `run_id?`, `binding_id`, `worker_session_id`, `manager_session_id` | worker name, manager name |
| `run_created` | `workerctl` | `info` | `create_run`, `command_pair`, `workerctl runs` | `task_id`, `run_id` | purpose, metadata source |
| `manager_cycle_started` | `manager` | `info` | cycle/run_cycle path | `task_id`, `run_id?`, `binding_id?`, `manager_cycle_id?` | manager id/session, worker session |
| `manager_cycle_succeeded` | `manager` | `info` | cycle/run_cycle path | `task_id`, `run_id?`, `manager_cycle_id`, `worker_session_id`, `manager_session_id` | inferred state, staleness, capture ids, notable pane pattern |
| `manager_cycle_failed` | `manager` | `error` | cycle/run_cycle path | `task_id`, `run_id?`, `manager_cycle_id?` | error type/message, ingest/capture failure details |
| `manager_decision_recorded` | `manager` | `info` | `command_record_decision`, lifecycle finish | `task_id`, `run_id?`, `manager_decision_id`, `manager_cycle_id?`, `command_id?` | decision, reason, allowed decision check |
| `command_created` | `workerctl` | `debug` | `create_command` callers | `task_id?`, `run_id?`, `command_id` | command type, worker/manager id |
| `command_attempted` | `workerctl` | `info` | `mark_command_attempted` callers | `task_id?`, `run_id?`, `command_id` | command type |
| `command_succeeded` | `workerctl` | `info` | `finish_command` callers | `task_id?`, `run_id?`, `command_id` | command type, result summary |
| `command_failed` | `workerctl` | `error` | `finish_command` callers | `task_id?`, `run_id?`, `command_id` | command type, error type/message |
| `worker_nudge_attempted` | `manager` | `info` | nudge/session-nudge/request compact | `task_id`, `run_id?`, `command_id`, `worker_session_id` | message length/hash, target session |
| `worker_nudge_succeeded` | `manager` | `info` | nudge/session-nudge/request compact | `task_id`, `run_id?`, `command_id`, `worker_session_id` | target session, dry_run bool |
| `worker_nudge_failed` | `manager` | `error` | nudge/session-nudge/request compact | `task_id`, `run_id?`, `command_id`, `worker_session_id?` | error type/message, target |
| `worker_interrupt_attempted` | `manager` | `warning` | interrupt/session-interrupt | `task_id`, `run_id?`, `command_id`, `worker_session_id` | followup length/hash, target session |
| `worker_interrupt_succeeded` | `manager` | `warning` | interrupt/session-interrupt | `task_id`, `run_id?`, `command_id`, `worker_session_id` | target session, dry_run bool |
| `worker_interrupt_failed` | `manager` | `error` | interrupt/session-interrupt | `task_id`, `run_id?`, `command_id`, `worker_session_id?` | error type/message |
| `terminal_capture_recorded` | `workerctl` | `info` | `capture_task_terminal` | `task_id`, `run_id?`, `capture_id`, `command_id?`, `worker_session_id?`, `manager_session_id?` | role, line count, byte count, sha256, source, classifier summary |
| `transcript_segment_recorded` | `workerctl` | `info` | `record_transcript_segment` | `task_id`, `run_id?`, `capture_id`, `transcript_segment_id` | role, kind, line count, retention class |
| `codex_events_ingested` | `workerctl` | `info` | `ingest_session`, command ingest | `run_id?`, `worker_session_id?`, `manager_session_id?` | new events, new offset, skipped lines |
| `codex_ingest_failed` | `workerctl` | `error` | `ingest_session`, command ingest/tail | `run_id?`, `session_id?` | error type/message, rollout path presence |
| `handoff_recorded` | `worker` | `info` | `command_handoff` / DB helper | `task_id`, `run_id?`, `worker_session_id?` | handoff id, summary length/hash, next step count |
| `acceptance_criterion_added` | `workerctl` | `info` | `command_criteria` | `task_id`, `run_id?`, `criterion_id` | status, source, criterion hash/short text |
| `acceptance_criterion_updated` | `workerctl` | `info` | `command_criteria` | `task_id`, `run_id?`, `criterion_id` | previous status, new status, proof/rationale presence |
| `task_finished` | `workerctl` | `info` | `finish-task` lifecycle | `task_id`, `run_id?`, `command_id`, `manager_decision_id?` | reason, final criteria audit summary, stopped worker/manager |
| `task_failed` | `workerctl` | `error` | stop/failure lifecycle | `task_id`, `run_id?`, `command_id?` | reason, error summary |
| `run_finished` | `workerctl` | `info` | `finish_run`, task finish integration | `task_id`, `run_id` | status, duration, event counts |
| `telemetry_export_created` | `workerctl` | `info` | telemetry export/report command | `task_id?`, `run_id?` | export path, file count, zip bool |

## Instrumentation Matrix

1. Foundation hardening:
   - Verify active run lookup by task.
   - Add validation for actor/severity/metadata shapes.
   - Ensure FTS stays synced for inserted telemetry.
   - Add helper wrappers to reduce duplicated emit boilerplate.

2. Pair/run lifecycle:
   - `command_pair`: pair start, task resolved/created, manager config seeded, worker spawn result, manager spawn result, binding created, run created, pair failed.
   - `_spawn_codex_and_register`: role-neutral spawn/register success/failure telemetry where task/run context is passed by caller.

3. Manager supervision/mutations:
   - Cycle path: started/succeeded/failed events tied to `manager_cycles`.
   - `command_record_decision` and lifecycle final decision: decision telemetry.
   - Command lifecycle: created/attempted/succeeded/failed or targeted wrappers at mutation boundaries.
   - Nudge/interrupt/compact: attempted/succeeded/failed telemetry.
   - Permission checks: include policy result on decision/mutation telemetry rather than separate noisy events.

4. Evidence surfaces:
   - `capture_task_terminal`: terminal capture telemetry with capture id and classifier summary.
   - `record_transcript_segment`: transcript segment telemetry with segment id and line count.
   - `ingest_session`: ingest success/failure telemetry with new events/skipped lines.
   - `command_handoff`: handoff recorded telemetry.
   - `command_criteria`: criterion add/update telemetry should duplicate into `telemetry_events`.
   - `finish-task` / `stop-task`: close active run and emit task/run finish telemetry.

5. Operator surfaces:
   - `workerctl telemetry --run <run>` chronological JSON timeline.
   - `workerctl telemetry --task <task>` timeline across runs.
   - `workerctl telemetry --search <query> [--run/--task]` FTS search.
   - `workerctl telemetry --summary --run <run>` duration, counts, actors, event types, errors, warnings, key ids.

6. Export/report:
   - Add optional `--include-telemetry` to `export-task`.
   - Write `telemetry-events.jsonl`, `telemetry-summary.json`, and `telemetry-timeline.md` or equivalent.
   - Include telemetry files in manifest only when requested/documented.

7. Docs and drill:
   - Document local-only behavior, schema, event taxonomy, query/report/export commands.
   - Run one realistic manager/worker drill with multiple turns and durable artifacts.

## Noise and Privacy Risks

- Do not store full prompt or terminal text in telemetry attributes; link to existing captures/transcripts by id and hash.
- Avoid emitting per-Codex-event telemetry for every raw rollout event; summarize ingest counts and use existing `codex_events` for raw detail.
- Avoid duplicating entire command payloads into telemetry; store key ids and compact summaries.
- Treat terminal content as evidence already governed by capture/transcript retention classes.

## Recommended First Worker Slice

Start with T003 foundation hardening once local repo access is restored.

Allowed files:

- `workerctl/db.py`
- `tests/test_workerctl.py`

Acceptance:

- `emit_telemetry_event` validates actor, severity, metadata object shapes, and run/task references cleanly.
- A helper can resolve the active run for a task and attach emitted events automatically.
- FTS rows are inserted and queryable for each telemetry event.
- Tests cover success and failure paths.

Verify:

- `python3 -m unittest tests.test_workerctl.DatabaseTests.test_run_helpers_create_list_finish_and_enforce_one_active_run_per_task tests.test_workerctl.DatabaseTests.test_telemetry_event_helpers_attach_active_run_and_index_search_text -v`
- `python3 -m py_compile workerctl/db.py`

## Blocker

Local implementation is blocked until `/Users/neonwatty/Desktop/codex-terminal-manager` is readable again by command-line tools. Current failure mode:

```text
fatal: Unable to read current working directory: Operation not permitted
sed/cat/ls/find/cp/xattr: Operation not permitted
```

Likely fixes:

- Grant the terminal/Codex process Full Disk Access or Desktop folder access in macOS Privacy settings.
- Move or clone the repo outside `Desktop`, for example under `/Users/neonwatty/src/codex-terminal-manager`.
- Re-run `git status --short --branch` from the repo before any Worker edits.
