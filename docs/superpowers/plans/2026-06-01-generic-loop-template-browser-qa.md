# Generic Loop Template Browser QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `workerctl qa-run generic-loop-template-browser`, a browser-backed QA receipt that proves the generic `visual_diff_loop` dispatcher gates work with a real rendered screenshot artifact.

**Architecture:** Keep `qa-run generic-loop-template` as the dependency-light synthetic baseline. Add a sibling browser scenario that writes a deterministic 2x2 CSS color-grid HTML file, captures it with Playwright through a narrow helper, records the screenshot as run-qualified evidence, and reuses the existing visual-diff plus adversarial-gate dispatcher proof.

**Tech Stack:** Python `unittest`, `workerctl` CLI, SQLite worker DB helpers, Node.js, `@playwright/test`, existing `workerctl.visual_diff.compute_visual_diff`.

---

## File Structure

- Modify `workerctl/cli.py`
  - Add `generic-loop-template-browser` to `qa-run` scenario choices.
- Modify `workerctl/commands.py`
  - Add helper functions for deterministic browser reference/candidate HTML creation.
  - Add `_qa_run_capture_browser_screenshot(...)`, a thin Python wrapper around a Node Playwright script.
  - Add `_qa_run_record_browser_visual_template_evidence(...)`.
  - Add `_qa_run_generic_loop_template_browser(...)`.
  - Register the new scenario in `command_qa_run`.
- Create `scripts/capture-static-html-screenshot.mjs`
  - Capture a local static HTML file to PNG using Playwright Chromium with fixed viewport and device scale factor.
  - Print stable JSON metadata on success.
  - Emit a clear error when Playwright or browser binaries are unavailable.
- Modify `tests/test_workerctl.py`
  - Add a focused receipt test that patches `_qa_run_capture_browser_screenshot` to avoid requiring a real browser during unit tests.
  - Parameterize dirty/stale queue tests across all three QA scenarios.
  - Add a help/routing assertion for the new scenario.
- Modify `README.md`
  - Document the new browser-backed QA command and the optional Playwright runtime requirement.
- Modify `docs/manual-qa-checklist.md`
  - Add a manual QA checklist row for the browser-backed receipt.
- Modify `docs/qa/general-loop-templates.md`
  - Add a browser-backed generic loop QA example.

## Task 1: Red Tests For Browser QA Scenario

**Files:**
- Modify: `tests/test_workerctl.py`
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`

- [ ] **Step 1: Add a failing CLI help test**

Add this test near the existing `qa-run` tests in `tests/test_workerctl.py`:

```python
    def test_qa_run_help_lists_generic_loop_template_browser(self):
        proc = self.run_workerctl("qa-run", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("generic-loop-template-browser", proc.stdout)
```

- [ ] **Step 2: Add a failing browser receipt test using a fake screenshot helper**

Add this test immediately after `test_qa_run_generic_loop_template_writes_replayable_receipt`:

```python
    def test_qa_run_generic_loop_template_browser_writes_replayable_receipt(self):
        def fake_capture(*, html_path, screenshot_path, viewport):
            self.assertTrue(Path(html_path).exists())
            html = Path(html_path).read_text()
            self.assertIn("qa-pixel-0", html)
            self.assertEqual(viewport, {"width": 2, "height": 2})
            commands._qa_run_write_png_rgba(
                Path(screenshot_path),
                2,
                2,
                [
                    (18, 24, 38, 255),
                    (44, 92, 152, 255),
                    (218, 226, 236, 255),
                    (246, 248, 251, 255),
                ],
            )
            return {
                "backend": "fake-playwright-chromium",
                "html_path": str(html_path),
                "screenshot_path": str(screenshot_path),
                "viewport": "2x2",
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            receipt_path = Path(tmpdir) / "receipt.json"
            args = argparse.Namespace(
                dispatcher_id=None,
                json=True,
                path=str(db_path),
                receipt_output=str(receipt_path),
                scenario="generic-loop-template-browser",
            )

            with mock.patch("workerctl.commands._qa_run_capture_browser_screenshot", side_effect=fake_capture):
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    commands.command_qa_run(args)

            summary = json.loads(stdout.getvalue())
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(summary["scenario"], "generic-loop-template-browser")
            self.assertEqual(summary["result"], "passed")
            self.assertEqual(summary["checks"], 3)
            self.assertEqual(receipt["scenario"], "generic-loop-template-browser")
            self.assertEqual(receipt["template"], "visual_diff_loop")
            self.assertEqual(receipt["result"], "passed")
            self.assertEqual(receipt["browser"]["backend"], "fake-playwright-chromium")
            self.assertEqual(receipt["browser"]["viewport"], "2x2")
            self.assertTrue(Path(receipt["artifacts"]["candidate_html"]).exists())
            self.assertTrue(Path(receipt["artifacts"]["candidate_screenshot"]).exists())
            self.assertTrue(Path(receipt["artifacts"]["reference_artifact"]).exists())
            self.assertTrue(Path(receipt["artifacts"]["visual_diff_report"]).exists())
            self.assertTrue(receipt["visual_diff"]["below_threshold"])
            self.assertEqual(receipt["visual_diff"]["diff_score"], 0.0)

            checks = {check["name"]: check for check in receipt["checks"]}
            missing = checks["browser_visual_template_blocks_before_visual_evidence"]
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

            unstructured = checks["browser_unstructured_adversarial_check_still_blocks"]
            self.assertEqual(unstructured["dispatch"]["state"], "blocked")
            self.assertEqual(unstructured["dispatch"]["reason"], "missing_adversarial_check_evidence")
            self.assertEqual(unstructured["dispatch"]["missing_evidence"], ["adversarial_check"])
            self.assertEqual(unstructured["worker_inbox_count"], 0)

            allowed = checks["browser_structured_visual_evidence_retry_delivers"]
            self.assertEqual(allowed["dispatch"]["state"], "pull_required")
            self.assertEqual(allowed["worker_inbox_count"], 1)

            replay_commands = "\n".join(receipt["replay_commands"])
            self.assertIn("capture-static-html-screenshot.mjs", replay_commands)
            self.assertIn("--evidence-type reference_artifact", replay_commands)
            self.assertIn("--evidence-type candidate_screenshot", replay_commands)
            self.assertIn("loop-evidence visual-diff", replay_commands)
            self.assertIn("loop-evidence adversarial-check", replay_commands)
```

- [ ] **Step 3: Parameterize queue isolation tests over the new scenario**

In both `test_qa_run_refuses_to_share_dirty_continue_iteration_queue` and
`test_qa_run_refuses_stale_attempted_continue_iteration_queue`, replace:

```python
        for scenario in ("ralph-loop-guardrails", "generic-loop-template"):
```

with:

```python
        for scenario in ("ralph-loop-guardrails", "generic-loop-template", "generic-loop-template-browser"):
```

- [ ] **Step 4: Run tests to prove red state**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_run_help_lists_generic_loop_template_browser \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_browser_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue \
  tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue
```

Expected: fail because `generic-loop-template-browser` is not an allowed CLI
choice and `_qa_run_capture_browser_screenshot` does not exist.

## Task 2: Browser Capture Helper

**Files:**
- Create: `scripts/capture-static-html-screenshot.mjs`
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Create the Node Playwright capture script**

Create `scripts/capture-static-html-screenshot.mjs`:

```javascript
#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith("--") || value === undefined) {
      throw new Error("Usage: capture-static-html-screenshot.mjs --html HTML --output PNG --width WIDTH --height HEIGHT");
    }
    args[key.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv);
const htmlPath = args.html;
const outputPath = args.output;
const width = Number.parseInt(args.width, 10);
const height = Number.parseInt(args.height, 10);

if (!htmlPath || !outputPath || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
  throw new Error("Usage: capture-static-html-screenshot.mjs --html HTML --output PNG --width WIDTH --height HEIGHT");
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { width, height },
  });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await page.screenshot({ path: outputPath, fullPage: false });
  console.log(JSON.stringify({
    backend: "playwright-chromium",
    html_path: htmlPath,
    screenshot_path: outputPath,
    viewport: `${width}x${height}`,
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`browser-backed QA requires Playwright/Chromium or a configured browser capture helper: ${message}`);
  process.exitCode = 2;
} finally {
  if (browser) {
    await browser.close();
  }
}
```

- [ ] **Step 2: Make the script executable**

Run:

```bash
chmod +x scripts/capture-static-html-screenshot.mjs
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Add browser artifact helper functions in `workerctl/commands.py`**

Insert these functions after `_qa_run_record_visual_template_evidence(...)`:

```python
def _qa_run_write_browser_reference(path: Path) -> None:
    _qa_run_write_png_rgba(
        path,
        2,
        2,
        [
            (18, 24, 38, 255),
            (44, 92, 152, 255),
            (218, 226, 236, 255),
            (246, 248, 251, 255),
        ],
    )


def _qa_run_write_candidate_html(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        """<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\">
  <style>
    html, body { margin: 0; width: 2px; height: 2px; overflow: hidden; background: transparent; }
    .qa-grid { display: grid; grid-template-columns: 1px 1px; grid-template-rows: 1px 1px; width: 2px; height: 2px; }
    .qa-pixel { width: 1px; height: 1px; }
    #qa-pixel-0 { background: rgb(18, 24, 38); }
    #qa-pixel-1 { background: rgb(44, 92, 152); }
    #qa-pixel-2 { background: rgb(218, 226, 236); }
    #qa-pixel-3 { background: rgb(246, 248, 251); }
  </style>
</head>
<body>
  <div class=\"qa-grid\" aria-label=\"generic loop browser QA reference\">
    <div id=\"qa-pixel-0\" class=\"qa-pixel\"></div>
    <div id=\"qa-pixel-1\" class=\"qa-pixel\"></div>
    <div id=\"qa-pixel-2\" class=\"qa-pixel\"></div>
    <div id=\"qa-pixel-3\" class=\"qa-pixel\"></div>
  </div>
</body>
</html>
""",
        encoding="utf-8",
    )


def _qa_run_capture_browser_screenshot(*, html_path: Path, screenshot_path: Path, viewport: dict[str, int]) -> dict[str, Any]:
    script = PROJECT_ROOT / "scripts" / "capture-static-html-screenshot.mjs"
    screenshot_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "node",
            str(script),
            "--html",
            str(html_path),
            "--output",
            str(screenshot_path),
            "--width",
            str(viewport["width"]),
            "--height",
            str(viewport["height"]),
        ],
        cwd=PROJECT_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise WorkerError(detail or "browser-backed QA requires Playwright/Chromium or a configured browser capture helper")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise WorkerError(f"browser screenshot helper returned invalid JSON: {proc.stdout!r}") from exc
    payload.setdefault("backend", "playwright-chromium")
    payload.setdefault("html_path", str(html_path))
    payload.setdefault("screenshot_path", str(screenshot_path))
    payload.setdefault("viewport", f"{viewport['width']}x{viewport['height']}")
    return payload
```

- [ ] **Step 4: Run a focused syntax check**

Run:

```bash
python3 -m py_compile workerctl/commands.py
node --check scripts/capture-static-html-screenshot.mjs
```

Expected: both commands exit `0`.

## Task 3: Browser QA Runner And CLI Wiring

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Add the scenario choice**

In `workerctl/cli.py`, change the `qa_run` scenario choices to:

```python
        choices=("ralph-loop-guardrails", "generic-loop-template", "generic-loop-template-browser"),
```

- [ ] **Step 2: Add browser visual evidence recorder**

In `workerctl/commands.py`, insert this helper after `_qa_run_capture_browser_screenshot(...)`:

```python
def _qa_run_record_browser_visual_template_evidence(
    *,
    db_path: Path,
    task_name: str,
    loop_run_id: str,
    artifact_dir: Path,
) -> dict[str, Any]:
    from workerctl.visual_diff import compute_visual_diff

    artifact_dir.mkdir(parents=True, exist_ok=True)
    reference_path = artifact_dir / "reference.png"
    candidate_html_path = artifact_dir / "candidate.html"
    candidate_screenshot_path = artifact_dir / "candidate-browser.png"
    diff_path = artifact_dir / "diff.png"
    report_path = artifact_dir / "visual-diff-report.json"
    viewport = {"width": 2, "height": 2}

    _qa_run_write_browser_reference(reference_path)
    _qa_run_write_candidate_html(candidate_html_path)
    browser = _qa_run_capture_browser_screenshot(
        html_path=candidate_html_path,
        screenshot_path=candidate_screenshot_path,
        viewport=viewport,
    )
    report = compute_visual_diff(
        reference_path=reference_path,
        candidate_path=candidate_screenshot_path,
        threshold=0.0,
        diff_output=diff_path,
        report_output=report_path,
    )
    reference = _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=task_name,
        loop_run_id=loop_run_id,
        evidence_type="reference_artifact",
        correlation_id="qa-run-browser-template-reference",
        artifact_path=reference_path,
        metadata={"artifact_path": str(reference_path), "viewport": report["viewport"]},
    )
    candidate = _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=task_name,
        loop_run_id=loop_run_id,
        evidence_type="candidate_screenshot",
        correlation_id="qa-run-browser-template-candidate",
        artifact_path=candidate_screenshot_path,
        metadata={
            "artifact_path": str(candidate_screenshot_path),
            "browser_backend": browser["backend"],
            "candidate_html": str(candidate_html_path),
            "viewport": browser["viewport"],
        },
    )
    report_result = _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=task_name,
        loop_run_id=loop_run_id,
        evidence_type="visual_diff_report",
        correlation_id="qa-run-browser-template-visual-diff",
        artifact_path=report_path,
        metadata=report,
    )
    threshold_result = _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=task_name,
        loop_run_id=loop_run_id,
        evidence_type="diff_below_threshold",
        correlation_id="qa-run-browser-template-visual-diff",
        status="pass" if report["below_threshold"] else "fail",
        artifact_path=report_path,
        metadata=report,
    )
    return {
        "artifacts": {
            "candidate_html": str(candidate_html_path),
            "candidate_screenshot": str(candidate_screenshot_path),
            "diff": str(diff_path),
            "reference_artifact": str(reference_path),
            "visual_diff_report": str(report_path),
        },
        "browser": browser,
        "diff": report,
        "evidence": {
            "candidate_screenshot": candidate["evidence"],
            "diff_below_threshold": threshold_result["evidence"],
            "reference_artifact": reference["evidence"],
            "visual_diff_report": report_result["evidence"],
        },
    }
```

- [ ] **Step 3: Add `_qa_run_generic_loop_template_browser`**

Add this function next to `_qa_run_generic_loop_template(...)`. It should mirror
that runner and use the browser evidence helper:

```python
def _qa_run_generic_loop_template_browser(args: argparse.Namespace) -> dict[str, Any]:
    from workerctl import db as worker_db

    db_path = _qa_run_db_path(args)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    slug = uuid.uuid4().hex[:8]
    dispatcher_id = getattr(args, "dispatcher_id", None) or f"qa-run-{slug}"
    template_metadata = loop_template_metadata(
        "visual_diff_loop",
        max_iterations=4,
        current_iteration=1,
        seed_prompt_sha256="qa-run-generic-template-browser-seed",
    )
    required_evidence = template_metadata["required_before_continue"]
    checks: list[dict[str, Any]] = []

    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        _qa_run_require_clean_continue_queue(conn, worker_db=worker_db)
        template_task = _qa_run_bound_task(conn, slug=slug, suffix="generic-loop-template-browser")
        template_run_id = worker_db.create_ralph_loop_run(
            conn,
            task_id=template_task["task_id"],
            name=f"{template_task['task_name']}-run",
            max_iterations=template_metadata["max_iterations"],
            current_iteration=template_metadata["current_iteration"],
            cleanup_policy=template_metadata["cleanup_policy"],
            required_before_continue=required_evidence,
            stop_conditions=template_metadata["stop_conditions"],
            seed_prompt_sha256=template_metadata["seed_prompt_sha256"],
            preset=template_metadata.get("preset"),
            metadata=template_metadata,
        )
        worker_db.enqueue_continue_iteration(
            conn,
            task_id=template_task["task_id"],
            message="Run browser visual diff template iteration 2 before evidence.",
            loop_run_id=template_run_id,
            requested_iteration=2,
            correlation_id="qa-run-browser-template-missing-visual",
        )
        conn.commit()

    missing_dispatch = _qa_run_dispatch_continue_once(
        db_path=db_path,
        dispatcher_id=dispatcher_id,
        expected_correlation_id="qa-run-browser-template-missing-visual",
    )
    missing_counts = _qa_run_delivery_counts(
        db_path=db_path,
        task_id=template_task["task_id"],
        worker_name=template_task["worker_name"],
    )
    _qa_run_require(missing_dispatch.get("state") == "blocked", "browser visual template did not block before evidence")
    _qa_run_require(missing_dispatch.get("reason") == "missing_required_evidence", "browser visual template used the wrong block reason before evidence")
    _qa_run_require(missing_dispatch.get("missing_evidence") == required_evidence, "browser visual template reported the wrong missing evidence before evidence")
    _qa_run_require(missing_counts["routed_notifications_count"] == 0, "browser visual template created a routed notification before evidence")
    _qa_run_require(missing_counts["worker_inbox_count"] == 0, "browser visual template left worker inbox mail before evidence")
    checks.append(
        _qa_run_check_result(
            name="browser_visual_template_blocks_before_visual_evidence",
            dispatch=missing_dispatch,
            counts=missing_counts,
            command="workerctl dispatch --once --type continue_iteration --dispatcher-id qa-run",
        )
    )

    visual_evidence = _qa_run_record_browser_visual_template_evidence(
        db_path=db_path,
        task_name=template_task["task_name"],
        loop_run_id=template_run_id,
        artifact_dir=db_path.parent / "generic-loop-template-browser-artifacts" / f"{slug}-{template_run_id}",
    )
    _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=template_task["task_name"],
        loop_run_id=template_run_id,
        evidence_type="adversarial_check",
        correlation_id="qa-run-browser-template-unstructured-adversarial",
        metadata={"note": "qa-run intentionally omits failure_mode, check, and result."},
    )
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        worker_db.enqueue_continue_iteration(
            conn,
            task_id=template_task["task_id"],
            message="Run browser visual diff template iteration 2 after visual evidence and malformed adversarial proof.",
            loop_run_id=template_run_id,
            requested_iteration=2,
            correlation_id="qa-run-browser-template-unstructured-adversarial",
        )
        conn.commit()

    unstructured_dispatch = _qa_run_dispatch_continue_once(
        db_path=db_path,
        dispatcher_id=dispatcher_id,
        expected_correlation_id="qa-run-browser-template-unstructured-adversarial",
    )
    unstructured_counts = _qa_run_delivery_counts(
        db_path=db_path,
        task_id=template_task["task_id"],
        worker_name=template_task["worker_name"],
    )
    _qa_run_require(unstructured_dispatch.get("state") == "blocked", "browser unstructured adversarial evidence did not block")
    _qa_run_require(unstructured_dispatch.get("reason") == "missing_adversarial_check_evidence", "browser unstructured adversarial evidence used the wrong block reason")
    _qa_run_require(unstructured_dispatch.get("missing_evidence") == ["adversarial_check"], "browser unstructured adversarial evidence reported the wrong missing evidence")
    _qa_run_require(unstructured_counts["routed_notifications_count"] == 0, "browser unstructured adversarial evidence created a routed notification")
    _qa_run_require(unstructured_counts["worker_inbox_count"] == 0, "browser unstructured adversarial evidence left worker inbox mail")
    checks.append(
        _qa_run_check_result(
            name="browser_unstructured_adversarial_check_still_blocks",
            dispatch=unstructured_dispatch,
            counts=unstructured_counts,
            command="workerctl loop-evidence add --evidence-type adversarial_check ... && workerctl dispatch --once --type continue_iteration",
        )
    )

    _qa_run_record_loop_evidence(
        db_path=db_path,
        task_name=template_task["task_name"],
        loop_run_id=template_run_id,
        evidence_type="adversarial_check",
        correlation_id="qa-run-browser-template-structured-adversarial",
        metadata=_adversarial_check_metadata(
            {
                "failure_mode": "Browser screenshot evidence could exist without being tied to the visual_diff_loop run and iteration.",
                "check": "Inspect reference, candidate screenshot, browser metadata, diff report, threshold evidence, and blocked retry before allowing iteration 2.",
                "result": "The malformed receipt stayed blocked, and the structured retry delivered exactly one worker inbox item.",
            }
        ),
    )
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        worker_db.enqueue_continue_iteration(
            conn,
            task_id=template_task["task_id"],
            message="Run browser visual diff template iteration 2 after structured adversarial proof.",
            loop_run_id=template_run_id,
            requested_iteration=2,
            correlation_id="qa-run-browser-template-structured-allowed",
        )
        conn.commit()

    allowed_dispatch = _qa_run_dispatch_continue_once(
        db_path=db_path,
        dispatcher_id=dispatcher_id,
        expected_correlation_id="qa-run-browser-template-structured-allowed",
    )
    allowed_counts = _qa_run_delivery_counts(
        db_path=db_path,
        task_id=template_task["task_id"],
        worker_name=template_task["worker_name"],
    )
    _qa_run_require(allowed_dispatch.get("state") == "pull_required", "browser structured visual evidence retry did not deliver")
    _qa_run_require(allowed_counts["worker_inbox_count"] == 1, "browser structured visual evidence retry did not create exactly one worker inbox item")
    checks.append(
        _qa_run_check_result(
            name="browser_structured_visual_evidence_retry_delivers",
            dispatch=allowed_dispatch,
            counts=allowed_counts,
            command="workerctl loop-evidence adversarial-check ... && workerctl dispatch --once --type continue_iteration",
        )
    )

    return {
        "artifacts": {
            "db_path": str(db_path),
            **visual_evidence["artifacts"],
        },
        "browser": visual_evidence["browser"],
        "checks": checks,
        "generated_at": now_iso(),
        "replay_commands": [
            "scripts/workerctl loop-templates --show visual_diff_loop --json",
            (
                "scripts/workerctl loop-templates --create-run <task> --template visual_diff_loop "
                "--max-iterations 4 --current-iteration 1 --seed-prompt-sha256 qa-run-generic-template-browser-seed"
            ),
            (
                "node scripts/capture-static-html-screenshot.mjs --html <candidate.html> "
                "--output <candidate-browser.png> --width 2 --height 2"
            ),
            (
                "scripts/workerctl loop-evidence add <task> --loop-run <run-id> --iteration 1 "
                "--evidence-type reference_artifact --artifact-path <reference.png>"
            ),
            (
                "scripts/workerctl loop-evidence add <task> --loop-run <run-id> --iteration 1 "
                "--evidence-type candidate_screenshot --artifact-path <candidate-browser.png> "
                "--metadata-json '{\"browser_backend\":\"playwright-chromium\",\"candidate_html\":\"<candidate.html>\",\"viewport\":\"2x2\"}'"
            ),
            (
                "scripts/workerctl loop-evidence visual-diff <task> --loop-run <run-id> --iteration 1 "
                "--reference <reference.png> --candidate <candidate-browser.png> --threshold 0 --diff-output <diff.png> --report-output <report.json>"
            ),
            (
                "scripts/workerctl loop-evidence adversarial-check <task> --loop-run <run-id> --iteration 1 "
                "--failure-mode <failure> --check <check> --result <result>"
            ),
            f"scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id {dispatcher_id} --path {db_path}",
        ],
        "result": "passed",
        "scenario": "generic-loop-template-browser",
        "template": "visual_diff_loop",
        "template_metadata": template_metadata,
        "visual_diff": visual_evidence["diff"],
    }
```

- [ ] **Step 4: Register the runner**

In `command_qa_run`, change the `scenarios` map to:

```python
    scenarios = {
        "ralph-loop-guardrails": _qa_run_ralph_loop_guardrails,
        "generic-loop-template": _qa_run_generic_loop_template,
        "generic-loop-template-browser": _qa_run_generic_loop_template_browser,
    }
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_run_help_lists_generic_loop_template_browser \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_browser_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue \
  tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue
```

Expected: pass.

## Task 4: Documentation And Manual QA Receipts

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-qa-checklist.md`
- Modify: `docs/qa/general-loop-templates.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Update README command reference**

In the `qa-run` command reference in `README.md`, update the scenario list to:

```markdown
- `qa-run <ralph-loop-guardrails|generic-loop-template|generic-loop-template-browser> --receipt-output RECEIPT.json [--path DB]` —
```

Add this sentence after the existing `generic-loop-template` description:

```markdown
  `generic-loop-template-browser` runs the same `visual_diff_loop` gate proof
  with a browser-rendered static HTML candidate screenshot, recording browser
  backend, viewport, candidate HTML, screenshot, visual diff, and structured
  adversarial evidence in the saved receipt.
```

- [ ] **Step 2: Add README example**

Add this example near the current QA examples:

```bash
scripts/workerctl qa-run generic-loop-template-browser --receipt-output /tmp/generic-loop-template-browser-receipt.json --json
```

- [ ] **Step 3: Add manual QA checklist row**

Add this row to `docs/manual-qa-checklist.md` after the existing generic loop
template QA row:

```markdown
- [ ] `scripts/workerctl qa-run generic-loop-template-browser --receipt-output /tmp/generic-loop-template-browser-receipt.json --json` writes a saved receipt proving browser-rendered `candidate_screenshot` evidence, visual diff metadata, missing visual evidence cutoff, unstructured `adversarial_check` refusal, and fresh retry delivery only after browser visual evidence plus structured adversarial proof.
```

- [ ] **Step 4: Update general loop template QA doc**

Add this browser-backed QA example to `docs/qa/general-loop-templates.md` near
the existing `qa-run generic-loop-template` material:

````markdown
### Browser-backed generic loop QA

Use the browser-backed receipt when you need to prove that `visual_diff_loop`
works with a real rendered HTML artifact:

```bash
scripts/workerctl qa-run generic-loop-template-browser \
  --receipt-output /tmp/generic-loop-template-browser-receipt.json \
  --json
```

The saved receipt must include the generated candidate HTML, browser backend,
2x2 viewport, browser-rendered `candidate_screenshot`, `visual_diff_report`,
`diff_below_threshold`, and structured `adversarial_check` evidence before a
fresh continuation reaches the worker inbox.
````

- [ ] **Step 5: Add documentation assertions**

In `test_readme_documents_generic_loop_templates`, add `checklist` and these
assertions:

```python
        checklist = (ROOT / "docs" / "manual-qa-checklist.md").read_text()
        self.assertIn("qa-run generic-loop-template-browser", readme)
        self.assertIn("generic-loop-template-browser-receipt.json", readme)
        self.assertIn("qa-run generic-loop-template-browser", checklist)
```

In `test_general_loop_template_qa_documents_visual_drill`, add these assertions:

```python
        self.assertIn("generic-loop-template-browser", qa_doc)
        self.assertIn("generic-loop-template-browser-receipt.json", qa_doc)
        self.assertIn("browser-rendered `candidate_screenshot`", qa_doc)
```

- [ ] **Step 6: Run doc-focused tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_readme_documents_generic_loop_templates \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_general_loop_template_qa_documents_visual_drill
```

Expected: pass.

## Task 5: Verification, Adversarial Review, PR, And Merge

**Files:**
- No file edits unless a check fails.

- [ ] **Step 1: Run focused QA tests and static checks**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_run_help_lists_generic_loop_template_browser \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_browser_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_ralph_loop_guardrails_writes_replayable_receipt \
  tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue \
  tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_readme_documents_generic_loop_templates \
  tests.test_workerctl.ManagerBootstrapPromptTests.test_general_loop_template_qa_documents_visual_drill
python3 -m py_compile workerctl/commands.py workerctl/cli.py
node --check scripts/capture-static-html-screenshot.mjs
git diff --check
```

Expected: pass.

- [ ] **Step 2: Run full Python suite**

Run:

```bash
python3 -m unittest tests.test_workerctl
```

Expected: pass.

- [ ] **Step 3: Run direct browser receipt proof when Chromium is installed**

Run:

```bash
receipt=$(mktemp -t generic-loop-template-browser-receipt)
scripts/workerctl qa-run generic-loop-template-browser --receipt-output "$receipt" --json
python3 - "$receipt" <<'PY'
import json, sys
receipt = json.load(open(sys.argv[1]))
commands = "\n".join(receipt["replay_commands"])
checks = {check["name"]: check for check in receipt["checks"]}
assert receipt["result"] == "passed"
assert receipt["scenario"] == "generic-loop-template-browser"
assert receipt["template"] == "visual_diff_loop"
assert receipt["browser"]["backend"] == "playwright-chromium"
assert receipt["visual_diff"]["below_threshold"] is True
assert "capture-static-html-screenshot.mjs" in commands
assert "--evidence-type reference_artifact" in commands
assert "--evidence-type candidate_screenshot" in commands
assert checks["browser_visual_template_blocks_before_visual_evidence"]["worker_inbox_count"] == 0
assert checks["browser_unstructured_adversarial_check_still_blocks"]["dispatch"]["reason"] == "missing_adversarial_check_evidence"
assert checks["browser_structured_visual_evidence_retry_delivers"]["dispatch"]["state"] == "pull_required"
print("browser receipt proof passed", receipt["browser"]["viewport"], receipt["visual_diff"]["diff_score"])
PY
```

Expected when browser dependencies are installed:

```text
browser receipt proof passed 2x2 0.0
```

When the receipt proof fails with the helper message
`browser-backed QA requires Playwright/Chromium or a configured browser capture
helper`, install Chromium and rerun the same proof:

```bash
npx playwright install chromium
```

Then rerun the receipt proof.

- [ ] **Step 4: Run codex review**

Run:

```bash
skills/codex-review/scripts/codex-review --mode local --full-access --parallel-tests "python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_browser_writes_replayable_receipt tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_writes_replayable_receipt tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue && python3 -m py_compile workerctl/commands.py workerctl/cli.py && node --check scripts/capture-static-html-screenshot.mjs && git diff --check"
```

Expected: no accepted/actionable findings.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git status --short
git add README.md docs/manual-qa-checklist.md scripts/capture-static-html-screenshot.mjs tests/test_workerctl.py workerctl/cli.py workerctl/commands.py
git commit -m "Add browser-backed generic loop QA run"
```

Expected: commit succeeds.

- [ ] **Step 6: Push, create PR, monitor CI, merge green**

Run:

```bash
git push -u origin codex/generic-loop-browser-qa-spec
gh pr create --base main --head codex/generic-loop-browser-qa-spec --title "Add browser-backed generic loop QA run" --body-file <(cat <<'EOF'
## Summary
- add `workerctl qa-run generic-loop-template-browser`
- capture a deterministic static HTML candidate through Playwright-backed browser screenshot helper
- prove visual evidence and structured adversarial proof gates before dispatcher continuation reaches the worker

## Verification
- focused QA/browser receipt tests
- full `python3 -m unittest tests.test_workerctl`
- `python3 -m py_compile workerctl/commands.py workerctl/cli.py`
- `node --check scripts/capture-static-html-screenshot.mjs`
- direct browser receipt proof when Chromium is installed
- `codex-review`

## Burden Of Proof
Strongest failure modes checked:
- receipt omits replayable browser capture or evidence commands
- unstructured adversarial evidence unblocks continuation
- valid browser visual evidence fails to route on a fresh retry
- dirty or stale continue_iteration commands contaminate QA scenarios
EOF
)
gh pr checks --watch --interval 10
gh pr merge --squash --delete-branch
```

Expected: CI passes and the PR merges into `main`.

## Self-Review Notes

- **Spec coverage:** Tasks cover the new CLI scenario, browser artifact creation, screenshot capture, visual evidence recording, dispatcher gate checks, replay receipt, docs, focused tests, full suite, adversarial review, PR, CI, and merge.
- **Dependency risk:** Unit tests fake the browser helper so CI does not depend on downloaded Chromium. The direct receipt proof is still required when Chromium is available, and the helper emits a precise install/runtime error when unavailable.
- **Replayability risk:** The receipt test and direct proof both assert the browser capture command and every required evidence type are present in `replay_commands`.
- **Scope boundary:** This plan excludes failing-diff repair and natural-language trigger mapping; those remain Scenario B and Scenario C.
