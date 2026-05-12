# Manual-Assignment Redesign — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich every `cycle` observation with a shadow signal from the legacy pane-pattern classifier (`classify_busy_wait`). This gives the manager Codex (and operators) visibility into both the JSON-derived state (busy/idle/unknown) and any notable pane pattern (`enter_to_confirm`, `trust_prompt`, `rate_limit_prompt`, etc.) in a single observation. Add a `workerctl divergences <task>` query so operators can audit, across the shadow period, which cycles surfaced a pane pattern.

**Architecture:** Two signals were always going to coexist after the redesign:
- **JSON state** (Phase 2-3): `busy` / `idle` / `unknown` from `event_msg` subtypes. Turn-level. Reliable, structured.
- **Pane pattern** (legacy, here resurrected): a side-effect detector that finds specific stuck-prompt strings in the rendered tmux pane (mcp startup, trust prompt, approval prompt, etc.). Catches stuck states JSON cannot see.

Phase 4 collects both signals into every `manager_cycles` row, exposes them in cycle output, surfaces pane patterns in replay summaries, and adds a query for "give me cycles where the pane saw something notable." Existing legacy `supervise` / `watch` / `classify_busy_wait` callers are untouched. The actual retirement (deciding which signal "wins" by default in the legacy paths) is Phase 5's job.

**Tech Stack:** Python 3, SQLite (WAL), `unittest`, stdlib only. No new third-party deps. Reuses Phase 1's `session_row`, Phase 2's `current_state` / `session_staleness_seconds`, Phase 3's `run_cycle`, and the legacy `classify.classify_busy_wait` + `tmux.capture_tmux_target` primitives.

**Scope note:** Phase 4 only. Out of scope: any change to legacy `supervise.py` / `watch` / `classify_busy_wait` callers; retirement of `promote` / `manage` / `become-worker` (Phase 5); a continuous shadow daemon; reading legacy worker `status.json` files (we use Phase 2 staleness as the age proxy).

---

## File Structure

**Created:**
- `workerctl/shadow_state.py` — pure-ish library. One function: `pane_signal_for_session(conn, *, session_id, busy_wait_seconds=90, now=None) -> dict`. ~70 lines.

**Modified:**
- `workerctl/supervise_cycle.py` — `run_cycle` calls `pane_signal_for_session` (best-effort, swallows tmux/classifier errors) and adds `pane_signal` + `notable_pane_pattern` to `status_payload`. Update docstring's "stable keys" list.
- `workerctl/replay.py` — when rendering a successful `session_cycle` row, append `[pane pattern: <pattern_id>]` to the summary if `notable_pane_pattern` is set.
- `workerctl/db.py` — one new helper `divergent_cycles_for_task(conn, *, task_name, limit=50)` that returns successful manager_cycles rows where `status_json.notable_pane_pattern` is not NULL.
- `workerctl/commands.py` — `command_divergences`.
- `workerctl/cli.py` — wire `divergences` subparser.
- `tests/test_workerctl.py` — append `ShadowStateTests`, extend `SuperviseCycleTests`, append `DivergencesCliTests`.
- `README.md` — Phase 4 subsection inside the existing Manual-Assignment Primitives section.

**Not touched:**
- `workerctl/supervise.py`, `workerctl/lifecycle.py`, `workerctl/classify.py` (we *call* `classify_busy_wait` but don't modify it), legacy `supervise` / `watch` / `promote` / `manage` paths.

---

## Task 1: `pane_signal_for_session` in new `workerctl/shadow_state.py`

**Files:**
- Create: `workerctl/shadow_state.py`
- Test: `tests/test_workerctl.py` — append `ShadowStateTests` class.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class ShadowStateTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _register_with_tmux(self, conn, **overrides):
        kwargs = {
            "name": "w", "role": "worker",
            "codex_session_path": "/a", "codex_session_id": "u", "pid": 1, "cwd": "/repo",
            "tmux_session": "codex-w", "tmux_pane_id": "%5",
        }
        kwargs.update(overrides)
        return worker_db.register_session(conn, **kwargs)

    def test_pane_signal_for_session_returns_no_tmux_when_unattached(self):
        from workerctl import shadow_state

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/a", codex_session_id="u", pid=1, cwd="/repo",
            )
            result = shadow_state.pane_signal_for_session(
                conn, session_id=session_id,
            )
            self.assertEqual(result["captured"], False)
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])
            self.assertEqual(result["reason"], "no tmux session attached")

    def test_pane_signal_for_session_captures_and_runs_classifier(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)

            # Stub the capture to return text matching the trust-prompt pattern.
            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            self.assertIsNotNone(result["classifier"])
            self.assertEqual(result["notable_pattern"], "trust_prompt")
            self.assertIn("trust", result["classifier"]["reason"].lower())

    def test_pane_signal_for_session_no_pattern_returns_classifier_none(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100: "$ codex\nready and typing...\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])

    def test_pane_signal_for_session_swallows_tmux_capture_error(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            session_id = worker_db.session_row(conn, name="w")["id"]

            original = worker_tmux.capture_tmux_target

            def boom(target, lines=100):
                raise RuntimeError("tmux died")

            worker_tmux.capture_tmux_target = boom
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            # Best-effort: a capture failure should NOT raise; it should be reported
            # in the result so callers (run_cycle) can surface it without aborting.
            self.assertEqual(result["captured"], False)
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])
            self.assertIn("tmux died", result["reason"])

    def test_pane_signal_for_session_uses_staleness_as_status_age(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)
            # Insert a state-bearing event 200 seconds before `now`.
            worker_db.insert_codex_event(
                conn, session_id=session_id,
                timestamp="2026-05-11T14:30:00Z",
                event_type="event_msg", subtype="task_started",
                payload={}, byte_offset=0,
            )

            original = worker_tmux.capture_tmux_target
            # Pane shows "esc to interrupt" — only fires the `long_running_interruptible`
            # pattern when status_age >= busy_wait_seconds. With staleness=200s and
            # threshold=90s, the pattern should fire.
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100: "running tests... esc to interrupt\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn,
                    session_id=session_id,
                    busy_wait_seconds=90,
                    now="2026-05-11T14:33:20Z",  # 200s after the event
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            self.assertEqual(result["notable_pattern"], "long_running_interruptible")
            self.assertEqual(result["status_age_seconds"], 200)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.ShadowStateTests -v
```
Expected: 5 tests FAIL with `ModuleNotFoundError: No module named 'workerctl.shadow_state'`.

- [ ] **Step 3: Create the module**

Create `workerctl/shadow_state.py`:

```python
from __future__ import annotations

import sqlite3
from typing import Any

from workerctl import classify as worker_classify
from workerctl import db as worker_db
from workerctl import ingest as worker_ingest
from workerctl import tmux as worker_tmux


DEFAULT_BUSY_WAIT_SECONDS = 90


def pane_signal_for_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    busy_wait_seconds: int = DEFAULT_BUSY_WAIT_SECONDS,
    now: str | None = None,
) -> dict[str, Any]:
    """Capture the session's tmux pane and run `classify_busy_wait` on the text.

    Returns a dict with stable keys:
      - `captured` (bool): whether the tmux capture succeeded.
      - `classifier` (dict | None): the raw output of `classify_busy_wait` if a
        pattern matched, else None.
      - `notable_pattern` (str | None): the `pattern` key from `classifier` for
        easy filtering, else None.
      - `status_age_seconds` (int | None): the staleness used as the classifier's
        `status_age` argument (Phase 2 JSON staleness, rounded to int seconds).
      - `reason` (str | None): a short message when `captured=False`, explaining
        why (e.g. "no tmux session attached", "<exception text>").

    This function is best-effort: tmux capture exceptions are caught and surfaced
    in `reason` rather than raised. The caller (e.g. `supervise_cycle.run_cycle`)
    should be able to enrich a cycle with a pane signal without aborting on a
    transient tmux failure.
    """
    row = worker_db.session_row(conn, name_or_id_lookup(conn, session_id))
    # Note: session_row takes name; we have id. Use a direct lookup instead.
    row = conn.execute(
        "select * from sessions where id = ?", (session_id,)
    ).fetchone()
    if row is None:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"unknown session id {session_id!r}",
        }

    if not row["tmux_session"]:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": "no tmux session attached",
        }

    target = worker_tmux.session_tmux_target(row)
    try:
        output = worker_tmux.capture_tmux_target(target)
    except Exception as exc:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"tmux capture failed: {exc}",
        }

    staleness = worker_ingest.session_staleness_seconds(
        conn, session_id=session_id, now=now,
    )
    status_age_seconds = int(staleness) if staleness is not None else None
    classifier = worker_classify.classify_busy_wait(
        output, status_age_seconds, busy_wait_seconds,
    )
    return {
        "captured": True,
        "classifier": classifier,
        "notable_pattern": classifier["pattern"] if classifier else None,
        "status_age_seconds": status_age_seconds,
        "reason": None,
    }


def name_or_id_lookup(conn, session_id):
    """Placeholder — not used. Remove before commit."""
    return None
```

Wait — the first `worker_db.session_row(conn, name=...)` call doesn't work because `session_row` takes name, not id. Replace the function body with the direct id-based query as shown after the `# Note:` comment, and delete the broken `name_or_id_lookup` placeholder. The clean version of the function body should be exactly:

```python
def pane_signal_for_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    busy_wait_seconds: int = DEFAULT_BUSY_WAIT_SECONDS,
    now: str | None = None,
) -> dict[str, Any]:
    """... (same docstring as above) ..."""
    row = conn.execute(
        "select * from sessions where id = ?", (session_id,)
    ).fetchone()
    if row is None:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"unknown session id {session_id!r}",
        }
    if not row["tmux_session"]:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": "no tmux session attached",
        }
    target = worker_tmux.session_tmux_target(row)
    try:
        output = worker_tmux.capture_tmux_target(target)
    except Exception as exc:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"tmux capture failed: {exc}",
        }
    staleness = worker_ingest.session_staleness_seconds(
        conn, session_id=session_id, now=now,
    )
    status_age_seconds = int(staleness) if staleness is not None else None
    classifier = worker_classify.classify_busy_wait(
        output, status_age_seconds, busy_wait_seconds,
    )
    return {
        "captured": True,
        "classifier": classifier,
        "notable_pattern": classifier["pattern"] if classifier else None,
        "status_age_seconds": status_age_seconds,
        "reason": None,
    }
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.ShadowStateTests -v
```
Expected: 5 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 259 tests (254 + 5).

- [ ] **Step 6: Commit**

```bash
git add workerctl/shadow_state.py tests/test_workerctl.py
git commit -m "Add pane_signal_for_session: shadow pane-pattern signal for sessions"
```

---

## Task 2: Extend `run_cycle` to include the pane signal

**Files:**
- Modify: `workerctl/supervise_cycle.py` — call `pane_signal_for_session`, include in status_payload.
- Test: `tests/test_workerctl.py` — append to `SuperviseCycleTests`.

- [ ] **Step 1: Write failing tests**

Append to `SuperviseCycleTests` in `tests/test_workerctl.py`:

```python
    def test_run_cycle_includes_pane_signal_when_tmux_attached(self):
        from workerctl import supervise_cycle
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Register worker with tmux_session populated so pane signal can resolve.
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text("".join(json.dumps(e) + "\n" for e in [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started"}},
            ]))
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u-w", pid=1, cwd="/r",
                tmux_session="codex-w", tmux_pane_id="%5",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path=str(rollout),
                codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()

            # Stub the pane capture to return a trust-prompt-bearing string.
            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result = supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:32:15Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["state"], "busy")
            self.assertEqual(result["notable_pane_pattern"], "trust_prompt")
            self.assertIsNotNone(result["pane_signal"])
            self.assertEqual(result["pane_signal"]["captured"], True)
            self.assertEqual(result["pane_signal"]["notable_pattern"], "trust_prompt")

    def test_run_cycle_pane_signal_none_when_session_has_no_tmux(self):
        """Manager-style sessions registered without --tmux-session should yield
        a non-captured pane_signal but the cycle still succeeds with JSON state."""
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            # _setup_bound_task registers worker WITHOUT tmux_session.
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["state"], "idle")
            self.assertIsNone(result["notable_pane_pattern"])
            self.assertIsNotNone(result["pane_signal"])
            self.assertEqual(result["pane_signal"]["captured"], False)
            self.assertEqual(result["pane_signal"]["reason"], "no tmux session attached")

    def test_run_cycle_pane_signal_swallows_capture_errors(self):
        """A tmux capture exception must not abort the cycle."""
        from workerctl import supervise_cycle
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Re-use _setup_bound_task but then patch the worker session row to
            # add a tmux_session, so pane_signal tries to capture.
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            conn.execute(
                "update sessions set tmux_session = 'codex-w', tmux_pane_id = '%5' "
                "where name = 'w'"
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target

            def boom(target, lines=100):
                raise RuntimeError("tmux server went away")

            worker_tmux.capture_tmux_target = boom
            try:
                result = supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:33:00Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["state"], "idle")
            self.assertEqual(result["pane_signal"]["captured"], False)
            self.assertIn("tmux server went away", result["pane_signal"]["reason"])
            self.assertIsNone(result["notable_pane_pattern"])
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests -v
```
Expected: 3 new tests FAIL with `KeyError: 'pane_signal'` or similar (the keys don't exist yet).

- [ ] **Step 3: Wire `pane_signal_for_session` into `run_cycle`**

In `workerctl/supervise_cycle.py`:

1. Add the import near the top with the other module imports:
```python
from workerctl import shadow_state as worker_shadow
```

2. Inside `run_cycle`, AFTER the staleness/state/last_state_event_at calls and BEFORE the success-path `status_payload` is built, add:

```python
    # Phase 4 shadow signal — best-effort pane-pattern detection alongside the
    # JSON state. Wrapped in try/except so any classifier or capture failure does
    # not abort the cycle (the pane signal is supplementary, not load-bearing).
    try:
        pane_signal = worker_shadow.pane_signal_for_session(
            conn,
            session_id=binding["worker_session_id"],
            now=started_at,
        )
    except Exception as exc:  # pragma: no cover — defensive belt-and-suspenders
        pane_signal = {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"pane_signal_for_session raised: {exc}",
        }
    notable_pane_pattern = pane_signal.get("notable_pattern")
```

3. Update the success-path `status_payload` dict to include the two new keys (sort alphabetically inside the dict, but the order doesn't matter for `json.dumps(sort_keys=True)`):

```python
    status_payload = {
        "kind": "session_cycle",
        "task": task_name,
        "binding_id": binding["binding_id"],
        "worker_session": binding["worker_session_name"],
        "manager_session": binding["manager_session_name"],
        "ingest": ingest_result,
        "state": state,
        "last_state_event_at": last_state_event_at,
        "staleness_seconds": staleness,
        "pane_signal": pane_signal,
        "notable_pane_pattern": notable_pane_pattern,
    }
```

4. Update the docstring's "stable keys" enumeration to include `pane_signal` and `notable_pane_pattern`. Add a line: *"`pane_signal` is a best-effort shadow signal from `classify_busy_wait` against the worker's tmux pane (None-shaped when no tmux session is attached or capture failed). `notable_pane_pattern` is a top-level shortcut to `pane_signal['notable_pattern']` for easy filtering and replay-summary rendering."*

5. Do NOT add the pane signal to the FAILURE-path `failure_status` payload. The failure path runs after an exception; the shadow signal collection isn't reliable at that point and isn't useful (the cycle failed for an ingest reason, not a pane reason).

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests -v
```
Expected: 11 tests PASS (8 existing + 3 new).

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 262 tests (259 + 3).

- [ ] **Step 6: Commit**

```bash
git add workerctl/supervise_cycle.py tests/test_workerctl.py
git commit -m "Include pane_signal and notable_pane_pattern in run_cycle output"
```

---

## Task 3: `replay.py` extension — surface notable pane pattern

**Files:**
- Modify: `workerctl/replay.py`
- Test: `tests/test_workerctl.py` — append to `SuperviseCycleTests`.

- [ ] **Step 1: Write failing test**

Append to `SuperviseCycleTests`:

```python
    def test_replay_renders_session_cycle_with_pane_pattern(self):
        """When a successful cycle has a notable_pane_pattern, the replay summary
        should mention it for operator visibility during the shadow period."""
        from workerctl import supervise_cycle
        from workerctl import replay as worker_replay
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started"}},
            ])
            conn.execute(
                "update sessions set tmux_session = 'codex-w', tmux_pane_id = '%5' "
                "where name = 'w'"
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:32:15Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            audit = worker_db.task_audit(conn, task="t")
            entries = list(worker_replay.replay_entries(audit))
            cycle_summaries = [
                e.get("summary", "")
                for e in entries
                if e.get("kind") == "observe"
            ]
            joined = " | ".join(cycle_summaries)
            self.assertIn("trust_prompt", joined,
                          f"replay did not surface pane pattern: {cycle_summaries!r}")
            self.assertIn("busy", joined.lower())
```

- [ ] **Step 2: Run test to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests.test_replay_renders_session_cycle_with_pane_pattern -v
```
Expected: FAIL — pane pattern not yet in the replay summary.

- [ ] **Step 3: Update replay summary builder**

Read `workerctl/replay.py` first (`grep -n "session_cycle\|notable_pane\|observe failed" workerctl/replay.py`) to find the existing session_cycle branch.

In the `kind == "session_cycle"` branch's *success* path (after the failed-error check), modify the summary so it appends a pattern note when one is present. The exact existing code may differ; the conceptual change is:

```python
        # success path of session_cycle branch
        state = status.get("state") or "unknown"
        worker_session = status.get("worker_session") or "<unknown>"
        staleness = status.get("staleness_seconds")
        notable = status.get("notable_pane_pattern")
        if staleness is not None:
            summary = f"observed session {worker_session} state {state} (staleness {staleness:.1f}s)"
        else:
            summary = f"observed session {worker_session} state {state}"
        if notable:
            summary += f" [pane pattern: {notable}]"
```

If the existing structure uses different variable names or layout, adapt — but the user-visible output must include `[pane pattern: trust_prompt]` (or similar) when `status.notable_pane_pattern` is set.

- [ ] **Step 4: Run test**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests.test_replay_renders_session_cycle_with_pane_pattern -v
```
Expected: PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 263 tests (262 + 1).

- [ ] **Step 6: Commit**

```bash
git add workerctl/replay.py tests/test_workerctl.py
git commit -m "Surface notable_pane_pattern in session_cycle replay summary"
```

---

## Task 4: `divergent_cycles_for_task` DB helper

**Files:**
- Modify: `workerctl/db.py` — add helper near `active_binding_for_task` or near other manager_cycles helpers.
- Test: `tests/test_workerctl.py` — new test class `DivergencesTests`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class DivergencesTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _insert_task(self, conn, task_id="task-1", task_name="t"):
        now = "2026-05-11T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values (?, ?, 'g', 'candidate', ?, ?)",
            (task_id, task_name, now, now),
        )
        return task_id

    def _insert_cycle(self, conn, *, task_id, status_payload, state="succeeded", error=None):
        now = "2026-05-11T00:00:00Z"
        cursor = conn.execute(
            """
            insert into manager_cycles(
              task_id, started_at, completed_at, state, status_json, error
            )
            values (?, ?, ?, ?, ?, ?)
            """,
            (task_id, now, now, state,
             json.dumps(status_payload, sort_keys=True, default=str), error),
        )
        return int(cursor.lastrowid)

    def test_divergent_cycles_for_task_returns_only_cycles_with_pane_pattern(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            # Cycle 1: no pane pattern → should NOT appear.
            self._insert_cycle(conn, task_id=task_id, status_payload={
                "kind": "session_cycle",
                "task": "t",
                "state": "busy",
                "notable_pane_pattern": None,
            })
            # Cycle 2: pane pattern present → SHOULD appear.
            cycle_id_2 = self._insert_cycle(conn, task_id=task_id, status_payload={
                "kind": "session_cycle",
                "task": "t",
                "state": "busy",
                "notable_pane_pattern": "trust_prompt",
            })
            # Cycle 3: failed cycle (no pane pattern field at all) → should NOT appear.
            self._insert_cycle(
                conn, task_id=task_id,
                status_payload={"kind": "session_cycle", "task": "t"},
                state="failed", error="boom",
            )
            conn.commit()

            rows = worker_db.divergent_cycles_for_task(conn, task_name="t")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], cycle_id_2)
            self.assertEqual(rows[0]["notable_pane_pattern"], "trust_prompt")

    def test_divergent_cycles_for_task_orders_newest_first(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            ids = []
            for pattern in ["enter_to_confirm", "trust_prompt", "rate_limit_prompt"]:
                ids.append(self._insert_cycle(conn, task_id=task_id, status_payload={
                    "kind": "session_cycle",
                    "task": "t",
                    "notable_pane_pattern": pattern,
                }))
            conn.commit()

            rows = worker_db.divergent_cycles_for_task(conn, task_name="t")
            row_ids = [r["id"] for r in rows]
            self.assertEqual(row_ids, list(reversed(ids)))

    def test_divergent_cycles_for_task_raises_on_unknown_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(WorkerError):
                worker_db.divergent_cycles_for_task(conn, task_name="missing")

    def test_divergent_cycles_for_task_respects_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            for i in range(5):
                self._insert_cycle(conn, task_id=task_id, status_payload={
                    "kind": "session_cycle",
                    "task": "t",
                    "notable_pane_pattern": "trust_prompt",
                })
            conn.commit()
            rows = worker_db.divergent_cycles_for_task(conn, task_name="t", limit=2)
            self.assertEqual(len(rows), 2)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.DivergencesTests -v
```
Expected: 4 tests FAIL with `AttributeError`.

- [ ] **Step 3: Implement the helper**

In `workerctl/db.py`, after `active_binding_for_task` (find with `grep -n "def active_binding_for_task" workerctl/db.py`), add:

```python
def divergent_cycles_for_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return successful Phase 3 cycle rows where the shadow pane signal flagged
    a notable pattern (`notable_pane_pattern` is non-null in `status_json`).

    Returns a list of dicts with keys: `id`, `task_id`, `started_at`,
    `completed_at`, `state`, `notable_pane_pattern`, `status` (parsed status_json).
    Ordered newest-first, capped at `limit`.

    Raises WorkerError if `task_name` is unknown. Failed cycles are excluded
    (they don't carry a notable_pane_pattern field — see supervise_cycle.run_cycle).
    """
    task = task_row(conn, task=task_name)
    rows = conn.execute(
        """
        select
          id, task_id, started_at, completed_at, state, status_json,
          json_extract(status_json, '$.notable_pane_pattern') as notable_pane_pattern
        from manager_cycles
        where task_id = ?
          and state = 'succeeded'
          and json_extract(status_json, '$.notable_pane_pattern') is not null
        order by id desc
        limit ?
        """,
        (task["id"], limit),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "task_id": r["task_id"],
            "started_at": r["started_at"],
            "completed_at": r["completed_at"],
            "state": r["state"],
            "notable_pane_pattern": r["notable_pane_pattern"],
            "status": json.loads(r["status_json"]),
        }
        for r in rows
    ]
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.DivergencesTests -v
```
Expected: 4 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 267 tests (263 + 4).

- [ ] **Step 6: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add divergent_cycles_for_task DB helper"
```

---

## Task 5: CLI `divergences <task>`

**Files:**
- Modify: `workerctl/commands.py` — add `command_divergences`.
- Modify: `workerctl/cli.py` — wire subparser.
- Test: `tests/test_workerctl.py` — append `DivergencesCliTests`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class DivergencesCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def test_cli_divergences_returns_cycles_with_pane_patterns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
            db_path = state_dir / "workerctl.db"

            # Build the DB by running workerctl through the CLI so initialize_database
            # runs and we use real DB plumbing.
            self.run_cli("sessions", env_extra=env)  # touches initialize_database

            # Inject a task and two cycles directly: one with a pane pattern, one without.
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'mytask', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            for pattern in [None, "trust_prompt"]:
                conn.execute(
                    """
                    insert into manager_cycles(
                      task_id, started_at, completed_at, state, status_json
                    )
                    values ('task-1', ?, ?, 'succeeded', ?)
                    """,
                    (now, now, json.dumps({
                        "kind": "session_cycle",
                        "task": "mytask",
                        "notable_pane_pattern": pattern,
                    }, sort_keys=True)),
                )
            conn.commit()

            proc = self.run_cli("divergences", "mytask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["notable_pane_pattern"], "trust_prompt")

    def test_cli_divergences_unknown_task_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            proc = self.run_cli(
                "divergences", "no-such-task",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)

    def test_cli_divergences_empty_when_no_pane_patterns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
            self.run_cli("sessions", env_extra=env)
            db_path = state_dir / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'mytask', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            conn.execute(
                """
                insert into manager_cycles(
                  task_id, started_at, completed_at, state, status_json
                )
                values ('task-1', ?, ?, 'succeeded', ?)
                """,
                (now, now, json.dumps({
                    "kind": "session_cycle",
                    "task": "mytask",
                    "notable_pane_pattern": None,
                }, sort_keys=True)),
            )
            conn.commit()

            proc = self.run_cli("divergences", "mytask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout), [])
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.DivergencesCliTests -v
```
Expected: 3 tests FAIL — unknown subcommand `divergences`.

- [ ] **Step 3: Add `command_divergences` to `workerctl/commands.py`**

Append (place near `command_cycle`):

```python
def command_divergences(args: argparse.Namespace) -> int:
    """List Phase 4 cycle observations where the shadow pane signal flagged a pattern.

    Output is a JSON list. Each entry has stable keys: `id`, `task_id`,
    `started_at`, `completed_at`, `state`, `notable_pane_pattern`, `status` (the
    parsed cycle status). Newest first, capped by `--limit` (default 50).
    """
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        rows = worker_db.divergent_cycles_for_task(
            conn, task_name=args.task, limit=args.limit,
        )
    finally:
        conn.close()
    print(json.dumps(rows, indent=2, sort_keys=True, default=str))
    return 0
```

- [ ] **Step 4: Wire the subparser in `workerctl/cli.py`**

Add `command_divergences` to the import block.

After the `cycle` subparser (Phase 3 Task 6), add:

```python
    divergences = subparsers.add_parser(
        "divergences",
        help="List cycle observations where the shadow pane signal flagged a notable pattern.",
    )
    divergences.add_argument("task", help="Task name.")
    divergences.add_argument("--limit", type=int, default=50, help="Max rows to return.")
    divergences.set_defaults(func=command_divergences)
```

- [ ] **Step 5: Run CLI tests**

```bash
python3 -m unittest tests.test_workerctl.DivergencesCliTests -v
```
Expected: 3 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 270 tests (267 + 3).

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add divergences CLI command"
```

---

## Task 6: README docs for Phase 4

**Files:**
- Modify: `README.md` — add `### Phase 4:` subsection inside the existing `## Manual-Assignment Primitives (Phase 1)` section.

- [ ] **Step 1: Verify CLI shapes**

```bash
python3 -m workerctl cycle --help
python3 -m workerctl divergences --help
```
Confirm the example commands in the README match the real flags.

- [ ] **Step 2: Add Phase 4 subsection to README**

In `README.md`, find the existing `### Phase 3: Observation Cycles + Session Actions` subsection. After it ends and before the next `##` heading, insert:

````markdown
### Phase 4: Shadow Pane Signal + Divergences

Every `cycle` invocation now also captures the worker's tmux pane (if attached)
and runs the legacy `classify_busy_wait` pattern detector. The results are
included in the cycle output as `pane_signal` and (for easy filtering)
`notable_pane_pattern`. The JSON state remains the primary signal; the pane
signal is supplementary — it surfaces stuck-prompt conditions (trust prompt,
rate-limit prompt, approval prompt, etc.) that the JSON event stream cannot see.

```bash
# A cycle with a notable pane pattern looks like:
workerctl cycle auth-refactor
# {
#   "kind": "session_cycle",
#   "task": "auth-refactor",
#   "state": "busy",
#   "notable_pane_pattern": "trust_prompt",
#   "pane_signal": {
#     "captured": true,
#     "classifier": {
#       "pattern": "trust_prompt",
#       "reason": "terminal is waiting for workspace trust confirmation",
#       "recommended_action": "inspect_or_accept_trust"
#     },
#     "notable_pattern": "trust_prompt",
#     "status_age_seconds": 4,
#     "reason": null
#   },
#   ...
# }

# A session without a tmux pane (e.g. a manager outside tmux) yields a clean
# non-captured signal — the cycle still succeeds with the JSON state:
# "pane_signal": { "captured": false, "reason": "no tmux session attached", ... }

# Audit divergences during the shadow period:
workerctl divergences auth-refactor
workerctl divergences auth-refactor --limit 5
```

**What counts as a "divergence"?** Currently: any cycle whose pane signal flagged
a pattern at all (`notable_pane_pattern` is non-null). This catches stuck-prompt
states the JSON stream cannot detect. The `divergences` command returns those
cycles newest-first along with their full `status_json` payload, so an operator
can decide whether the pane signal was right and the worker needed intervention.

**Operational shape.** A manager Codex driving supervision continues to consume
`workerctl cycle` as its primary observation. It can now also branch on
`notable_pane_pattern` — e.g., if the pattern is `trust_prompt`, the manager
might send a confirmation via `session-nudge` rather than waiting on
`staleness_seconds`. The shadow signal is best-effort: tmux capture failures are
caught and reported in `pane_signal.reason` rather than aborting the cycle.

**Replay parity.** `workerctl replay <task>` and `workerctl audit <task>` both
surface `[pane pattern: <pattern_id>]` in the rendered cycle summary when a
pattern was detected — so historical pattern occurrences are easy to scan
through the same audit surfaces used in Phase 2-3.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document Phase 4 shadow pane signal and divergences command"
```

---

## Self-Review

**Spec coverage:**
- `pane_signal_for_session` helper → Task 1 ✓
- Cycle output enriched with `pane_signal` + `notable_pane_pattern` → Task 2 ✓
- Replay summary surfaces pattern → Task 3 ✓
- `divergent_cycles_for_task` DB helper → Task 4 ✓
- CLI `divergences <task>` → Task 5 ✓
- README docs → Task 6 ✓

**Placeholder scan:** every step has full code; no TBDs.

**Type consistency:**
- `pane_signal_for_session` returns dict with keys `captured`, `classifier`, `notable_pattern`, `status_age_seconds`, `reason` (Task 1) → consumed by `run_cycle` reading `notable_pattern` to set `notable_pane_pattern` (Task 2) ✓
- `run_cycle` returns dict including `pane_signal` and `notable_pane_pattern` (Task 2) → replay reads `status.notable_pane_pattern` (Task 3) ✓
- `divergent_cycles_for_task` returns list of dicts with `id`, `task_id`, `started_at`, `completed_at`, `state`, `notable_pane_pattern`, `status` (Task 4) → CLI prints as-is (Task 5); tests assert on `notable_pane_pattern` and `len(rows)` ✓

**No schema migration.** Phase 4 stores everything in `manager_cycles.status_json` (already JSON-validated; queried via `json_extract`). No new tables; no new columns. No `SCHEMA_VERSION` bump.

**Known caveats:**
- Task 1 uses `session_staleness_seconds` (Phase 2 JSON-event-derived) as the `status_age` argument to `classify_busy_wait`. The legacy `classify_busy_wait` was historically called with `status_age` from worker `status.json` mtime. The two are different sources but morally equivalent: "how long since the worker did something." For sessions that don't yet have `codex_events` ingested (`staleness_seconds is None`), the classifier still runs all its pattern checks (they only depend on the pane text); only the `long_running_interruptible` pattern needs a numeric age and is silently skipped — acceptable for the shadow phase.
- Task 4's `divergent_cycles_for_task` excludes failed cycles. Failed cycles don't carry a `notable_pane_pattern` field (the failure path in `run_cycle` runs before the shadow signal is collected). Documented in the helper docstring.
- Task 5's CLI `divergences` test seeds `manager_cycles` directly via SQL rather than running real cycles. This is intentional — a true end-to-end test would require both a live rollout file and a stubbed `capture_tmux_target`, which is overkill for asserting the CLI surface.

---

## Out of Scope (deferred to Phase 5)

- **Retiring `promote` / `manage` / `become-worker` / legacy `supervise` / `watch`.** Phase 4 leaves all legacy paths untouched.
- **"Flipping" the primary signal.** The cycle output already lists JSON `state` first; a manager Codex can already act on JSON state and use the pane signal as confirmation. There is no single "primary" supervise loop to flip — Phase 5 will retire the legacy supervise loop, at which point only the new path exists.
- **Trimming `workerctl/tmux.py`** to the PTY+keys+capture primitives needed by `send_text_to_session` / `interrupt_session` / `pane_signal_for_session`.
- **Collapsing `recover` / `reconcile` / `db-doctor` / `close-stale`** into one DB-centric reconciliation command.
- **Reading legacy worker `status.json`** files for backfilled sessions. Phase 4 uses JSON-event staleness only.
- **A continuous shadow daemon.** Phase 4's shadow is per-cycle (driven by the manager Codex calling `cycle` repeatedly), consistent with the Phase 3 architecture.
