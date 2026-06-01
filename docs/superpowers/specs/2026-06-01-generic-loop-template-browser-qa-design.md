# Generic Loop Template Browser QA Design

## Purpose

Add a browser-backed QA scenario that proves the generic `visual_diff_loop`
template works with real rendered UI artifacts, not only deterministic
in-process PNG fixtures.

The first slice is intentionally small and stable: a tiny static HTML candidate
page is rendered through a browser screenshot path, compared with a reference
artifact, and then passed through the same dispatcher continuation gates used by
the generic loop template QA run.

## Scenario

Create a new QA run:

```bash
scripts/workerctl qa-run generic-loop-template-browser \
  --receipt-output /tmp/generic-loop-template-browser-receipt.json \
  --json
```

The run creates a disposable task, manager/worker binding, and
`visual_diff_loop` run. The worker's conceptual assignment is to recreate a
tiny reference UI as HTML. The harness supplies the first matching candidate so
this slice proves browser artifact handling and dispatcher gates, not visual
repair behavior.

## Required Proof

The saved receipt must prove three dispatcher gates:

1. Before browser artifacts exist, a manager-requested `continue_iteration`
   blocks with `missing_required_evidence`, delivers no notification, and leaves
   the worker inbox empty.
2. After visual artifacts exist but `adversarial_check` is missing or malformed,
   a fresh `continue_iteration` blocks with
   `missing_adversarial_check_evidence`, delivers no notification, and leaves
   the worker inbox empty.
3. After structured `adversarial_check` evidence exists, a fresh
   `continue_iteration` returns `state=pull_required` and creates exactly one
   worker inbox item.

The receipt must also include replayable evidence for:

- `reference_artifact`
- generated candidate HTML path
- browser backend used for capture
- browser-rendered `candidate_screenshot`
- viewport
- `visual_diff_report`
- `diff_below_threshold`
- structured `adversarial_check`

## Architecture

Keep the existing synthetic run as the fast deterministic baseline:

- `qa-run generic-loop-template`
  - Generates reference and candidate PNGs in-process.
  - Proves generic template dispatch gates without browser dependencies.

Add a sibling browser-backed run:

- `qa-run generic-loop-template-browser`
  - Uses the same `visual_diff_loop` template and dispatcher gate checks.
  - Writes a tiny static candidate HTML file.
  - Captures a real browser screenshot from that HTML.
  - Records the screenshot as run-qualified `candidate_screenshot` evidence.
  - Computes the visual diff with the existing `loop-evidence visual-diff`
    behavior.

Recommended helper boundaries:

- `_qa_run_write_visual_reference(...)`
- `_qa_run_write_candidate_html(...)`
- `_qa_run_capture_browser_screenshot(...)`
- `_qa_run_generic_loop_template_browser(...)`

The screenshot helper should accept a static HTML path and output screenshot
path now. It should not assume static HTML forever; the same boundary should
later accept a localhost app URL without changing the dispatcher proof.

## Data Flow

```text
qa-run generic-loop-template-browser
  -> create temp DB/task/binding
  -> create visual_diff_loop run
  -> enqueue continue_iteration before evidence
  -> dispatch proves blocked + inbox 0
  -> write reference PNG
  -> write candidate HTML
  -> render candidate HTML to PNG through browser capture helper
  -> record reference_artifact + candidate_screenshot
  -> run visual-diff evidence recording
  -> record malformed adversarial_check
  -> dispatch proves still blocked
  -> record structured adversarial_check
  -> enqueue fresh continue_iteration
  -> dispatch proves pull_required + inbox 1
  -> write receipt
```

## Browser Strategy

Use Playwright/headless Chromium when available. The browser capture path should
record the backend name, viewport, source HTML path, and output screenshot path.

The browser-backed QA command should fail clearly when the browser runtime is
not available:

```text
browser-backed QA requires Playwright/Chromium or a configured browser capture helper
```

Unit tests should not require a real browser on every run. Focused tests can
exercise command wiring and receipt expectations with a fake capture helper.
One browser-backed integration path should run when the dependencies are
available in local QA or CI.

## Acceptance Criteria

- `scripts/workerctl qa-run --help` lists `generic-loop-template-browser`.
- `scripts/workerctl qa-run generic-loop-template-browser --receipt-output ...`
  writes a receipt with `result=passed`.
- The receipt names `template=visual_diff_loop`.
- The first dispatch check blocks before visual evidence with
  `missing_required_evidence`, zero notifications, and worker inbox count `0`.
- The second dispatch check blocks malformed or missing adversarial proof with
  `missing_adversarial_check_evidence`, zero notifications, and worker inbox
  count `0`.
- The third dispatch check delivers with `state=pull_required` and worker inbox
  count `1`.
- Replay commands include the browser capture step and the explicit
  `reference_artifact`, `candidate_screenshot`, `visual_diff_report`,
  `diff_below_threshold`, and `adversarial_check` evidence steps.
- The visual diff report is below threshold for the matching mini UI.
- Existing `generic-loop-template` and `ralph-loop-guardrails` QA runs still
  pass.

## Tests

Add or update focused tests for:

- CLI scenario routing for `generic-loop-template-browser`.
- Browser receipt shape with a fake screenshot helper.
- Missing visual evidence blocks before worker delivery.
- Malformed adversarial proof blocks even after visual evidence exists.
- Structured proof allows only a fresh retry to reach the worker inbox.
- Replay commands contain both browser capture and evidence-recording steps.
- Dirty or stale `continue_iteration` queue checks remain isolated across all
  QA-run scenarios.

Run at minimum:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_generic_loop_template_browser_writes_replayable_receipt
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_refuses_to_share_dirty_continue_iteration_queue
python3 -m unittest tests.test_workerctl.CliTests.test_qa_run_refuses_stale_attempted_continue_iteration_queue
python3 -m py_compile workerctl/commands.py workerctl/cli.py
git diff --check
```

Before merging, also run the full `tests.test_workerctl` suite and a direct
receipt assertion that tries to disprove replayability by checking for the
browser capture command and the required visual evidence commands.

## Out Of Scope

- Intentionally failing visual diffs followed by repair. That is Scenario B.
- Natural-language trigger parsing such as "run this as an adversarial gated
  visual diff loop." That is Scenario C.
- Capturing an arbitrary localhost app URL. The helper boundary should make this
  easy later, but this first slice uses static HTML for determinism.

## Risks And Mitigations

- Browser runtime variance could make CI flaky. Keep the UI tiny, use a fixed
  viewport, avoid external assets and fonts, and retain the synthetic QA run as
  the dependency-light baseline.
- A receipt could appear green while omitting replayable browser or evidence
  commands. Add direct receipt assertions for the browser capture command and
  each required evidence type.
- Visual evidence could be recorded without being tied to the loop run and
  iteration. Assert run-qualified evidence metadata in tests and receipt checks.
- Dispatcher retries could accidentally reuse a stale blocked command. Preserve
  the fresh retry pattern from the existing generic QA run and keep dirty/stale
  queue guard tests parameterized across QA scenarios.
