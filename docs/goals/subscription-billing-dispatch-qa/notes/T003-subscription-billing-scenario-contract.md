# T003 Subscription Billing Scenario Contract

## Purpose

Create a harder resettable Dispatch QA fixture in `/Users/neonwatty/Desktop/workerctl-dispatch-lab` named `subscription-billing`. The scenario should be complex enough to exercise worker reasoning and manager verification, but small enough that a focused worker can fix it in one pass and the dashboard can still make Dispatch evidence easy to see.

The scenario is not complete until it has been run through the dashboard and the dashboard shows Dispatch chain evidence, not just pane text.

## Lab Files To Add Or Edit

When the lab repo is writable, the implementation Worker should edit only:

- `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
- `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`
- `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/subscription-billing/files/src/dispatch_lab/billing.py`
- `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/subscription-billing/files/src/dispatch_lab/__init__.py`
- `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/subscription-billing/files/tests/test_billing.py`

The materialized root files `src/dispatch_lab/billing.py` and `tests/test_billing.py` should be created only by `LAB_SCENARIO=subscription-billing ./lab reset --force`.

## Runner Wiring

Add a new `subscription-billing` case in `cmd_start` with:

- `task_goal`: `Fix the failing subscription billing pytest suite in the workerctl Dispatch billing lab.`
- `task_summary`: `Advanced manager/worker Dispatch QA loop with subscription invoice, entitlement, credit, and audit behavior.`
- `task_prompt`: worker should inspect failing tests, infer the subscription billing contract, make the smallest coherent changes so `.venv/bin/python -m pytest -q` passes, run tests, inspect diff, and finish with concise commands/evidence. No workerctl completion command.
- `manager_objective`: verify the worker fixed subscription billing with receipt-backed evidence while keeping the diff focused.

Acceptance criteria:

1. `.venv/bin/python -m pytest -q` passes in the lab repo.
2. The fix handles plan pricing, seat quantities, prorated upgrades, credits/refunds, entitlement windows, and manager-verifiable audit summary fields.
3. `git diff` is focused on the subscription billing implementation and avoids broad unrelated rewrites.
4. Dashboard Dispatch conversation shows a worker receipt consumed by a manager cycle before `finish_task` succeeds.

Also update usage/help and README scenario docs so `LAB_SCENARIO=subscription-billing ./lab qa-start` is first-class.

## Intentionally Red Baseline

`billing.py` should start with plausible but incomplete implementation bugs. The worker should need to infer the contract from tests rather than make a one-line fix.

Recommended initial data model:

```python
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class SubscriptionChange:
    account_id: str
    plan: str
    seats: int
    billing_day: date
    effective_on: date
    previous_plan: str | None = None
    previous_seats: int = 0
    credit_cents: int = 0
    refund_requested: bool = False


@dataclass(frozen=True)
class BillingDecision:
    invoice_cents: int
    credit_applied_cents: int
    refund_cents: int
    entitlement_starts_on: date
    entitlement_ends_on: date
    audit_summary: str
```

Recommended buggy behavior:

- prices only by plan, ignoring seats;
- credits are ignored or applied after total incorrectly;
- refunds always zero;
- entitlement end date is always `effective_on + timedelta(days=30)` instead of tied to billing period;
- prorated upgrade is treated as full-price new invoice;
- audit summary omits manager-verifiable fields.

## Required Contract

Suggested production API:

```python
def normalize_plan(plan: str) -> str: ...
def plan_price_cents(plan: str) -> int: ...
def billing_period_end(billing_day: date) -> date: ...
def remaining_days_in_period(effective_on: date, billing_day: date) -> int: ...
def invoice_subscription(change: SubscriptionChange) -> BillingDecision: ...
```

Rules:

- Plans normalize case and whitespace.
- Supported plans: `starter`, `growth`, `enterprise`.
- Monthly per-seat prices:
  - `starter`: 1200
  - `growth`: 3500
  - `enterprise`: 9000
- Unknown plans raise `ValueError("Unsupported plan: <plan>")`.
- Seat count must be positive.
- Base invoice is `plan_price_cents(plan) * seats`.
- `credit_cents` applies against invoice and cannot make invoice negative.
- Refund is generated only when `refund_requested` is true and unapplied credit remains after invoice reduction.
- Entitlement starts on `effective_on`.
- Entitlement ends on the day before the next billing day, preserving monthly boundaries.
- Upgrades inside an active billing period charge a prorated delta for remaining days when `previous_plan` or `previous_seats` is present.
- Proration uses a 30-day denominator and rounds to nearest cent with integer arithmetic: `(delta_cents * remaining_days + 15) // 30`.
- Downgrades should not create negative invoices; remaining negative delta becomes credit/refund according to credit/refund rules.
- Audit summary must contain fields a manager can verify from the dashboard receipt:
  - `account=<account_id>`
  - `plan=<normalized_plan>`
  - `seats=<seats>`
  - `invoice=<invoice_cents>`
  - `credit=<credit_applied_cents>`
  - `refund=<refund_cents>`
  - `entitlement=<YYYY-MM-DD>..<YYYY-MM-DD>`

## Test Cases

`tests/test_billing.py` should include around six focused tests:

1. `test_new_growth_subscription_charges_seats_and_sets_entitlement_window`
   - plan `" Growth "`, seats `3`, billing day `2026-05-01`, effective `2026-05-01`
   - invoice `10500`
   - entitlement `2026-05-01` through `2026-05-31`
   - summary includes account, plan, seats, invoice, entitlement.

2. `test_credit_reduces_invoice_without_negative_total`
   - starter, seats `2`, credit `1000`
   - invoice after credit `1400`
   - credit applied `1000`
   - refund `0`.

3. `test_refund_uses_unapplied_credit_when_requested`
   - starter, seats `1`, credit `2000`, refund requested true
   - invoice `0`
   - credit applied `1200`
   - refund `800`.

4. `test_midcycle_upgrade_charges_prorated_delta`
   - previous starter 2 seats to growth 2 seats, billing day `2026-05-01`, effective `2026-05-16`
   - full delta `(3500 - 1200) * 2 = 4600`
   - remaining days `16`
   - prorated invoice `(4600 * 16 + 15) // 30 = 2453`.

5. `test_downgrade_creates_credit_or_refund_without_negative_invoice`
   - previous enterprise 1 seat to starter 1 seat midcycle, refund requested true
   - invoice `0`
   - refund is positive and summary includes refund.

6. `test_unknown_plan_and_invalid_seats_raise_clear_errors`
   - unsupported plan error includes the original normalized unsupported value.
   - zero seats raises `ValueError("seats must be positive")`.

The initial baseline should fail most or all of these tests. After the worker fix, `.venv/bin/python -m pytest -q` should pass.

## Verification Commands

Before implementation:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git status --short
bash -n lab
LAB_SCENARIO=subscription-billing ./lab reset --force
.venv/bin/python -m pytest -q
```

The pre-fix pytest command should be intentionally red.

After implementation:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
bash -n lab
LAB_SCENARIO=subscription-billing ./lab reset --force
.venv/bin/python -m pytest -q
git diff --check
```

For dashboard QA:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=subscription-billing ./lab qa-start
./lab cycle
```

Then wait for the worker to complete, run another `./lab cycle`, and confirm dashboard evidence:

- Dispatch core active.
- `worker_task_complete` delivered.
- Source event id visible.
- Manager cycle id visible and explicitly shown as consumed.
- Worker receipt contains final `.venv/bin/python -m pytest -q` pass evidence.
- `finish_task` succeeds only after the manager cycle consumes the routed fact.
- Task state is `done`.
- All accepted criteria are satisfied.

Cleanup:

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
```

## Stop Conditions For Lab Implementation

Stop and report instead of improvising if:

- reset removes committed scenario files;
- the scenario needs product code changes before it can run;
- baseline is green before the worker fixes anything;
- dashboard shows worker pane completion but no Dispatch chain;
- manager cycle does not consume the routed notification;
- cleanup leaves active dashboard, worker, or manager sessions;
- sandbox cannot write `/Users/neonwatty/Desktop/workerctl-dispatch-lab`.

## Expected Commit Shape

In the lab repo, the final commit should contain only:

- `README.md`
- `lab`
- `scenarios/subscription-billing/files/src/dispatch_lab/__init__.py`
- `scenarios/subscription-billing/files/src/dispatch_lab/billing.py`
- `scenarios/subscription-billing/files/tests/test_billing.py`

If product fixes are needed, they should be committed separately in `/Users/neonwatty/Desktop/codex-terminal-manager` and verified with the relevant product tests before another lab QA run.
