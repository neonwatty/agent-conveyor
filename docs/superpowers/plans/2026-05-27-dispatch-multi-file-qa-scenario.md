# Dispatch Multi-File QA Scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a harder resettable QA lab scenario that exercises the manager-worker-Dispatch-dashboard loop on a multi-file Python change with meaningful acceptance evidence.

**Architecture:** Extend the sibling lab repo with a new `support-triage` scenario under `scenarios/support-triage/files`. The fixture starts red across multiple behavior areas, forcing the worker to inspect and edit several small modules while the manager verifies criteria through Dispatch worker receipts and the dashboard conversation lane.

**Tech Stack:** Bash lab wrapper, Python 3, pytest, workerctl, tmux, Codex sessions, dashboard on localhost.

---

## File Structure

- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/support-triage/files/src/dispatch_lab/triage.py`
  - Ticket parsing, priority scoring, routing, SLA, and outbound summary logic.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/support-triage/files/src/dispatch_lab/__init__.py`
  - Package marker.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/support-triage/files/tests/test_triage.py`
  - Red tests for a realistic multi-rule support triage workflow.
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
  - Add `support-triage` scenario prompt, manager objective, and acceptance criteria.
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`
  - Document when to use `support-triage` and how to run it.

## Scenario Contract

The worker receives a small support-ticket workflow. The tests should initially fail because the implementation has plausible but wrong behavior:

- Severity parsing is case-sensitive and ignores aliases.
- Enterprise customers are not escalated correctly.
- Billing/security keywords are routed to the wrong team.
- SLA due dates are calculated from calendar days instead of business days.
- The manager-facing summary omits enough evidence to verify the routing decision.

The intended worker fix should touch only `src/dispatch_lab/triage.py`. The worker should not need to edit tests or lab harness files.

## Tasks

### Task 1: Add Support Triage Scenario Fixture

**Files:**
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/support-triage/files/src/dispatch_lab/triage.py`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/support-triage/files/src/dispatch_lab/__init__.py`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/support-triage/files/tests/test_triage.py`

- [ ] **Step 1: Create the failing implementation**

Add this file at `scenarios/support-triage/files/src/dispatch_lab/triage.py`:

```python
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class Ticket:
    customer_tier: str
    subject: str
    body: str
    severity: str
    opened_on: date


@dataclass(frozen=True)
class TriageDecision:
    normalized_severity: str
    priority: int
    team: str
    due_on: date
    summary: str


SEVERITY_PRIORITY = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "urgent": 4,
}


def normalize_severity(raw: str) -> str:
    return raw


def priority_for(ticket: Ticket) -> int:
    return SEVERITY_PRIORITY.get(normalize_severity(ticket.severity), 1)


def route_team(ticket: Ticket) -> str:
    text = f"{ticket.subject} {ticket.body}"
    if "invoice" in text:
        return "support"
    if "login" in text:
        return "support"
    return "general"


def due_date(opened_on: date, priority: int) -> date:
    if priority >= 4:
        return opened_on + timedelta(days=1)
    if priority == 3:
        return opened_on + timedelta(days=2)
    return opened_on + timedelta(days=5)


def summarize(ticket: Ticket, team: str, priority: int, due_on: date) -> str:
    return f"{team} priority {priority} due {due_on.isoformat()}"


def triage(ticket: Ticket) -> TriageDecision:
    priority = priority_for(ticket)
    team = route_team(ticket)
    due_on = due_date(ticket.opened_on, priority)
    return TriageDecision(
        normalized_severity=normalize_severity(ticket.severity),
        priority=priority,
        team=team,
        due_on=due_on,
        summary=summarize(ticket, team, priority, due_on),
    )
```

- [ ] **Step 2: Create package marker**

Add this file at `scenarios/support-triage/files/src/dispatch_lab/__init__.py`:

```python
```

- [ ] **Step 3: Create behavior tests**

Add this file at `scenarios/support-triage/files/tests/test_triage.py`:

```python
from datetime import date

from dispatch_lab.triage import Ticket, normalize_severity, triage


def test_normalize_severity_accepts_aliases_and_whitespace():
    assert normalize_severity(" P1 ") == "urgent"
    assert normalize_severity("sev-2") == "high"
    assert normalize_severity("Medium") == "medium"
    assert normalize_severity("") == "low"


def test_enterprise_security_ticket_routes_to_security_with_escalated_priority():
    ticket = Ticket(
        customer_tier="enterprise",
        subject="Suspicious login from new region",
        body="Admin reports possible account takeover and MFA bypass.",
        severity="sev-2",
        opened_on=date(2026, 5, 22),
    )

    decision = triage(ticket)

    assert decision.normalized_severity == "high"
    assert decision.priority == 4
    assert decision.team == "security"
    assert decision.due_on == date(2026, 5, 25)
    assert "enterprise" in decision.summary
    assert "security" in decision.summary
    assert "urgent" in decision.summary


def test_billing_ticket_routes_to_billing_without_enterprise_escalation():
    ticket = Ticket(
        customer_tier="standard",
        subject="Invoice total looks wrong",
        body="The latest renewal invoice has duplicate line items.",
        severity="medium",
        opened_on=date(2026, 5, 26),
    )

    decision = triage(ticket)

    assert decision.normalized_severity == "medium"
    assert decision.priority == 2
    assert decision.team == "billing"
    assert decision.due_on == date(2026, 6, 2)
    assert "billing" in decision.summary
    assert "2026-06-02" in decision.summary


def test_business_day_sla_skips_weekends_for_high_priority():
    ticket = Ticket(
        customer_tier="pro",
        subject="Production export is failing",
        body="All CSV exports return a server error.",
        severity="high",
        opened_on=date(2026, 5, 22),
    )

    decision = triage(ticket)

    assert decision.priority == 3
    assert decision.team == "support"
    assert decision.due_on == date(2026, 5, 26)


def test_summary_contains_manager_verification_evidence():
    ticket = Ticket(
        customer_tier="enterprise",
        subject="Invoice portal exposes another account",
        body="Billing page shows a different company name after login.",
        severity="P1",
        opened_on=date(2026, 5, 27),
    )

    decision = triage(ticket)

    assert decision.team == "security"
    assert decision.priority == 4
    assert "severity=urgent" in decision.summary
    assert "tier=enterprise" in decision.summary
    assert "team=security" in decision.summary
    assert "due=2026-05-28" in decision.summary
```

- [ ] **Step 4: Verify the scenario starts red**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=support-triage ./lab reset --force
.venv/bin/python -m pytest -q
```

Expected:

```text
5 failed
```

Exact assertion messages may vary, but failures must cover severity normalization, routing, priority escalation, business-day SLA, and summary evidence.

### Task 2: Wire Scenario Into Lab Runner

**Files:**
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`

- [ ] **Step 1: Add scenario case**

In `cmd_start()`, add this case between `complex-refactor)` and `*)`:

```bash
    support-triage)
      task_goal="Fix the failing support-ticket triage pytest suite in the workerctl Dispatch advanced lab."
      task_summary="Advanced manager/worker Dispatch QA loop with multi-rule support triage behavior."
      task_prompt="You are the worker for the support triage Dispatch QA lab. Inspect the failing support-ticket triage tests, infer the intended severity, routing, escalation, SLA, and summary-evidence contract, make the smallest coherent implementation changes so .venv/bin/python -m pytest -q passes, run the test, inspect git diff, then finish with a concise final answer containing commands and evidence. There is no workerctl completion command to run."
      manager_objective="Verify the worker fixed the support triage pytest suite with receipt-backed evidence, while keeping the diff focused."
      acceptance_args=(
        --manager-acceptance ".venv/bin/python -m pytest -q passes in the lab repo."
        --manager-acceptance "The fix handles severity aliases, enterprise escalation, team routing, business-day SLA dates, and manager-verifiable summary evidence."
        --manager-acceptance "git diff is focused on the support triage implementation and avoids broad unrelated rewrites."
        --manager-acceptance "Dashboard Dispatch conversation shows a worker receipt consumed by a manager cycle before finish_task succeeds."
      )
      ;;
```

- [ ] **Step 2: Verify the lab starts the advanced scenario**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=support-triage ./lab reset --force
./lab status
```

Expected `./lab status` includes:

```text
SCENARIO=support-triage
LAB_SCENARIO=complex-refactor ./lab qa-start
```

The status useful-command text may still mention `complex-refactor`; that is acceptable in this task unless we choose to make it scenario-aware later.

### Task 3: Document the Advanced QA Cycle

**Files:**
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`

- [ ] **Step 1: Add scenario description**

Add this paragraph after the existing `complex-refactor` description:

```markdown
For an advanced multi-file-style reasoning scenario, set `LAB_SCENARIO=support-triage`.
That fixture has a support-ticket triage module with severity aliases,
enterprise escalation, team routing, business-day SLA dates, and manager-facing
summary evidence. It is designed to require deeper contract inference than the
calculator or order-pricing fixtures while keeping the expected implementation
change focused.
```

- [ ] **Step 2: Add run command**

Add this example below the complex scenario command:

```markdown
For the advanced support triage scenario:

```bash
LAB_SCENARIO=support-triage ./lab qa-start
```
```

- [ ] **Step 3: Verify documentation mentions the scenario**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
rg -n "support-triage|support-ticket triage|severity aliases" README.md
```

Expected:

```text
README.md:<line>:For an advanced multi-file-style reasoning scenario, set `LAB_SCENARIO=support-triage`.
README.md:<line>:LAB_SCENARIO=support-triage ./lab qa-start
```

### Task 4: Run Full Scenario QA Smoke

**Files:**
- No new source files. This validates the scenario through the real loop.

- [ ] **Step 1: Start the advanced QA run**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=support-triage ./lab qa-start
```

Expected:

```text
QA run is ready.
Dashboard: http://127.0.0.1:8797/?task=dispatch-lab-...
```

- [ ] **Step 2: Drive manager cycles until worker completion**

Run:

```bash
./lab cycle
sleep 30
./lab cycle
sleep 30
./lab cycle
```

Expected before completion:

```text
"task_completed": false
```

Expected after worker completion:

```text
"task_completed": true
"worker_receipt": {
```

- [ ] **Step 3: Verify dashboard conversation receipt**

Run:

```bash
curl -fsS 'http://127.0.0.1:8797/api/observation' > .lab/observation-current.json
python3 - <<'PY'
import json
with open(".lab/observation-current.json") as f:
    obj = json.load(f)
for chain in obj["dispatch"]["chains"]:
    print(chain["summary"], [item["kind"] for item in chain.get("conversation", [])])
PY
```

Expected:

```text
worker_task_complete notification #... ['routed_notification', 'worker_receipt', 'manager_cycle']
```

- [ ] **Step 4: Verify finish**

Run:

```bash
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl audit "$(awk -F= '/^TASK=/{print $2}' .lab/run.env)" --json > .lab/audit-current.json
python3 - <<'PY'
import json
with open(".lab/audit-current.json") as f:
    obj = json.load(f)
print((obj.get("task") or {}).get("state"))
print([d.get("decision") for d in obj.get("manager_decisions", [])])
PY
```

Expected:

```text
done
['stop']
```

### Task 5: Cleanup and Commit

**Files:**
- Stage only scenario and harness/docs files.
- Do not stage `src/dispatch_lab/triage.py` after a live worker run; that is generated QA output.

- [ ] **Step 1: Stop live QA resources**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cleanup
./lab dashboard-stop
```

Expected:

```text
Remaining active lab sessions:
[]
```

- [ ] **Step 2: Reset lab working fixture to baseline**

Run:

```bash
LAB_SCENARIO=support-triage ./lab reset --force
git status --short
```

Expected dirty files should be limited to the committed scenario assets plus `lab` and `README.md` before commit.

- [ ] **Step 3: Commit scenario**

Run:

```bash
git add README.md lab scenarios/support-triage
git commit -m "Add advanced support triage dispatch QA scenario"
```

Expected:

```text
[main <sha>] Add advanced support triage dispatch QA scenario
```

## Self-Review

- Spec coverage: The plan adds a more complex scenario, wires it into the lab, documents it, verifies red start, verifies the live Dispatch/dashboard receipt path, and includes cleanup.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: `Ticket`, `TriageDecision`, `normalize_severity`, and `triage` names are consistent across implementation and tests.

