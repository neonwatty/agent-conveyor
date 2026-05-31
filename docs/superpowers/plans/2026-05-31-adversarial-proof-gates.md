# Adversarial Proof Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make issue #176 operational by adding adversarial burden-of-proof guidance to manager flows and making `adversarial_check` a first-class evidence gate that can block Ralph-loop continuation and audited task finish.

**Architecture:** This is a two-layer change. GoalBuddy/prompting defines the burden-of-proof stance and the oracle; Codex Terminal Manager enforces structured evidence presence through loop policy and finish gates. CTM does not try to semantically grade whether the proof is good; it requires a manager/worker to record a strongest realistic failure mode, how it was checked, and evidence before continuation or finish.

**Tech Stack:** Python standard library, SQLite-backed `workerctl`, existing acceptance criteria ledger, existing Ralph-loop policy metadata, existing dispatcher command blocking, existing `unittest` suite in `tests/test_workerctl.py`.

---

## Scope Boundaries

This plan intentionally does **not** build an LLM judge for proof quality. The manager remains the quality judge. CTM enforces that the adversarial proof exists, has required structured fields, is attached to the right loop/task, and appears in audit/replay surfaces.

This plan also does **not** implement the larger `loop-runner start|tick|watch` proposal. It creates the proof primitive that the future runner can consume.

---

## File Structure

- Modify `workerctl/commands.py`
  - Add reusable adversarial proof prompt text.
  - Add adversarial evidence recording helper/subcommand.
  - Add finish-time proof gate helper.
  - Reuse existing acceptance criteria and loop evidence storage.

- Modify `workerctl/cli.py`
  - Add `loop-evidence adversarial-check`.
  - Add `finish-task --require-adversarial-proof`.

- Modify `workerctl/loop_templates.py`
  - Add `adversarial_check` to loop templates that represent repeated quality/PR/visual/test loops.
  - Add artifact requirement metadata explaining the evidence shape.

- Modify `README.md`
  - Document burden-of-proof manager behavior.
  - Document `loop-evidence adversarial-check`.
  - Document `finish-task --require-adversarial-proof`.

- Modify `skills/manage-codex-workers/SKILL.md`
  - Mirror the manager burden-of-proof guidance for users invoking the skill directly.

- Modify `docs/qa/ralph-loop.md`
  - Update Ralph-loop QA expectations to include adversarial proof before continuation/finish.

- Modify `docs/qa/general-loop-templates.md`
  - Update generic loop template QA to prove missing `adversarial_check` blocks continuation and recorded proof unblocks it.

- Modify `tests/test_workerctl.py`
  - Add focused tests near existing manager prompt, loop template, loop evidence, dispatcher policy, and finish-task tests.

---

## Task 1: Add Manager Burden-Of-Proof Prompting

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `tests/test_workerctl.py`
- Modify: `README.md`
- Modify: `skills/manage-codex-workers/SKILL.md`

- [ ] **Step 1: Write the failing manager prompt test**

Add this test to `ManagerBootstrapPromptTests` in `tests/test_workerctl.py`:

```python
    def test_prompt_includes_adversarial_burden_of_proof_guidance(self):
        prompt = commands.manager_bootstrap_prompt(
            manager_name="proof-mgr",
            cwd="/repo",
            task_name="proof-task",
            task_goal="Verify a worker change",
            worker_name="proof-worker",
        )

        self.assertIn("Before declaring work complete, try to disprove the change.", prompt)
        self.assertIn("strongest realistic failure mode", prompt)
        self.assertIn("Treat unverified assumptions as blockers or explicit follow-ups.", prompt)
        self.assertIn("Do not accept worker claims, passing happy-path tests, or generated summaries as proof by themselves.", prompt)
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests.test_prompt_includes_adversarial_burden_of_proof_guidance -v
```

Expected: `FAIL` because the prompt does not yet include the adversarial proof wording.

- [ ] **Step 3: Add reusable prompt text**

In `workerctl/commands.py`, near `manager_bootstrap_prompt`, add:

```python
ADVERSARIAL_PROOF_GUIDANCE = """Burden of proof:
- Before declaring work complete, try to disprove the change.
- Identify the strongest realistic failure mode that would embarrass this work after merge.
- Verify that failure mode with a command, test, trace, screenshot, audit record, diff, or direct inspection.
- Do not accept worker claims, passing happy-path tests, or generated summaries as proof by themselves.
- Treat unverified assumptions as blockers or explicit follow-ups."""
```

Then insert this block in `manager_bootstrap_prompt` after `Your role is to supervise, not to implement the worker task.`:

```python
{ADVERSARIAL_PROOF_GUIDANCE}
```

The rendered section should appear before setup instructions so the stance governs all supervision.

- [ ] **Step 4: Run the manager prompt test**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests.test_prompt_includes_adversarial_burden_of_proof_guidance -v
```

Expected: `PASS`.

- [ ] **Step 5: Update manager docs**

In `README.md`, add a short subsection near the manager/criteria docs:

```md
### Adversarial proof before completion

Managers should treat `done`, `tests passed`, and worker summaries as claims, not proof. Before declaring work complete, try to disprove the change: name the strongest realistic failure mode, verify it with a command, test, trace, screenshot, audit record, diff, or direct inspection, and record the result as criteria or loop evidence. Treat unverified assumptions as blockers or explicit follow-ups.
```

In `skills/manage-codex-workers/SKILL.md`, add the same operational guidance near the manager supervision/finish criteria section:

```md
Before declaring work complete, try to disprove the change. Identify the strongest realistic failure mode, verify it with a command, test, trace, screenshot, audit record, diff, or direct inspection, and include that evidence in the handoff. Do not accept worker claims, passing happy-path tests, or generated summaries as proof by themselves.
```

- [ ] **Step 6: Run the existing doc prompt test**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v
```

Expected: `PASS`.

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py tests/test_workerctl.py README.md skills/manage-codex-workers/SKILL.md
git commit -m "docs: add adversarial manager proof guidance"
```

---

## Task 2: Add `adversarial_check` To Loop Templates

**Files:**
- Modify: `workerctl/loop_templates.py`
- Modify: `tests/test_workerctl.py`
- Modify: `README.md`
- Modify: `docs/qa/general-loop-templates.md`

- [ ] **Step 1: Write failing template expectations**

Update existing template tests in `tests/test_workerctl.py` so `visual_diff_loop`, `test_coverage_loop`, and `pr_ci_merge_loop` require `adversarial_check`.

For the visual diff assertions, change the expected list to:

```python
[
    "reference_artifact",
    "candidate_screenshot",
    "visual_diff_report",
    "diff_below_threshold",
    "adversarial_check",
]
```

For `pr_ci_merge_loop`, change the expected list to:

```python
["pr_url", "ci_green", "merge", "adversarial_check"]
```

Add this focused test near the loop template tests:

```python
    def test_quality_loop_templates_require_adversarial_check(self):
        templates = {
            template["name"]: template
            for template in json.loads(
                self.run_workerctl("loop-templates", "--list", "--json").stdout
            )["templates"]
        }

        for name in ("pr_ci_merge_loop", "test_coverage_loop", "visual_diff_loop"):
            with self.subTest(name=name):
                self.assertIn("adversarial_check", templates[name]["required_before_continue"])
                self.assertIn("adversarial_check", templates[name]["artifact_requirements"])
```

- [ ] **Step 2: Run failing template tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.LoopTemplatesCliTests -v
```

Expected: `FAIL` because the templates do not yet include `adversarial_check`.

- [ ] **Step 3: Add shared artifact requirement helper**

In `workerctl/loop_templates.py`, above `LOOP_TEMPLATES`, add:

```python
ADVERSARIAL_CHECK_REQUIREMENT: dict[str, Any] = {
    "type": "object",
    "description": "Structured proof that the manager or worker tried to disprove the iteration before continuing.",
    "required": ["failure_mode", "check", "result"],
    "properties": {
        "failure_mode": {"type": "string", "description": "Strongest realistic failure mode considered."},
        "check": {"type": "string", "description": "Command, test, trace, screenshot, audit, diff, or inspection used."},
        "result": {"type": "string", "description": "Why the check rules out the failure mode or what remains unresolved."},
    },
}
```

- [ ] **Step 4: Update quality loop templates**

In `workerctl/loop_templates.py`, append `"adversarial_check"` to `required_before_continue` for:

```python
"pr_ci_merge_loop"
"test_coverage_loop"
"visual_diff_loop"
```

For each affected template, ensure `artifact_requirements` includes:

```python
"adversarial_check": ADVERSARIAL_CHECK_REQUIREMENT
```

For templates that already have an `artifact_requirements` dict, add the key inside the existing dict. For templates without one, add:

```python
artifact_requirements={
    "adversarial_check": ADVERSARIAL_CHECK_REQUIREMENT,
},
```

Do **not** add `adversarial_check` to `build_then_clear` or `compact_then_continue` in this slice; those are context-management loops and should not grow quality gates until a later policy decision.

- [ ] **Step 5: Run template tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.LoopTemplatesCliTests -v
```

Expected: `PASS`.

- [ ] **Step 6: Update docs**

In `README.md`, update the `loop-templates` paragraph so it says quality-oriented loops may require `adversarial_check` before continuation.

In `docs/qa/general-loop-templates.md`, update expected `required_before_continue` examples for `visual_diff_loop` and `pr_ci_merge_loop` to include `adversarial_check`.

- [ ] **Step 7: Commit**

```bash
git add workerctl/loop_templates.py tests/test_workerctl.py README.md docs/qa/general-loop-templates.md
git commit -m "feat: require adversarial evidence in quality loop templates"
```

---

## Task 3: Add Structured `loop-evidence adversarial-check`

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Modify: `tests/test_workerctl.py`
- Modify: `README.md`

- [ ] **Step 1: Write failing CLI test**

Add this test near existing loop evidence tests in `tests/test_workerctl.py`:

```python
    def test_loop_evidence_adversarial_check_records_structured_receipt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="adversarial-task", goal="Prove adversarial evidence.")
                run_id = worker_db.create_ralph_loop_run(
                    conn,
                    task_id=task_id,
                    max_iterations=2,
                    current_iteration=1,
                    required_before_continue=["adversarial_check"],
                    name="adversarial-policy",
                )
                conn.commit()

            proc = self.run_workerctl(
                "loop-evidence",
                "adversarial-check",
                "adversarial-task",
                "--loop-run",
                run_id,
                "--iteration",
                "1",
                "--failure-mode",
                "The worker only tested the happy path.",
                "--check",
                "python3 -m unittest tests.test_workerctl.SomeFocusedTest -v",
                "--result",
                "The focused negative case passed and rules out the regression.",
                "--artifact-path",
                "/tmp/adversarial-proof.txt",
                "--correlation-id",
                "corr-adversarial",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["evidence"]["evidence_type"], "adversarial_check")
            self.assertEqual(payload["evidence"]["failure_mode"], "The worker only tested the happy path.")
            self.assertEqual(payload["evidence"]["check"], "python3 -m unittest tests.test_workerctl.SomeFocusedTest -v")
            self.assertEqual(payload["evidence"]["result"], "The focused negative case passed and rules out the regression.")
            self.assertEqual(payload["criterion"]["status"], "satisfied")
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
python3 -m unittest tests.test_workerctl.LoopEvidenceCliTests.test_loop_evidence_adversarial_check_records_structured_receipt -v
```

Expected: `FAIL` because the `adversarial-check` subcommand does not exist.

- [ ] **Step 3: Add CLI parser**

In `workerctl/cli.py`, after the `loop_evidence_visual` parser, add:

```python
    loop_evidence_adversarial = loop_evidence_actions.add_parser(
        "adversarial-check",
        help="Record structured adversarial proof for a Ralph-loop iteration.",
    )
    loop_evidence_adversarial.add_argument("task", help="Task name or ID.")
    loop_evidence_adversarial.add_argument("--loop-run", required=True, help="Ralph-loop run id or name.")
    loop_evidence_adversarial.add_argument("--iteration", required=True, type=int, help="Iteration the adversarial check proves.")
    loop_evidence_adversarial.add_argument("--failure-mode", required=True, help="Strongest realistic failure mode considered.")
    loop_evidence_adversarial.add_argument("--check", required=True, help="Command, test, trace, screenshot, audit, diff, or inspection used.")
    loop_evidence_adversarial.add_argument("--result", required=True, help="Why the check rules out the failure mode or what remains unresolved.")
    loop_evidence_adversarial.add_argument("--status", default="pass", help="Evidence status stored in the receipt.")
    loop_evidence_adversarial.add_argument("--source", default="manager_inferred", choices=("manager_inferred", "worker_proposed", "user_requested", "final_audit"))
    loop_evidence_adversarial.add_argument("--artifact-path", help="Optional artifact backing this evidence.")
    loop_evidence_adversarial.add_argument("--correlation-id", help="Optional correlation id for replay and dashboard linkage.")
    loop_evidence_adversarial.add_argument("--json", action="store_true", help="Print stable JSON output.")
    loop_evidence_adversarial.add_argument("--path", help="Override the workerctl database path.")
    loop_evidence_adversarial.set_defaults(func=command_loop_evidence)
```

- [ ] **Step 4: Implement command branch**

In `workerctl/commands.py`, inside `command_loop_evidence`, add an `elif args.action in {"adversarial_check", "adversarial-check"}` branch before the final unsupported action branch:

```python
        elif args.action in {"adversarial_check", "adversarial-check"}:
            failure_mode = args.failure_mode.strip()
            check = args.check.strip()
            result_text = args.result.strip()
            if not failure_mode:
                raise WorkerError("--failure-mode must be non-empty")
            if not check:
                raise WorkerError("--check must be non-empty")
            if not result_text:
                raise WorkerError("--result must be non-empty")
            result = _record_loop_evidence(
                conn,
                task=task,
                loop_run=args.loop_run,
                iteration=args.iteration,
                evidence_type="adversarial_check",
                status=args.status,
                source=args.source,
                proof=f"Adversarial check: {failure_mode} -> {result_text}",
                artifact_path=args.artifact_path,
                correlation_id=args.correlation_id,
                metadata={
                    "failure_mode": failure_mode,
                    "check": check,
                    "result": result_text,
                },
            )
```

- [ ] **Step 5: Run the new CLI test**

Run:

```bash
python3 -m unittest tests.test_workerctl.LoopEvidenceCliTests.test_loop_evidence_adversarial_check_records_structured_receipt -v
```

Expected: `PASS`.

- [ ] **Step 6: Add validation test for empty fields**

Add this test:

```python
    def test_loop_evidence_adversarial_check_rejects_empty_failure_mode(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="bad-adversarial-task", goal="Reject empty proof.")
                run_id = worker_db.create_ralph_loop_run(
                    conn,
                    task_id=task_id,
                    max_iterations=2,
                    required_before_continue=["adversarial_check"],
                )
                conn.commit()

            proc = self.run_workerctl(
                "loop-evidence",
                "adversarial-check",
                "bad-adversarial-task",
                "--loop-run",
                run_id,
                "--iteration",
                "1",
                "--failure-mode",
                "   ",
                "--check",
                "inspection",
                "--result",
                "checked",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 1)
            self.assertIn("--failure-mode must be non-empty", proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)
```

- [ ] **Step 7: Run the loop evidence test class**

Run:

```bash
python3 -m unittest tests.test_workerctl.LoopEvidenceCliTests -v
```

Expected: `PASS`.

- [ ] **Step 8: Update README**

Add CLI documentation:

```md
`loop-evidence adversarial-check TASK --loop-run RUN --iteration N --failure-mode F --check C --result R` records first-class adversarial proof. Use it when a manager or worker tried to disprove the iteration before continuing. The receipt is stored as `evidence_type=adversarial_check` and can satisfy Ralph-loop continuation policy.
```

- [ ] **Step 9: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py tests/test_workerctl.py README.md
git commit -m "feat: record structured adversarial loop evidence"
```

---

## Task 4: Add Finish-Time Adversarial Proof Gate

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Modify: `tests/test_workerctl.py`
- Modify: `README.md`

- [ ] **Step 1: Write failing finish gate tests**

Add tests near the existing finish-task tests in `tests/test_workerctl.py`:

```python
    def test_finish_task_requires_adversarial_proof_when_requested(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.create_task(conn, name="finish-proof-task", goal="Require proof before finish.")
                conn.commit()

            proc = self.run_workerctl(
                "finish-task",
                "finish-proof-task",
                "--require-adversarial-proof",
                "--reason",
                "Done without proof.",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 1)
            self.assertIn("adversarial proof is required", proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)
```

Add the passing case:

```python
    def test_finish_task_accepts_satisfied_adversarial_proof(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="finish-proof-task", goal="Require proof before finish.")
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Adversarial proof recorded",
                    status="satisfied",
                    source="manager_inferred",
                    proof="Tried to disprove the change.",
                    evidence={
                        "evidence_type": "adversarial_check",
                        "failure_mode": "Happy-path only verification.",
                        "check": "negative test",
                        "result": "negative test passed",
                    },
                )
                conn.commit()

            proc = self.run_workerctl(
                "finish-task",
                "finish-proof-task",
                "--require-adversarial-proof",
                "--reason",
                "Proof exists.",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["task"]["state"], "done")
```

- [ ] **Step 2: Run failing finish tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.FinishTaskTests.test_finish_task_requires_adversarial_proof_when_requested tests.test_workerctl.FinishTaskTests.test_finish_task_accepts_satisfied_adversarial_proof -v
```

Expected: `FAIL` because the flag does not exist.

- [ ] **Step 3: Add CLI flag**

In `workerctl/cli.py`, under the existing finish-task gate flags, add:

```python
    finish_task.add_argument(
        "--require-adversarial-proof",
        action="store_true",
        help="Fail before finishing unless a satisfied adversarial_check proof exists for the task.",
    )
```

- [ ] **Step 4: Add proof detection helper**

In `workerctl/commands.py`, near `_acceptance_criteria_summary`, add:

```python
def _task_has_satisfied_adversarial_proof(conn: Any, *, task_id: str) -> bool:
    from workerctl import db as worker_db

    criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task_id, statuses=["satisfied"])
    for criterion in criteria:
        evidence = criterion.get("evidence") or {}
        if evidence.get("evidence_type") == "adversarial_check":
            return True
        if evidence.get("adversarial_check") is True:
            return True
    return False
```

- [ ] **Step 5: Enforce the finish gate**

In `command_finish_task`, after resolving `task` and before mutating task state, add:

```python
        if getattr(args, "require_adversarial_proof", False):
            if not _task_has_satisfied_adversarial_proof(conn, task_id=task["id"]):
                raise WorkerError(
                    "adversarial proof is required before finish; record satisfied evidence_type=adversarial_check"
                )
```

Do this before any calls that stop sessions or mark the task done.

- [ ] **Step 6: Run finish tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.FinishTaskTests -v
```

Expected: `PASS`.

- [ ] **Step 7: Update README**

Update finish-task docs:

```md
Use `--require-adversarial-proof` to fail before finishing unless the task has at least one satisfied criterion with `evidence_type=adversarial_check`. This is useful for manager-led work where `tests passed` is not enough by itself.
```

- [ ] **Step 8: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py tests/test_workerctl.py README.md
git commit -m "feat: gate task finish on adversarial proof"
```

---

## Task 5: Prove Dispatcher Blocks Missing Adversarial Evidence

**Files:**
- Modify: `tests/test_workerctl.py`
- Modify: `docs/qa/general-loop-templates.md`
- Modify: `docs/qa/ralph-loop.md`

- [ ] **Step 1: Write dispatcher policy regression test**

Add this test near existing Ralph-loop dispatcher tests:

```python
    def test_dispatch_blocks_continue_iteration_until_adversarial_check_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="dispatch-proof-task", goal="Require adversarial continuation proof.")
                worker_id = worker_db.register_session(conn, name="proof-worker", role="worker", cwd=tmpdir)
                manager_id = worker_db.register_session(conn, name="proof-manager", role="manager", cwd=tmpdir)
                worker_db.bind_task_session(conn, task_id=task_id, session_id=worker_id, role="worker")
                worker_db.bind_task_session(conn, task_id=task_id, session_id=manager_id, role="manager")
                run_id = worker_db.create_ralph_loop_run(
                    conn,
                    task_id=task_id,
                    max_iterations=2,
                    current_iteration=1,
                    required_before_continue=["adversarial_check"],
                    name="dispatch-proof-policy",
                )
                worker_db.enqueue_continue_iteration(
                    conn,
                    task_id=task_id,
                    message="Run iteration 2.",
                    loop_run_id=run_id,
                    requested_iteration=2,
                    correlation_id="corr-proof",
                )
                conn.commit()

            blocked = self.run_workerctl(
                "dispatch",
                "--once",
                "--type",
                "continue_iteration",
                "--dispatcher-id",
                "proof-dispatcher",
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(blocked.returncode, 0, blocked.stderr)
            blocked_payload = json.loads(blocked.stdout)
            self.assertEqual(blocked_payload["state"], "blocked")
            self.assertEqual(blocked_payload["missing_evidence"], ["adversarial_check"])

            proof = self.run_workerctl(
                "loop-evidence",
                "adversarial-check",
                "dispatch-proof-task",
                "--loop-run",
                run_id,
                "--iteration",
                "1",
                "--failure-mode",
                "The continuation repeats the same mistake.",
                "--check",
                "manager inspected the worker receipt and diff",
                "--result",
                "The receipt and diff show the issue was fixed before continuing.",
                "--correlation-id",
                "corr-proof",
                "--path",
                str(db_path),
            )
            self.assertEqual(proof.returncode, 0, proof.stderr)

            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.enqueue_continue_iteration(
                    conn,
                    task_id=task_id,
                    message="Run iteration 2 after proof.",
                    loop_run_id=run_id,
                    requested_iteration=2,
                    correlation_id="corr-proof-2",
                )
                conn.commit()

            delivered = self.run_workerctl(
                "dispatch",
                "--once",
                "--type",
                "continue_iteration",
                "--dispatcher-id",
                "proof-dispatcher",
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(delivered.returncode, 0, delivered.stderr)
            delivered_payload = json.loads(delivered.stdout)
            self.assertTrue(delivered_payload["delivered"])
            self.assertEqual(delivered_payload["command_type"], "continue_iteration")
```

- [ ] **Step 2: Run the regression test**

Run:

```bash
python3 -m unittest tests.test_workerctl.DispatchCommandQueueTests.test_dispatch_blocks_continue_iteration_until_adversarial_check_exists -v
```

Expected after Tasks 2 and 3: `PASS`. If it fails because helper names or test class names differ, move the test to the existing class that already covers `continue_iteration` dispatch blocking and use that class's `run_workerctl` helper.

- [ ] **Step 3: Update QA docs**

In `docs/qa/general-loop-templates.md`, add a step after creating a quality loop run:

```md
Before recording adversarial proof, queue `continue_iteration` for iteration 2 and run Dispatch. Acceptance: Dispatch blocks with `missing_evidence` containing `adversarial_check`, `delivered=false`, and no worker inbox delivery.
```

Then add:

```md
Record proof with `scripts/workerctl loop-evidence adversarial-check ...`. Queue a new `continue_iteration` command. Acceptance: Dispatch delivers the retry and replay links the proof criterion to the correlation id.
```

In `docs/qa/ralph-loop.md`, update the CI/PR iteration examples so the required evidence list includes `adversarial_check` and the QA receipt records it before allowed continuation.

- [ ] **Step 4: Run focused dispatcher and loop tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.DispatchCommandQueueTests tests.test_workerctl.LoopEvidenceCliTests tests.test_workerctl.LoopTemplatesCliTests -v
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add tests/test_workerctl.py docs/qa/general-loop-templates.md docs/qa/ralph-loop.md
git commit -m "test: prove adversarial evidence gates loop continuation"
```

---

## Task 6: Final Review, Issue #176 Mapping, And GoalBuddy Usage Notes

**Files:**
- Modify: `README.md`
- Modify: `docs/qa/general-loop-templates.md`
- Modify: `docs/qa/ralph-loop.md`
- Optional create: `docs/qa/adversarial-proof.md`

- [ ] **Step 1: Add issue #176 acceptance mapping**

Create `docs/qa/adversarial-proof.md` with:

```md
# Adversarial Proof

Adversarial proof is the burden-of-proof check used by manager-led and Ralph-loop workflows. It asks the manager or worker to assume the implementation may still be wrong until evidence proves otherwise.

## Required receipt

An adversarial proof receipt must record:

- `failure_mode`: the strongest realistic failure mode considered.
- `check`: the command, test, trace, screenshot, audit record, diff, or inspection used.
- `result`: why the check rules out the failure mode, or what remains unresolved.

## CTM enforcement

- Manager prompts include burden-of-proof guidance.
- `loop-evidence adversarial-check` records structured `evidence_type=adversarial_check`.
- Quality loop templates can require `adversarial_check` in `required_before_continue`.
- Dispatch blocks `continue_iteration` when required adversarial evidence is missing.
- `finish-task --require-adversarial-proof` blocks task completion until satisfied adversarial proof exists.

## GoalBuddy usage

When planning with GoalBuddy, include adversarial proof in the oracle:

> The goal is complete only when the implementation has passing verification and a recorded adversarial check naming the strongest realistic failure mode, the check that tried to disprove it, and evidence that rules it out or converts it into an explicit follow-up.
```

- [ ] **Step 2: Link the doc**

In `README.md`, add a link near the loop/criteria docs:

```md
See `docs/qa/adversarial-proof.md` for the burden-of-proof receipt shape and how it maps to manager prompts, Ralph-loop evidence, Dispatch blocking, and audited finish.
```

In `docs/qa/ralph-loop.md` and `docs/qa/general-loop-templates.md`, link to `docs/qa/adversarial-proof.md` where `adversarial_check` first appears.

- [ ] **Step 3: Run full focused suite**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests tests.test_workerctl.LoopTemplatesCliTests tests.test_workerctl.LoopEvidenceCliTests tests.test_workerctl.DispatchCommandQueueTests tests.test_workerctl.FinishTaskTests -v
```

Expected: `PASS`.

- [ ] **Step 4: Run repo review checks**

Run:

```bash
python3 -m unittest tests.test_workerctl -v
```

Expected: `PASS`. If the full suite is too slow locally, record the focused suite above plus the reason full suite was not completed.

- [ ] **Step 5: Run PR review toolkit**

Run the repo's established PR review toolkit command. If no single command exists, use:

```bash
git diff --check
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests tests.test_workerctl.LoopTemplatesCliTests tests.test_workerctl.LoopEvidenceCliTests tests.test_workerctl.DispatchCommandQueueTests tests.test_workerctl.FinishTaskTests -v
```

Expected: no whitespace errors and all focused tests pass.

- [ ] **Step 6: Commit final docs**

```bash
git add README.md docs/qa/adversarial-proof.md docs/qa/general-loop-templates.md docs/qa/ralph-loop.md
git commit -m "docs: map adversarial proof gates to issue 176"
```

---

## Acceptance Criteria

- Manager bootstrap prompts include operational burden-of-proof language from issue #176.
- `README.md` and `skills/manage-codex-workers/SKILL.md` tell managers not to accept worker claims, happy-path tests, or summaries as proof by themselves.
- `loop-templates --show visual_diff_loop --json` includes `adversarial_check` in `required_before_continue` and `artifact_requirements`.
- `loop-evidence adversarial-check` records a satisfied acceptance criterion with:
  - `evidence_type=adversarial_check`
  - `failure_mode`
  - `check`
  - `result`
  - optional `artifact_path`
  - optional `correlation_id`
- Dispatch blocks `continue_iteration` when a loop requires `adversarial_check` for the previous iteration and no satisfied proof exists.
- Dispatch delivers a retry after `loop-evidence adversarial-check` records the missing proof.
- `finish-task --require-adversarial-proof` fails closed without satisfied adversarial proof.
- `finish-task --require-adversarial-proof` succeeds when a satisfied criterion has `evidence_type=adversarial_check`.
- QA docs explain how GoalBuddy oracles should include adversarial proof.

---

## GoalBuddy Board Shape For This Work

If this plan is converted into a GoalBuddy board, the oracle should be:

```text
A focused local QA run proves issue #176 is operational: manager prompts require a burden-of-proof stance; a quality Ralph-loop template requires adversarial_check; Dispatch blocks iteration 2 before worker delivery when adversarial proof is missing; loop-evidence adversarial-check records structured proof and unblocks the retry; finish-task --require-adversarial-proof fails without proof and succeeds with proof; docs map the behavior back to issue #176.
```

Suggested vertical slices:

1. Prompt/docs slice: manager burden-of-proof guidance plus tests.
2. Policy slice: quality templates require `adversarial_check`.
3. Evidence slice: structured `loop-evidence adversarial-check`.
4. Gate slice: finish-task proof gate and dispatcher regression.
5. QA/docs slice: issue #176 mapping and final focused verification.

---

## Self-Review

Spec coverage: issue #176 asks for adversarial burden-of-proof prompts, finish/export criteria pressure, docs clarity, and operational wording. Tasks 1, 4, and 6 cover prompts and finish docs; Tasks 2, 3, and 5 make the proof first-class in loop policy and dispatcher behavior.

Placeholder scan: no `TBD`, `TODO`, or “add tests” placeholders remain. Each task names exact files, commands, and expected behavior.

Type consistency: the evidence type is consistently `adversarial_check`; CLI spelling is `adversarial-check`; metadata fields are consistently `failure_mode`, `check`, and `result`.
