# Ralph Loop Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named Ralph-loop presets that create evidence-gated continuation policies consistently, expose their gate requirements to operators, and prove Dispatch cuts off preset continuations before worker delivery when preset conditions are not satisfied.

**Architecture:** Keep Dispatch mechanical: it continues to enforce only `max_iterations` and explicit recorded evidence. Add a small preset catalog that maps human-friendly preset names to Ralph-loop run metadata, then add CLI/docs/dashboard QA around that catalog. Do not add external CI, PR, merge, or coverage inspection in this slice; presets declare which evidence receipts must already exist.

**Tech Stack:** Python `workerctl` CLI and SQLite metadata; existing acceptance criteria evidence receipts; existing Dispatch command queue; dashboard TypeScript tests; existing manual/browser QA docs.

---

## File Structure

- Create `workerctl/ralph_loop_presets.py`
  - Owns the preset catalog, validation, list/show serialization, and conversion from preset name to Ralph-loop run metadata.
  - No database access.
- Modify `workerctl/commands.py`
  - Adds `command_ralph_loop_presets`.
  - Reuses `create_db_ralph_loop_run`.
  - Keeps `command_runs` unchanged except for importing the new command if needed.
- Modify `workerctl/cli.py`
  - Adds `ralph-loop-presets` parser with `--list`, `--show`, and `--create-run`.
- Modify `tests/test_workerctl.py`
  - Adds CLI tests for list/show/create/unknown preset.
  - Adds Dispatch tests for multi-evidence preset behavior.
- Modify `dashboard/server/workerctl.test.ts`
  - Adds dashboard summary coverage for multiple missing evidence values.
- Modify `dashboard/client/main.tsx`
  - Changes missing evidence display from `missing pr_url,ci_green` to `missing pr_url, ci_green`.
- Modify `docs/qa/ralph-loop.md`
  - Adds a “Preset Evidence Gate Drill”.
- Modify `docs/manual-qa-checklist.md`
  - Adds checklist item for preset listing/create-run/block/retry.
- Optional new GoalBuddy files under `docs/goals/ralph-loop-presets/`
  - Use only if this plan is executed as a GoalBuddy goal.

---

### Task 1: Preset Catalog

**Files:**
- Create: `workerctl/ralph_loop_presets.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing catalog unit tests**

Add these tests near the existing `DatabaseTests` or create a focused `RalphLoopPresetTests` class in `tests/test_workerctl.py`:

```python
class RalphLoopPresetTests(unittest.TestCase):
    def test_ralph_loop_presets_include_operator_ready_templates(self):
        from workerctl.ralph_loop_presets import list_ralph_loop_presets, ralph_loop_preset_metadata

        names = [preset["name"] for preset in list_ralph_loop_presets()]

        self.assertIn("test_coverage_loop", names)
        self.assertIn("build_then_clear", names)
        self.assertIn("pr_ci_merge_loop", names)
        self.assertIn("compact_then_continue", names)

        coverage = ralph_loop_preset_metadata("test_coverage_loop")
        self.assertEqual(coverage["kind"], "ralph_loop")
        self.assertEqual(coverage["required_before_continue"], ["test_coverage"])
        self.assertEqual(coverage["stop_conditions"], ["max_iterations", "required_evidence"])

    def test_ralph_loop_preset_metadata_allows_safe_overrides(self):
        from workerctl.ralph_loop_presets import ralph_loop_preset_metadata

        metadata = ralph_loop_preset_metadata(
            "pr_ci_merge_loop",
            max_iterations=4,
            current_iteration=1,
            seed_prompt_sha256="abc123",
        )

        self.assertEqual(metadata["max_iterations"], 4)
        self.assertEqual(metadata["current_iteration"], 1)
        self.assertEqual(metadata["seed_prompt_sha256"], "abc123")
        self.assertEqual(metadata["required_before_continue"], ["pr_url", "ci_green", "merge"])

    def test_ralph_loop_preset_rejects_unknown_name(self):
        from workerctl.ralph_loop_presets import ralph_loop_preset_metadata

        with self.assertRaisesRegex(WorkerError, "Unknown Ralph loop preset"):
            ralph_loop_preset_metadata("not-a-preset")
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.RalphLoopPresetTests.test_ralph_loop_presets_include_operator_ready_templates \
  tests.test_workerctl.RalphLoopPresetTests.test_ralph_loop_preset_metadata_allows_safe_overrides \
  tests.test_workerctl.RalphLoopPresetTests.test_ralph_loop_preset_rejects_unknown_name \
  -v
```

Expected: fails with `ModuleNotFoundError: No module named 'workerctl.ralph_loop_presets'`.

- [ ] **Step 3: Implement the preset catalog**

Create `workerctl/ralph_loop_presets.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from workerctl.core import WorkerError


@dataclass(frozen=True)
class RalphLoopPreset:
    name: str
    description: str
    max_iterations: int
    cleanup_policy: str
    required_before_continue: tuple[str, ...]
    stop_conditions: tuple[str, ...] = ("max_iterations", "required_evidence")

    def to_metadata(
        self,
        *,
        max_iterations: int | None = None,
        current_iteration: int = 0,
        seed_prompt_sha256: str | None = None,
    ) -> dict[str, Any]:
        effective_max = self.max_iterations if max_iterations is None else max_iterations
        if effective_max < 1:
            raise WorkerError("max_iterations must be at least 1")
        if current_iteration < 0:
            raise WorkerError("current_iteration must be non-negative")
        if current_iteration > effective_max:
            raise WorkerError("current_iteration must not exceed max_iterations")
        return {
            "cleanup_policy": self.cleanup_policy,
            "current_iteration": current_iteration,
            "kind": "ralph_loop",
            "max_iterations": effective_max,
            "preset": self.name,
            "required_before_continue": list(self.required_before_continue),
            "seed_prompt_sha256": seed_prompt_sha256,
            "stop_conditions": list(self.stop_conditions),
        }

    def summary(self) -> dict[str, Any]:
        return {
            "cleanup_policy": self.cleanup_policy,
            "description": self.description,
            "max_iterations": self.max_iterations,
            "name": self.name,
            "required_before_continue": list(self.required_before_continue),
            "stop_conditions": list(self.stop_conditions),
        }


RALPH_LOOP_PRESETS: dict[str, RalphLoopPreset] = {
    "test_coverage_loop": RalphLoopPreset(
        name="test_coverage_loop",
        description="Repeat a test-coverage analysis/fix loop until coverage evidence is recorded or max iterations is reached.",
        max_iterations=3,
        cleanup_policy="clear",
        required_before_continue=("test_coverage",),
    ),
    "build_then_clear": RalphLoopPreset(
        name="build_then_clear",
        description="Require build evidence before the manager can route another iteration, then clear worker context between iterations.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("build_passed", "cleanup"),
    ),
    "pr_ci_merge_loop": RalphLoopPreset(
        name="pr_ci_merge_loop",
        description="Require PR URL, green CI, and merge evidence before continuing a manager-led PR loop.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("pr_url", "ci_green", "merge"),
    ),
    "compact_then_continue": RalphLoopPreset(
        name="compact_then_continue",
        description="Require worker completion and cleanup evidence before compacting context and continuing.",
        max_iterations=4,
        cleanup_policy="compact",
        required_before_continue=("worker_completion", "cleanup"),
    ),
}


def list_ralph_loop_presets() -> list[dict[str, Any]]:
    return [RALPH_LOOP_PRESETS[name].summary() for name in sorted(RALPH_LOOP_PRESETS)]


def ralph_loop_preset(name: str) -> RalphLoopPreset:
    try:
        return RALPH_LOOP_PRESETS[name]
    except KeyError as exc:
        allowed = ", ".join(sorted(RALPH_LOOP_PRESETS))
        raise WorkerError(f"Unknown Ralph loop preset: {name}; expected one of: {allowed}") from exc


def ralph_loop_preset_metadata(
    name: str,
    *,
    max_iterations: int | None = None,
    current_iteration: int = 0,
    seed_prompt_sha256: str | None = None,
) -> dict[str, Any]:
    return ralph_loop_preset(name).to_metadata(
        max_iterations=max_iterations,
        current_iteration=current_iteration,
        seed_prompt_sha256=seed_prompt_sha256,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
python3 -m unittest tests.test_workerctl.RalphLoopPresetTests -v
```

Expected: all preset catalog tests pass.

- [ ] **Step 5: Commit**

```bash
git add workerctl/ralph_loop_presets.py tests/test_workerctl.py
git commit -m "Add Ralph-loop preset catalog"
```

---

### Task 2: Preset CLI

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `workerctl/cli.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing CLI tests**

Add these tests near the existing `CliTests` run-related tests:

```python
    def test_ralph_loop_presets_cli_lists_and_shows_presets(self):
        list_proc = self.run_workerctl("ralph-loop-presets", "--list", "--json")

        self.assertEqual(list_proc.returncode, 0, list_proc.stderr)
        payload = json.loads(list_proc.stdout)
        names = [preset["name"] for preset in payload["presets"]]
        self.assertIn("test_coverage_loop", names)
        self.assertIn("pr_ci_merge_loop", names)

        show_proc = self.run_workerctl("ralph-loop-presets", "--show", "pr_ci_merge_loop", "--json")

        self.assertEqual(show_proc.returncode, 0, show_proc.stderr)
        preset = json.loads(show_proc.stdout)
        self.assertEqual(preset["name"], "pr_ci_merge_loop")
        self.assertEqual(preset["required_before_continue"], ["pr_url", "ci_green", "merge"])

    def test_ralph_loop_presets_cli_creates_policy_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="preset-task", goal="Run preset loop.")
                conn.commit()

            proc = self.run_workerctl(
                "ralph-loop-presets",
                "--create-run",
                "preset-task",
                "--preset",
                "pr_ci_merge_loop",
                "--name",
                "preset-policy",
                "--max-iterations",
                "3",
                "--current-iteration",
                "1",
                "--seed-prompt-sha256",
                "seed123",
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["purpose"], "ralph_loop")
            self.assertEqual(payload["metadata"]["preset"], "pr_ci_merge_loop")
            self.assertEqual(payload["metadata"]["max_iterations"], 3)
            self.assertEqual(payload["metadata"]["current_iteration"], 1)
            self.assertEqual(payload["metadata"]["required_before_continue"], ["pr_url", "ci_green", "merge"])
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                loop_run = worker_db.ralph_loop_run(conn, run=payload["id"])
            self.assertEqual(loop_run["task_id"], task_id)
            self.assertEqual(loop_run["required_before_continue"], ["pr_url", "ci_green", "merge"])

    def test_ralph_loop_presets_cli_rejects_unknown_preset(self):
        proc = self.run_workerctl("ralph-loop-presets", "--show", "nope", "--json")

        self.assertEqual(proc.returncode, 1)
        self.assertIn("Unknown Ralph loop preset", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_lists_and_shows_presets \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_creates_policy_run \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_rejects_unknown_preset \
  -v
```

Expected: fails because `ralph-loop-presets` is not a known command.

- [ ] **Step 3: Implement `command_ralph_loop_presets`**

In `workerctl/commands.py`, add imports near existing imports:

```python
from workerctl.ralph_loop_presets import list_ralph_loop_presets, ralph_loop_preset, ralph_loop_preset_metadata
```

Add this command near `command_runs`:

```python
def command_ralph_loop_presets(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    if getattr(args, "list", False):
        result = {"presets": list_ralph_loop_presets()}
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if getattr(args, "show", None):
        result = ralph_loop_preset(args.show).summary()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if getattr(args, "create_run", None):
        metadata = ralph_loop_preset_metadata(
            args.preset,
            max_iterations=args.max_iterations,
            current_iteration=args.current_iteration,
            seed_prompt_sha256=args.seed_prompt_sha256,
        )
        with connect_db(db_path) as conn:
            initialize_database(conn)
            task = db_task_row(conn, task=args.create_run)
            run_id = create_db_ralph_loop_run(
                conn,
                task_id=task["id"],
                name=args.name,
                max_iterations=metadata["max_iterations"],
                current_iteration=metadata["current_iteration"],
                cleanup_policy=metadata["cleanup_policy"],
                required_before_continue=metadata["required_before_continue"],
                stop_conditions=metadata["stop_conditions"],
                seed_prompt_sha256=metadata["seed_prompt_sha256"],
            )
            row = db_run_row(conn, run=run_id)
            row["metadata"]["preset"] = metadata["preset"]
            conn.execute(
                "update runs set metadata_json = ? where id = ?",
                (json.dumps(row["metadata"], sort_keys=True), run_id),
            )
            conn.commit()
            result = db_run_row(conn, run=run_id)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    raise WorkerError("ralph-loop-presets requires --list, --show, or --create-run")
```

- [ ] **Step 4: Wire the CLI parser**

In `workerctl/cli.py`, import the command:

```python
    command_ralph_loop_presets,
```

Add this parser near `runs`:

```python
    ralph_presets = subparsers.add_parser(
        "ralph-loop-presets",
        help="List Ralph-loop presets or create a Ralph-loop policy run from a preset.",
    )
    preset_action = ralph_presets.add_mutually_exclusive_group(required=True)
    preset_action.add_argument("--list", action="store_true", help="List available presets.")
    preset_action.add_argument("--show", metavar="PRESET", help="Show one preset.")
    preset_action.add_argument("--create-run", metavar="TASK", help="Create a Ralph-loop policy run for a task from --preset.")
    ralph_presets.add_argument("--preset", help="Preset name for --create-run.")
    ralph_presets.add_argument("--name", help="Optional run name for --create-run.")
    ralph_presets.add_argument("--max-iterations", type=int, help="Override preset max iterations.")
    ralph_presets.add_argument("--current-iteration", type=int, default=0, help="Current completed iteration for the policy run.")
    ralph_presets.add_argument("--seed-prompt-sha256", help="Optional seed prompt SHA-256 to store on the policy run.")
    ralph_presets.add_argument("--json", action="store_true", help="Print JSON output.")
    ralph_presets.add_argument("--path", help="Override the workerctl database path.")
    ralph_presets.set_defaults(func=command_ralph_loop_presets)
```

In `command_ralph_loop_presets`, before `ralph_loop_preset_metadata`, add:

```python
        if not args.preset:
            raise WorkerError("ralph-loop-presets --create-run requires --preset")
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_lists_and_shows_presets \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_creates_policy_run \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_rejects_unknown_preset \
  -v
```

Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add Ralph-loop preset CLI"
```

---

### Task 3: Multi-Evidence Dispatch Behavior

**Files:**
- Modify: `tests/test_workerctl.py`
- Modify: `workerctl/commands.py` only if tests reveal a real behavior gap.

- [ ] **Step 1: Write failing or characterization dispatch test**

Add this to `DispatchTests`:

```python
    def test_dispatch_blocks_preset_until_all_required_evidence_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn, db_path = self.open_db(tmpdir)
            worker_id, _manager_id = self.setup_bound_task(conn)
            conn.execute("update sessions set tmux_session = null where id = ?", (worker_id,))
            loop_run_id = worker_db.create_ralph_loop_run(
                conn,
                task_id="task-dispatch",
                name="preset-loop",
                max_iterations=3,
                current_iteration=1,
                cleanup_policy="clear",
                required_before_continue=["pr_url", "ci_green", "merge"],
                stop_conditions=["max_iterations", "required_evidence"],
            )
            first_command_id = worker_db.enqueue_continue_iteration(
                conn,
                task_id="task-dispatch",
                message="Run iteration 2.",
                loop_run_id=loop_run_id,
                requested_iteration=2,
                correlation_id="ralph-loop-preset-missing-all",
            )
            conn.commit()

            args = argparse.Namespace(
                dispatcher_id="dispatch-test",
                dry_run=False,
                json=True,
                limit=10,
                once=True,
                path=str(db_path),
                type="continue_iteration",
                watch=False,
            )
            with mock.patch.object(worker_tmux, "send_text_to_session") as send:
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    commands.command_dispatch(args)

            first_payload = json.loads(stdout.getvalue())
            self.assertEqual(first_payload["processed"][0]["state"], "blocked")
            self.assertEqual(first_payload["processed"][0]["reason"], "missing_required_evidence")
            self.assertEqual(first_payload["processed"][0]["missing_evidence"], ["pr_url", "ci_green", "merge"])
            self.assertEqual(worker_db.routed_notifications(conn, task_id="task-dispatch"), [])
            self.assertEqual(worker_db.session_inbox(conn, session_name="worker-session"), [])
            send.assert_not_called()

            for evidence_type in ("pr_url", "ci_green", "merge"):
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-dispatch",
                    criterion=f"Iteration 1 {evidence_type}",
                    status="satisfied",
                    source="manager_inferred",
                    proof=f"{evidence_type} receipt recorded.",
                    evidence={
                        "correlation_id": f"ralph-loop-{evidence_type}",
                        "evidence_type": evidence_type,
                        "iteration": 1,
                        "ralph_loop_run_id": loop_run_id,
                    },
                )
            second_command_id = worker_db.enqueue_continue_iteration(
                conn,
                task_id="task-dispatch",
                message="Run iteration 2 after preset evidence.",
                loop_run_id=loop_run_id,
                requested_iteration=2,
                correlation_id="ralph-loop-preset-allowed",
            )
            conn.commit()

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                commands.command_dispatch(args)

            second_payload = json.loads(stdout.getvalue())
            self.assertEqual(second_payload["processed"][0]["state"], "pull_required")
            notification = worker_db.routed_notifications(conn, task_id="task-dispatch")[0]
            self.assertEqual(notification["command_id"], second_command_id)
            self.assertEqual(notification["payload"]["ralph_loop"]["required_before_continue"], ["pr_url", "ci_green", "merge"])
            self.assertNotEqual(first_command_id, second_command_id)
```

- [ ] **Step 2: Run test**

Run:

```bash
python3 -m unittest tests.test_workerctl.DispatchTests.test_dispatch_blocks_preset_until_all_required_evidence_exists -v
```

Expected: pass if existing generic evidence logic already supports multiple gates. If it fails because missing evidence order or reason differs, fix the implementation in `workerctl/commands.py` to keep the expected stable order and `missing_required_evidence` reason for two or more missing gates.

- [ ] **Step 3: Commit**

```bash
git add tests/test_workerctl.py workerctl/commands.py
git commit -m "Cover multi-evidence Ralph-loop preset gating"
```

---

### Task 4: Dashboard Multi-Evidence Display

**Files:**
- Modify: `dashboard/client/main.tsx`
- Modify: `dashboard/server/workerctl.test.ts`

- [ ] **Step 1: Write failing dashboard test expectation**

In `dashboard/server/workerctl.test.ts`, extend `dispatch chains expose missing Ralph-loop continuation evidence` or add a new test:

```typescript
test("dispatch chains expose multiple missing Ralph-loop evidence gates", () => {
  const chains = dispatchChainEntries({
    command_attempts: [
      {
        command_id: "cmd-missing-preset",
        dispatcher_id: "dispatch-local",
        error: "missing_required_evidence missing_evidence=pr_url,ci_green,merge current_iteration=1 max_iterations=3 requested_iteration=2",
        id: 9,
        result: {
          current_iteration: 1,
          delivered: false,
          max_iterations: 3,
          missing_evidence: ["pr_url", "ci_green", "merge"],
          reason: "missing_required_evidence",
          requested_iteration: 2,
          run_id: "run-preset",
          state: "blocked",
          target_worker_notified: false,
        },
        side_effect_completed: false,
        side_effect_started: false,
        started_at: "2026-05-30T10:00:01Z",
        state: "failed",
      },
    ],
    commands: [
      {
        correlation_id: "ralph-loop-preset-missing",
        created_at: "2026-05-30T10:00:00Z",
        id: "cmd-missing-preset",
        state: "failed",
        type: "continue_iteration",
      },
    ],
    correlation_chains: [
      {
        attempt_ids: [9],
        command_id: "cmd-missing-preset",
        command_state: "failed",
        command_type: "continue_iteration",
        correlation_id: "ralph-loop-preset-missing",
        created_at: "2026-05-30T10:00:00Z",
        manager_cycle_id: null,
        manager_decision_id: null,
        routed_notification_ids: [],
      },
    ],
    routed_notifications: [],
  });

  assert.deepEqual(chains[0].blocked_policy?.missing_evidence, ["pr_url", "ci_green", "merge"]);
  assert.equal(chains[0].blocked_policy?.reason, "missing_required_evidence");
});
```

- [ ] **Step 2: Improve client display spacing**

In `dashboard/client/main.tsx`, change:

```tsx
chain.blocked_policy.missing_evidence?.length ? `missing ${chain.blocked_policy.missing_evidence.join(",")}` : null,
```

to:

```tsx
chain.blocked_policy.missing_evidence?.length ? `missing ${chain.blocked_policy.missing_evidence.join(", ")}` : null,
```

- [ ] **Step 3: Run dashboard tests**

Run:

```bash
npm test -- --runInBand dashboard/server/workerctl.test.ts
```

Expected: 40+ dashboard tests pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/client/main.tsx dashboard/server/workerctl.test.ts
git commit -m "Show multi-evidence Ralph-loop blocks"
```

---

### Task 5: QA Plan And Docs

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `tests/test_workerctl.py`
- Modify: `docs/qa/ralph-loop.md`
- Modify: `docs/manual-qa-checklist.md`
- Modify: `README.md`

- [ ] **Step 1: Add QA-plan test expectations**

Update `test_qa_plan_ralph_loop_outputs_managed_delivery_loop` in `tests/test_workerctl.py`:

```python
self.assertTrue(any("ralph-loop-presets --list" in step for step in payload["steps"]))
self.assertTrue(any("ralph-loop-presets --create-run" in step and "pr_ci_merge_loop" in step for step in payload["steps"]))
self.assertTrue(any("missing_required_evidence" in step for step in payload["steps"]))
self.assertTrue(any("missing pr_url, ci_green, merge" in step for step in payload["steps"]))
```

- [ ] **Step 2: Run QA-plan test to verify it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_outputs_managed_delivery_loop -v
```

Expected: fails because the preset drill is not yet listed.

- [ ] **Step 3: Add QA-plan steps**

In `workerctl/commands.py`, in the `qa_plans["ralph-loop"]["steps"]` array, add these strings after the missing CI-green drill:

```python
"List preset policies with workerctl ralph-loop-presets --list --json and verify test_coverage_loop, build_then_clear, pr_ci_merge_loop, and compact_then_continue are present with required_before_continue evidence lists.",
"Create a preset-backed run in a disposable task: workerctl ralph-loop-presets --create-run <task> --preset pr_ci_merge_loop --name qa-ralph-loop-preset --max-iterations 3 --current-iteration 1 --seed-prompt-sha256 <seed-sha256> --json.",
"Record a manager decision and enqueue requested iteration 2 against the preset run before pr_url, ci_green, and merge evidence exist; dispatch once and verify state=blocked, reason=missing_required_evidence, missing_evidence=[pr_url,ci_green,merge], delivered=false, target_worker_notified=false, and no routed notification id.",
"Open the dashboard and verify the Dispatch panel shows continue_iteration, missing_required_evidence, missing pr_url, ci_green, merge, iteration 1/3, requested 2, 0 notifications, Inbox 0, and Pull inbox 0.",
"Record satisfied criteria evidence for pr_url, ci_green, and merge with ralph_loop_run_id=<run-id>, iteration=1, and matching evidence_type values; enqueue a fresh requested iteration 2 command and verify Dispatch delivers it to the worker inbox or tmux target.",
```

- [ ] **Step 4: Update docs**

In `docs/qa/ralph-loop.md`, add a section named `## Preset Evidence Gate Drill` after the Missing CI-Green Evidence Drill. Include these exact commands:

```bash
scripts/workerctl ralph-loop-presets --list --json

RALPH_LOOP_RUN_ID="$(scripts/workerctl ralph-loop-presets \
  --create-run qa-ralph-loop-preset \
  --preset pr_ci_merge_loop \
  --name qa-ralph-loop-preset-policy \
  --max-iterations 3 \
  --current-iteration 1 \
  --seed-prompt-sha256 "<seed-sha256>" \
  --json \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
```

State the required blocked observations:

```text
state=blocked
reason=missing_required_evidence
missing_evidence=["pr_url","ci_green","merge"]
delivered=false
target_worker_notified=false
0 notifications
Inbox 0
Pull inbox 0
```

In `docs/manual-qa-checklist.md`, add:

```markdown
- [ ] `scripts/workerctl qa-plan ralph-loop` includes the preset evidence drill: `ralph-loop-presets --list`, `ralph-loop-presets --create-run`, `pr_ci_merge_loop`, `missing_required_evidence`, `missing pr_url, ci_green, merge`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and delivered retry after `pr_url`, `ci_green`, and `merge` criterion evidence is recorded.
```

In `README.md`, add one short bullet near the existing `runs` or `qa-plan` docs:

```markdown
- `ralph-loop-presets --list|--show PRESET|--create-run TASK --preset PRESET` — list named Ralph-loop evidence policies or create a Ralph-loop policy run with preset `required_before_continue` gates.
```

- [ ] **Step 5: Run tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_outputs_managed_delivery_loop -v
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add workerctl/commands.py tests/test_workerctl.py docs/qa/ralph-loop.md docs/manual-qa-checklist.md README.md
git commit -m "Document Ralph-loop preset QA"
```

---

### Task 6: Browser QA Receipt

**Files:**
- Create: `docs/goals/ralph-loop-presets/goal.md`
- Create: `docs/goals/ralph-loop-presets/state.yaml`
- Create: `docs/goals/ralph-loop-presets/notes/T004-browser-qa.md`

- [ ] **Step 1: Create GoalBuddy goal if execution uses GoalBuddy**

Use the existing Ralph-loop evidence goal as the template. Minimum active task sequence:

```yaml
goal:
  title: "Ralph Loop Presets"
  slug: "ralph-loop-presets"
  kind: specific
  status: active
  oracle:
    signal: "Browser QA proves pr_ci_merge_loop blocks before worker delivery when pr_url, ci_green, and merge evidence are missing, then delivers after all three evidence receipts are recorded."
active_task: T001
tasks:
  - id: T001
    type: scout
    status: done
  - id: T002
    type: judge
    status: done
  - id: T003
    type: worker
    status: done
  - id: T004
    type: worker
    status: active
  - id: T005
    type: pm
    status: queued
  - id: T999
    type: judge
    status: queued
completion:
  full_outcome_complete: false
  final_audit: null
```

- [ ] **Step 2: Run browser QA**

Use a disposable DB and task:

```bash
export WORKERCTL_DB=/tmp/workerctl-ralph-loop-presets-qa.db
rm -f "$WORKERCTL_DB"
scripts/workerctl tasks --create qa-ralph-loop-preset --goal "QA Ralph-loop preset evidence gates" --path "$WORKERCTL_DB"
```

Create no-tmux worker/manager sessions using the existing session registration helpers used in prior browser QA. Bind them to `qa-ralph-loop-preset`.

Create preset run:

```bash
RALPH_LOOP_RUN_ID="$(scripts/workerctl ralph-loop-presets \
  --create-run qa-ralph-loop-preset \
  --preset pr_ci_merge_loop \
  --name qa-ralph-loop-preset-policy \
  --max-iterations 3 \
  --current-iteration 1 \
  --seed-prompt-sha256 "preset-seed" \
  --json \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
```

Enqueue and dispatch before evidence exists:

```bash
MANAGER_DECISION_ID="$(scripts/workerctl record-decision qa-ralph-loop-preset nudge \
  --reason "Manager requests preset iteration 2 before preset evidence exists." \
  --payload-json "{\"ralph_loop_run_id\":\"$RALPH_LOOP_RUN_ID\",\"requested_iteration\":2,\"correlation_id\":\"ralph-loop-preset-missing\"}" \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

scripts/workerctl enqueue-continue-iteration qa-ralph-loop-preset \
  --loop-run "$RALPH_LOOP_RUN_ID" \
  --requested-iteration 2 \
  --manager-decision-id "$MANAGER_DECISION_ID" \
  --correlation-id ralph-loop-preset-missing \
  --message "Run preset iteration 2." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-ralph-loop-preset --json --path "$WORKERCTL_DB"
```

Record evidence and retry:

```bash
for evidence_type in pr_url ci_green merge; do
  criterion_id="$(scripts/workerctl criteria qa-ralph-loop-preset \
    --add \
    --criterion "Iteration 1 ${evidence_type} evidence exists" \
    --source manager_inferred \
    --status accepted \
    --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')"
  scripts/workerctl criteria qa-ralph-loop-preset \
    --satisfy "$criterion_id" \
    --proof "${evidence_type} receipt recorded." \
    --evidence-json "{\"correlation_id\":\"ralph-loop-preset-${evidence_type}\",\"evidence_type\":\"${evidence_type}\",\"iteration\":1,\"ralph_loop_run_id\":\"$RALPH_LOOP_RUN_ID\"}" \
    --path "$WORKERCTL_DB"
done
```

Retry:

```bash
scripts/workerctl enqueue-continue-iteration qa-ralph-loop-preset \
  --loop-run "$RALPH_LOOP_RUN_ID" \
  --requested-iteration 2 \
  --correlation-id ralph-loop-preset-allowed \
  --message "Run preset iteration 2 after preset evidence." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-ralph-loop-preset --json --path "$WORKERCTL_DB"
```

- [ ] **Step 3: Browser assertions**

Start dashboard:

```bash
npm run dashboard -- --host 127.0.0.1 --port 8799 --task qa-ralph-loop-preset --db-path "$WORKERCTL_DB" --workerctl-path scripts/workerctl
```

Assert the page contains:

```text
continue_iteration
missing_required_evidence
missing pr_url, ci_green, merge
iteration 1/3
requested 2
target_worker_notified=false
ralph-loop-preset-missing
ralph-loop-preset-allowed
1 notification
Run preset iteration 2 after preset evidence.
Inbox 1
Pull inbox 1
```

- [ ] **Step 4: Record receipt**

Create `docs/goals/ralph-loop-presets/notes/T004-browser-qa.md` with the DB path, task, preset, blocked dispatch fields, allowed retry fields, dashboard assertions, audit/replay/worker-inbox evidence, and cleanup note.

- [ ] **Step 5: Commit**

```bash
git add docs/goals/ralph-loop-presets
git commit -m "Record Ralph-loop preset browser QA"
```

---

### Task 7: Final Verification And PR

**Files:**
- Modify only receipt files if needed.

- [ ] **Step 1: Run focused Python tests**

```bash
python3 -m unittest \
  tests.test_workerctl.RalphLoopPresetTests \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_lists_and_shows_presets \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_creates_policy_run \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_rejects_unknown_preset \
  tests.test_workerctl.DispatchTests.test_dispatch_blocks_preset_until_all_required_evidence_exists \
  tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_outputs_managed_delivery_loop \
  -v
```

Expected: pass.

- [ ] **Step 2: Run full Python suite**

```bash
python3 -m unittest tests.test_workerctl -q
```

Expected: pass.

- [ ] **Step 3: Run dashboard tests/build**

```bash
npm test
npm run build
```

Expected: tests and build pass.

- [ ] **Step 4: Run diff and state checks**

```bash
git diff --check
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/ralph-loop-presets/state.yaml
```

Expected: both pass if GoalBuddy state exists. If execution did not use GoalBuddy, run only `git diff --check`.

- [ ] **Step 5: Run Codex review toolkit**

```bash
/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --full-access
```

Expected: `codex-review clean: no accepted/actionable findings reported`. Fix accepted findings and rerun focused tests plus review if needed.

- [ ] **Step 6: Open PR**

```bash
git push -u origin codex/ralph-loop-presets
gh pr create --base main --head codex/ralph-loop-presets --title "Add Ralph-loop evidence presets" --body "$(cat <<'EOF'
## Summary
- add named Ralph-loop presets for coverage, build/clear, PR/CI/merge, and compact/continue loops
- add CLI to list/show presets and create Ralph-loop policy runs from presets
- prove multi-evidence Dispatch blocking and allowed retry after recorded receipts
- update dashboard display and Ralph-loop QA docs for preset evidence gates

## Verification
- python3 -m unittest tests.test_workerctl -q
- npm test
- npm run build
- git diff --check
- Codex review toolkit clean
- Browser QA: pr_ci_merge_loop blocks before worker delivery until pr_url, ci_green, and merge evidence exist
EOF
)"
```

- [ ] **Step 7: Merge when green**

```bash
gh pr checks --watch --interval 10
gh pr merge --squash --delete-branch
```

Expected: GitHub checks pass before merge.

---

## Acceptance Criteria

- `workerctl ralph-loop-presets --list --json` lists `test_coverage_loop`, `build_then_clear`, `pr_ci_merge_loop`, and `compact_then_continue`.
- `workerctl ralph-loop-presets --show pr_ci_merge_loop --json` shows `required_before_continue=["pr_url","ci_green","merge"]`.
- `workerctl ralph-loop-presets --create-run <task> --preset pr_ci_merge_loop` creates a finished `ralph_loop` policy run without replacing the active telemetry run.
- Preset-created runs preserve `preset`, `max_iterations`, `current_iteration`, `cleanup_policy`, `required_before_continue`, `stop_conditions`, and `seed_prompt_sha256` metadata.
- Dispatch blocks a preset-backed `continue_iteration` before worker delivery when any required preset evidence is missing.
- Blocked preset attempts include `reason=missing_required_evidence`, ordered `missing_evidence`, `delivered=false`, and `target_worker_notified=false`.
- The worker receives no tmux push and no worker inbox item for blocked preset continuations.
- After all required evidence receipts are satisfied for the previous iteration, a fresh continuation request is delivered.
- Dashboard/replay/audit expose multiple missing evidence names and the allowed retry.
- Docs and `qa-plan ralph-loop` include preset list/create/block/retry steps.
- Browser QA proves the preset block and recovery path with precise visible assertions.

## Self-Review

- Spec coverage: The plan covers catalog, CLI, Dispatch behavior, dashboard display, docs/QA, browser receipt, review, PR, and merge.
- Placeholder scan: No placeholder markers or unspecified test steps are present.
- Type consistency: Preset metadata uses existing Ralph-loop fields: `kind`, `max_iterations`, `current_iteration`, `cleanup_policy`, `required_before_continue`, `stop_conditions`, and `seed_prompt_sha256`.
