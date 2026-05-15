# Criteria Mutation Response Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `workerctl criteria` mutation responses internally consistent under concurrent manager/operator mutations, while keeping `criteria --list` as the canonical task state before final decisions.

**Architecture:** Criteria mutations should be serialized at the SQLite write boundary. Each mutation command will acquire a task/database write lock with `BEGIN IMMEDIATE`, perform the mutation, build the returned criteria snapshot while the write lock is still held, then commit and print. This makes every mutation response a serializable point-in-time receipt: it contains the affected row plus all criteria state committed before that mutation took the lock, and no later mutation can interleave before the response snapshot is built.

**Tech Stack:** Python standard library, SQLite, argparse CLI, existing `workerctl` command/test patterns, `unittest`.

---

## Scope And Semantics

This plan fixes the stale mutation-response snapshot discovered during live QA:

- Two `workerctl criteria --defer` commands were launched concurrently.
- Durable SQLite state was correct after both commands.
- One mutation response included a stale full-list/summary snapshot because another mutation committed after that response's snapshot was built.

The fix is **not** to promise that a response includes future concurrent commits. That is impossible without waiting for global quiescence. The intended contract after this fix:

- `affected_criterion` is the authoritative receipt for the row changed by the command.
- The mutation response's `criteria` and `summary` are a serializable snapshot built while the command still holds the write lock.
- If multiple mutations are launched concurrently, later mutations wait until earlier mutation snapshots are built.
- `workerctl criteria <task> --list` remains the canonical task state before audited finish or manager decisions.

## Files

- Modify: `workerctl/commands.py`
  - Add a small transaction helper for criteria mutations.
  - Update `command_criteria` add/update branches to build mutation responses before committing the write transaction.
  - Keep list-only behavior unchanged.
- Modify: `tests/test_workerctl.py`
  - Add a regression test proving a mutation response snapshot is built while a write lock is held.
  - Keep existing CLI behavior tests passing.
- Modify: `README.md`
  - Document mutation response semantics: `affected_criterion` is the mutation receipt; `criteria --list` is canonical after batches/concurrent changes.
- Modify: `skills/manage-codex-workers/SKILL.md`
  - Teach managers to use `criteria --list` before audited finish when multiple criteria changed.
- Modify: `docs/manual-assignment-phase-9-emergent-acceptance-criteria-plan.md`
  - Record the live-QA finding and the corrected response contract.

## Task 1: Add A Regression Test For Serialized Mutation Snapshots

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add the failing test skeleton**

Add this test to `AcceptanceCriteriaCliTests` in `tests/test_workerctl.py`:

```python
    def test_mutation_response_snapshot_is_built_under_write_lock(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            task_id = self._create_task(db_path)
            conn = worker_db.connect(db_path)
            try:
                first_id = worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="First criterion",
                    status="accepted",
                    source="manager_inferred",
                )
                second_id = worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Second criterion",
                    status="accepted",
                    source="manager_inferred",
                )
                conn.commit()
            finally:
                conn.close()

            from workerctl import commands as worker_commands

            original_response = worker_commands._acceptance_criteria_response
            lock_probe = {"attempted": False, "locked": False}

            def response_with_lock_probe(conn, *, task, statuses=None, affected_criterion=None):
                lock_probe["attempted"] = True
                probe = sqlite3.connect(db_path, timeout=0)
                try:
                    with self.assertRaises(sqlite3.OperationalError) as raised:
                        probe.execute(
                            "update acceptance_criteria set status = 'deferred' where id = ?",
                            (second_id,),
                        )
                    self.assertIn("locked", str(raised.exception).lower())
                    lock_probe["locked"] = True
                finally:
                    probe.close()
                return original_response(
                    conn,
                    task=task,
                    statuses=statuses,
                    affected_criterion=affected_criterion,
                )

            args = argparse.Namespace(
                accept=None,
                add=False,
                criterion=None,
                defer=first_id,
                evidence_json=None,
                list=False,
                path=str(db_path),
                proof=None,
                rationale="Defer first criterion",
                reject=None,
                satisfy=None,
                source=None,
                status=[],
                task="criteria-cli-task",
            )

            try:
                worker_commands._acceptance_criteria_response = response_with_lock_probe
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = worker_commands.command_criteria(args)
            finally:
                worker_commands._acceptance_criteria_response = original_response

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertTrue(lock_probe["attempted"])
            self.assertTrue(lock_probe["locked"])
            self.assertEqual(payload["affected_criterion"]["id"], first_id)
            self.assertEqual(payload["affected_criterion"]["status"], "deferred")
            self.assertEqual(payload["summary"]["accepted"], 1)
            self.assertEqual(payload["summary"]["deferred"], 1)
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests.test_mutation_response_snapshot_is_built_under_write_lock -v
```

Expected before implementation:

- The test fails because the probe update succeeds instead of raising `sqlite3.OperationalError: database is locked`.
- This proves the mutation response is currently built after the write lock is released or without holding an explicit write lock.

## Task 2: Add A Criteria Mutation Transaction Helper

**Files:**
- Modify: `workerctl/commands.py`

- [ ] **Step 1: Add the helper near `_acceptance_criteria_response`**

Add:

```python
def _begin_criteria_mutation(conn: Any) -> None:
    conn.execute("BEGIN IMMEDIATE")
```

Rationale:

- `BEGIN IMMEDIATE` acquires SQLite's write lock before the command reads criteria and performs the mutation.
- Other writer processes wait on `busy_timeout` instead of interleaving between mutation and response snapshot.
- The helper stays local to `commands.py` because this is a CLI response consistency concern, not a general DB API.

- [ ] **Step 2: Remove the fresh-read helper if present**

If `workerctl/commands.py` contains `_fresh_acceptance_criteria_response`, delete it. It improves ordinary stale reads but cannot prevent another concurrent mutation from committing between the mutation commit and response read.

Delete this block if present:

```python
def _fresh_acceptance_criteria_response(...):
    ...
```

## Task 3: Serialize `criteria --add` Responses

**Files:**
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Update the add branch**

In `command_criteria`, keep `task = worker_db.task_row(...)` before the action branch. Inside `if args.add:`, after validating `--criterion`, `--source`, and `--status`, call `_begin_criteria_mutation(conn)` before reading existing criteria.

The add branch should follow this shape:

```python
        if args.add:
            if not args.criterion:
                raise WorkerError("--criterion is required with criteria --add")
            if not args.source:
                raise WorkerError("--source is required with criteria --add")
            if len(args.status) > 1:
                raise WorkerError("criteria --add accepts at most one --status")
            _begin_criteria_mutation(conn)
            existing_criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
            existing = next(
                (
                    row
                    for row in existing_criteria
                    if row["source"] == args.source and row["criterion"] == args.criterion
                ),
                None,
            )
            criterion_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id=task["id"],
                criterion=args.criterion,
                status=args.status[0] if args.status else "proposed",
                source=args.source,
                proof=args.proof,
                rationale=args.rationale,
                evidence=evidence,
            )
            criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
            criterion = next(row for row in criteria if row["id"] == criterion_id)
            if existing is None:
                worker_db.insert_event(
                    conn,
                    "acceptance_criterion_added",
                    actor="workerctl",
                    task_id=task["id"],
                    payload=_acceptance_criterion_event_payload(
                        criterion=criterion,
                        task_id=task["id"],
                        created=True,
                    ),
                )
            result = _acceptance_criteria_response(conn, task=task, affected_criterion=criterion)
            conn.commit()
```

Important ordering:

- Build `result` before `conn.commit()`.
- Print only after leaving the `with` block, as the command already does.
- Do not emit a second add event for duplicate criteria.

- [ ] **Step 2: Run add/duplicate tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.AcceptanceCriteriaCliTests.test_add_and_list_outputs_task_criteria_summary_and_event \
  tests.test_workerctl.AcceptanceCriteriaCliTests.test_duplicate_add_preserves_one_row_and_does_not_emit_second_added_event \
  -v
```

Expected: both pass.

## Task 4: Serialize Update Action Responses

**Files:**
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Update the accept/satisfy/defer/reject branch**

In the final `else:` branch of `command_criteria`, call `_begin_criteria_mutation(conn)` before reading `task_criteria`.

The update branch should follow this shape:

```python
        else:
            if args.status:
                raise WorkerError("--status is only supported with criteria --list or --add")
            action_status = {
                "accept": "accepted",
                "satisfy": "satisfied",
                "defer": "deferred",
                "reject": "rejected",
            }
            action_name = next(name for name in action_status if getattr(args, name) is not None)
            criterion_id = getattr(args, action_name)
            _begin_criteria_mutation(conn)
            task_criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
            existing = next((row for row in task_criteria if row["id"] == criterion_id), None)
            if existing is None:
                raise WorkerError(f"Unknown acceptance criterion for task {task['name']}: {criterion_id}")
            update_kwargs: dict[str, Any] = {}
            if args.evidence_json is not None:
                update_kwargs["evidence"] = evidence
            if args.proof is not None:
                update_kwargs["proof"] = args.proof
            if args.rationale is not None:
                update_kwargs["rationale"] = args.rationale
            criterion = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=criterion_id,
                status=action_status[action_name],
                **update_kwargs,
            )
            worker_db.insert_event(
                conn,
                "acceptance_criterion_updated",
                actor="workerctl",
                task_id=task["id"],
                payload=_acceptance_criterion_event_payload(
                    criterion=criterion,
                    task_id=task["id"],
                    previous=existing,
                ),
            )
            result = _acceptance_criteria_response(conn, task=task, affected_criterion=criterion)
            conn.commit()
```

- [ ] **Step 2: Run the new lock regression test**

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests.test_mutation_response_snapshot_is_built_under_write_lock -v
```

Expected: pass.

- [ ] **Step 3: Run all criteria CLI tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests -v
```

Expected: pass.

## Task 5: Update QA Plan And Docs With The Response Contract

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `README.md`
- Modify: `skills/manage-codex-workers/SKILL.md`
- Modify: `docs/manual-assignment-phase-9-emergent-acceptance-criteria-plan.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Keep `qa-plan emergent-criteria` explicit about canonical list checks**

In `workerctl/commands.py`, ensure the `emergent-criteria` QA plan contains:

```python
"after multiple criteria mutations, workerctl criteria --list is used as the canonical task state"
```

in `expected_observations`, and:

```python
"Run workerctl criteria qa-emergent-criteria --list and verify accepted is 0 before attempting the final audited finish."
```

in `steps`.

- [ ] **Step 2: Strengthen the QA plan test**

In `test_qa_plan_emergent_criteria_outputs_criteria_flow`, assert both strings:

```python
self.assertTrue(any("criteria qa-emergent-criteria --list" in step for step in payload["steps"]))
self.assertTrue(
    any("criteria --list is used as the canonical task state" in observation
        for observation in payload["expected_observations"])
)
```

- [ ] **Step 3: Add README wording**

Near the `criteria <task>` command docs in `README.md`, add:

```markdown
For mutation responses, treat `affected_criterion` as the authoritative receipt
for the row changed by that command. When a manager applies multiple criteria
changes, run `criteria <task> --list` before final audit or other decisions; the
list command is the canonical task-level criteria state.
```

- [ ] **Step 4: Add skill wording**

Near the criteria command examples in `skills/manage-codex-workers/SKILL.md`, add:

```markdown
When making multiple criteria changes, use each mutation response's
`affected_criterion` as the row receipt, then run `scripts/workerctl criteria
<task> --list` before finishing or making an audit decision.
```

- [ ] **Step 5: Record the live-QA finding**

In `docs/manual-assignment-phase-9-emergent-acceptance-criteria-plan.md`, under `Live QA With Real Worker/Manager Pairs`, add a short note:

```markdown
Live QA finding: concurrent criteria mutations can finish in different orders.
Mutation responses are point-in-time receipts for `affected_criterion`; managers
must run `criteria --list` before final audit when they batch or parallelize
criteria changes.
```

- [ ] **Step 6: Run QA plan tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_plan_self_management_outputs_repeatable_steps \
  tests.test_workerctl.CliTests.test_qa_plan_emergent_criteria_outputs_criteria_flow \
  -v
```

Expected: pass.

## Task 6: Manual Concurrency Reproduction

**Files:**
- No code changes.

- [ ] **Step 1: Create a throwaway task**

Run:

```bash
task="qa-criteria-concurrency-$(date +%s)"
scripts/workerctl tasks --create "$task" --goal "QA criteria mutation response consistency"
```

Expected: command exits 0 and prints a task row.

- [ ] **Step 2: Add two accepted criteria**

Run:

```bash
scripts/workerctl criteria "$task" --add --criterion "first criterion" --source manager_inferred --status accepted >/tmp/qa_c1.json
scripts/workerctl criteria "$task" --add --criterion "second criterion" --source manager_inferred --status accepted >/tmp/qa_c2.json
id1=$(python3 -c 'import json; print(json.load(open("/tmp/qa_c1.json"))["affected_criterion"]["id"])')
id2=$(python3 -c 'import json; print(json.load(open("/tmp/qa_c2.json"))["affected_criterion"]["id"])')
```

Expected: both IDs are non-empty integers.

- [ ] **Step 3: Launch two mutations concurrently**

Run:

```bash
scripts/workerctl criteria "$task" --defer "$id1" --rationale "parallel test one" >/tmp/qa_d1.json &
pid1=$!
scripts/workerctl criteria "$task" --defer "$id2" --rationale "parallel test two" >/tmp/qa_d2.json &
pid2=$!
wait "$pid1" "$pid2"
python3 - <<'PY'
import json
for path in ("/tmp/qa_d1.json", "/tmp/qa_d2.json"):
    payload = json.load(open(path))
    print(path, payload["affected_criterion"]["id"], payload["affected_criterion"]["status"], payload["summary"])
PY
```

Expected:

- Both `affected_criterion.status` values are `deferred`.
- One response may show `accepted: 1, deferred: 1` and the later response should show `accepted: 0, deferred: 2`, depending on which mutation serialized first.
- No response should show its own affected criterion in the old status.

- [ ] **Step 4: Verify canonical list and audit gate**

Run:

```bash
scripts/workerctl criteria "$task" --list
scripts/workerctl finish-task "$task" --reason "QA concurrency response complete" --require-criteria-audit
```

Expected:

- `criteria --list` reports `accepted: 0, deferred: 2`.
- `finish-task --require-criteria-audit` succeeds with `open_criteria: []`.

## Task 7: Full Verification And Review

**Files:**
- No code changes unless failures are found.

- [ ] **Step 1: Run focused tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.AcceptanceCriteriaCliTests \
  tests.test_workerctl.CliTests.test_qa_plan_self_management_outputs_repeatable_steps \
  tests.test_workerctl.CliTests.test_qa_plan_emergent_criteria_outputs_criteria_flow \
  -v
```

Expected: pass.

- [ ] **Step 2: Run compile and diff checks**

Run:

```bash
python3 -m py_compile workerctl/*.py
git diff --check
```

Expected: both exit 0.

- [ ] **Step 3: Run full unit suite**

Run:

```bash
python3 -m unittest tests.test_workerctl -v
```

Expected: pass. If tmux-backed tests fail due to local tmux permission problems, rerun in a terminal where `tmux new-session` works and document the environment-specific failure.

- [ ] **Step 4: Run Codex review**

Run:

```bash
~/.codex/skills/codex-review/scripts/codex-review --full-access
```

Expected: `codex-review clean: no accepted/actionable findings reported`.

## Self-Review

- Spec coverage: The plan covers the live-QA finding, mutation response serialization, canonical list guidance, tests, manual reproduction, and review.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: Helper names, test class names, command names, and JSON fields match existing code (`AcceptanceCriteriaCliTests`, `_acceptance_criteria_response`, `affected_criterion`, `summary`, `criteria`).
