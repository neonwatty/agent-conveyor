# Phase 6 Implementation Plan — Silent-Failure Cleanup + UX Ergonomics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish phase. Two threads bundled into one phase:
1. **Silent-failure cleanup** — act on the 13 exception-swallow findings codex produced during the Phase 5 audit dogfood. Triaged down to the ~8 with real correctness/observability impact.
2. **UX ergonomics** — close the biggest spawn-and-register friction gap (`workerctl start-worker`) and make `reconcile` thresholds configurable.

**Architecture:** No structural change. Phase 6 is targeted fixes plus one new convenience command. No schema migration. No new modules; everything lands in existing files.

**Tech Stack:** Python 3, SQLite (WAL), stdlib only.

**Scope note:** Phase 6 only. Out of scope: dropping legacy tables, session-native replacements for `capture`/`stop` (still useful for direct access), parse_iso consolidation across `core.py`/`db.py`/`ingest.py` (refactor, not a bug fix), and Phase 7+ ergonomics like `start-manager`.

---

## Silent-failure findings — triage

From codex's 13 findings, here's what Phase 6 fixes (8) vs. defers (5):

**FIX:**
- F1 — `command_status` swallows terminal_capture_error (`commands.py:610`)
- F2 — `idle_summary` swallows capture error and falls back to stale transcript (`commands.py:670`)
- F3 — `wait_for_status_update` ignores failed capture (`commands.py:311`)
- F4 — `command_session_nudge` rollback swallow (`commands.py:1833`)
- F5 — `command_session_interrupt` rollback swallow (`commands.py:1880`)
- F6 — `parse_jsonl_events` skip-counters (`ingest.py:48`) — surface skipped malformed lines
- F7 — `read_events` skip-counters (`state.py:85`)
- F8 — `supervise_cycle` audit-write failure silent (`supervise_cycle.py:134`)

**DEFER:**
- `state.py:135` `latest_status` broad except — legacy code path, deemphasized post-Phase 5.
- `db.py:597` `sync_worker_ids_to_config_files` — edge case affecting few users.
- `core.py:21` + `db.py:1310` parse_iso duplicates — refactor work, not a bug. Better as its own consolidation phase.
- `supervise_cycle.py:106` rollback — already mitigated by audit-row write attempt.

---

## File Structure

**Modified:**
- `workerctl/ingest.py` — `parse_jsonl_events` returns events with embedded skip counters (or accepts a counter callback). `ingest_session` surfaces total skipped count in its return dict.
- `workerctl/state.py` — `read_events` returns/logs skipped line count.
- `workerctl/commands.py` — capture-error visibility for `command_status` / `idle_summary` / `wait_for_status_update`; rollback-failure attachment for `command_session_nudge` / `command_session_interrupt`.
- `workerctl/supervise_cycle.py` — surface audit-write failure (stderr + payload).
- `workerctl/cli.py` — new `start-worker` subparser; new `reconcile --stale-cycles-seconds N` flag.
- `tests/test_workerctl.py` — regression tests per fix.
- `README.md` — `start-worker` command + Phase 6 changes section.

**Created:**
- (Nothing new — Phase 6 is fixes + 1 command in existing files.)

---

## Task 1: Capture-error visibility in status / idle_summary / wait_for_status_update

**Files:**
- Modify: `workerctl/commands.py` — `command_status`, `idle_summary`, `wait_for_status_update`
- Test: `tests/test_workerctl.py`

The pattern across all three: `except WorkerError as exc:` followed by silent fallback to stale/missing data. Fix: preserve `capture_error` in the returned/printed payload so operators see what happened.

- [ ] **Step 1: Write failing tests**

Append to existing test class (or add new `CaptureErrorVisibilityTests`):

```python
class CaptureErrorVisibilityTests(unittest.TestCase):
    def test_idle_summary_marks_terminal_unknown_on_capture_failure(self):
        # Setup: register legacy worker, monkey-patch capture_output to raise WorkerError.
        # Verify idle_summary returns dict with `capture_error` field non-null AND
        # `terminal_fresh: false` (or equivalent) so callers know freshness is unknown.
        ...

    def test_command_status_includes_capture_error_in_output(self):
        # Same monkey-patch shape. Verify the printed JSON has `terminal_capture_error`
        # key with the error text. Currently swallowed.
        ...

    def test_wait_for_status_update_appends_failed_capture_event(self):
        # Verify the events table receives a `capture_failed` row with the error text
        # when capture raises during verification. Currently swallowed.
        ...
```

- [ ] **Step 2-N: Implement each fix**

For `command_status` (commands.py:610): the `except WorkerError as exc:` currently stores `capture_meta["error"]` but the print/output doesn't include it. Change the output dict to include `terminal_capture_error: <exc text>` at the top level.

For `idle_summary` (commands.py:670): when capture fails, the fallback reads stale transcript. Change the returned dict to include `capture_error: <text>` and set a `terminal_fresh: false` flag so the caller's `recommended_action` knows freshness is unknown.

For `wait_for_status_update` (commands.py:311): when capture fails inside the verify loop, write a `capture_failed` event with the error text BEFORE continuing the wait — so the audit log records what happened.

- [ ] **Step N+1: Commit**

```bash
git add workerctl/commands.py tests/test_workerctl.py
git commit -m "Phase 6 F1-F3: surface terminal capture errors in status/idle/wait"
```

---

## Task 2: Rollback-failure attachment in session-nudge / session-interrupt

**Files:**
- Modify: `workerctl/commands.py` (lines ~1833, ~1880)
- Test: `tests/test_workerctl.py`

When tmux raises, the inner `try: conn.rollback(); except Exception: pass` discards rollback errors before re-raising the original. If the rollback itself fails (DB lock contention, etc.), the operator never knows.

- [ ] **Step 1: Write failing tests**

Monkey-patch `conn.rollback` to raise. Verify the outer audit event still records the original tmux error AND attaches the rollback error in a `rollback_error` field of the payload.

- [ ] **Step 2: Implement**

Replace `except Exception: pass` with `except Exception as rollback_exc: rollback_error = str(rollback_exc)`. Then attach `rollback_error` to the failure-event payload alongside `error` and `error_type`.

- [ ] **Step 3: Commit**

```bash
git add workerctl/commands.py tests/test_workerctl.py
git commit -m "Phase 6 F4-F5: attach rollback failure to nudge/interrupt audit"
```

---

## Task 3: Malformed-line counters in parse_jsonl_events + read_events

**Files:**
- Modify: `workerctl/ingest.py` — `parse_jsonl_events`, `ingest_session`
- Modify: `workerctl/state.py` — `read_events` (if it has a similar pattern)
- Test: `tests/test_workerctl.py`

`parse_jsonl_events` silently skips malformed JSON / non-dict / non-string-type lines. Add a returned counter so `ingest_session` can surface it in cycle output.

- [ ] **Step 1: Decide the API shape**

Option A: `parse_jsonl_events` becomes a generator that yields events AND a final summary record (awkward).
Option B: `parse_jsonl_events` becomes a context object: `parser = JsonlEventStream(content, start_offset)`; `events = list(parser)`; `parser.skipped_count`. (Cleaner but larger refactor.)
Option C: `parse_jsonl_events` stays a generator; add a sibling helper `parse_jsonl_events_with_stats(content, start_offset) -> tuple[list, int]` that wraps it. Tracks skipped count.

Recommendation: **Option C** — minimal API change, parse_jsonl_events callers that don't care keep working. `ingest_session` switches to the new helper.

- [ ] **Step 2: Write failing test**

```python
def test_ingest_session_reports_skipped_malformed_lines(self):
    # Build a rollout with 2 valid events + 1 malformed JSON line + 1 valid event.
    # Run ingest_session. Assert result["skipped_lines"] == 1 (new field).
    ...
```

- [ ] **Step 3: Implement**

Add `parse_jsonl_events_with_stats(...)` returning `(list[event], skipped_count)`. Have `ingest_session` use it and include `skipped_lines` in the returned dict.

Update `run_cycle` to include `ingest.skipped_lines` in the cycle output JSON (small additive key — Phase 4's audit consumers already expect dict shape, this is forward-compatible).

For `read_events` (state.py:85): same pattern. Return tuple `(events, skipped_count)` or attach as a `.skipped` attribute on the returned list. The caller (`command_events`) should print the count to stderr or include it in JSON output.

- [ ] **Step 4: Commit**

```bash
git add workerctl/ingest.py workerctl/state.py workerctl/supervise_cycle.py tests/test_workerctl.py
git commit -m "Phase 6 F6-F7: report skipped malformed lines in ingest and read_events"
```

---

## Task 4: supervise_cycle audit-write failure visibility

**Files:**
- Modify: `workerctl/supervise_cycle.py` — the inner `try: ... except sqlite3.Error: pass` around the failed-cycle audit insert.

- [ ] **Step 1: Write failing test**

Monkey-patch the audit insert path to raise `sqlite3.OperationalError`. Verify the original exception still propagates AND the secondary failure is printed to stderr OR attached to the raised exception's args.

- [ ] **Step 2: Implement**

Replace `except sqlite3.Error: pass` with `except sqlite3.Error as audit_exc: print(f"workerctl: failed to record cycle failure audit: {audit_exc}", file=sys.stderr)`. Document in the docstring that the original exception is always preferred but secondary failures land on stderr.

- [ ] **Step 3: Commit**

```bash
git add workerctl/supervise_cycle.py tests/test_workerctl.py
git commit -m "Phase 6 F8: log supervise_cycle audit-write failure to stderr"
```

---

## Task 5: `workerctl start-worker` — spawn-and-register ergonomics

**Files:**
- Modify: `workerctl/commands.py` — new `command_start_worker(args)`.
- Modify: `workerctl/cli.py` — new subparser.
- Test: `tests/test_workerctl.py` — start-worker CLI tests.

The biggest UX gap: currently a user has to manually `tmux new-session` → `tmux send-keys "codex" Enter` → `pgrep` → `register-worker --pid <pid>`. I hit pid-discovery glitches twice during dogfood. `workerctl start-worker --name N --cwd D [--task "..."]` would do it all.

- [ ] **Step 1: Write failing test**

```python
class StartWorkerTests(unittest.TestCase):
    def test_start_worker_spawns_tmux_session_and_registers(self):
        # Use a mock codex script (a shell script that mimics codex's session_meta
        # write behavior) so the test doesn't need a real codex install.
        # Or: monkey-patch the tmux send-keys + lsof discovery paths.
        # Verify: tmux session exists with the expected name; sessions table has a
        # row with role='worker' and codex_session_path matching the fake rollout.
        ...

    def test_start_worker_fails_cleanly_if_tmux_session_already_exists(self):
        # Pre-create the tmux session. start-worker should refuse with WorkerError.
        ...

    def test_start_worker_fails_if_codex_doesnt_write_session_meta_within_timeout(self):
        # The discovery loop polls for the rollout file; should time out cleanly.
        ...
```

- [ ] **Step 2: Implement `command_start_worker`**

Logic:
1. Validate args (`name` doesn't conflict with existing session; `cwd` exists).
2. Build tmux session name: `codex-<name>` (matches existing convention).
3. Refuse if tmux session already exists.
4. `tmux new-session -d -s <session> -c <cwd> "codex <task_args>"` — codex runs as the only process in the session.
5. Poll for the native codex pid and its open rollout (with `--timeout-seconds` flag, default 15s):
   - `pgrep` for native codex children in the tmux session's process tree
   - `lsof` to find the rollout
   - First rollout matching `~/.codex/sessions/.../rollout-*.jsonl` opened by a codex pid spawned after the tmux session creation time wins.
6. Call the existing `_register_session_from_args` machinery (or reuse `register_session` directly).
7. Return JSON: `{session_id, name, role: 'worker', pid, codex_session_path, tmux_session, ...}`.

- [ ] **Step 3: Add the subparser**

```python
start_worker = subparsers.add_parser(
    "start-worker",
    help="Spawn a fresh codex session in a new tmux window and register it as a worker in one call.",
)
start_worker.add_argument("--name", required=True)
start_worker.add_argument("--cwd", default=str(INVOCATION_CWD))
start_worker.add_argument("--task", default=None, help="Initial task prompt to pass to codex.")
start_worker.add_argument("--sandbox", default="danger-full-access",
                          help="Codex sandbox mode (passed via --sandbox).")
start_worker.add_argument("--ask-for-approval", default="never",
                          help="Codex approval mode (passed via --ask-for-approval).")
start_worker.add_argument("--timeout-seconds", type=int, default=15,
                          help="Max seconds to wait for codex to write session_meta.")
start_worker.set_defaults(func=command_start_worker)
```

- [ ] **Step 4: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Phase 6 UX: add start-worker spawn-and-register command"
```

---

## Task 6: Configurable reconcile thresholds

**Files:**
- Modify: `workerctl/commands.py` — `collect_reconcile_report`, `apply_reconcile`, `command_reconcile`.
- Modify: `workerctl/cli.py` — `--stale-cycles-seconds` flag.
- Test: `tests/test_workerctl.py` — threshold-overridden test.

Currently `collect_reconcile_report` hardcodes `age > 3600` for stuck-task detection. Make it a parameter.

- [ ] **Step 1: Add threshold parameter**

```python
def collect_reconcile_report(
    conn: sqlite3.Connection,
    *,
    stale_cycles_seconds: float = 3600.0,
) -> dict:
    ...
    if age > stale_cycles_seconds:
        stuck_tasks.append(...)
```

`apply_reconcile` takes the same parameter and passes through.

- [ ] **Step 2: Add CLI flag**

```python
reconcile.add_argument(
    "--stale-cycles-seconds", type=float, default=3600.0,
    help="Threshold (seconds) for a cycle to count as stale. Default 3600 (1h).",
)
```

`command_reconcile` passes `args.stale_cycles_seconds` to the helper.

- [ ] **Step 3: Write test**

```python
def test_reconcile_threshold_override(self):
    # Build a task with a manager_cycles row 100 seconds old.
    # Default threshold (3600): not stuck.
    # With --stale-cycles-seconds 50: stuck.
    ...
```

- [ ] **Step 4: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Phase 6 UX: configurable reconcile stale-cycles threshold"
```

---

## Task 7: README updates

**Files:**
- Modify: `README.md`

Add to the Commands → Sessions section:
- `start-worker --name N [--cwd D] [--task T] [--timeout-seconds N]` — spawn-and-register ergonomic

Add to the Commands → Administration section:
- Note the new `--stale-cycles-seconds` flag on `reconcile`.

Add a "Changes in Phase 6" section near the bottom (optional — short list of fixes).

- [ ] **Step 1: Update README**
- [ ] **Step 2: Verify** `workerctl start-worker --help` and `workerctl reconcile --help` match the docs.
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Phase 6: document start-worker and reconcile threshold"
```

---

## Self-Review

**Spec coverage:**
- Silent-failure F1-F3 (capture errors) → Task 1 ✓
- Silent-failure F4-F5 (rollback) → Task 2 ✓
- Silent-failure F6-F7 (skip counters) → Task 3 ✓
- Silent-failure F8 (audit-write) → Task 4 ✓
- UX: spawn-and-register → Task 5 ✓
- UX: configurable reconcile → Task 6 ✓
- README → Task 7 ✓

**Placeholder scan:** Task 5's tmux-spawn detail is the only step with "use judgment" — the polling-for-rollout discovery loop is structurally similar to the dogfood pid-discovery I did by hand. Reference patterns: how the dogfood test discovered the worker pid (`pgrep -f "vendor.*codex/codex"` + `lsof | grep rollout`).

**Type consistency:** No new types. `parse_jsonl_events_with_stats` returns `tuple[list[dict], int]` — clear shape, no TypedDict needed. `ingest_session` return dict gets one new `skipped_lines: int` key. `command_reconcile` JSON output gets `stale_cycles_seconds: float` echoed in the report header.

**Known caveats:**
- Task 3's API decision (sibling helper vs. refactor) is presented as Option A/B/C. Recommendation: C. Implementer can deviate if a cleaner shape emerges.
- Task 5's `start-worker` needs to work without a mocked codex; tests use real `tmux new-session` but fake the codex command (a shell script that writes a session_meta-shaped rollout to disk).
- The 5 deferred findings are documented above; future Phase 7+ can revisit if real impact surfaces.
