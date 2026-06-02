# Ralph Loop Real Work Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ralph-loop runs ready for real vertical slices by adding an operator guide, one non-test-coverage deterministic QA proof, and a compact loop-status summary command.

**Architecture:** Keep Dispatch as the authority and avoid new loop machinery. Document the operator contract, reuse existing `loop-templates`/`loop-evidence`/`worker-inbox` primitives for a new deterministic QA scenario, and add one read-only summary command that aggregates existing task, run, command, notification, inbox, criteria, and telemetry data.

**Tech Stack:** Python standard library, SQLite-backed `workerctl`, existing `unittest` suite, Markdown docs, GitHub PR/CI flow.

---

## File Structure

- Modify `README.md`: add the operator guide and new command/scenario to the command reference.
- Modify `docs/manual-qa-checklist.md`: add the guide, non-coverage QA run, and status summary checks.
- Modify `docs/qa/README.md`: link the new operator guide.
- Create `docs/qa/ralph-loop-operator-guide.md`: concise natural-language trigger and operating guide.
- Modify `docs/qa/general-loop-templates.md`: cross-link the new non-coverage QA scenario.
- Modify `workerctl/cli.py`: add `qa-run build-clear-loop` and `loop-status`.
- Modify `workerctl/commands.py`: add plan content, deterministic `build_clear_loop` QA runner, and read-only loop-status implementation.
- Modify `tests/test_workerctl.py`: add focused CLI, receipt, docs, and status summary tests.

---

### Task 1: Operator Guide For Real Ralph Loops

**Files:**
- Create: `docs/qa/ralph-loop-operator-guide.md`
- Modify: `README.md`
- Modify: `docs/qa/README.md`
- Modify: `docs/manual-qa-checklist.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing documentation tests**

Add this test near the existing docs tests in `tests/test_workerctl.py`:

```python
def test_docs_include_ralph_loop_operator_guide(self):
    guide = (ROOT / "docs" / "qa" / "ralph-loop-operator-guide.md").read_text()
    qa_readme = (ROOT / "docs" / "qa" / "README.md").read_text()
    readme = (ROOT / "README.md").read_text()
    checklist = (ROOT / "docs" / "manual-qa-checklist.md").read_text()

    for document in (guide, qa_readme, readme, checklist):
        self.assertIn("Ralph loop operator guide", document)
    self.assertIn("Run this as an adversarially gated Ralph loop.", guide)
    self.assertIn("Do not send the worker another iteration until adversarial proof exists.", guide)
    self.assertIn("loop-triggers --classify", guide)
    self.assertIn("loop-templates --create-run", guide)
    self.assertIn("enqueue-continue-iteration", guide)
    self.assertIn("worker-inbox", guide)
    self.assertIn("loop-evidence adversarial-check", guide)
    self.assertIn("telemetry failures", guide)
    self.assertIn("loop-status", guide)
    self.assertIn("max_iterations", guide)
    self.assertIn("required_before_continue", guide)
    self.assertIn("The manager asks; Dispatch decides.", guide)
    self.assertIn("Generic caution does not arm a loop gate", guide)
```

- [ ] **Step 2: Run the failing docs test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_docs_include_ralph_loop_operator_guide
```

Expected: fail because `docs/qa/ralph-loop-operator-guide.md` does not exist.

- [ ] **Step 3: Create the operator guide**

Create `docs/qa/ralph-loop-operator-guide.md`:

```markdown
# Ralph loop operator guide

Use this guide when a manager should run a bounded manager/worker loop with Dispatch enforcing the rails. The core rule is:

> The manager asks; Dispatch decides.

The manager can request another worker iteration, but Dispatch blocks delivery unless the loop policy permits it. A blocked continuation must leave the worker inbox empty.

## Natural-language triggers

Use `scripts/workerctl loop-triggers --classify "<prompt>" --json` before turning operator prose into loop policy.

Controlled trigger examples:

- `Run this as an adversarially gated Ralph loop.`
- `Do not send the worker another iteration until adversarial proof exists.`
- `Do not mark this done until you have tried to disprove it.`
- `Ask the worker to identify the strongest realistic failure mode and prove it is handled.`
- `Each loop must include adversarial acceptance criteria from manager to worker.`

Generic caution does not arm a loop gate. For example, `be careful, run tests, and summarize risks` is guidance, not permission to create a loop policy.

## Standard operating sequence

1. Classify the prompt:

   ```bash
   scripts/workerctl loop-triggers --classify "Run this as an adversarially gated Ralph loop." --json
   ```

2. Create a template-backed loop run:

   ```bash
   scripts/workerctl loop-templates --create-run <task> --template <template> --max-iterations 3 --current-iteration 1 --json
   ```

3. Ask the worker for the first iteration through the normal manager/worker task flow.

4. Record required evidence before another iteration:

   ```bash
   scripts/workerctl loop-evidence add <task> --loop-run <run> --iteration 1 --evidence-type <evidence_type> --artifact-path <path>
   scripts/workerctl loop-evidence adversarial-check <task> --loop-run <run> --iteration 1 --failure-mode "<risk>" --check "<command or inspection>" --result "<why handled>"
   ```

5. Queue the manager-requested continuation:

   ```bash
   scripts/workerctl enqueue-continue-iteration <task> --loop-run <run> --requested-iteration 2 --message "Run the next bounded iteration." --json
   ```

6. Let Dispatch enforce policy:

   ```bash
   scripts/workerctl dispatch --once --type continue_iteration --json
   ```

7. For Codex app or no-tmux sessions, poll and consume the inbox:

   ```bash
   scripts/workerctl worker-inbox <task> --consume-next --wait --timeout 30 --json
   ```

8. Review status and telemetry before continuing:

   ```bash
   scripts/workerctl loop-status <task> --run <run> --json
   scripts/workerctl telemetry failures --task <task> --json
   ```

## Pass bar for real vertical slices

- `max_iterations` is present and blocks over-looping.
- `required_before_continue` is present for quality loops.
- Blocked Dispatch attempts have `state=blocked`, `delivered=false`, and worker inbox count `0`.
- Allowed Dispatch attempts include `run_id`, `loop_policy`, `requested_iteration`, `current_iteration`, `max_iterations`, and `missing_evidence=[]`.
- Worker inbox consumption emits searchable `dispatch_inbox_consumed` telemetry.
- The final report includes `loop-status`, `telemetry failures`, `audit`, `replay`, PR/CI/merge receipts when relevant, and an adversarial proof record.
```

- [ ] **Step 4: Link the guide from existing docs**

Add one paragraph to `README.md` near the loop command reference:

```markdown
For real vertical slices, start with the Ralph loop operator guide in
`docs/qa/ralph-loop-operator-guide.md`. It explains the controlled
natural-language triggers, Dispatch authority model, worker inbox polling,
required evidence, adversarial proof, `loop-status`, and telemetry review pass
bar.
```

Add one bullet to `docs/qa/README.md`:

```markdown
- [Ralph loop operator guide](ralph-loop-operator-guide.md): natural-language triggers, Dispatch authority, inbox polling, required evidence, adversarial proof, and telemetry review for real vertical slices.
```

Add one checklist item to `docs/manual-qa-checklist.md`:

```markdown
- [ ] Ralph loop operator guide documents the real-work sequence: `loop-triggers --classify`, `loop-templates --create-run`, `loop-evidence adversarial-check`, `enqueue-continue-iteration`, `worker-inbox --consume-next --wait`, `loop-status`, and `telemetry failures`.
```

- [ ] **Step 5: Run the docs test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_docs_include_ralph_loop_operator_guide
```

Expected: pass.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add README.md docs/qa/README.md docs/qa/ralph-loop-operator-guide.md docs/manual-qa-checklist.md tests/test_workerctl.py
git commit -m "Document Ralph loop operator guide"
```

---

### Task 2: Deterministic Non-Coverage QA Run

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Modify: `README.md`
- Modify: `docs/manual-qa-checklist.md`
- Modify: `docs/qa/general-loop-templates.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing CLI and receipt tests**

Add these tests near the existing `qa-run` tests in `tests/test_workerctl.py`:

```python
def test_qa_run_help_lists_build_clear_loop(self):
    proc = self.run_workerctl("qa-run", "--help")

    self.assertEqual(proc.returncode, 0, proc.stderr)
    self.assertIn("build-clear-loop", proc.stdout)

def test_qa_run_build_clear_loop_writes_replayable_receipt(self):
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "db" / "workerctl.db"
        receipt_path = Path(tmpdir) / "receipts" / "receipt.json"

        proc = self.run_workerctl(
            "qa-run",
            "build-clear-loop",
            "--receipt-output",
            str(receipt_path),
            "--path",
            str(db_path),
            "--json",
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = json.loads(proc.stdout)
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(summary["scenario"], "build-clear-loop")
        self.assertEqual(summary["result"], "passed")
        self.assertEqual(receipt["scenario"], "build-clear-loop")
        self.assertEqual(receipt["template"], "build_then_clear")
        self.assertEqual(receipt["result"], "passed")
        self.assertEqual(Path(receipt["artifacts"]["db_path"]), db_path.resolve())
        self.assertEqual(receipt["template_metadata"]["template"], "build_then_clear")
        self.assertEqual(receipt["template_metadata"]["cleanup_policy"], "clear")
        self.assertEqual(receipt["template_metadata"]["required_before_continue"], ["build_passed"])

        checks = {check["name"]: check for check in receipt["checks"]}
        missing = checks["build_clear_blocks_before_build_evidence"]
        self.assertEqual(missing["dispatch"]["state"], "blocked")
        self.assertEqual(missing["dispatch"]["reason"], "missing_required_evidence")
        self.assertEqual(missing["dispatch"]["missing_evidence"], ["build_passed"])
        self.assertEqual(missing["worker_inbox_count"], 0)

        allowed = checks["build_clear_retry_delivers_after_build_evidence"]
        self.assertEqual(allowed["dispatch"]["state"], "pull_required")
        self.assertEqual(allowed["dispatch"]["loop_policy"]["template"], "build_then_clear")
        self.assertEqual(allowed["dispatch"]["requested_iteration"], 2)
        self.assertEqual(allowed["dispatch"]["current_iteration"], 1)
        self.assertEqual(allowed["dispatch"]["max_iterations"], 2)
        self.assertEqual(allowed["dispatch"]["missing_evidence"], [])
        self.assertEqual(allowed["worker_inbox_count"], 1)

        replay_commands = "\n".join(receipt["replay_commands"])
        self.assertIn("loop-templates --show build_then_clear", replay_commands)
        self.assertIn("--evidence-type build_passed", replay_commands)
        self.assertIn("worker-inbox", replay_commands)
```

- [ ] **Step 2: Run the failing QA test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_help_lists_build_clear_loop tests.test_workerctl.CliTests.test_qa_run_build_clear_loop_writes_replayable_receipt
```

Expected: fail because the scenario is not wired into `qa-run`.

- [ ] **Step 3: Wire the CLI choice**

In `workerctl/cli.py`, add `"build-clear-loop"` to the `qa_run.add_argument(... choices=(...))` tuple:

```python
choices=(
    "ralph-loop-guardrails",
    "generic-loop-template",
    "generic-loop-template-browser",
    "test-coverage-loop",
    "adversarial-triggers",
    "build-clear-loop",
),
```

- [ ] **Step 4: Add the QA runner mapping**

In `workerctl/commands.py`, update `command_qa_run`:

```python
scenarios = {
    "ralph-loop-guardrails": _qa_run_ralph_loop_guardrails,
    "generic-loop-template": _qa_run_generic_loop_template,
    "generic-loop-template-browser": _qa_run_generic_loop_template_browser,
    "test-coverage-loop": _qa_run_test_coverage_loop,
    "adversarial-triggers": _qa_run_adversarial_triggers,
    "build-clear-loop": _qa_run_build_clear_loop,
}
```

- [ ] **Step 5: Implement `_qa_run_build_clear_loop` by copying the proven test-coverage runner shape**

Add a helper near the existing QA runners in `workerctl/commands.py`. Use existing helper functions from the neighboring QA runners: `_qa_run_db_path`, `_qa_run_create_bound_task`, `template_metadata`, `_create_loop_policy_run`, `create_command`, `process_next_command`, `list_routed_notifications`, and `list_unconsumed_notifications_for_session`.

```python
def _qa_run_build_clear_loop(args: argparse.Namespace) -> dict[str, Any]:
    db_path = _qa_run_db_path(args)
    dispatcher_id = args.dispatcher_id or "qa-run-build-clear"
    generated_at = utc_now_iso()
    with connect_db(db_path) as conn:
        initialize_database(conn)
        task = _qa_run_create_bound_task(
            conn,
            suffix="build-clear-loop",
            goal="Executable QA run for build_then_clear loop.",
            summary="Disposable no-tmux manager/worker binding for build_then_clear proof.",
        )
        metadata = template_metadata(
            "build_then_clear",
            max_iterations=2,
            current_iteration=1,
            seed_prompt_sha256="qa-run-build-clear-seed",
        )
        loop_run_id = _create_loop_policy_run(
            db_path=db_path,
            task_ref=task["task_name"],
            name="qa-build-clear-run",
            metadata=metadata,
        )["id"]

        missing_command_id = create_command(
            conn,
            task_id=task["task_id"],
            type="continue_iteration",
            payload={
                "loop_run_id": loop_run_id,
                "requested_iteration": 2,
                "message": "Run build/clear iteration 2 before build evidence.",
            },
            correlation_id="qa-run-build-clear-missing",
        )
        missing_dispatch = process_next_command(
            conn,
            dispatcher_id=dispatcher_id,
            command_type="continue_iteration",
        )
        missing_inbox = list_unconsumed_notifications_for_session(conn, task["worker_id"])

        record_acceptance_criterion(
            conn,
            task_id=task["task_id"],
            criterion=f"Ralph loop {loop_run_id} iteration 1 build_passed evidence",
            source="manager_inferred",
            status="satisfied",
            proof="qa-run recorded build_passed receipt before continuing.",
            evidence={
                "evidence_type": "build_passed",
                "status": "pass",
                "iteration": 1,
                "ralph_loop_run_id": loop_run_id,
                "command": "scripts/run-unittests-isolated",
                "result": "Focused build/test command passed before retry.",
                "correlation_id": "qa-run-build-clear-build-passed",
            },
        )

        allowed_command_id = create_command(
            conn,
            task_id=task["task_id"],
            type="continue_iteration",
            payload={
                "loop_run_id": loop_run_id,
                "requested_iteration": 2,
                "message": "Run build/clear iteration 2 after build evidence.",
            },
            correlation_id="qa-run-build-clear-allowed",
        )
        allowed_dispatch = process_next_command(
            conn,
            dispatcher_id=dispatcher_id,
            command_type="continue_iteration",
        )
        allowed_inbox = list_unconsumed_notifications_for_session(conn, task["worker_id"])
        routed_notifications = list_routed_notifications(conn, task_id=task["task_id"])
        conn.commit()

    checks = [
        {
            "name": "build_clear_blocks_before_build_evidence",
            "status": "passed",
            "command_id": missing_command_id,
            "dispatch": missing_dispatch,
            "worker_inbox_count": len(missing_inbox),
            "routed_notifications_count": 0,
        },
        {
            "name": "build_clear_retry_delivers_after_build_evidence",
            "status": "passed",
            "command_id": allowed_command_id,
            "dispatch": allowed_dispatch,
            "worker_inbox_count": len(allowed_inbox),
            "routed_notifications_count": len(routed_notifications),
        },
    ]
    return {
        "artifacts": {"db_path": str(db_path)},
        "checks": checks,
        "generated_at": generated_at,
        "generated_tasks": [task],
        "receipt_path": None,
        "replay_commands": [
            "scripts/workerctl loop-templates --show build_then_clear --json",
            "scripts/workerctl loop-templates --create-run <task> --template build_then_clear --max-iterations 2 --current-iteration 1 --json",
            "scripts/workerctl enqueue-continue-iteration <task> --loop-run <run> --requested-iteration 2 --json",
            "scripts/workerctl dispatch --once --type continue_iteration --json",
            "scripts/workerctl loop-evidence add <task> --loop-run <run> --iteration 1 --evidence-type build_passed --metadata-json '{\"status\":\"pass\"}'",
            "scripts/workerctl worker-inbox <task> --consume-next --wait --json",
        ],
        "result": "passed",
        "scenario": "build-clear-loop",
        "template": "build_then_clear",
        "template_metadata": metadata,
    }
```

If exact helper names differ when implementing, use the neighboring `_qa_run_test_coverage_loop` helper calls as the source of truth and keep the receipt shape above.

- [ ] **Step 6: Add docs for the new QA scenario**

Update `README.md` command reference:

```markdown
`build-clear-loop` proves a non-test-coverage loop using the `build_then_clear`
template: Dispatch blocks iteration 2 until `build_passed` evidence exists,
then delivers a pull-required worker inbox item after the manager records the
build receipt.
```

Update `docs/manual-qa-checklist.md`:

```markdown
- [ ] `scripts/workerctl qa-run build-clear-loop --receipt-output /tmp/build-clear-loop-receipt.json --json` writes a saved receipt proving `build_then_clear` metadata, missing `build_passed` cutoff, worker inbox 0 before evidence, and fresh retry delivery after build evidence.
```

Update `docs/qa/general-loop-templates.md`:

```markdown
## Non-coverage generic loop proof

Run `scripts/workerctl qa-run build-clear-loop --receipt-output /tmp/build-clear-loop-receipt.json --json` to prove a simple `build_then_clear` template can use the same Dispatch continuation rails without test-coverage-specific evidence.
```

- [ ] **Step 7: Run focused QA tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_help_lists_build_clear_loop tests.test_workerctl.CliTests.test_qa_run_build_clear_loop_writes_replayable_receipt
```

Expected: pass.

- [ ] **Step 8: Run the deterministic QA scenario manually**

Run:

```bash
TMPDIR="$(mktemp -d -t workerctl-build-clear.XXXXXX)"
python3 scripts/workerctl qa-run build-clear-loop --receipt-output "$TMPDIR/build-clear-loop-receipt.json" --path "$TMPDIR/workerctl.db" --json
python3 - <<'PY' "$TMPDIR/build-clear-loop-receipt.json"
import json, sys
receipt = json.load(open(sys.argv[1]))
checks = {check["name"]: check for check in receipt["checks"]}
assert receipt["result"] == "passed"
assert checks["build_clear_blocks_before_build_evidence"]["worker_inbox_count"] == 0
assert checks["build_clear_retry_delivers_after_build_evidence"]["dispatch"]["state"] == "pull_required"
print("build-clear-loop receipt proof passed")
PY
```

Expected: summary JSON reports `result=passed`, and the proof script prints `build-clear-loop receipt proof passed`.

- [ ] **Step 9: Commit Task 2**

Run:

```bash
git add README.md docs/manual-qa-checklist.md docs/qa/general-loop-templates.md workerctl/cli.py workerctl/commands.py tests/test_workerctl.py
git commit -m "Add build clear loop QA run"
```

---

### Task 3: Loop Status Summary Command

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Modify: `README.md`
- Modify: `docs/qa/ralph-loop-operator-guide.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing loop-status tests**

Add these tests near existing telemetry/inbox CLI tests in `tests/test_workerctl.py`:

```python
def test_loop_status_help_is_available(self):
    proc = self.run_workerctl("loop-status", "--help")

    self.assertEqual(proc.returncode, 0, proc.stderr)
    self.assertIn("Summarize a Ralph loop run", proc.stdout)
    self.assertIn("--run", proc.stdout)

def test_loop_status_summarizes_blocked_allowed_and_consumed_flow(self):
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "workerctl.db"
        receipt_path = Path(tmpdir) / "receipt.json"
        qa = self.run_workerctl(
            "qa-run",
            "test-coverage-loop",
            "--receipt-output",
            str(receipt_path),
            "--path",
            str(db_path),
            "--json",
        )
        self.assertEqual(qa.returncode, 0, qa.stderr)
        receipt = json.loads(receipt_path.read_text())
        task = receipt["generated_tasks"][0]["task_name"]
        run_id = json.loads((Path(tmpdir) / "receipt.json").read_text())["checks"][0]["dispatch"]["run_id"]

        before = self.run_workerctl("loop-status", task, "--run", run_id, "--path", str(db_path), "--json")
        self.assertEqual(before.returncode, 0, before.stderr)
        before_payload = json.loads(before.stdout)
        self.assertEqual(before_payload["task"]["name"], task)
        self.assertEqual(before_payload["run"]["id"], run_id)
        self.assertEqual(before_payload["policy"]["template"], "test_coverage_loop")
        self.assertEqual(before_payload["policy"]["current_iteration"], 1)
        self.assertEqual(before_payload["policy"]["max_iterations"], 3)
        self.assertEqual(before_payload["commands"]["states"]["blocked"], 2)
        self.assertEqual(before_payload["commands"]["states"]["succeeded"], 1)
        self.assertEqual(before_payload["notifications"]["delivered"], 1)
        self.assertEqual(before_payload["inbox"]["worker_unconsumed"], 1)
        self.assertEqual(before_payload["telemetry"]["dispatch_inbox_consumed"], 0)

        consume = self.run_workerctl("worker-inbox", task, "--consume-next", "--wait", "--timeout", "2", "--path", str(db_path), "--json")
        self.assertEqual(consume.returncode, 0, consume.stderr)

        after = self.run_workerctl("loop-status", task, "--run", run_id, "--path", str(db_path), "--json")
        self.assertEqual(after.returncode, 0, after.stderr)
        after_payload = json.loads(after.stdout)
        self.assertEqual(after_payload["inbox"]["worker_unconsumed"], 0)
        self.assertEqual(after_payload["telemetry"]["dispatch_inbox_consumed"], 1)
        self.assertEqual(after_payload["failures"]["failed_commands"], 0)
        self.assertEqual(after_payload["recommendation"], "ready_for_manager_review")
```

- [ ] **Step 2: Run the failing loop-status tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_loop_status_help_is_available tests.test_workerctl.CliTests.test_loop_status_summarizes_blocked_allowed_and_consumed_flow
```

Expected: fail because `loop-status` is not registered.

- [ ] **Step 3: Wire the CLI**

In `workerctl/cli.py`, import `command_loop_status` and add a parser near `loop-templates`:

```python
loop_status = subparsers.add_parser(
    "loop-status",
    help="Summarize a Ralph loop run for manager review.",
)
loop_status.add_argument("task", help="Task name or ID.")
loop_status.add_argument("--run", required=True, help="Loop run name or ID.")
loop_status.add_argument("--json", action="store_true", help="Print JSON output.")
loop_status.add_argument("--path", help="Override the workerctl database path.")
loop_status.set_defaults(func=command_loop_status)
```

- [ ] **Step 4: Implement read-only aggregation**

Add `command_loop_status` to `workerctl/commands.py`:

```python
def command_loop_status(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        task = db_task_row(conn, task=args.task)
        run = db_run_row(conn, run=args.run)
        if run["task_id"] != task["id"]:
            raise WorkerError("--run does not belong to task")
        metadata = run.get("metadata") or {}
        commands = list_commands(conn, task_id=task["id"], include_attempts=True)
        relevant_commands = [
            command
            for command in commands
            if (command.get("result") or {}).get("run_id") == run["id"]
            or (command.get("payload") or {}).get("loop_run_id") == run["id"]
            or (command.get("payload") or {}).get("ralph_loop_run_id") == run["id"]
        ]
        command_states = Counter(command["state"] for command in relevant_commands)
        notifications = list_routed_notifications(conn, task_id=task["id"])
        loop_notifications = [
            notification
            for notification in notifications
            if (notification.get("payload") or {}).get("ralph_loop", {}).get("run_id") == run["id"]
            or (notification.get("payload") or {}).get("loop_policy", {}).get("run_id") == run["id"]
        ]
        worker_items = [
            item
            for item in list_unconsumed_notifications_for_task_role(conn, task_id=task["id"], role="worker")
            if (item.get("payload") or {}).get("ralph_loop", {}).get("run_id") == run["id"]
            or (item.get("payload") or {}).get("loop_policy", {}).get("run_id") == run["id"]
        ]
        events = query_telemetry_events(conn, task_id=task["id"], limit=1000)
        loop_events = [event for event in events if event.get("run_id") == run["id"]]
        event_counts = Counter(event["event_type"] for event in loop_events)
        failure_view = telemetry_failures_view(conn, task_id=task["id"], run_id=run["id"])
        criteria = list_acceptance_criteria(conn, task_id=task["id"])
        evidence = [
            criterion
            for criterion in criteria
            if (criterion.get("evidence") or {}).get("ralph_loop_run_id") == run["id"]
        ]
    result = {
        "task": {"id": task["id"], "name": task["name"], "state": task["state"]},
        "run": {"id": run["id"], "name": run["name"], "status": run["status"]},
        "policy": {
            "template": metadata.get("template") or metadata.get("preset"),
            "current_iteration": metadata.get("current_iteration"),
            "max_iterations": metadata.get("max_iterations"),
            "required_before_continue": metadata.get("required_before_continue") or [],
            "cleanup_policy": metadata.get("cleanup_policy"),
        },
        "commands": {"total": len(relevant_commands), "states": dict(command_states)},
        "notifications": {
            "total": len(loop_notifications),
            "delivered": sum(1 for item in loop_notifications if item.get("state") == "delivered"),
        },
        "inbox": {"worker_unconsumed": len(worker_items)},
        "evidence": {"total": len(evidence), "types": sorted({(item.get("evidence") or {}).get("evidence_type") for item in evidence if (item.get("evidence") or {}).get("evidence_type")})},
        "telemetry": {
            "total": len(loop_events),
            "dispatch_inbox_consumed": event_counts.get("dispatch_inbox_consumed", 0),
            "by_event_type": dict(event_counts),
        },
        "failures": {
            "alerts": len(failure_view["alerts"]),
            "failed_commands": len(failure_view["failed_commands"]),
            "failed_cycles": len(failure_view["failed_cycles"]),
            "pane_capture_failures": len(failure_view["pane_capture_failures"]),
        },
        "recommendation": "ready_for_manager_review",
    }
    if result["failures"]["alerts"] or result["failures"]["failed_commands"] or result["failures"]["failed_cycles"]:
        result["recommendation"] = "inspect_failures"
    elif result["inbox"]["worker_unconsumed"]:
        result["recommendation"] = "worker_should_consume_inbox"
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True, default=str))
    else:
        print(f"task: {result['task']['name']}")
        print(f"run: {result['run']['id']}")
        print(f"template: {result['policy']['template']}")
        print(f"commands: {result['commands']['states']}")
        print(f"worker_inbox: {result['inbox']['worker_unconsumed']}")
        print(f"dispatch_inbox_consumed: {result['telemetry']['dispatch_inbox_consumed']}")
        print(f"recommendation: {result['recommendation']}")
    return 0
```

Adjust helper names to existing equivalents if the local module exposes them under slightly different names; keep the JSON contract from the tests fixed.

- [ ] **Step 5: Import missing dependencies**

At the top of `workerctl/commands.py`, add or reuse:

```python
from collections import Counter
```

If `Counter` already exists, do not add a duplicate import.

- [ ] **Step 6: Document `loop-status`**

Add to `README.md`:

```markdown
- `loop-status TASK --run RUN [--json]` — Summarize a Ralph-loop run for manager review: policy template, iteration bounds, command states, routed notifications, worker inbox backlog, evidence types, consumed-inbox telemetry, failure counts, and a recommendation.
```

Add to `docs/qa/ralph-loop-operator-guide.md` status review section:

```markdown
`loop-status` is the compact manager review command. A run is ready for review when failures are zero, blocked attempts are explainable policy blocks, worker inbox backlog is zero after consumption, and `dispatch_inbox_consumed` telemetry is present for pull-required deliveries.
```

- [ ] **Step 7: Run focused loop-status tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_loop_status_help_is_available tests.test_workerctl.CliTests.test_loop_status_summarizes_blocked_allowed_and_consumed_flow
```

Expected: pass.

- [ ] **Step 8: Run combined regression tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_docs_include_ralph_loop_operator_guide \
  tests.test_workerctl.CliTests.test_qa_run_build_clear_loop_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_loop_status_summarizes_blocked_allowed_and_consumed_flow \
  tests.test_workerctl.CliTests.test_qa_run_test_coverage_loop_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt
```

Expected: all pass.

- [ ] **Step 9: Burden-of-proof manual check**

Run a fresh T005-like flow and try to disprove the status command:

```bash
TMPDIR="$(mktemp -d -t workerctl-loop-status.XXXXXX)"
python3 scripts/workerctl qa-run test-coverage-loop --receipt-output "$TMPDIR/test-coverage-loop-receipt.json" --path "$TMPDIR/workerctl.db" --json
TASK="$(python3 - <<'PY' "$TMPDIR/test-coverage-loop-receipt.json"
import json, sys
print(json.load(open(sys.argv[1]))["generated_tasks"][0]["task_name"])
PY
)"
RUN="$(python3 - <<'PY' "$TMPDIR/test-coverage-loop-receipt.json"
import json, sys
checks = {check["name"]: check for check in json.load(open(sys.argv[1]))["checks"]}
print(checks["structured_test_coverage_retry_delivers"]["dispatch"]["run_id"])
PY
)"
python3 scripts/workerctl loop-status "$TASK" --run "$RUN" --path "$TMPDIR/workerctl.db" --json > "$TMPDIR/status-before.json"
python3 scripts/workerctl worker-inbox "$TASK" --consume-next --wait --timeout 2 --path "$TMPDIR/workerctl.db" --json > "$TMPDIR/consume.json"
python3 scripts/workerctl loop-status "$TASK" --run "$RUN" --path "$TMPDIR/workerctl.db" --json > "$TMPDIR/status-after.json"
python3 - <<'PY' "$TMPDIR/status-before.json" "$TMPDIR/status-after.json"
import json, sys
before = json.load(open(sys.argv[1]))
after = json.load(open(sys.argv[2]))
assert before["inbox"]["worker_unconsumed"] == 1, before
assert after["inbox"]["worker_unconsumed"] == 0, after
assert after["telemetry"]["dispatch_inbox_consumed"] == 1, after
assert after["failures"]["failed_commands"] == 0, after
print("loop-status disproval check passed")
PY
```

Expected: proof script prints `loop-status disproval check passed`.

- [ ] **Step 10: Commit Task 3**

Run:

```bash
git add README.md docs/qa/ralph-loop-operator-guide.md workerctl/cli.py workerctl/commands.py tests/test_workerctl.py
git commit -m "Add Ralph loop status summary"
```

---

## Final Verification

- [ ] Run focused regression:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_docs_include_ralph_loop_operator_guide \
  tests.test_workerctl.CliTests.test_qa_run_build_clear_loop_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_loop_status_summarizes_blocked_allowed_and_consumed_flow \
  tests.test_workerctl.CliTests.test_qa_run_test_coverage_loop_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_adversarial_triggers_writes_replayable_receipt
```

- [ ] Run deterministic CLI receipts:

```bash
TMPDIR="$(mktemp -d -t workerctl-real-work-readiness.XXXXXX)"
python3 scripts/workerctl qa-run build-clear-loop --receipt-output "$TMPDIR/build-clear-loop.json" --path "$TMPDIR/build-clear.db" --json
python3 scripts/workerctl qa-run test-coverage-loop --receipt-output "$TMPDIR/test-coverage-loop.json" --path "$TMPDIR/test-coverage.db" --json
```

- [ ] Run stale-semantics probe against generated receipts:

```bash
rg -n "missing_evidence=\\[\\]|target_worker_notified=true|dispatch_inbox_consumed.*0|Generic caution.*arm" "$TMPDIR" || true
```

Expected: no matches that contradict the acceptance criteria.

- [ ] Run GitHub PR workflow after implementation:

```bash
git status --short --branch
git push -u origin <branch>
gh pr create --base main --head <branch> --title "[codex] Prepare Ralph loops for real vertical slices" --body-file <body.md>
gh pr checks --watch --interval 10
gh pr merge --squash --delete-branch
```

---

## Self-Review

- Spec coverage: Task 1 covers the operator guide concern, Task 2 covers the non-test-coverage deterministic QA concern, and Task 3 covers the compact loop-status summary concern.
- Placeholder scan: no task relies on an unresolved placeholder; helper-name uncertainty is explicitly bounded to existing neighboring QA helper names with a fixed JSON contract.
- Type consistency: the plan uses existing `workerctl` JSON terms: `task`, `run`, `loop_policy`, `current_iteration`, `requested_iteration`, `max_iterations`, `missing_evidence`, `worker_inbox_count`, `dispatch_inbox_consumed`, and `telemetry failures`.
