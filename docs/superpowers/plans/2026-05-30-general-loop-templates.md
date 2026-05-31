# General Loop Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-coded Ralph-loop presets with general-purpose loop templates while keeping existing Ralph-loop commands compatible, then prove the generic mechanism with a template-driven visual-diff QA drill.

**Architecture:** Keep Dispatch generic: it enforces loop run metadata (`max_iterations`, `current_iteration`, and `required_before_continue`) and routes `continue_iteration` commands exactly as it does today. Move named template definitions into a generic `loop_templates` module, expose a new `loop-templates` CLI, and leave `ralph-loop-presets` as a compatibility alias over the same templates. Store template metadata in the existing `runs.metadata_json`; no database migration is needed for this slice.

**Tech Stack:** Python 3 standard library, SQLite-backed workerctl state, existing `unittest` suite in `tests/test_workerctl.py`, existing dashboard/manual QA docs.

---

## File Structure

- Create `workerctl/loop_templates.py`
  - Owns the generic `LoopTemplate` dataclass.
  - Owns all built-in loop templates, including current Ralph-loop-compatible templates and the first visual-diff template.
  - Exposes list/show/metadata helpers used by commands and tests.

- Modify `workerctl/ralph_loop_presets.py`
  - Becomes a thin backward-compatible wrapper around `workerctl.loop_templates`.
  - Keeps current imports and function names working for existing tests, docs, and operator scripts.

- Modify `workerctl/commands.py`
  - Add `command_loop_templates`.
  - Reuse the same create-run implementation for `loop-templates` and `ralph-loop-presets`.
  - Keep dispatch policy logic unchanged except for carrying generic `template` metadata through command results and notifications where useful.

- Modify `workerctl/cli.py`
  - Add a new `loop-templates` subcommand.
  - Keep `ralph-loop-presets` with existing options and behavior.

- Modify `tests/test_workerctl.py`
  - Add unit tests for generic template definitions.
  - Add CLI tests for `loop-templates --list`, `--show visual_diff_loop`, and `--create-run`.
  - Add dispatch tests proving template-created runs block on missing visual evidence and deliver after evidence exists.
  - Keep existing Ralph-loop preset tests passing.

- Modify `README.md`
  - Document general loop templates and the compatibility status of `ralph-loop-presets`.
  - Add a concise visual-diff example.

- Create `docs/qa/general-loop-templates.md`
  - Manual QA runbook for generic loop templates.
  - Includes a browser/dashboard drill for missing visual evidence, allowed retry, and max-iteration cutoff.

- Modify `docs/manual-qa-checklist.md`
  - Add checklist items for generic loop templates and visual-diff template QA.

---

## Task 1: Add Generic Loop Template Model

**Files:**
- Create: `workerctl/loop_templates.py`
- Modify: `workerctl/ralph_loop_presets.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write the failing unit tests**

Add these tests to `tests/test_workerctl.py` inside `RalphLoopPresetTests`:

```python
    def test_loop_templates_include_visual_diff_template(self):
        from workerctl.loop_templates import list_loop_templates, loop_template_metadata

        names = [template["name"] for template in list_loop_templates()]

        self.assertIn("test_coverage_loop", names)
        self.assertIn("pr_ci_merge_loop", names)
        self.assertIn("visual_diff_loop", names)

        visual = loop_template_metadata("visual_diff_loop")
        self.assertEqual(visual["kind"], "ralph_loop")
        self.assertEqual(visual["template"], "visual_diff_loop")
        self.assertEqual(visual["preset"], "visual_diff_loop")
        self.assertEqual(
            visual["required_before_continue"],
            ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold"],
        )
        self.assertEqual(visual["stop_conditions"], ["max_iterations", "required_evidence", "manager_accepts"])
        self.assertEqual(visual["artifact_requirements"]["diff_score"]["type"], "number")

    def test_loop_template_metadata_allows_visual_diff_overrides(self):
        from workerctl.loop_templates import loop_template_metadata

        metadata = loop_template_metadata(
            "visual_diff_loop",
            max_iterations=5,
            current_iteration=2,
            seed_prompt_sha256="visual-seed",
        )

        self.assertEqual(metadata["max_iterations"], 5)
        self.assertEqual(metadata["current_iteration"], 2)
        self.assertEqual(metadata["seed_prompt_sha256"], "visual-seed")
        self.assertEqual(metadata["cleanup_policy"], "compact")
        self.assertEqual(metadata["template"], "visual_diff_loop")
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.RalphLoopPresetTests.test_loop_templates_include_visual_diff_template \
  tests.test_workerctl.RalphLoopPresetTests.test_loop_template_metadata_allows_visual_diff_overrides \
  -v
```

Expected: both tests fail with `ModuleNotFoundError: No module named 'workerctl.loop_templates'`.

- [ ] **Step 3: Create `workerctl/loop_templates.py`**

Add this module:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from workerctl.core import WorkerError


@dataclass(frozen=True)
class LoopTemplate:
    name: str
    description: str
    max_iterations: int
    cleanup_policy: str
    required_before_continue: tuple[str, ...]
    stop_conditions: tuple[str, ...] = ("max_iterations", "required_evidence")
    artifact_requirements: dict[str, dict[str, Any]] = field(default_factory=dict)
    recommended_tools: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()

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
            "artifact_requirements": self.artifact_requirements,
            "cleanup_policy": self.cleanup_policy,
            "current_iteration": current_iteration,
            "kind": "ralph_loop",
            "max_iterations": effective_max,
            "preset": self.name,
            "recommended_tools": list(self.recommended_tools),
            "required_before_continue": list(self.required_before_continue),
            "seed_prompt_sha256": seed_prompt_sha256,
            "stop_conditions": list(self.stop_conditions),
            "tags": list(self.tags),
            "template": self.name,
        }

    def summary(self) -> dict[str, Any]:
        return {
            "artifact_requirements": self.artifact_requirements,
            "cleanup_policy": self.cleanup_policy,
            "description": self.description,
            "max_iterations": self.max_iterations,
            "name": self.name,
            "recommended_tools": list(self.recommended_tools),
            "required_before_continue": list(self.required_before_continue),
            "stop_conditions": list(self.stop_conditions),
            "tags": list(self.tags),
        }


LOOP_TEMPLATES: dict[str, LoopTemplate] = {
    "build_then_clear": LoopTemplate(
        name="build_then_clear",
        description="Require build evidence before the manager can route another iteration, then clear worker context between iterations.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("build_passed", "cleanup"),
        tags=("build", "context"),
    ),
    "compact_then_continue": LoopTemplate(
        name="compact_then_continue",
        description="Require worker completion and cleanup evidence before compacting context and continuing.",
        max_iterations=4,
        cleanup_policy="compact",
        required_before_continue=("worker_completion", "cleanup"),
        tags=("context",),
    ),
    "pr_ci_merge_loop": LoopTemplate(
        name="pr_ci_merge_loop",
        description="Require PR URL, green CI, and merge evidence before continuing a manager-led PR loop.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("pr_url", "ci_green", "merge"),
        recommended_tools=("gh", "verification.run_tests"),
        tags=("repo", "ci"),
    ),
    "test_coverage_loop": LoopTemplate(
        name="test_coverage_loop",
        description="Repeat a test-coverage analysis/fix loop until coverage evidence is recorded or max iterations is reached.",
        max_iterations=3,
        cleanup_policy="clear",
        required_before_continue=("test_coverage",),
        recommended_tools=("coverage", "verification.run_tests"),
        tags=("tests",),
    ),
    "visual_diff_loop": LoopTemplate(
        name="visual_diff_loop",
        description="Repeat screenshot-to-HTML or UX visual-diff passes until screenshot artifacts and an acceptable diff report are recorded.",
        max_iterations=4,
        cleanup_policy="compact",
        required_before_continue=(
            "reference_artifact",
            "candidate_screenshot",
            "visual_diff_report",
            "diff_below_threshold",
        ),
        stop_conditions=("max_iterations", "required_evidence", "manager_accepts"),
        artifact_requirements={
            "reference_artifact": {"type": "path", "description": "Desired UX screenshot or reference image path."},
            "candidate_screenshot": {"type": "path", "description": "Screenshot captured from the worker-produced HTML or app view."},
            "visual_diff_report": {"type": "path", "description": "Readable report describing visual differences and screenshots compared."},
            "diff_score": {"type": "number", "description": "Numeric diff score where lower means closer to the reference."},
            "viewport": {"type": "string", "description": "Viewport used for the candidate screenshot, such as 1440x900."},
        },
        recommended_tools=("browser", "playwright", "pixelmatch"),
        tags=("visual", "frontend", "qa"),
    ),
}


def list_loop_templates() -> list[dict[str, Any]]:
    return [LOOP_TEMPLATES[name].summary() for name in sorted(LOOP_TEMPLATES)]


def loop_template(name: str) -> LoopTemplate:
    try:
        return LOOP_TEMPLATES[name]
    except KeyError as exc:
        allowed = ", ".join(sorted(LOOP_TEMPLATES))
        raise WorkerError(f"Unknown loop template: {name}; expected one of: {allowed}") from exc


def loop_template_metadata(
    name: str,
    *,
    max_iterations: int | None = None,
    current_iteration: int = 0,
    seed_prompt_sha256: str | None = None,
) -> dict[str, Any]:
    return loop_template(name).to_metadata(
        max_iterations=max_iterations,
        current_iteration=current_iteration,
        seed_prompt_sha256=seed_prompt_sha256,
    )
```

- [ ] **Step 4: Convert `workerctl/ralph_loop_presets.py` into a compatibility wrapper**

Replace the body of `workerctl/ralph_loop_presets.py` with:

```python
from __future__ import annotations

from typing import Any

from workerctl.loop_templates import (
    LOOP_TEMPLATES as RALPH_LOOP_PRESETS,
    LoopTemplate as RalphLoopPreset,
    list_loop_templates,
    loop_template,
    loop_template_metadata,
)


def list_ralph_loop_presets() -> list[dict[str, Any]]:
    return list_loop_templates()


def ralph_loop_preset(name: str) -> RalphLoopPreset:
    return loop_template(name)


def ralph_loop_preset_metadata(
    name: str,
    *,
    max_iterations: int | None = None,
    current_iteration: int = 0,
    seed_prompt_sha256: str | None = None,
) -> dict[str, Any]:
    return loop_template_metadata(
        name,
        max_iterations=max_iterations,
        current_iteration=current_iteration,
        seed_prompt_sha256=seed_prompt_sha256,
    )
```

- [ ] **Step 5: Run tests and verify the template layer passes**

Run:

```bash
python3 -m unittest tests.test_workerctl.RalphLoopPresetTests -v
```

Expected: all `RalphLoopPresetTests` pass.

- [ ] **Step 6: Commit**

```bash
git add workerctl/loop_templates.py workerctl/ralph_loop_presets.py tests/test_workerctl.py
git commit -m "Add generic loop template definitions"
```

---

## Task 2: Add `loop-templates` CLI While Preserving `ralph-loop-presets`

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `workerctl/cli.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing CLI tests**

Add these tests near the existing Ralph-loop preset CLI tests in `tests/test_workerctl.py`:

```python
    def test_loop_templates_cli_lists_and_shows_visual_diff_template(self):
        list_proc = self.run_workerctl("loop-templates", "--list", "--json")

        self.assertEqual(list_proc.returncode, 0, list_proc.stderr)
        payload = json.loads(list_proc.stdout)
        names = [template["name"] for template in payload["templates"]]
        self.assertIn("visual_diff_loop", names)

        show_proc = self.run_workerctl("loop-templates", "--show", "visual_diff_loop", "--json")

        self.assertEqual(show_proc.returncode, 0, show_proc.stderr)
        template = json.loads(show_proc.stdout)
        self.assertEqual(template["name"], "visual_diff_loop")
        self.assertEqual(
            template["required_before_continue"],
            ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold"],
        )

    def test_loop_templates_cli_creates_visual_diff_policy_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="visual-template-task", goal="Run visual template loop.")
                conn.commit()

            proc = self.run_workerctl(
                "loop-templates",
                "--create-run",
                "visual-template-task",
                "--template",
                "visual_diff_loop",
                "--name",
                "visual-policy",
                "--max-iterations",
                "4",
                "--current-iteration",
                "1",
                "--seed-prompt-sha256",
                "visual123",
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["purpose"], "ralph_loop")
            self.assertEqual(payload["metadata"]["template"], "visual_diff_loop")
            self.assertEqual(payload["metadata"]["preset"], "visual_diff_loop")
            self.assertEqual(payload["metadata"]["max_iterations"], 4)
            self.assertEqual(payload["metadata"]["current_iteration"], 1)
            self.assertEqual(
                payload["metadata"]["required_before_continue"],
                ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold"],
            )
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                loop_run = worker_db.ralph_loop_run(conn, run=payload["id"])
            self.assertEqual(loop_run["task_id"], task_id)
            self.assertEqual(loop_run["preset"], "visual_diff_loop")
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_loop_templates_cli_lists_and_shows_visual_diff_template \
  tests.test_workerctl.CliTests.test_loop_templates_cli_creates_visual_diff_policy_run \
  -v
```

Expected: both fail because `loop-templates` is not a known subcommand.

- [ ] **Step 3: Add generic command imports in `workerctl/commands.py`**

Change the existing import:

```python
from workerctl.ralph_loop_presets import list_ralph_loop_presets, ralph_loop_preset, ralph_loop_preset_metadata
```

to:

```python
from workerctl.loop_templates import list_loop_templates, loop_template, loop_template_metadata
from workerctl.ralph_loop_presets import list_ralph_loop_presets, ralph_loop_preset, ralph_loop_preset_metadata
```

- [ ] **Step 4: Add shared create-run helper and `command_loop_templates`**

Add this helper above `command_ralph_loop_presets` in `workerctl/commands.py`:

```python
def _create_loop_template_run(args: argparse.Namespace, *, template_name: str, task_name: str) -> dict[str, Any]:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    metadata = loop_template_metadata(
        template_name,
        max_iterations=args.max_iterations,
        current_iteration=args.current_iteration,
        seed_prompt_sha256=args.seed_prompt_sha256,
    )
    with connect_db(db_path) as conn:
        initialize_database(conn)
        task = db_task_row(conn, task=task_name)
        run_id = create_db_ralph_loop_run(
            conn,
            task_id=task["id"],
            name=args.name,
            max_iterations=metadata["max_iterations"],
            current_iteration=metadata["current_iteration"],
            cleanup_policy=metadata.get("cleanup_policy"),
            required_before_continue=metadata.get("required_before_continue"),
            stop_conditions=metadata.get("stop_conditions"),
            seed_prompt_sha256=metadata.get("seed_prompt_sha256"),
            preset=metadata.get("template") or metadata.get("preset"),
        )
        conn.commit()
        result = db_run_row(conn, run=run_id)
    result["metadata"] = {**result["metadata"], **{key: metadata[key] for key in metadata if key not in result["metadata"]}}
    return result
```

Add this command below the helper:

```python
def command_loop_templates(args: argparse.Namespace) -> int:
    if args.list:
        print(json.dumps({"templates": list_loop_templates()}, indent=2, sort_keys=True))
        return 0
    if args.show:
        print(json.dumps(loop_template(args.show).summary(), indent=2, sort_keys=True))
        return 0
    if args.create_run:
        if not args.template:
            raise WorkerError("--create-run requires --template")
        result = _create_loop_template_run(args, template_name=args.template, task_name=args.create_run)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    raise WorkerError("Choose one of --list, --show, or --create-run")
```

Then simplify `command_ralph_loop_presets` by reusing the same helper:

```python
def command_ralph_loop_presets(args: argparse.Namespace) -> int:
    if args.list:
        print(json.dumps({"presets": list_ralph_loop_presets()}, indent=2, sort_keys=True))
        return 0
    if args.show:
        print(json.dumps(ralph_loop_preset(args.show).summary(), indent=2, sort_keys=True))
        return 0
    if args.create_run:
        if not args.preset:
            raise WorkerError("--create-run requires --preset")
        result = _create_loop_template_run(args, template_name=args.preset, task_name=args.create_run)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    raise WorkerError("Choose one of --list, --show, or --create-run")
```

- [ ] **Step 5: Register the CLI command in `workerctl/cli.py`**

Add `command_loop_templates` to the import list from `workerctl.commands`.

Add this parser immediately before the existing `ralph-loop-presets` parser:

```python
    loop_templates = subparsers.add_parser(
        "loop-templates",
        help="List loop templates or create a template-backed loop policy run.",
    )
    loop_template_action = loop_templates.add_mutually_exclusive_group(required=True)
    loop_template_action.add_argument("--list", action="store_true", help="List available loop templates.")
    loop_template_action.add_argument("--show", metavar="TEMPLATE", help="Show one loop template.")
    loop_template_action.add_argument("--create-run", metavar="TASK", help="Create a template-backed loop policy run for a task.")
    loop_templates.add_argument("--template", help="Template name to use with --create-run.")
    loop_templates.add_argument("--name", help="Optional run name when creating a run.")
    loop_templates.add_argument("--max-iterations", type=int, help="Override the template default max iterations when creating a run.")
    loop_templates.add_argument("--current-iteration", type=int, default=0, help="Current completed iteration when creating a run.")
    loop_templates.add_argument("--seed-prompt-sha256", help="Seed prompt hash to store with the policy run.")
    loop_templates.add_argument("--json", action="store_true", help="Print stable JSON output.")
    loop_templates.add_argument("--path", help="Override the workerctl database path.")
    loop_templates.set_defaults(func=command_loop_templates)
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_loop_templates_cli_lists_and_shows_visual_diff_template \
  tests.test_workerctl.CliTests.test_loop_templates_cli_creates_visual_diff_policy_run \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_lists_and_shows_templates \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_creates_policy_run \
  -v
```

Expected: all four tests pass.

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add generic loop templates CLI"
```

---

## Task 3: Preserve Full Template Metadata in Run Records

**Files:**
- Modify: `workerctl/db.py`
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing tests for artifact metadata persistence**

Add this assertion to `test_loop_templates_cli_creates_visual_diff_policy_run` after the existing `required_before_continue` assertion:

```python
            self.assertEqual(payload["metadata"]["artifact_requirements"]["diff_score"]["type"], "number")
            self.assertEqual(payload["metadata"]["recommended_tools"], ["browser", "playwright", "pixelmatch"])
            self.assertEqual(payload["metadata"]["tags"], ["visual", "frontend", "qa"])
```

Add this assertion after `loop_run = worker_db.ralph_loop_run(conn, run=payload["id"])`:

```python
            self.assertEqual(loop_run["metadata"]["artifact_requirements"]["viewport"]["type"], "string")
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_loop_templates_cli_creates_visual_diff_policy_run -v
```

Expected: the test fails because `create_ralph_loop_run` currently stores only the policy fields and drops richer template metadata.

- [ ] **Step 3: Extend `create_ralph_loop_run` with optional metadata extras**

In `workerctl/db.py`, change the signature of `create_ralph_loop_run` to include:

```python
    extra_metadata: dict[str, Any] | None = None,
```

Build metadata as:

```python
    metadata: dict[str, Any] = {
        **(extra_metadata or {}),
        "cleanup_policy": cleanup_policy,
        "current_iteration": current_iteration,
        "kind": "ralph_loop",
        "max_iterations": max_iterations,
        "policy_record": True,
        "preset": preset,
        "required_before_continue": required_evidence,
        "seed_prompt_sha256": seed_prompt_sha256,
        "stop_conditions": stop_conditions or [],
    }
```

This keeps authoritative policy fields from the function arguments while allowing template-only fields like `artifact_requirements`, `recommended_tools`, `tags`, and `template`.

- [ ] **Step 4: Pass template extras from `command_loop_templates`**

In `_create_loop_template_run`, pass extras:

```python
            extra_metadata={
                key: value
                for key, value in metadata.items()
                if key
                not in {
                    "cleanup_policy",
                    "current_iteration",
                    "kind",
                    "max_iterations",
                    "preset",
                    "required_before_continue",
                    "seed_prompt_sha256",
                    "stop_conditions",
                }
            },
```

- [ ] **Step 5: Run the metadata persistence tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_loop_templates_cli_creates_visual_diff_policy_run \
  tests.test_workerctl.CliTests.test_ralph_loop_presets_cli_creates_policy_run \
  -v
```

Expected: both tests pass, and existing Ralph-loop preset runs still store their policy fields.

- [ ] **Step 6: Commit**

```bash
git add workerctl/db.py workerctl/commands.py tests/test_workerctl.py
git commit -m "Persist loop template metadata on policy runs"
```

---

## Task 4: Prove Dispatch Gates Template Evidence Generically

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Write a failing dispatch test for missing visual-diff evidence**

Add this test next to the existing `continue_iteration` dispatch tests:

```python
    def test_dispatch_blocks_visual_diff_template_until_required_evidence_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn, db_path = self.open_db(tmpdir)
            worker_id, _manager_id = self.setup_bound_task(conn)
            conn.execute("update sessions set tmux_session = null where id = ?", (worker_id,))
            loop_run_id = worker_db.create_ralph_loop_run(
                conn,
                task_id="task-dispatch",
                name="visual-loop",
                max_iterations=4,
                current_iteration=1,
                cleanup_policy="compact",
                required_before_continue=[
                    "reference_artifact",
                    "candidate_screenshot",
                    "visual_diff_report",
                    "diff_below_threshold",
                ],
                stop_conditions=["max_iterations", "required_evidence", "manager_accepts"],
                preset="visual_diff_loop",
                extra_metadata={
                    "template": "visual_diff_loop",
                    "artifact_requirements": {
                        "diff_score": {"type": "number", "description": "Numeric diff score."}
                    },
                },
            )
            command_id = worker_db.enqueue_continue_iteration(
                conn,
                task_id="task-dispatch",
                message="Run visual iteration 2.",
                loop_run_id=loop_run_id,
                requested_iteration=2,
                correlation_id="visual-loop-missing-evidence",
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

            payload = json.loads(stdout.getvalue())
            processed = payload["processed"][0]
            command_row = conn.execute(
                "select state, result_json, error from commands where id = ?",
                (command_id,),
            ).fetchone()

            self.assertEqual(processed["state"], "blocked")
            self.assertEqual(processed["reason"], "missing_required_evidence")
            self.assertEqual(
                processed["missing_evidence"],
                ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold"],
            )
            self.assertFalse(processed["delivered"])
            self.assertFalse(processed["target_worker_notified"])
            self.assertEqual(processed["current_iteration"], 1)
            self.assertEqual(processed["max_iterations"], 4)
            self.assertEqual(processed["requested_iteration"], 2)
            self.assertEqual(command_row["state"], "failed")
            self.assertIn("missing_required_evidence", command_row["error"])
            self.assertEqual(worker_db.routed_notifications(conn, task_id="task-dispatch"), [])
            self.assertEqual(worker_db.session_inbox(conn, session_name="worker-session"), [])
            send.assert_not_called()
```

- [ ] **Step 2: Run the test and verify it passes**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_dispatch_blocks_visual_diff_template_until_required_evidence_exists -v
```

Expected: the test passes once Task 3 added `extra_metadata`; the existing dispatcher policy already gates arbitrary evidence names.

- [ ] **Step 3: Write an allow-after-evidence test**

Add this test next to the missing-evidence visual test:

```python
    def test_dispatch_allows_visual_diff_template_after_required_evidence_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn, db_path = self.open_db(tmpdir)
            worker_id, _manager_id = self.setup_bound_task(conn)
            conn.execute("update sessions set tmux_session = null where id = ?", (worker_id,))
            loop_run_id = worker_db.create_ralph_loop_run(
                conn,
                task_id="task-dispatch",
                name="visual-loop",
                max_iterations=4,
                current_iteration=1,
                cleanup_policy="compact",
                required_before_continue=[
                    "reference_artifact",
                    "candidate_screenshot",
                    "visual_diff_report",
                    "diff_below_threshold",
                ],
                stop_conditions=["max_iterations", "required_evidence", "manager_accepts"],
                preset="visual_diff_loop",
                extra_metadata={"template": "visual_diff_loop"},
            )
            for evidence_type, proof in [
                ("reference_artifact", "/tmp/reference.png recorded"),
                ("candidate_screenshot", "/tmp/candidate.png recorded"),
                ("visual_diff_report", "/tmp/diff-report.json recorded"),
                ("diff_below_threshold", "diff score 0.012 <= threshold 0.02"),
            ]:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-dispatch",
                    criterion=f"Visual evidence exists: {evidence_type}",
                    status="satisfied",
                    source="manager_inferred",
                    proof=proof,
                    evidence={
                        "correlation_id": f"visual-loop-{evidence_type}",
                        "evidence_type": evidence_type,
                        "iteration": 1,
                        "ralph_loop_run_id": loop_run_id,
                        "status": "pass",
                    },
                )
            command_id = worker_db.enqueue_continue_iteration(
                conn,
                task_id="task-dispatch",
                message="Run visual iteration 2.",
                loop_run_id=loop_run_id,
                requested_iteration=2,
                correlation_id="visual-loop-allowed",
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

            payload = json.loads(stdout.getvalue())
            notification = worker_db.routed_notifications(conn, task_id="task-dispatch")[0]
            consumed = worker_db.consume_next_session_inbox_item(conn, session_name="worker-session")
            command_row = conn.execute("select state from commands where id = ?", (command_id,)).fetchone()

            self.assertEqual(payload["processed"][0]["state"], "pull_required")
            self.assertEqual(command_row["state"], "succeeded")
            self.assertEqual(notification["command_id"], command_id)
            self.assertEqual(notification["signal_type"], "continue_iteration")
            self.assertEqual(notification["delivery_mode"], "pull_required")
            self.assertEqual(notification["payload"]["ralph_loop"]["run_id"], loop_run_id)
            self.assertEqual(notification["payload"]["ralph_loop"]["requested_iteration"], 2)
            self.assertEqual(
                notification["payload"]["ralph_loop"]["required_before_continue"],
                ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold"],
            )
            self.assertEqual(consumed["payload"]["message"], "Run visual iteration 2.")
            send.assert_not_called()
```

- [ ] **Step 4: Run the visual dispatch tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_dispatch_blocks_visual_diff_template_until_required_evidence_exists \
  tests.test_workerctl.CliTests.test_dispatch_allows_visual_diff_template_after_required_evidence_exists \
  -v
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/test_workerctl.py
git commit -m "Prove template evidence gates dispatch continuation"
```

---

## Task 5: Add Generic Loop Template QA Runbook

**Files:**
- Create: `docs/qa/general-loop-templates.md`
- Modify: `docs/manual-qa-checklist.md`
- Modify: `README.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing docs tests**

Add these tests to `tests/test_workerctl.py` in `ManagerBootstrapPromptTests`:

```python
    def test_readme_documents_generic_loop_templates(self):
        readme = (PROJECT_ROOT / "README.md").read_text()

        self.assertIn("loop-templates", readme)
        self.assertIn("visual_diff_loop", readme)
        self.assertIn("required_before_continue", readme)
        self.assertIn("ralph-loop-presets", readme)

    def test_general_loop_template_qa_documents_visual_drill(self):
        qa_doc = (PROJECT_ROOT / "docs" / "qa" / "general-loop-templates.md").read_text()

        self.assertIn("visual_diff_loop", qa_doc)
        self.assertIn("loop-templates --create-run", qa_doc)
        self.assertIn("missing_required_evidence", qa_doc)
        self.assertIn("diff_below_threshold", qa_doc)
        self.assertIn("worker-inbox", qa_doc)
        self.assertIn("dispatch_inbox_consumed", qa_doc)
```

- [ ] **Step 2: Run docs tests and verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_readme_documents_generic_loop_templates \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_general_loop_template_qa_documents_visual_drill \
  -v
```

Expected: the QA doc test fails because the file does not exist, and the README test fails until the new section is written.

- [ ] **Step 3: Create `docs/qa/general-loop-templates.md`**

Create the document with this content:

```markdown
# Codex QA: General Loop Templates

Use this QA scenario to prove a named loop template can create a generic policy run, Dispatch can block a manager-requested continuation before worker delivery when required evidence is missing, and a fresh retry can reach the worker inbox after evidence is recorded.

## Scenario

- Template: `visual_diff_loop`
- Task: `qa-general-loop-template`
- Default max iterations: `4`
- Required evidence before iteration 2: `reference_artifact`, `candidate_screenshot`, `visual_diff_report`, `diff_below_threshold`
- Dispatcher role: mechanical routing and policy enforcement only
- Manager role: decide whether another visual pass is useful and record the evidence receipts
- Worker role: implement or inspect the UI, produce screenshots or HTML, and report artifact paths

## Setup

```bash
WORKERCTL_DB="$(mktemp -t workerctl-loop-template.XXXXXX.db)"
scripts/workerctl tasks --create qa-general-loop-template --goal "QA generic loop templates with visual-diff evidence." --path "$WORKERCTL_DB"
scripts/workerctl register-worker --name qa-loop-worker --pid $$ --cwd "$PWD" --path "$WORKERCTL_DB"
scripts/workerctl register-manager --name qa-loop-manager --pid $$ --cwd "$PWD" --path "$WORKERCTL_DB"
scripts/workerctl bind --task qa-general-loop-template --worker qa-loop-worker --manager qa-loop-manager --path "$WORKERCTL_DB"
```

Create the template-backed run:

```bash
RUN_ID="$(scripts/workerctl loop-templates \
  --create-run qa-general-loop-template \
  --template visual_diff_loop \
  --name qa-visual-template-run \
  --max-iterations 4 \
  --current-iteration 1 \
  --seed-prompt-sha256 visual-template-seed \
  --json \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
```

## Missing Evidence Block

Queue a manager continuation before visual evidence exists:

```bash
DECISION_ID="$(scripts/workerctl record-decision qa-general-loop-template nudge \
  --reason "Manager requests visual iteration 2 before visual evidence exists." \
  --payload-json "{\"loop_run_id\":\"$RUN_ID\",\"requested_iteration\":2,\"template\":\"visual_diff_loop\",\"correlation_id\":\"visual-loop-missing\"}" \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

scripts/workerctl enqueue-continue-iteration qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --requested-iteration 2 \
  --manager-decision-id "$DECISION_ID" \
  --correlation-id visual-loop-missing \
  --message "Run visual iteration 2." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-loop-template --json --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Dispatch result includes `state=blocked`.
- Dispatch result includes `reason=missing_required_evidence`.
- Dispatch result includes all four missing evidence names in order.
- Dispatch result includes `delivered=false` and `target_worker_notified=false`.
- `scripts/workerctl worker-inbox qa-general-loop-template --json --path "$WORKERCTL_DB"` returns no items.
- Dashboard Dispatch panel shows the correlation `visual-loop-missing`, `0 notifications`, `Inbox 0`, and `Pull inbox 0`.

## Allowed Retry After Evidence

Record visual evidence as satisfied criteria:

```bash
scripts/workerctl criteria qa-general-loop-template --add --criterion "Reference artifact recorded" --source manager_inferred --status satisfied --proof "/tmp/reference.png" --evidence-json "{\"ralph_loop_run_id\":\"$RUN_ID\",\"iteration\":1,\"evidence_type\":\"reference_artifact\",\"status\":\"pass\",\"artifact_path\":\"/tmp/reference.png\",\"correlation_id\":\"visual-loop-reference\"}" --path "$WORKERCTL_DB"
scripts/workerctl criteria qa-general-loop-template --add --criterion "Candidate screenshot recorded" --source manager_inferred --status satisfied --proof "/tmp/candidate.png" --evidence-json "{\"ralph_loop_run_id\":\"$RUN_ID\",\"iteration\":1,\"evidence_type\":\"candidate_screenshot\",\"status\":\"pass\",\"artifact_path\":\"/tmp/candidate.png\",\"viewport\":\"1440x900\",\"correlation_id\":\"visual-loop-candidate\"}" --path "$WORKERCTL_DB"
scripts/workerctl criteria qa-general-loop-template --add --criterion "Visual diff report recorded" --source manager_inferred --status satisfied --proof "/tmp/visual-diff.json" --evidence-json "{\"ralph_loop_run_id\":\"$RUN_ID\",\"iteration\":1,\"evidence_type\":\"visual_diff_report\",\"status\":\"pass\",\"artifact_path\":\"/tmp/visual-diff.json\",\"diff_score\":0.012,\"threshold\":0.02,\"correlation_id\":\"visual-loop-report\"}" --path "$WORKERCTL_DB"
scripts/workerctl criteria qa-general-loop-template --add --criterion "Visual diff is below threshold" --source manager_inferred --status satisfied --proof "diff score 0.012 <= threshold 0.02" --evidence-json "{\"ralph_loop_run_id\":\"$RUN_ID\",\"iteration\":1,\"evidence_type\":\"diff_below_threshold\",\"status\":\"pass\",\"diff_score\":0.012,\"threshold\":0.02,\"correlation_id\":\"visual-loop-threshold\"}" --path "$WORKERCTL_DB"
```

Queue and dispatch a fresh retry:

```bash
scripts/workerctl enqueue-continue-iteration qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --requested-iteration 2 \
  --correlation-id visual-loop-allowed \
  --message "Run visual iteration 2 after evidence receipts." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-loop-template --json --path "$WORKERCTL_DB"
scripts/workerctl worker-inbox qa-general-loop-template --consume-next --wait --timeout 2 --json --path "$WORKERCTL_DB"
scripts/workerctl telemetry --task qa-general-loop-template --event-type dispatch_inbox_consumed --json --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Dispatch result includes `state=pull_required` for a non-tmux worker.
- Routed notification has `signal_type=continue_iteration`.
- Worker inbox consumption returns the visual iteration message.
- Telemetry includes `dispatch_inbox_consumed`.
- Replay and audit connect `visual-loop-allowed` to the command attempt, routed notification, worker inbox item, and consumption event.

## Max Iteration Cutoff

Create a second run at its max:

```bash
MAX_RUN_ID="$(scripts/workerctl loop-templates \
  --create-run qa-general-loop-template \
  --template visual_diff_loop \
  --name qa-visual-max-run \
  --max-iterations 1 \
  --current-iteration 1 \
  --json \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

scripts/workerctl enqueue-continue-iteration qa-general-loop-template \
  --loop-run "$MAX_RUN_ID" \
  --requested-iteration 2 \
  --correlation-id visual-loop-max-block \
  --message "Run visual iteration 2." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-loop-template --json --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Dispatch result includes `state=blocked`.
- Dispatch result includes `reason=max_iterations_reached`.
- Dispatch result includes `delivered=false` and `target_worker_notified=false`.
- Worker inbox receives no item for `visual-loop-max-block`.
```

- [ ] **Step 4: Update `README.md`**

Add this section near the existing Ralph-loop command docs:

```markdown
- `loop-templates --list|--show TEMPLATE|--create-run TASK --template TEMPLATE` —
  List generic loop templates or create a template-backed loop policy run.
  Template-backed runs use the same Dispatch guardrails as Ralph-loop presets:
  `max_iterations` prevents over-looping, and `required_before_continue`
  evidence blocks a manager continuation before worker delivery until matching
  satisfied criterion evidence exists. `ralph-loop-presets` remains as a
  compatibility alias for the current Ralph-loop QA flows.
  The built-in `visual_diff_loop` template requires `reference_artifact`,
  `candidate_screenshot`, `visual_diff_report`, and `diff_below_threshold`
  evidence before a manager-requested next visual pass can reach the worker.
```

- [ ] **Step 5: Update `docs/manual-qa-checklist.md`**

Add these checklist items:

```markdown
- [ ] `scripts/workerctl loop-templates --list --json` includes `visual_diff_loop`, `test_coverage_loop`, `pr_ci_merge_loop`, `build_then_clear`, and `compact_then_continue`.
- [ ] Generic loop template QA blocks `visual_diff_loop` continuation with `missing_required_evidence`, `0 notifications`, `Inbox 0`, and `Pull inbox 0` before visual evidence exists.
- [ ] Generic loop template QA delivers a fresh `continue_iteration` after `reference_artifact`, `candidate_screenshot`, `visual_diff_report`, and `diff_below_threshold` evidence are recorded.
- [ ] Generic loop template QA consumes the delivered worker inbox item with `--consume-next --wait` and records `dispatch_inbox_consumed` telemetry.
```

- [ ] **Step 6: Run docs tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_readme_documents_generic_loop_templates \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_general_loop_template_qa_documents_visual_drill \
  -v
```

Expected: both tests pass.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/manual-qa-checklist.md docs/qa/general-loop-templates.md tests/test_workerctl.py
git commit -m "Document generic loop template QA"
```

---

## Task 6: Run Full Verification and Review

**Files:**
- No source edits expected unless verification finds an issue.

- [ ] **Step 1: Run focused loop-template tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.RalphLoopPresetTests \
  tests.test_workerctl.CliTests.test_loop_templates_cli_lists_and_shows_visual_diff_template \
  tests.test_workerctl.CliTests.test_loop_templates_cli_creates_visual_diff_policy_run \
  tests.test_workerctl.CliTests.test_dispatch_blocks_visual_diff_template_until_required_evidence_exists \
  tests.test_workerctl.CliTests.test_dispatch_allows_visual_diff_template_after_required_evidence_exists \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_readme_documents_generic_loop_templates \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_general_loop_template_qa_documents_visual_drill \
  -v
```

Expected: all listed tests pass.

- [ ] **Step 2: Run repository release check**

Run:

```bash
scripts/rc-check
```

Expected: Python unittest suite passes, dashboard tests pass, dashboard build passes, shell syntax checks pass, and any documented optional smoke skips are explicit.

- [ ] **Step 3: Run review toolkit**

Run:

```bash
/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --parallel-tests "scripts/rc-check"
```

Expected: no accepted actionable findings remain. If review finds an issue, fix it in the smallest relevant task area, rerun the focused tests and `scripts/rc-check`, then rerun review.

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: `git diff --check` exits zero. Git status shows only intentional changes before the final commit or is clean after the final commit.

- [ ] **Step 5: Commit verification fixes if needed**

If Step 3 or Step 4 required changes, run:

```bash
git add workerctl tests README.md docs
git commit -m "Polish generic loop template rollout"
```

Expected: a commit is created only if verification fixes were necessary.

---

## Task 7: Manual QA Browser/Dashboard Drill

**Files:**
- No source edits expected unless QA finds an issue.

- [ ] **Step 1: Create a disposable database and task**

Run the setup commands in `docs/qa/general-loop-templates.md` under `Setup`.

Expected: task, worker, manager, and binding are created successfully in the disposable database.

- [ ] **Step 2: Create the visual template run**

Run the `loop-templates --create-run` command in the QA doc.

Expected: output metadata includes:

```json
{
  "template": "visual_diff_loop",
  "max_iterations": 4,
  "current_iteration": 1,
  "required_before_continue": [
    "reference_artifact",
    "candidate_screenshot",
    "visual_diff_report",
    "diff_below_threshold"
  ]
}
```

- [ ] **Step 3: Prove missing evidence blocks worker delivery**

Run the `Missing Evidence Block` commands in the QA doc.

Expected: Dispatch returns `state=blocked`, `reason=missing_required_evidence`, `delivered=false`, `target_worker_notified=false`, and no worker inbox item exists for `visual-loop-missing`.

- [ ] **Step 4: Open the dashboard for the disposable task**

Run:

```bash
scripts/workerctl dashboard --task qa-general-loop-template --ensure-dispatch --dispatcher-id qa-loop-template --path "$WORKERCTL_DB"
```

Expected: the Dispatch panel shows `visual-loop-missing`, missing evidence, `0 notifications`, `Inbox 0`, and `Pull inbox 0`.

- [ ] **Step 5: Prove evidence allows a fresh retry**

Run the `Allowed Retry After Evidence` commands in the QA doc.

Expected: Dispatch returns `state=pull_required`; `worker-inbox --consume-next --wait` returns the visual iteration message; telemetry includes `dispatch_inbox_consumed`.

- [ ] **Step 6: Prove max-iteration cutoff still blocks**

Run the `Max Iteration Cutoff` commands in the QA doc.

Expected: Dispatch returns `state=blocked`, `reason=max_iterations_reached`, and no worker inbox item exists for `visual-loop-max-block`.

- [ ] **Step 7: Export QA evidence**

Run:

```bash
scripts/workerctl replay qa-general-loop-template --path "$WORKERCTL_DB"
scripts/workerctl audit qa-general-loop-template --json --path "$WORKERCTL_DB"
scripts/workerctl export-task qa-general-loop-template --output /tmp/qa-general-loop-template-export --path "$WORKERCTL_DB"
```

Expected: replay and audit show the blocked attempt, allowed retry, inbox consumption, and max-iteration block with their correlation ids.

---

## Acceptance Criteria

- `loop-templates --list --json` returns all current loop templates plus `visual_diff_loop`.
- `loop-templates --show visual_diff_loop --json` returns required evidence, artifact requirements, recommended tools, tags, cleanup policy, and stop conditions.
- `loop-templates --create-run` creates a `ralph_loop` policy run backed by generic template metadata.
- `ralph-loop-presets` remains backward-compatible for existing operators and tests.
- Dispatch blocks `continue_iteration` before worker delivery when a template run is missing required evidence.
- Dispatch delivers a fresh `continue_iteration` after matching satisfied criterion evidence exists for the previous iteration.
- Dispatch blocks over-max continuation before worker delivery.
- Non-tmux workers receive allowed continuation through `worker-inbox`, and consumption emits `dispatch_inbox_consumed`.
- README and QA docs explain generic templates and the visual-diff drill.
- `scripts/rc-check` and codex-review toolkit pass before PR creation.

## Self-Review

- **Spec coverage:** The plan covers generic loop templates, visual-diff as a data template instead of bespoke dispatcher behavior, backward compatibility, dispatch guardrails, inbox delivery, docs, and QA.
- **Placeholder scan:** No implementation step relies on `TBD`, `TODO`, or undefined future behavior. Dynamic values in shell commands are declared in the command blocks before use.
- **Type consistency:** The plan consistently uses `LoopTemplate`, `loop_template_metadata`, `template`, `preset`, `required_before_continue`, `artifact_requirements`, and existing `ralph_loop` run metadata.
