# Dashboard Evidence Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `dashboard-evidence-review` QA lab scenario that exercises a realistic multi-turn manager/worker/Dispatch closeout with dashboard-shaped audit evidence and a post-completion "what's next?" review.

**Architecture:** The lab scenario lives in `workerctl-dispatch-lab` as resettable fixture files: realistic JSON audit fixtures, a small Python evidence summarizer, and pytest coverage. The product repo adds the repeatable QA runbook and README link so Codex can drive the scenario through the dashboard.

**Tech Stack:** Bash lab runner, Python 3.11-compatible code, pytest, JSON fixtures, existing `workerctl` CLI and dashboard.

---

## File Structure

Product repo `/Users/neonwatty/Desktop/codex-terminal-manager`:

- Modify `docs/qa/README.md` to list the new runbook.
- Create `docs/qa/dashboard-evidence-review.md` with start, dashboard checks, CLI fallback checks, and cleanup commands.

Lab repo `/Users/neonwatty/Desktop/workerctl-dispatch-lab`:

- Modify `README.md` to describe the new scenario and command.
- Modify `lab` to support `LAB_SCENARIO=dashboard-evidence-review`.
- Create `scenarios/dashboard-evidence-review/files/fixtures/before_finish.json`.
- Create `scenarios/dashboard-evidence-review/files/fixtures/after_finish.json`.
- Create `scenarios/dashboard-evidence-review/files/src/dispatch_lab/dashboard_evidence.py`.
- Create `scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py`.

The Python module owns only audit summarization. The lab runner owns only scenario reset/start wiring. The product docs own only repeatable QA procedure.

---

### Task 1: Add Failing Dashboard Evidence Fixture Tests

**Files:**
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/fixtures/before_finish.json`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/fixtures/after_finish.json`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py`

- [ ] **Step 1: Create `before_finish.json`**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/fixtures/before_finish.json` with this fixture:

```json
{
  "task": {
    "name": "qa-dashboard-evidence",
    "state": "candidate"
  },
  "acceptance_criteria": [
    {
      "id": 1,
      "criterion": "pytest passes",
      "status": "satisfied"
    },
    {
      "id": 2,
      "criterion": "post-completion review received",
      "status": "accepted"
    }
  ],
  "routed_notifications": [
    {
      "id": 41,
      "binding_id": "binding-dashboard",
      "signal_type": "worker_task_complete",
      "state": "delivered",
      "source_event_id": 901,
      "consumed_manager_cycle_id": 77,
      "created_at": "2026-05-28T12:00:02Z",
      "payload": {
        "task": "qa-dashboard-evidence",
        "source_session": "qa-dashboard-evidence-worker",
        "target_session": "qa-dashboard-evidence-manager",
        "worker_receipt": {
          "last_agent_message": "Implemented evidence summary. Verification evidence: pytest passed. Product / QA risks: manual dashboard review should confirm finish ordering."
        }
      }
    }
  ],
  "correlation_chains": [
    {
      "command_type": "worker_task_complete",
      "command_state": "delivered",
      "created_at": "2026-05-28T12:00:02Z",
      "manager_cycle_id": 77,
      "routed_notification_ids": [41],
      "source_event_id": 901
    }
  ],
  "commands": []
}
```

- [ ] **Step 2: Create `after_finish.json`**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/fixtures/after_finish.json` with this fixture:

```json
{
  "task": {
    "name": "qa-dashboard-evidence",
    "state": "done"
  },
  "acceptance_criteria": [
    {
      "id": 1,
      "criterion": "pytest passes",
      "status": "satisfied"
    },
    {
      "id": 2,
      "criterion": "post-completion review received",
      "status": "satisfied"
    }
  ],
  "routed_notifications": [
    {
      "id": 41,
      "binding_id": "binding-dashboard",
      "signal_type": "worker_task_complete",
      "state": "delivered",
      "source_event_id": 901,
      "consumed_manager_cycle_id": 77,
      "created_at": "2026-05-28T12:00:02Z",
      "payload": {
        "task": "qa-dashboard-evidence",
        "source_session": "qa-dashboard-evidence-worker",
        "target_session": "qa-dashboard-evidence-manager",
        "worker_receipt": {
          "last_agent_message": "Verification evidence: pytest passed and diff was focused.\n\nProduct / QA risks: confirm dashboard relationship survives completed task state."
        }
      }
    }
  ],
  "correlation_chains": [
    {
      "command_type": "worker_task_complete",
      "command_state": "delivered",
      "created_at": "2026-05-28T12:00:02Z",
      "manager_cycle_id": 77,
      "routed_notification_ids": [41],
      "source_event_id": 901
    },
    {
      "command_id": "command-finish-good",
      "command_type": "finish_task",
      "command_state": "succeeded",
      "created_at": "2026-05-28T12:00:30Z",
      "manager_cycle_id": null,
      "routed_notification_ids": []
    }
  ],
  "commands": [
    {
      "id": "command-finish-good",
      "type": "finish_task",
      "state": "succeeded",
      "created_at": "2026-05-28T12:00:30Z"
    }
  ]
}
```

- [ ] **Step 3: Write the pytest file**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py`:

```python
import json
from pathlib import Path

from dispatch_lab.dashboard_evidence import summarize_audit


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_before_finish_requires_post_completion_review_before_done():
    summary = summarize_audit(load_fixture("before_finish.json"))

    assert summary["task_state"] == "candidate"
    assert summary["criteria"] == {"satisfied": 1, "open": 1, "total": 2}
    assert summary["relationship"] == {
        "state": "observed",
        "task": "qa-dashboard-evidence",
        "worker": "qa-dashboard-evidence-worker",
        "manager": "qa-dashboard-evidence-manager",
    }
    assert summary["worker_completion"]["source_event_id"] == 901
    assert summary["worker_completion"]["routed_notification_id"] == 41
    assert summary["worker_completion"]["consumed_manager_cycle_id"] == 77
    assert summary["finish"]["succeeded"] is False
    assert summary["ready_to_finish"] is False


def test_after_finish_proves_consumption_before_finish_and_review_sections():
    summary = summarize_audit(load_fixture("after_finish.json"))

    assert summary["task_state"] == "done"
    assert summary["criteria"] == {"satisfied": 2, "open": 0, "total": 2}
    assert summary["relationship"]["state"] == "observed"
    assert summary["worker_completion"]["manager_consumed"] is True
    assert summary["finish"] == {
        "succeeded": True,
        "command_id": "command-finish-good",
        "after_manager_consumption": True,
    }
    assert summary["post_completion_review"] == {
        "verification_evidence": True,
        "product_qa_risks": True,
    }
    assert summary["ready_to_finish"] is True


def test_finish_before_manager_consumption_is_not_valid():
    audit = load_fixture("after_finish.json")
    audit["correlation_chains"][0]["manager_cycle_id"] = None
    audit["routed_notifications"][0]["consumed_manager_cycle_id"] = None

    summary = summarize_audit(audit)

    assert summary["worker_completion"]["manager_consumed"] is False
    assert summary["finish"]["succeeded"] is True
    assert summary["finish"]["after_manager_consumption"] is False
    assert summary["ready_to_finish"] is False
```

- [ ] **Step 4: Run the scenario tests directly and verify they fail**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
PYTHONPATH=scenarios/dashboard-evidence-review/files/src \
  .venv/bin/python -m pytest -q scenarios/dashboard-evidence-review/files/tests
```

Expected: fail because `dispatch_lab.dashboard_evidence` does not exist yet.

- [ ] **Step 5: Commit the failing fixture tests**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add scenarios/dashboard-evidence-review/files/fixtures/before_finish.json \
  scenarios/dashboard-evidence-review/files/fixtures/after_finish.json \
  scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py
git commit -m "Add dashboard evidence review fixture tests"
```

---

### Task 2: Implement the Dashboard Evidence Summarizer

**Files:**
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/src/dispatch_lab/dashboard_evidence.py`
- Test: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py`

- [ ] **Step 1: Create the module implementation**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/dashboard-evidence-review/files/src/dispatch_lab/dashboard_evidence.py`:

```python
from __future__ import annotations

from datetime import datetime
from typing import Any


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _criteria_summary(criteria: list[dict[str, Any]]) -> dict[str, int]:
    satisfied = sum(1 for item in criteria if item.get("status") == "satisfied")
    open_count = sum(1 for item in criteria if item.get("status") in {"accepted", "proposed"})
    return {"satisfied": satisfied, "open": open_count, "total": len(criteria)}


def _worker_completion(audit: dict[str, Any]) -> dict[str, Any]:
    notifications = [
        item
        for item in audit.get("routed_notifications", [])
        if item.get("signal_type") == "worker_task_complete"
    ]
    if not notifications:
        return {
            "source_event_id": None,
            "routed_notification_id": None,
            "consumed_manager_cycle_id": None,
            "manager_consumed": False,
            "receipt": "",
        }
    notification = notifications[-1]
    receipt = (notification.get("payload") or {}).get("worker_receipt") or {}
    consumed_cycle = notification.get("consumed_manager_cycle_id")
    return {
        "source_event_id": notification.get("source_event_id"),
        "routed_notification_id": notification.get("id"),
        "consumed_manager_cycle_id": consumed_cycle,
        "manager_consumed": consumed_cycle is not None,
        "receipt": receipt.get("last_agent_message") or "",
    }


def _relationship(audit: dict[str, Any]) -> dict[str, str | None]:
    for notification in reversed(audit.get("routed_notifications", [])):
        payload = notification.get("payload") or {}
        worker = payload.get("source_session")
        manager = payload.get("target_session")
        task = payload.get("task") or (audit.get("task") or {}).get("name")
        if worker and manager and task:
            return {
                "state": "observed",
                "task": task,
                "worker": worker,
                "manager": manager,
            }
    return {"state": "none", "task": None, "worker": None, "manager": None}


def _finish(audit: dict[str, Any], *, manager_consumed: bool) -> dict[str, Any]:
    finish_chains = [
        item
        for item in audit.get("correlation_chains", [])
        if item.get("command_type") == "finish_task"
    ]
    if not finish_chains:
        return {"succeeded": False, "command_id": None, "after_manager_consumption": False}

    finish_chain = finish_chains[-1]
    return {
        "succeeded": finish_chain.get("command_state") == "succeeded",
        "command_id": finish_chain.get("command_id"),
        "after_manager_consumption": manager_consumed,
    }


def _post_completion_review(receipt: str) -> dict[str, bool]:
    lower = receipt.lower()
    return {
        "verification_evidence": "verification evidence" in lower,
        "product_qa_risks": "product / qa risks" in lower or "product/qa risks" in lower,
    }


def summarize_audit(audit: dict[str, Any]) -> dict[str, Any]:
    criteria = _criteria_summary(audit.get("acceptance_criteria", []))
    completion = _worker_completion(audit)
    finish = _finish(audit, manager_consumed=completion["manager_consumed"])
    review = _post_completion_review(completion["receipt"])
    ready_to_finish = (
        criteria["open"] == 0
        and completion["manager_consumed"]
        and review["verification_evidence"]
        and review["product_qa_risks"]
    )
    if finish["succeeded"]:
        ready_to_finish = ready_to_finish and finish["after_manager_consumption"]

    return {
        "task_state": (audit.get("task") or {}).get("state"),
        "criteria": criteria,
        "relationship": _relationship(audit),
        "worker_completion": {
            key: value for key, value in completion.items() if key != "receipt"
        },
        "finish": finish,
        "post_completion_review": review,
        "ready_to_finish": ready_to_finish,
    }
```

- [ ] **Step 2: Run the scenario tests directly**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
PYTHONPATH=scenarios/dashboard-evidence-review/files/src \
  .venv/bin/python -m pytest -q scenarios/dashboard-evidence-review/files/tests
```

Expected: `3 passed`.

- [ ] **Step 3: Inspect the scenario diff**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git diff -- scenarios/dashboard-evidence-review/files/src/dispatch_lab/dashboard_evidence.py \
  scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py \
  scenarios/dashboard-evidence-review/files/fixtures/before_finish.json \
  scenarios/dashboard-evidence-review/files/fixtures/after_finish.json
```

Expected: only the new module, tests, and fixtures are shown.

- [ ] **Step 4: Commit implementation**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add scenarios/dashboard-evidence-review/files/src/dispatch_lab/dashboard_evidence.py
git commit -m "Implement dashboard evidence summarizer"
```

---

### Task 3: Wire the Scenario Into the Lab Runner

**Files:**
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`

- [ ] **Step 1: Add README scenario description**

Modify `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md` after the subscription billing paragraph:

```markdown
For dashboard evidence review, set `LAB_SCENARIO=dashboard-evidence-review`.
That fixture has `workerctl audit`-shaped JSON evidence, a small dashboard
evidence summarizer, and tests that require relationship recovery, criteria
counts, manager consumption, finish ordering, and a post-completion "what's
next?" review receipt.
```

Add a command block near the other scenario commands:

````markdown
For dashboard evidence review:

```bash
LAB_SCENARIO=dashboard-evidence-review ./lab qa-start
```
````

- [ ] **Step 2: Add `dashboard-evidence-review` case to `cmd_start`**

Modify `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab` in the `case "$SCENARIO" in` block:

```bash
    dashboard-evidence-review)
      task_goal="Fix the failing dashboard evidence review pytest suite in the workerctl Dispatch lab."
      task_summary="Multi-turn dashboard/Dispatch QA loop with realistic audit-shaped evidence."
      task_prompt="You are the worker for the dashboard evidence review Dispatch QA lab. Inspect the failing dashboard evidence tests and JSON fixtures, infer the intended evidence summary contract, make focused implementation changes so .venv/bin/python -m pytest -q passes, run the test, inspect git diff, then finish with a concise final answer containing commands and evidence. Do not include a what-next review unless the manager asks for it."
      manager_objective="Verify the worker fixed the dashboard evidence review pytest suite, then ask for a structured what-next review before finishing."
      acceptance_args=(
        --manager-acceptance ".venv/bin/python -m pytest -q passes in the lab repo."
        --manager-acceptance "The evidence summary distinguishes worker completion, manager consumption, criteria state, relationship recovery, and finish ordering."
        --manager-acceptance "git diff is focused on the dashboard evidence implementation and fixtures."
        --manager-acceptance "Dashboard Dispatch conversation shows a worker receipt consumed by a manager cycle before finish_task succeeds."
        --manager-acceptance "After implementation evidence is accepted, the manager sends a what-next nudge and receives a worker reply with separate Verification evidence and Product / QA risks sections."
      )
      ;;
```

- [ ] **Step 3: Ensure reset applies the scenario files**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=dashboard-evidence-review ./lab reset --force
find src tests fixtures -maxdepth 3 -type f | sort
```

Expected output includes:

```text
fixtures/after_finish.json
fixtures/before_finish.json
src/dispatch_lab/dashboard_evidence.py
tests/test_dashboard_evidence.py
```

- [ ] **Step 4: Run baseline tests after reset**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
.venv/bin/python -m pytest -q
```

Expected: `3 passed`.

- [ ] **Step 5: Commit lab runner wiring**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add lab README.md
git commit -m "Wire dashboard evidence review scenario"
```

---

### Task 4: Add Product QA Runbook

**Files:**
- Create: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/dashboard-evidence-review.md`
- Modify: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/README.md`

- [ ] **Step 1: Add the runbook**

Create `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/dashboard-evidence-review.md`:

````markdown
# Codex + Chrome QA: Dashboard Evidence Review

Use this task to run the dashboard evidence review Dispatch QA test.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=dashboard-evidence-review`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: fix dashboard evidence summarization for realistic
  `workerctl audit`-shaped fixtures.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=dashboard-evidence-review ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The evidence summary distinguishes worker completion, manager consumption,
  criteria state, relationship recovery, and finish ordering.
- `git diff` is focused on the dashboard evidence implementation and fixtures.
- Dashboard Dispatch conversation shows a worker receipt consumed by a manager
  cycle before `finish_task` succeeds.
- After implementation evidence is accepted, the manager sends a what-next nudge
  and receives a worker reply with separate `Verification evidence` and
  `Product / QA risks` sections.

## Chrome Checks

- Dispatch banner shows active.
- Relationship state is not `none` for the printed task.
- Worker receipt includes pytest pass evidence.
- Dispatch lane shows `worker_task_complete`.
- A manager cycle consumes the routed worker completion.
- A later worker receipt answers the manager's what-next nudge with the required
  two sections.
- All accepted criteria are satisfied.
- `finish_task` succeeds only after manager consumption and what-next review.
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

- `routed_notifications` contains `worker_task_complete`.
- at least one routed notification has `consumed_manager_cycle_id`.
- a worker receipt includes `Verification evidence`.
- a worker receipt includes `Product / QA risks`.
- accepted criteria are all satisfied, deferred, or rejected.
- `finish_task` succeeded after the consumed worker completion.
- task state is `done`.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
````

- [ ] **Step 2: Update QA README**

Modify `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/README.md` in the task list:

```markdown
- [Dashboard evidence review](dashboard-evidence-review.md) - realistic
  Dispatch/dashboard evidence summarization with a required what-next review.
```

- [ ] **Step 3: Commit docs**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git add docs/qa/dashboard-evidence-review.md docs/qa/README.md
git commit -m "Add dashboard evidence review QA runbook"
```

---

### Task 5: Live QA Validation

**Files:**
- Validate only. No planned file edits.

- [ ] **Step 1: Start the live scenario**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=dashboard-evidence-review ./lab qa-start
```

Expected: prints `DASHBOARD_URL=http://127.0.0.1:8797/?task=dispatch-lab-...`.

- [ ] **Step 2: Open dashboard**

Open the printed dashboard URL in the browser.

Expected initial dashboard state:

```text
Dispatch core active
Relationship active
Criteria 0 satisfied / 5 open
Finish task none
```

- [ ] **Step 3: Run cycles until first worker completion**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cycle
```

Repeat until the dashboard shows a `worker_task_complete` notification with a worker receipt containing pytest evidence.

Expected dashboard evidence:

```text
worker_task_complete notification
Worker receipt from source event
.venv/bin/python -m pytest -q
```

- [ ] **Step 4: Confirm manager asks what-next before finish**

Run more cycles until the manager sends the post-completion nudge.

Expected evidence in dashboard or audit:

```text
what next
Verification evidence
Product / QA risks
```

If the worker does not answer in the required structure, continue cycles until the manager requests the structured answer.

- [ ] **Step 5: Confirm auto-finish**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cycle
```

Expected output includes:

```text
All accepted criteria are closed; finishing task with criteria audit.
```

Expected dashboard final state:

```text
Relationship observed
Task state done
Criteria 5 satisfied / 0 open
Finish task succeeded
Dispatch core active
```

- [ ] **Step 6: Cleanup and reset**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short --branch
```

Expected: only committed source changes remain, or clean if all implementation branches have been merged.

---

### Task 6: Final Verification and PRs

**Files:**
- Product repo docs and plan/spec files.
- Lab repo scenario files and runner changes.

- [ ] **Step 1: Run product checks**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
node dashboard/scripts/run-tests.mjs
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests
./node_modules/.bin/tsc -p dashboard/tsconfig.json && ./node_modules/.bin/vite build --config dashboard/vite.config.ts
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Run lab checks**

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
bash -n ./lab
LAB_SCENARIO=dashboard-evidence-review ./lab reset --force
.venv/bin/python -m pytest -q
git diff --check
```

Expected: `3 passed`; diff check passes.

- [ ] **Step 3: Open PRs**

Product repo:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --short --branch
git push -u origin HEAD
gh pr create --base main --head "$(git branch --show-current)" --title "Add dashboard evidence review QA runbook" --body "Adds the dashboard evidence review QA runbook and implementation plan."
```

Lab repo:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git status --short --branch
git push -u origin HEAD
gh pr create --base main --head "$(git branch --show-current)" --title "Add dashboard evidence review QA scenario" --body "Adds the dashboard evidence review scenario with audit-shaped fixtures and lab wiring."
```

- [ ] **Step 4: Merge after checks pass**

Product repo:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
gh pr checks --watch --interval 10
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only
```

Lab repo:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
gh pr checks --watch --interval 10 || true
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only
```

Expected final state:

```bash
git status --short --branch
```

shows clean `main...origin/main` in both repos.

---

## Self-Review

- Spec coverage: Tasks cover fixtures, summarizer, lab runner support, product QA docs, multi-turn live validation, cleanup, and PR closeout.
- Placeholder scan: No placeholder markers, unnamed files, or unspecified tests remain.
- Type consistency: The plan consistently uses `summarize_audit(audit: dict) -> dict`, criteria keys `satisfied/open/total`, and relationship keys `state/task/worker/manager`.
