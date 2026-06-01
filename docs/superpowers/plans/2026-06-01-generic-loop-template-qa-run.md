# Generic Loop Template QA Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an executable `workerctl qa-run generic-loop-template` receipt run that proves generic loop templates, especially `visual_diff_loop`, obey the same Dispatch guardrails as Ralph-loop presets.

**Architecture:** Extend the existing `qa-run` command rather than adding a separate tool. Reuse the no-tmux manager/worker binding helpers, queue-cleanliness guard, one-command dispatch helper, and JSON receipt pattern added for `ralph-loop-guardrails`. The new scenario creates a `visual_diff_loop` policy run through generic template metadata, proves missing evidence blocks delivery, proves unstructured adversarial evidence does not unblock the loop, records the required visual artifacts plus structured adversarial proof, and verifies a fresh retry reaches the worker pull inbox.

**Tech Stack:** Python stdlib, `unittest`, SQLite-backed `workerctl.db`, existing `workerctl` CLI, existing `workerctl.loop_templates`, existing Dispatch `continue_iteration` policy enforcement.

---

## Acceptance Criteria

- `scripts/workerctl qa-run generic-loop-template --receipt-output RECEIPT.json --json` exits `0`, writes a receipt, and prints a stable JSON summary.
- The receipt proves the run used generic `loop-templates` metadata for `visual_diff_loop`, not a bespoke Ralph-loop preset-only path.
- The first continuation attempt is blocked with `reason=missing_required_evidence` and exact missing evidence:
  `["reference_artifact","candidate_screenshot","visual_diff_report","diff_below_threshold","adversarial_check"]`.
- The blocked attempt creates no routed notifications and no worker inbox item.
- Recording generic visual evidence plus an unstructured `adversarial_check` still blocks a fresh continuation with exact missing evidence `["adversarial_check"]`.
- Recording structured `adversarial_check` evidence with non-empty `failure_mode`, `check`, and `result` allows a fresh retry to deliver with `state=pull_required` and exactly one worker inbox item.
- Existing dirty/stale queue protections apply to both `ralph-loop-guardrails` and `generic-loop-template`.
- Docs and the manual QA checklist include the new command and expected proof.
- Focused tests, full `tests.test_workerctl`, static syntax checks, direct receipt run, dirty/stale queue disproof, and codex-review helper all pass before PR/merge.

## Files

- Modify: `workerctl/cli.py`
  - Add `generic-loop-template` to `qa-run` scenario choices.
- Modify: `workerctl/commands.py`
  - Add `_qa_run_generic_loop_template`.
  - Update `command_qa_run` to dispatch scenarios through a mapping.
  - Reuse existing helpers where possible.
- Modify: `tests/test_workerctl.py`
  - Add happy-path receipt test for `generic-loop-template`.
  - Extend dirty/stale queue tests to prove both scenarios refuse contaminated queues.
- Modify: `README.md`
  - Document the new executable QA scenario.
- Modify: `docs/manual-qa-checklist.md`
  - Add manual checklist item for the saved generic-template receipt.

## Task 1: Add Failing Tests For The New Scenario

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add the generic-template receipt test**

Add this test near the existing `test_qa_run_ralph_loop_guardrails_writes_replayable_receipt` test:

```python
    def test_qa_run_generic_loop_template_writes_replayable_receipt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            receipt_path = Path(tmpdir) / "receipt.json"

            proc = self.run_workerctl(
                "qa-run",
                "generic-loop-template",
                "--receipt-output",
                str(receipt_path),
                "--path",
                str(db_path),
                "--json",
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(receipt_path.exists())
            summary = json.loads(proc.stdout)
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(summary["scenario"], "generic-loop-template")
            self.assertEqual(summary["result"], "passed")
            self.assertEqual(summary["checks"], 3)
            self.assertEqual(receipt["scenario"], "generic-loop-template")
            self.assertEqual(receipt["template"], "visual_diff_loop")
            self.assertEqual(receipt["result"], "passed")
            self.assertEqual(Path(receipt["artifacts"]["db_path"]), db_path.resolve())
            self.assertEqual(receipt["template_metadata"]["template"], "visual_diff_loop")
            self.assertEqual(receipt["template_metadata"]["cleanup_policy"], "compact")
            self.assertEqual(
                receipt["template_metadata"]["required_before_continue"],
                [
                    "reference_artifact",
                    "candidate_screenshot",
                    "visual_diff_report",
                    "diff_below_threshold",
                    "adversarial_check",
                ],
            )

            checks = {check["name"]: check for check in receipt["checks"]}
            missing = checks["visual_template_blocks_before_visual_evidence"]
            self.assertEqual(missing["status"], "passed")
            self.assertEqual(missing["dispatch"]["state"], "blocked")
            self.assertEqual(missing["dispatch"]["reason"], "missing_required_evidence")
            self.assertEqual(
                missing["dispatch"]["missing_evidence"],
                [
                    "reference_artifact",
                    "candidate_screenshot",
                    "visual_diff_report",
                    "diff_below_threshold",
                    "adversarial_check",
                ],
            )
            self.assertEqual(missing["routed_notifications_count"], 0)
            self.assertEqual(missing["worker_inbox_count"], 0)

            unstructured = checks["unstructured_adversarial_check_still_blocks"]
            self.assertEqual(unstructured["status"], "passed")
            self.assertEqual(unstructured["dispatch"]["state"], "blocked")
            self.assertEqual(unstructured["dispatch"]["missing_evidence"], ["adversarial_check"])
            self.assertEqual(unstructured["worker_inbox_count"], 0)

            allowed = checks["structured_visual_evidence_retry_delivers"]
            self.assertEqual(allowed["status"], "passed")
            self.assertEqual(allowed["dispatch"]["state"], "pull_required")
            self.assertEqual(allowed["worker_inbox_count"], 1)

            replay_commands = "\n".join(receipt["replay_commands"])
            self.assertIn("loop-templates --show visual_diff_loop", replay_commands)
            self.assertIn("loop-evidence visual-diff", replay_commands)
            self.assertIn("loop-evidence adversarial-check", replay_commands)
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt
```

Expected: fail because `generic-loop-template` is not an accepted `qa-run` scenario.

- [ ] **Step 3: Add scenario-param dirty queue regression**

Replace the first line of `test_qa_run_refuses_to_share_dirty_continue_iteration_queue` with a loop over both scenarios:

```python
    def test_qa_run_refuses_to_share_dirty_continue_iteration_queue(self):
        for scenario in ("ralph-loop-guardrails", "generic-loop-template"):
            with self.subTest(scenario=scenario):
                with tempfile.TemporaryDirectory() as tmpdir:
                    db_path = Path(tmpdir) / "workerctl.db"
                    receipt_path = Path(tmpdir) / "receipt.json"
                    with worker_db.connect(db_path) as conn:
                        worker_db.initialize_database(conn)
                        task_id = worker_db.create_task(conn, name="preexisting-task", goal="Existing queue.")
                        conn.execute("update tasks set state = 'managed' where id = ?", (task_id,))
                        worker_db.register_session(
                            conn,
                            name="preexisting-worker",
                            role="worker",
                            codex_session_path="/tmp/preexisting-worker.jsonl",
                            codex_session_id="preexisting-worker",
                            pid=os.getpid(),
                            cwd=str(ROOT),
                            tmux_session=None,
                        )
                        worker_db.register_session(
                            conn,
                            name="preexisting-manager",
                            role="manager",
                            codex_session_path="/tmp/preexisting-manager.jsonl",
                            codex_session_id="preexisting-manager",
                            pid=os.getpid(),
                            cwd=str(ROOT),
                            tmux_session=None,
                        )
                        worker_db.bind_sessions(
                            conn,
                            task_name="preexisting-task",
                            worker_session_name="preexisting-worker",
                            manager_session_name="preexisting-manager",
                        )
                        run_id = worker_db.create_ralph_loop_run(
                            conn,
                            task_id=task_id,
                            name="preexisting-run",
                            max_iterations=3,
                            current_iteration=1,
                            required_before_continue=[],
                        )
                        command_id = worker_db.enqueue_continue_iteration(
                            conn,
                            task_id=task_id,
                            message="Do not consume me.",
                            loop_run_id=run_id,
                            requested_iteration=2,
                            correlation_id="preexisting-command",
                        )
                        conn.commit()

                    proc = self.run_workerctl(
                        "qa-run",
                        scenario,
                        "--receipt-output",
                        str(receipt_path),
                        "--path",
                        str(db_path),
                        "--json",
                    )

                    self.assertNotEqual(proc.returncode, 0)
                    self.assertIn("continue_iteration dispatch queue is not clean", proc.stderr)
                    self.assertFalse(receipt_path.exists())
                    with worker_db.connect(db_path) as conn:
                        command = conn.execute(
                            "select state from commands where id = ?",
                            (command_id,),
                        ).fetchone()
                        self.assertEqual(command["state"], "pending")
```

- [ ] **Step 4: Add scenario-param stale attempted queue regression**

Apply the same loop structure to `test_qa_run_refuses_stale_attempted_continue_iteration_queue`, using `scenario` in the `qa-run` invocation and keeping the final assertion `self.assertEqual(command["state"], "attempted")`.

- [ ] **Step 5: Run the focused failing tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue \
  tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue
```

Expected: at least the new scenario fails because CLI choices and `command_qa_run` do not support `generic-loop-template`.

## Task 2: Add CLI Scenario Routing

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`

- [ ] **Step 1: Add the new scenario choice**

In `workerctl/cli.py`, update the `qa_run.add_argument("scenario", ...)` choices:

```python
    qa_run.add_argument(
        "scenario",
        nargs="?",
        default="ralph-loop-guardrails",
        choices=("ralph-loop-guardrails", "generic-loop-template"),
    )
```

- [ ] **Step 2: Convert `command_qa_run` to a scenario map**

Replace the current `command_qa_run` body with:

```python
def command_qa_run(args: argparse.Namespace) -> int:
    scenario = getattr(args, "scenario", "ralph-loop-guardrails")
    scenarios = {
        "ralph-loop-guardrails": _qa_run_ralph_loop_guardrails,
        "generic-loop-template": _qa_run_generic_loop_template,
    }
    try:
        runner = scenarios[scenario]
    except KeyError as exc:
        raise WorkerError(f"Unsupported QA run scenario: {scenario}") from exc

    receipt_output = Path(args.receipt_output).expanduser().resolve()
    receipt_output.parent.mkdir(parents=True, exist_ok=True)
    receipt = runner(args)
    receipt["receipt_path"] = str(receipt_output)
    receipt_output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    summary = {
        "checks": len(receipt["checks"]),
        "receipt_path": str(receipt_output),
        "result": receipt["result"],
        "scenario": receipt["scenario"],
    }
    if getattr(args, "json", False):
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(f"QA run {scenario}: {receipt['result']}")
        print(f"Receipt: {receipt_output}")
    return 0
```

- [ ] **Step 3: Run the focused new test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt
```

Expected: fail with `NameError` or similar because `_qa_run_generic_loop_template` is not implemented yet.

## Task 3: Implement Generic Template Harness

**Files:**
- Modify: `workerctl/commands.py`

- [ ] **Step 1: Add a helper to record visual-template evidence**

Add this helper after `_qa_run_record_loop_evidence`:

```python
def _qa_run_record_visual_template_evidence(
    *,
    db_path: Path,
    task_name: str,
    loop_run_id: str,
) -> list[dict[str, Any]]:
    evidence_records = []
    for evidence_type, metadata in (
        (
            "reference_artifact",
            {
                "artifact_path": "/tmp/qa-run-reference.png",
                "description": "Reference UX screenshot for generic template QA.",
            },
        ),
        (
            "candidate_screenshot",
            {
                "artifact_path": "/tmp/qa-run-candidate.png",
                "viewport": "1440x900",
            },
        ),
        (
            "visual_diff_report",
            {
                "artifact_path": "/tmp/qa-run-visual-diff.json",
                "diff_score": 0.0,
                "threshold": 0.02,
                "below_threshold": True,
                "viewport": "1440x900",
            },
        ),
        (
            "diff_below_threshold",
            {
                "diff_score": 0.0,
                "threshold": 0.02,
                "below_threshold": True,
            },
        ),
    ):
        evidence_records.append(
            _qa_run_record_loop_evidence(
                db_path=db_path,
                task_name=task_name,
                loop_run_id=loop_run_id,
                evidence_type=evidence_type,
                correlation_id=f"qa-run-visual-{evidence_type}",
                status="pass",
                metadata=metadata,
            )
        )
    return evidence_records
```

- [ ] **Step 2: Add `_qa_run_generic_loop_template`**

Add this function before `command_qa_run`:

```python
def _qa_run_generic_loop_template(args: argparse.Namespace) -> dict[str, Any]:
    from workerctl import db as worker_db
    from workerctl.loop_templates import loop_template_metadata

    db_path = _qa_run_db_path(args)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    slug = uuid.uuid4().hex[:8]
    dispatcher_id = getattr(args, "dispatcher_id", None) or f"qa-run-{slug}"
    checks: list[dict[str, Any]] = []
    metadata = loop_template_metadata(
        "visual_diff_loop",
        max_iterations=4,
        current_iteration=1,
        seed_prompt_sha256="qa-run-generic-template-seed",
    )
    required = metadata["required_before_continue"]

    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        _qa_run_require_clean_continue_queue(conn, worker_db=worker_db)
        task = _qa_run_bound_task(conn, slug=slug, suffix="generic-template")
        run_id = worker_db.create_ralph_loop_run(
            conn,
            task_id=task["task_id"],
            name=f"{task['task_name']}-visual-diff-run",
            max_iterations=metadata["max_iterations"],
            current_iteration=metadata["current_iteration"],
            cleanup_policy=metadata["cleanup_policy"],
            required_before_continue=required,
            stop_conditions=metadata["stop_conditions"],
            seed_prompt_sha256=metadata["seed_prompt_sha256"],
            preset=metadata["preset"],
            metadata=metadata,
        )
        worker_db.enqueue_continue_iteration(
            conn,
            task_id=task["task_id"],
            message="Run visual diff iteration 2 before visual evidence.",
            loop_run_id=run_id,
            requested_iteration=2,
            correlation_id="qa-run-visual-missing-evidence",
        )
        conn.commit()

    missing_dispatch = _qa_run_dispatch_continue_once(
        db_path=db_path,
        dispatcher_id=dispatcher_id,
        expected_correlation_id="qa-run-visual-missing-evidence",
    )
    missing_counts = _qa_run_delivery_counts(db_path=db_path, task_id=task["task_id"], worker_name=task["worker_name"])
    _qa_run_require(missing_dispatch.get("state") == "blocked", "visual template drill did not block before evidence")
    _qa_run_require(missing_dispatch.get("reason") == "missing_required_evidence", "visual template drill used the wrong block reason")
    _qa_run_require(missing_dispatch.get("missing_evidence") == required, "visual template drill reported the wrong missing evidence")
    _qa_run_require(missing_counts["routed_notifications_count"] == 0, "visual template drill created a routed notification")
    _qa_run_require(missing_counts["worker_inbox_count"] == 0, "visual template drill left worker inbox mail")
    checks.append(
        _qa_run_check_result(
            name="visual_template_blocks_before_visual_evidence",
            dispatch=missing_dispatch,
            counts=missing_counts,
            command="workerctl loop-templates --create-run <task> --template visual_diff_loop && workerctl dispatch --once --type continue_iteration",
        )
    )

    _qa_run_record_visual_template_evidence(
        db_path=db_path,
        task_name=task["task_name"],
        loop_run_id=run_id,
    )
    _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=task["task_name"],
        loop_run_id=run_id,
        evidence_type="adversarial_check",
        correlation_id="qa-run-visual-unstructured-adversarial",
        metadata={"note": "This intentionally lacks failure_mode/check/result and must not satisfy Dispatch."},
    )
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        worker_db.enqueue_continue_iteration(
            conn,
            task_id=task["task_id"],
            message="Run visual diff iteration 2 after visual evidence but before structured adversarial proof.",
            loop_run_id=run_id,
            requested_iteration=2,
            correlation_id="qa-run-visual-unstructured-block",
        )
        conn.commit()
    unstructured_dispatch = _qa_run_dispatch_continue_once(
        db_path=db_path,
        dispatcher_id=dispatcher_id,
        expected_correlation_id="qa-run-visual-unstructured-block",
    )
    unstructured_counts = _qa_run_delivery_counts(db_path=db_path, task_id=task["task_id"], worker_name=task["worker_name"])
    _qa_run_require(unstructured_dispatch.get("state") == "blocked", "unstructured adversarial evidence unexpectedly delivered")
    _qa_run_require(unstructured_dispatch.get("missing_evidence") == ["adversarial_check"], "unstructured adversarial drill reported the wrong missing evidence")
    _qa_run_require(unstructured_counts["worker_inbox_count"] == 0, "unstructured adversarial drill left worker inbox mail")
    checks.append(
        _qa_run_check_result(
            name="unstructured_adversarial_check_still_blocks",
            dispatch=unstructured_dispatch,
            counts=unstructured_counts,
            command="workerctl loop-evidence add --evidence-type adversarial_check --metadata-json '{\"note\":\"not enough\"}' && workerctl dispatch --once --type continue_iteration",
        )
    )

    _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=task["task_name"],
        loop_run_id=run_id,
        evidence_type="adversarial_check",
        correlation_id="qa-run-visual-structured-adversarial",
        metadata=_adversarial_check_metadata(
            {
                "failure_mode": "A visual loop could continue after artifact receipts while hiding unacceptable screenshot drift.",
                "check": "Inspect reference artifact, candidate screenshot, visual diff report, threshold receipt, and empty blocked inbox before retry.",
                "result": "The generic template stayed blocked until all visual receipts and structured adversarial proof existed.",
            }
        ),
    )
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        worker_db.enqueue_continue_iteration(
            conn,
            task_id=task["task_id"],
            message="Run visual diff iteration 2 after all visual template evidence.",
            loop_run_id=run_id,
            requested_iteration=2,
            correlation_id="qa-run-visual-allowed",
        )
        conn.commit()
    allowed_dispatch = _qa_run_dispatch_continue_once(
        db_path=db_path,
        dispatcher_id=dispatcher_id,
        expected_correlation_id="qa-run-visual-allowed",
    )
    allowed_counts = _qa_run_delivery_counts(db_path=db_path, task_id=task["task_id"], worker_name=task["worker_name"])
    _qa_run_require(allowed_dispatch.get("state") == "pull_required", "structured visual evidence retry did not deliver")
    _qa_run_require(allowed_counts["worker_inbox_count"] == 1, "structured visual evidence retry did not create exactly one worker inbox item")
    checks.append(
        _qa_run_check_result(
            name="structured_visual_evidence_retry_delivers",
            dispatch=allowed_dispatch,
            counts=allowed_counts,
            command="workerctl loop-evidence visual-diff ... && workerctl loop-evidence adversarial-check ... && workerctl dispatch --once --type continue_iteration",
        )
    )

    return {
        "artifacts": {"db_path": str(db_path)},
        "checks": checks,
        "generated_at": now_iso(),
        "replay_commands": [
            "scripts/workerctl loop-templates --show visual_diff_loop --json",
            "scripts/workerctl loop-templates --create-run <task> --template visual_diff_loop --current-iteration 1 --json",
            f"scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id {dispatcher_id} --path {db_path}",
            "scripts/workerctl loop-evidence visual-diff <task> --loop-run <run-id> --iteration 1 --reference reference.png --candidate candidate.png --threshold 0.02 --report-output visual-diff.json --diff-output visual-diff.png",
            "scripts/workerctl loop-evidence adversarial-check <task> --loop-run <run-id> --iteration 1 --failure-mode <failure> --check <check> --result <result>",
        ],
        "result": "passed",
        "scenario": "generic-loop-template",
        "template": "visual_diff_loop",
        "template_metadata": metadata,
    }
```

- [ ] **Step 3: Run the focused generic-template receipt test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt
```

Expected: pass.

- [ ] **Step 4: Run all focused qa-run tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_run_ralph_loop_guardrails_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue \
  tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue
```

Expected: pass.

## Task 4: Document The New Executable QA Run

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-qa-checklist.md`

- [ ] **Step 1: Update README command reference**

In the `qa-run` bullet, replace the existing text with:

```markdown
- `qa-run <ralph-loop-guardrails|generic-loop-template> --receipt-output RECEIPT.json [--path DB]` —
  Run a deterministic no-tmux QA harness and save a JSON receipt.
  `ralph-loop-guardrails` proves max-iteration cutoff, missing-evidence
  cutoff, structured `adversarial_check` retry delivery, and the
  `pr_ci_merge_loop` preset evidence gate. `generic-loop-template` proves the
  `visual_diff_loop` template blocks before visual evidence, rejects
  unstructured adversarial evidence, and delivers only after required visual
  receipts plus structured adversarial proof exist.
```

- [ ] **Step 2: Update README examples**

Add this example next to the existing `qa-run ralph-loop-guardrails` example:

```bash
scripts/workerctl qa-run generic-loop-template --receipt-output /tmp/generic-loop-template-receipt.json --json
```

- [ ] **Step 3: Update manual QA checklist**

Add this checklist item after the Ralph-loop `qa-run` item:

```markdown
- [ ] `scripts/workerctl qa-run generic-loop-template --receipt-output /tmp/generic-loop-template-receipt.json --json` writes a saved receipt proving `visual_diff_loop` metadata, missing visual evidence cutoff, unstructured `adversarial_check` refusal, and fresh retry delivery only after visual evidence plus structured adversarial proof.
```

- [ ] **Step 4: Run doc-related tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_readme_documents_generic_loop_templates \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_general_loop_template_qa_documents_visual_drill
```

Expected: pass.

## Task 5: Verification And Adversarial Review

**Files:**
- No file edits unless a check fails.

- [ ] **Step 1: Run focused qa-run tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_run_ralph_loop_guardrails_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue \
  tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue
```

Expected: pass.

- [ ] **Step 2: Run full workerctl tests**

Run:

```bash
python3 -m unittest tests.test_workerctl
```

Expected: pass.

- [ ] **Step 3: Run static checks**

Run:

```bash
python3 -m py_compile workerctl/commands.py workerctl/cli.py && git diff --check
```

Expected: exit `0`.

- [ ] **Step 4: Run direct fresh receipt proof**

Run:

```bash
tmp="$(mktemp -d)"
scripts/workerctl qa-run generic-loop-template \
  --receipt-output "$tmp/receipt.json" \
  --path "$tmp/workerctl.db" \
  --json
python3 - <<'PY' "$tmp/receipt.json"
import json, sys
receipt = json.load(open(sys.argv[1]))
checks = {check["name"]: check for check in receipt["checks"]}
print(receipt["result"], receipt["template"], len(receipt["checks"]))
print(checks["visual_template_blocks_before_visual_evidence"]["dispatch"]["reason"])
print(checks["unstructured_adversarial_check_still_blocks"]["dispatch"]["missing_evidence"])
print(checks["structured_visual_evidence_retry_delivers"]["dispatch"]["state"])
PY
```

Expected:

```text
passed visual_diff_loop 3
missing_required_evidence
['adversarial_check']
pull_required
```

- [ ] **Step 5: Try to disprove queue isolation for both scenarios**

Run the existing dirty/stale focused tests from Step 1. They prove both `ralph-loop-guardrails` and `generic-loop-template` refuse contaminated queues. Do not proceed if a preexisting pending command becomes `succeeded`, `failed`, or `attempted`, or if a stale attempted command changes state.

- [ ] **Step 6: Run codex-review helper**

Run:

```bash
skills/codex-review/scripts/codex-review \
  --mode local \
  --full-access \
  --parallel-tests "python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_ralph_loop_guardrails_writes_replayable_receipt tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue && python3 -m py_compile workerctl/commands.py workerctl/cli.py && git diff --check"
```

Expected: `codex-review clean: no accepted/actionable findings reported`.

## Task 6: PR, CI, And Merge

**Files:**
- No code edits unless CI or review fails.

- [ ] **Step 1: Inspect final diff**

Run:

```bash
git status --short --branch
git diff --stat
```

Expected: only intended files changed.

- [ ] **Step 2: Commit**

Run:

```bash
git add README.md docs/manual-qa-checklist.md tests/test_workerctl.py workerctl/cli.py workerctl/commands.py
git commit -m "Add generic loop template QA receipt run"
```

- [ ] **Step 3: Push and open PR**

Run:

```bash
git push -u origin codex/generic-loop-template-qa-run
gh pr create \
  --base main \
  --head codex/generic-loop-template-qa-run \
  --title "Add generic loop template QA receipt run" \
  --body "$(cat <<'EOF'
## Summary
- adds `workerctl qa-run generic-loop-template`
- proves `visual_diff_loop` blocks before visual evidence and before structured adversarial proof
- documents the new saved receipt command

## Verification
- `python3 -m unittest tests.test_workerctl`
- `python3 -m py_compile workerctl/commands.py workerctl/cli.py && git diff --check`
- direct `qa-run generic-loop-template` receipt proof
- dirty/stale queue regression tests
- codex-review helper clean

## Burden of proof
Strongest failure mode tested: generic visual evidence plus an unstructured adversarial-check receipt could accidentally unblock Dispatch. The new receipt run proves it remains blocked with `missing_evidence=["adversarial_check"]` until structured `failure_mode`, `check`, and `result` proof exists.
EOF
)"
```

- [ ] **Step 4: Monitor CI and merge when green**

Run:

```bash
gh pr checks --watch --interval 10
gh pr merge --squash --delete-branch
```

Expected: all checks pass, PR merges to `main`, local checkout fast-forwards cleanly.

## Self-Review

- **Spec coverage:** This plan covers the next step only: an executable `qa-run` for generic loop templates. It does not rebuild loop templates, because those already exist. It proves generic `visual_diff_loop` metadata, missing-evidence cutoff, unstructured adversarial rejection, structured adversarial delivery, docs, queue isolation, PR review, CI, and merge.
- **Placeholder scan:** No `TBD`, `TODO`, or undefined acceptance criteria remain. The only angle-bracket values are replay-command examples intended for humans inside receipts.
- **Type consistency:** The plan uses existing scenario strings, helper signatures, and receipt structures from `ralph-loop-guardrails`. The new test expects three generic-template checks plus stable `template` and `template_metadata` receipt keys.
