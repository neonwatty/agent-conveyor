# Phase 8 Implementation Plan

**Goal:** Close ergonomic + signal-quality gaps surfaced during the Phase 7 dogfood round.

**Architecture:** Four focused additions to existing modules — no new subsystems. Each task touches 1–3 files plus tests plus README; each ships as one commit.

**Tech stack:** Python 3 / SQLite / argparse / unittest (existing).

---

## Dogfood findings driving Phase 8

During the Phase 7 dogfood round (2026-05-13), a fresh worker spawned via `start-worker` was supervised through `register-manager` + `bind` + `cycle`. The worker shipped two real commits (`8869ea8`, `e2573de`) covering separate findings (state-filter, session-name lookup fallback — both already merged in PR #38). Five remaining findings drive this phase; four are in scope.

1. **`workerctl cycle` doesn't surface task completion.** After the worker emitted `task_complete`, the cycle returned `state: idle` indistinguishable from "stalled at startup." The signal exists in `codex_events` but isn't lifted into `status_payload`.
2. **No `start-manager` ergonomic.** Manager registration required: open codex → type warm-up prompt → `ps -ef | grep codex` → `lsof -p <pid>` → `register-manager`. 4-step manual dance; `start-worker` solves the equivalent for workers in one shot.
3. **Classifier false positive on healthy long-running work.** `long_running_interruptible` fired at status_age=233s even with 133 codex events flowing that cycle. The classifier ignores recent event volume.
4. **`register-manager` doesn't auto-probe the rollout path.** `lsof` is the canonical lookup; user has to run it manually. Should be folded into `register-manager --pid`.
5. *Skipped for v1:* worker-committed-to-main guardrail (soft finding; defer).

---

## Task 1: `cycle` surfaces task_complete

**Goal:** Add `last_event_subtype` and `task_completed` to `cycle` output so `state: idle` can be disambiguated from `task_complete`-after-`state: idle`.

**Files:**
- Modify: `workerctl/supervise_cycle.py` (run_cycle)
- Modify: `workerctl/db.py` (potentially add `latest_event_subtype` helper)
- Test: `tests/test_workerctl.py` (extend `SuperviseCycleTests`)
- Modify: `README.md`

### Steps

- [ ] **Step 1: Survey current code.**
  ```bash
  grep -n "def run_cycle\|status_payload\b" workerctl/supervise_cycle.py
  grep -n "session_id\|subtype" workerctl/codex_events.py 2>/dev/null || grep -rn "from workerctl import codex_events" workerctl/
  ```
  Identify where `status_payload` is constructed in `run_cycle`. Identify how to query the most-recent `codex_events` row for a session by `session_id`.

- [ ] **Step 2: Write failing tests.** Add to `SuperviseCycleTests`:
  ```python
  def test_cycle_includes_task_completed_true_after_task_complete_event(self):
      with tempfile.TemporaryDirectory() as tmpdir:
          db_path = self._minimal_bound_db(tmpdir)
          # Seed a task_complete codex_event for the worker.
          conn = worker_db.connect(db_path)
          worker_row = worker_db.session_by_name(conn, name="worker-1")
          conn.execute(
              """insert into codex_events(session_id, type, subtype, payload_json, timestamp, byte_offset)
                 values (?, 'event_msg', 'task_complete', '{}', '2026-05-13T14:02:30Z', 1000)""",
              (worker_row["id"],),
          )
          conn.commit()
          conn.close()
          result = supervise_cycle.run_cycle(
              db_path=db_path, task_slug="t1",
              tmux_runner=_tmux_skip_runner, ingest_runner=_no_ingest_runner,
          )
          self.assertEqual(result["status_payload"]["last_event_subtype"], "task_complete")
          self.assertTrue(result["status_payload"]["task_completed"])

  def test_cycle_includes_task_completed_false_when_no_events(self):
      with tempfile.TemporaryDirectory() as tmpdir:
          db_path = self._minimal_bound_db(tmpdir)
          result = supervise_cycle.run_cycle(
              db_path=db_path, task_slug="t1",
              tmux_runner=_tmux_skip_runner, ingest_runner=_no_ingest_runner,
          )
          self.assertIsNone(result["status_payload"]["last_event_subtype"])
          self.assertFalse(result["status_payload"]["task_completed"])

  def test_cycle_task_completed_false_when_latest_event_is_not_task_complete(self):
      with tempfile.TemporaryDirectory() as tmpdir:
          db_path = self._minimal_bound_db(tmpdir)
          conn = worker_db.connect(db_path)
          worker_row = worker_db.session_by_name(conn, name="worker-1")
          conn.execute(
              """insert into codex_events(session_id, type, subtype, payload_json, timestamp, byte_offset)
                 values (?, 'event_msg', 'token_count', '{}', '2026-05-13T14:02:30Z', 2000)""",
              (worker_row["id"],),
          )
          conn.commit()
          conn.close()
          result = supervise_cycle.run_cycle(
              db_path=db_path, task_slug="t1",
              tmux_runner=_tmux_skip_runner, ingest_runner=_no_ingest_runner,
          )
          self.assertEqual(result["status_payload"]["last_event_subtype"], "token_count")
          self.assertFalse(result["status_payload"]["task_completed"])
  ```
  Adapt column names (`session_id`, `subtype`, `byte_offset`, `timestamp`) to whatever the real schema uses — verify via `.schema codex_events` or `db.py`.

- [ ] **Step 3: Run tests to verify failure.**
  ```bash
  python3 -m unittest tests.test_workerctl.SuperviseCycleTests -v 2>&1 | tail -10
  ```
  3 new tests should fail (KeyError on `last_event_subtype` / `task_completed`).

- [ ] **Step 4: Add helper in `workerctl/db.py`.** Near other query helpers:
  ```python
  def latest_codex_event_subtype(
      conn: sqlite3.Connection, *, session_id: str
  ) -> str | None:
      row = conn.execute(
          "select subtype from codex_events where session_id = ? "
          "order by byte_offset desc limit 1",
          (session_id,),
      ).fetchone()
      return row["subtype"] if row else None
  ```
  Match the actual codex_events schema (column names) — adjust if needed.

- [ ] **Step 5: Wire into `run_cycle`.** Where `status_payload` is built, add:
  ```python
  last_subtype = worker_db.latest_codex_event_subtype(
      conn, session_id=binding["worker_session_id"]
  )
  status_payload["last_event_subtype"] = last_subtype
  status_payload["task_completed"] = last_subtype == "task_complete"
  ```

- [ ] **Step 6: Run tests.**
  ```bash
  python3 -m unittest tests.test_workerctl 2>&1 | tail -3
  ```
  Expected: 252 + 3 = 255 / 0.

- [ ] **Step 7: Update README.** Near the `cycle` documentation, add a sentence:
  > `status_payload` now includes `last_event_subtype` (the subtype of the most recent `codex_events` row for the worker) and `task_completed` (true iff that subtype is `task_complete`). Use this to distinguish "worker finished cleanly" from "worker idle but unstarted."

- [ ] **Step 8: Commit.**
  ```bash
  git add workerctl/supervise_cycle.py workerctl/db.py tests/test_workerctl.py README.md
  git commit -m "Phase 8: cycle surfaces last_event_subtype and task_completed"
  ```

---

## Task 2: `workerctl start-manager`

**Goal:** Mirror `start-worker`'s spawn-and-register flow for managers. Eliminates the 4-step manager registration dance.

**Files:**
- Modify: `workerctl/commands.py` (new `command_start_manager` lifted from `command_start_worker`)
- Modify: `workerctl/cli.py` (new subparser)
- Test: `tests/test_workerctl.py` (new `StartManagerTests` — mock subprocess + tmux + lsof)
- Modify: `README.md`

### Steps

- [ ] **Step 1: Read `command_start_worker`.**
  ```bash
  grep -n "def command_start_worker\|def _spawn_codex\|def _wait_for_rollout" workerctl/commands.py
  ```
  Understand the existing flow: tmux new-session → spawn codex via send-keys → poll filesystem for the rollout JSONL → register.

- [ ] **Step 2: Write failing tests.** New class:
  ```python
  class StartManagerTests(unittest.TestCase):
      def test_start_manager_spawns_codex_and_registers(self):
          # Mock the spawn helpers so no real codex is launched.
          with tempfile.TemporaryDirectory() as tmpdir:
              env = os.environ.copy()
              env["WORKERCTL_STATE_ROOT"] = tmpdir
              proc = subprocess.run(
                  [sys.executable, "-m", "workerctl", "start-manager",
                   "--name", "test-mgr",
                   "--cwd", tmpdir,
                   "--dry-run"],
                  env=env, capture_output=True, text=True, cwd=str(ROOT),
              )
              self.assertEqual(proc.returncode, 0, proc.stderr)
              out = json.loads(proc.stdout)
              self.assertEqual(out["role"], "manager")
              self.assertEqual(out["name"], "test-mgr")
  ```
  If `--dry-run` doesn't exist, either add it OR write tests that patch the spawn helpers directly via `unittest.mock`.

- [ ] **Step 3: Run tests to verify failure.**
  ```bash
  python3 -m unittest tests.test_workerctl.StartManagerTests -v
  ```

- [ ] **Step 4: Implement `command_start_manager`.** Likely refactor: extract shared spawn logic from `command_start_worker` into `_spawn_codex_and_wait_for_rollout(*, name, cwd, task, role, ...)` — both commands call it with `role="worker"` or `role="manager"`. Then `command_start_manager` is a thin wrapper.

  Notable difference vs worker: managers don't take a `--task` prompt (the manager process supervises rather than executes). Drop `--task` from the manager flags.

- [ ] **Step 5: Add CLI subparser** in `workerctl/cli.py`. Mirror the `start-worker` subparser but omit `--task`.

- [ ] **Step 6: Run tests.**
  ```bash
  python3 -m unittest tests.test_workerctl 2>&1 | tail -3
  ```
  Expected: 255 + N / 0 (N depends on tests added).

- [ ] **Step 7: Update README.** Add a `start-manager` section parallel to the `start-worker` documentation. Cross-reference the dogfood finding.

- [ ] **Step 8: Commit.**
  ```bash
  git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py README.md
  git commit -m "Phase 8: start-manager mirrors start-worker spawn-and-register flow"
  ```

---

## Task 3: Classifier weighs event flow

**Goal:** Stop `long_running_interruptible` from firing when codex_events are streaming. Suppress this pattern when recent event count is non-trivial.

**Files:**
- Modify: `workerctl/shadow_state.py` (classify_busy_wait signature + logic)
- Modify: `workerctl/supervise_cycle.py` (forward `ingest.new_events` into classifier)
- Test: `tests/test_workerctl.py` (or `tests/test_shadow_state.py` if it exists)
- Modify: `README.md`

### Steps

- [ ] **Step 1: Survey current classifier.**
  ```bash
  grep -n "def classify_busy_wait\|long_running_interruptible" workerctl/shadow_state.py workerctl/classify.py 2>/dev/null
  ```
  Find where `long_running_interruptible` is decided. Note the existing args — likely `status_age_seconds`, `terminal_capture`, etc.

- [ ] **Step 2: Write failing tests.** Add to whatever test class covers classifier:
  ```python
  def test_classifier_suppresses_long_running_interruptible_with_recent_events(self):
      # status_age_seconds high, but event count also high — worker is healthy.
      result = classify.classify_busy_wait(
          status_age_seconds=300,
          terminal_capture="<a Codex 'Esc to interrupt' indicator>",
          recent_event_count=133,
      )
      self.assertIsNone(result["pattern"])
      # Or, depending on convention:
      # self.assertNotEqual(result["pattern"], "long_running_interruptible")

  def test_classifier_still_flags_long_running_interruptible_when_event_count_low(self):
      result = classify.classify_busy_wait(
          status_age_seconds=300,
          terminal_capture="<a Codex 'Esc to interrupt' indicator>",
          recent_event_count=2,
      )
      self.assertEqual(result["pattern"], "long_running_interruptible")
  ```
  Threshold: 10 events/cycle feels right. Justify: a healthy busy worker emits multiple events per second; 10 events/cycle ≈ 1+ event every ~5 seconds for a 30s cycle.

- [ ] **Step 3: Run tests to verify failure.**

- [ ] **Step 4: Modify `classify_busy_wait`.** Add `recent_event_count: int = 0` parameter. In the branch that currently sets `pattern = "long_running_interruptible"`, add a precondition: `if recent_event_count < 10:`. (Use a named constant `RECENT_EVENT_QUIET_THRESHOLD = 10` at module top.)

- [ ] **Step 5: Forward from `run_cycle`.** Where `pane_signal_for_session` is called, pass `recent_event_count = ingest_result.get("new_events", 0)`. The classifier itself receives this via `pane_signal_for_session`. If `pane_signal_for_session` doesn't currently take `recent_event_count`, add it as a kwarg and forward to `classify_busy_wait`.

- [ ] **Step 6: Run tests.**
  Expected: 255+N+2 / 0.

- [ ] **Step 7: Update README.** Document the new behavior in the cycle / pane_signal section: classifier now considers event volume.

- [ ] **Step 8: Commit.**
  ```bash
  git add workerctl/shadow_state.py workerctl/supervise_cycle.py tests/test_workerctl.py README.md
  git commit -m "Phase 8: classifier weighs recent event volume; suppress false positives"
  ```

---

## Task 4: `register-manager --pid` auto-discovers rollout

**Goal:** Eliminate the manual `lsof` step. If `--codex-session` is omitted but `--pid` is given, probe `lsof -p <pid>` to find the rollout JSONL.

**Files:**
- Modify: `workerctl/commands.py` (command_register_manager + small lsof helper)
- Test: `tests/test_workerctl.py` (patch subprocess.run for lsof output)
- Modify: `README.md`

### Steps

- [ ] **Step 1: Survey current `command_register_manager`.**
  ```bash
  grep -n "def command_register_manager" workerctl/commands.py
  ```

- [ ] **Step 2: Write failing tests.**
  ```python
  class RegisterManagerLsofTests(unittest.TestCase):
      def test_register_manager_uses_lsof_to_find_rollout(self):
          lsof_output = b"""codex 28975 user  34w  REG  1,17  4560872  41566360 /home/u/.codex/sessions/2026/05/13/rollout-XXX.jsonl"""
          fake_run = unittest.mock.MagicMock(
              return_value=subprocess.CompletedProcess(args=[], returncode=0, stdout=lsof_output, stderr=b"")
          )
          with unittest.mock.patch.object(commands.subprocess, "run", fake_run):
              # Call register-manager without --codex-session
              ...
          # Assert the registered session_path matches the lsof-found path
          ...

      def test_register_manager_falls_back_with_hint_if_no_jsonl_found(self):
          # lsof returns no JSONL → registration fails with helpful message about warm-up.
          ...
  ```
  Adapt to existing test patterns in the module. The key contract: `register-manager --pid <pid>` (no `--codex-session`) succeeds when lsof finds a JSONL fd, fails cleanly otherwise.

- [ ] **Step 3: Run tests to verify failure.**

- [ ] **Step 4: Implement lsof helper.** In `workerctl/commands.py`:
  ```python
  _CODEX_ROLLOUT_PATTERN = re.compile(r"(/.*\.codex/sessions/.+\.jsonl)$")

  def _lsof_codex_rollout(pid: int) -> str | None:
      try:
          proc = subprocess.run(
              ["lsof", "-p", str(pid)],
              capture_output=True, text=True, check=False, timeout=5.0,
          )
      except (FileNotFoundError, subprocess.TimeoutExpired):
          return None
      for line in proc.stdout.splitlines():
          m = _CODEX_ROLLOUT_PATTERN.search(line)
          if m:
              return m.group(1)
      return None
  ```

- [ ] **Step 5: Update `command_register_manager`.** If `--codex-session` is None and `--pid` is provided, call `_lsof_codex_rollout(args.pid)`. If still None, raise `WorkerError("could not find a codex rollout JSONL for pid <pid>. The codex session may not have written its rollout yet — type any input into the codex prompt and retry.")`.

- [ ] **Step 6: Run tests.**

- [ ] **Step 7: Update README.** Update the `register-manager` section to document the new behavior — pass `--pid` alone if the rollout is discoverable via lsof, otherwise pass both.

- [ ] **Step 8: Commit.**
  ```bash
  git add workerctl/commands.py tests/test_workerctl.py README.md
  git commit -m "Phase 8: register-manager auto-discovers rollout JSONL via lsof"
  ```

---

## Done criteria

- All 4 tasks committed individually on `manual-assignment-phase-8`.
- `python3 -m unittest tests.test_workerctl` passes (target: 252 + ~10 = ~262).
- README documents all four additions.
- PR opened, CI green, merged.

## Out of scope

- Worker-committed-to-main guardrail (deferred — soft finding).
- Any refactor of `codex_events` schema.
- Any new long-running daemon work.
