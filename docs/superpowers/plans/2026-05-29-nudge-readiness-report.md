# Nudge Readiness Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `nudge-readiness-report` Dispatch QA scenario that proves post-implementation manager nudging, worker-side next-step assessment, manager-side comparison, and finish ordering.

**Architecture:** Keep the current one-lab-repo organization. Add a resettable fixture under `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files`, wire it into `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`, and document the live Chrome/dashboard checks in the product repo. The fixture is intentionally failing at reset time so the worker has a real feature task to complete.

**Tech Stack:** Bash lab harness, Python 3.11+, pytest, Markdown QA runbooks, `workerctl` Dispatch dashboard.

---

## File Structure

- Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/src/dispatch_lab/readiness.py` as the intentionally incomplete worker task.
- Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/src/dispatch_lab/__init__.py` as the fixture package marker.
- Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/tests/test_readiness.py` as the deterministic contract the worker must satisfy.
- Modify `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab` to add the scenario prompt, manager objective, and acceptance criteria.
- Modify `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md` to list the scenario and commands.
- Create `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/nudge-readiness-report.md` as the product QA runbook.
- Modify `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/README.md` to list the new runbook.

Do not commit root-level `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src` or `/Users/neonwatty/Desktop/workerctl-dispatch-lab/tests` changes produced by `./lab reset`; reset back to `LAB_SCENARIO=complex-refactor` before final status checks.

### Task 1: Create The Lab Fixture Contract

**Files:**
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/src/dispatch_lab/__init__.py`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/src/dispatch_lab/readiness.py`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/tests/test_readiness.py`

- [ ] **Step 1: Create the package marker**

```python
# /Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/src/dispatch_lab/__init__.py
```

- [ ] **Step 2: Write the readiness reporter tests**

```python
# /Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/tests/test_readiness.py
from __future__ import annotations

from dispatch_lab.readiness import render_markdown, summarize_readiness


CHECKS = [
    {
        "id": "REL-101",
        "name": "API smoke tests",
        "status": "verified",
        "severity": "critical",
        "owner": "platform",
        "evidence": ".venv/bin/python -m pytest tests/test_api.py -q",
    },
    {
        "id": "REL-102",
        "name": "Billing migration rollback",
        "status": "blocked",
        "severity": "high",
        "owner": "billing",
        "blocker": "rollback SQL not reviewed",
    },
    {
        "id": "REL-103",
        "name": "Support handoff",
        "status": "unverified",
        "severity": "medium",
        "owner": "support",
    },
    {
        "id": "REL-104",
        "name": "Docs changelog",
        "status": "verified",
        "severity": "low",
        "owner": "docs",
        "evidence": "docs/changelog.md reviewed",
    },
    {
        "id": "REL-105",
        "name": "Enterprise entitlement audit",
        "status": "unverified",
        "severity": "high",
        "owner": "billing",
    },
]


def test_groups_checks_by_readiness_status_in_stable_order() -> None:
    report = summarize_readiness(CHECKS)

    assert [item["id"] for item in report["verified"]] == ["REL-101", "REL-104"]
    assert [item["id"] for item in report["unverified"]] == ["REL-105", "REL-103"]
    assert [item["id"] for item in report["blocked"]] == ["REL-102"]


def test_computes_counts_and_high_risk_for_blocked_high_severity_work() -> None:
    report = summarize_readiness(CHECKS)

    assert report["summary"] == {
        "total": 5,
        "verified": 2,
        "unverified": 2,
        "blocked": 1,
    }
    assert report["risk_level"] == "high"


def test_recommends_next_action_from_blocker_before_unverified_checks() -> None:
    report = summarize_readiness(CHECKS)

    assert (
        report["recommended_next_action"]
        == "Resolve REL-102 blocker with billing: rollback SQL not reviewed."
    )


def test_medium_risk_when_no_blockers_but_high_severity_unverified_checks() -> None:
    checks = [item for item in CHECKS if item["status"] != "blocked"]

    report = summarize_readiness(checks)

    assert report["risk_level"] == "medium"
    assert (
        report["recommended_next_action"]
        == "Verify 1 high-severity check before release: REL-105."
    )


def test_low_risk_when_every_check_is_verified() -> None:
    checks = [
        {**item, "status": "verified", "evidence": item.get("evidence", "verified")}
        for item in CHECKS
    ]

    report = summarize_readiness(checks)

    assert report["risk_level"] == "low"
    assert report["recommended_next_action"] == "Ready to release after manager review."


def test_markdown_report_has_manager_verifiable_sections() -> None:
    markdown = render_markdown(summarize_readiness(CHECKS))

    assert "## Release Readiness" in markdown
    assert "- Risk: high" in markdown
    assert "- Verified: 2 / 5" in markdown
    assert "## Blockers" in markdown
    assert "- REL-102 (high, billing): rollback SQL not reviewed" in markdown
    assert "## Unverified Checks" in markdown
    assert "- REL-105 (high, billing): Enterprise entitlement audit" in markdown
    assert "## Recommended Next Action" in markdown
    assert "Resolve REL-102 blocker with billing" in markdown
```

- [ ] **Step 3: Add an intentionally incomplete implementation**

```python
# /Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/src/dispatch_lab/readiness.py
from __future__ import annotations

from typing import Any


def summarize_readiness(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """Return a release-readiness summary for manager review."""
    return {
        "summary": {
            "total": len(checks),
            "verified": len(checks),
            "unverified": 0,
            "blocked": 0,
        },
        "verified": list(checks),
        "unverified": [],
        "blocked": [],
        "risk_level": "low",
        "recommended_next_action": "Ready to release after manager review.",
    }


def render_markdown(report: dict[str, Any]) -> str:
    """Render a compact Markdown report."""
    summary = report["summary"]
    return "\n".join(
        [
            "## Release Readiness",
            f"- Risk: {report['risk_level']}",
            f"- Verified: {summary['verified']} / {summary['total']}",
            "",
            "## Recommended Next Action",
            report["recommended_next_action"],
        ]
    )
```

- [ ] **Step 4: Verify the fixture fails after reset**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=nudge-readiness-report ./lab reset --force
.venv/bin/python -m pytest -q
```

Expected: pytest fails because the intentionally incomplete implementation treats blocked and unverified checks as verified.

- [ ] **Step 5: Reset the lab back to the known active baseline**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Expected: status shows only the new scenario fixture files as untracked or staged; root-level `src/` and `tests/` should not remain modified.

### Task 2: Wire The Scenario Into The Lab Harness

**Files:**
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`

- [ ] **Step 1: Add the scenario to the `lab` start case**

In `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`, add this case before `dashboard-evidence-review)`:

```bash
    nudge-readiness-report)
      task_goal="Fix the failing release readiness reporter pytest suite in the workerctl Dispatch lab."
      task_summary="Focused manager/worker Dispatch QA loop for post-implementation what-next nudging and comparison evidence."
      task_prompt="You are the worker for the nudge readiness report Dispatch QA lab. Inspect the failing release readiness reporter tests, infer the intended blocker, verification, risk, and recommended-next-action contract, make focused implementation changes so .venv/bin/python -m pytest -q passes, run the tests, inspect git diff, then finish with a concise final answer containing commands and implementation evidence. Do not include a what-next review, next-step assessment, or Product / QA risks section unless the manager asks for it. There is no workerctl completion command to run."
      manager_objective="Verify the worker fixed the release readiness reporter pytest suite, then ask a structured what-next nudge, compare the worker-side next-step assessment against manager-side evidence, and only finish after that comparison is auditable."
      acceptance_args=(
        --manager-acceptance ".venv/bin/python -m pytest -q passes in the lab repo."
        --manager-acceptance "The readiness reporter produces deterministic blockers, verified checks, unverified checks, risk level, and recommended next action."
        --manager-acceptance "git diff is focused on the readiness reporter fixture."
        --manager-acceptance "Dashboard Dispatch conversation shows a worker implementation receipt consumed by a manager cycle before finish_task succeeds."
        --manager-acceptance "After implementation evidence is accepted, manager sends a what-next nudge and receives worker reply with separate Verification evidence, Worker next-step assessment, and Product / QA risks sections."
        --manager-acceptance "Manager compares the worker-side assessment against manager-side evidence before finish_task succeeds."
      )
      ;;
```

- [ ] **Step 2: Update the usage text**

In `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`, update the usage line that lists supported scenarios so it includes `nudge-readiness-report`:

```text
Set LAB_SCENARIO=complex-refactor, support-triage, subscription-billing, dashboard-evidence-review, late-attach-support-reporter, or nudge-readiness-report for larger QA fixtures.
```

- [ ] **Step 3: Add README scenario description**

In `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`, add this paragraph after the dashboard evidence review paragraph:

```markdown
For nudge readiness reporting, set `LAB_SCENARIO=nudge-readiness-report`.
That fixture has a small release readiness reporter with blockers, verified and
unverified checks, risk scoring, recommended next action, and a dedicated
post-implementation what-next nudge comparison between worker-side and
manager-side assessments.
```

- [ ] **Step 4: Add README command example**

In `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`, add this command block near the other scenario commands:

````markdown
For nudge readiness reporting:

```bash
LAB_SCENARIO=nudge-readiness-report ./lab qa-start
```
````

- [ ] **Step 5: Verify shell syntax and reset support**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
bash -n ./lab
LAB_SCENARIO=nudge-readiness-report ./lab reset --force
.venv/bin/python -m pytest -q
```

Expected: `bash -n` passes. Reset applies the scenario. Pytest fails for the intentional worker task baseline.

- [ ] **Step 6: Restore the known active scenario**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Expected: status contains only intentional lab harness, README, and scenario fixture changes.

- [ ] **Step 7: Commit lab fixture and harness changes**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add lab README.md scenarios/nudge-readiness-report
git commit -m "Add nudge readiness report lab scenario"
```

### Task 3: Add Product QA Runbook

**Files:**
- Create: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/nudge-readiness-report.md`
- Modify: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/README.md`

- [ ] **Step 1: Create the runbook**

````markdown
# Codex + Chrome QA: Nudge Readiness Report

Use this task to test the manager's post-implementation "What's next?" nudge,
the worker-side next-step assessment, and the manager-side comparison before
finish.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=nudge-readiness-report`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: finish a release readiness reporter that summarizes
  blockers, verified checks, unverified checks, risk level, and recommended
  next action.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=nudge-readiness-report ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The readiness reporter produces deterministic blockers, verified checks,
  unverified checks, risk level, and recommended next action.
- `git diff` is focused on the readiness reporter fixture.
- Dashboard Dispatch conversation shows a worker implementation receipt
  consumed by a manager cycle before `finish_task` succeeds.
- After implementation evidence is accepted, the manager sends a what-next
  nudge and receives a worker reply with separate `Verification evidence`,
  `Worker next-step assessment`, and `Product / QA risks` sections.
- The manager compares the worker-side assessment against manager-side evidence
  before `finish_task` succeeds.

## Chrome Checks

- Dispatch banner shows active.
- Relationship state is visible and is not `none`.
- First worker receipt includes `.venv/bin/python -m pytest -q` pass evidence.
- Dispatch conversation lane shows the first `worker_task_complete`.
- A manager cycle consumes the first routed worker completion notification.
- A later manager what-next nudge is visible after implementation evidence is
  consumed.
- A later worker receipt is visible after the nudge.
- The later worker receipt includes separate `Verification evidence`,
  `Worker next-step assessment`, and `Product / QA risks` sections.
- A later manager cycle consumes the post-nudge worker receipt.
- Manager comparison between worker-side and manager-side assessment is visible
  in manager output, dashboard receipt text, or audit evidence.
- All accepted criteria are satisfied.
- `finish_task` succeeds only after post-nudge receipt consumption and manager
  comparison.
- Task state becomes `done`.

## CLI Checks

Run cycles until completion:

```bash
./lab cycle
```

Then audit:

```bash
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl audit "$TASK" --json
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Required audit evidence:

- `routed_notifications` contains at least two `worker_task_complete` entries.
- The first completion contains implementation/test evidence.
- The later completion contains the post-nudge worker review sections.
- Both relevant completions include `source_event_id`.
- Both relevant completions include `consumed_manager_cycle_id`.
- The manager nudge event or nudge command appears between the implementation
  receipt and the post-nudge worker receipt.
- The post-nudge receipt is consumed before `finish_task`.
- Manager comparison evidence appears before `finish_task`.
- All accepted criteria are satisfied.
- `finish_task` command state is `succeeded`, with command id recorded.
- Task state is `done`.

## Failure Capture

If the run fails, capture:

- run id
- dashboard URL
- relevant `./lab cycle` output
- `workerctl audit "$TASK" --json` summary
- dashboard visible state
- exact missing or wrong behavior

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
````

- [ ] **Step 2: Add the runbook to the QA README**

In `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/README.md`, add this bullet after Dashboard evidence review:

```markdown
- [Nudge readiness report](nudge-readiness-report.md) - dedicated what-next
  nudge, worker-side assessment, and manager-side comparison test.
```

- [ ] **Step 3: Verify docs references**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
rg -n "nudge-readiness-report|Nudge readiness report" docs/qa docs/superpowers/specs docs/superpowers/plans
```

Expected: output includes the design, this plan, the new runbook, and the QA README bullet.

- [ ] **Step 4: Commit product docs**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git add docs/qa/nudge-readiness-report.md docs/qa/README.md docs/superpowers/plans/2026-05-29-nudge-readiness-report.md
git commit -m "Add nudge readiness QA implementation plan and runbook"
```

### Task 4: End-To-End Implementation Verification

**Files:**
- Verify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
- Verify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files/tests/test_readiness.py`
- Verify: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/nudge-readiness-report.md`

- [ ] **Step 1: Confirm both repos are clean on their feature branches**

```bash
git -C /Users/neonwatty/Desktop/codex-terminal-manager status --short --branch
git -C /Users/neonwatty/Desktop/workerctl-dispatch-lab status --short --branch
```

Expected: no unstaged or untracked files.

- [ ] **Step 2: Confirm the new scenario starts from a failing worker task**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=nudge-readiness-report ./lab reset --force
.venv/bin/python -m pytest -q
```

Expected: pytest fails against `tests/test_readiness.py`. This is the desired baseline for a worker QA task.

- [ ] **Step 3: Confirm lab start metadata works**

Run this only when ready to start live QA because it creates workerctl sessions:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=nudge-readiness-report ./lab qa-start
```

Expected: output prints `DASHBOARD_URL`, starts worker/manager sessions, and includes next commands for `./lab cycle`, `./lab status`, and `./lab cleanup`.

- [ ] **Step 4: Drive the manual QA run**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cycle
```

Repeat until the worker implementation receipt is consumed, the manager sends the what-next nudge, the worker replies with the required sections, the manager comparison is visible, accepted criteria close, and `finish_task` succeeds.

- [ ] **Step 5: Capture audit evidence**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl audit "$TASK" --json
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Expected: audit shows two relevant `worker_task_complete` notifications, manager consumption for both, nudge between them, comparison before finish, all accepted criteria closed, and task state `done`.

- [ ] **Step 6: Cleanup and restore lab root**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Expected: cleanup stops dashboard/session processes and reset restores the known active lab baseline without root-level fixture drift.

## Self-Review

- Spec coverage: Tasks 1 and 2 add the lab fixture and scenario wiring; Task 3 adds the product QA runbook; Task 4 covers live dashboard/audit verification and cleanup.
- Completeness scan: every code and documentation step includes concrete content.
- Type consistency: `summarize_readiness(checks)` and `render_markdown(report)` are used consistently across fixture tests and implementation skeleton.
