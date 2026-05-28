# T004 Lab Implementation Apply Plan

## Status

`/Users/neonwatty/Desktop/workerctl-dispatch-lab` was not writable in the current sandbox. A write probe failed with:

```text
operation not permitted: .codex-write-probe-22852
```

This is a task-level blocker for applying the scenario, not a reason to stop the goal. Use this note as the direct implementation recipe when the lab repo is available as a writable root.

## Apply Steps

From `/Users/neonwatty/Desktop/workerctl-dispatch-lab`:

1. Update `lab`.
2. Update `README.md`.
3. Add `scenarios/subscription-billing/files/src/dispatch_lab/__init__.py`.
4. Add `scenarios/subscription-billing/files/src/dispatch_lab/billing.py`.
5. Add `scenarios/subscription-billing/files/tests/test_billing.py`.
6. Run:

```bash
bash -n lab
LAB_SCENARIO=subscription-billing ./lab reset --force
.venv/bin/python -m pytest -q
git diff --check
```

The first materialized pytest run should be intentionally red before the worker fixes `src/dispatch_lab/billing.py`.

## `lab` Changes

Usage text:

```diff
-Set LAB_SCENARIO=complex-refactor for the larger order-pricing QA fixture.
+Set LAB_SCENARIO=complex-refactor, support-triage, or subscription-billing for larger QA fixtures.
```

Add this `case "$SCENARIO"` branch after `support-triage)`:

```bash
    subscription-billing)
      task_goal="Fix the failing subscription billing pytest suite in the workerctl Dispatch billing lab."
      task_summary="Advanced manager/worker Dispatch QA loop with subscription invoice, entitlement, credit, and audit behavior."
      task_prompt="You are the worker for the subscription billing Dispatch QA lab. Inspect the failing subscription billing tests, infer the intended plan pricing, seat quantity, credit/refund, entitlement-window, proration, and audit-summary contract, make the smallest coherent implementation changes so .venv/bin/python -m pytest -q passes, run the test, inspect git diff, then finish with a concise final answer containing commands and evidence. There is no workerctl completion command to run."
      manager_objective="Verify the worker fixed the subscription billing pytest suite with receipt-backed evidence, while keeping the diff focused."
      acceptance_args=(
        --manager-acceptance ".venv/bin/python -m pytest -q passes in the lab repo."
        --manager-acceptance "The fix handles plan pricing, seat quantities, prorated upgrades, credits/refunds, entitlement windows, and manager-verifiable audit summary fields."
        --manager-acceptance "git diff is focused on the subscription billing implementation and avoids broad unrelated rewrites."
        --manager-acceptance "Dashboard Dispatch conversation shows a worker receipt consumed by a manager cycle before finish_task succeeds."
      )
      ;;
```

Update `cmd_status` useful commands if desired:

```diff
   LAB_SCENARIO=complex-refactor ./lab reset --force
   LAB_SCENARIO=complex-refactor ./lab qa-start
+  LAB_SCENARIO=subscription-billing ./lab reset --force
+  LAB_SCENARIO=subscription-billing ./lab qa-start
```

## `README.md` Changes

Add after support-triage scenario description:

```markdown
For subscription billing, set `LAB_SCENARIO=subscription-billing`. That fixture
has plan normalization, seat pricing, credit/refund application, prorated
upgrades, entitlement windows, and manager-verifiable audit summaries in a
small billing workflow.
```

Add after the support-triage command:

```markdown
For subscription billing:

```bash
LAB_SCENARIO=subscription-billing ./lab qa-start
```
```

## `scenarios/subscription-billing/files/src/dispatch_lab/__init__.py`

```python
```

## `scenarios/subscription-billing/files/src/dispatch_lab/billing.py`

This baseline is intentionally incomplete.

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


PLAN_PRICES = {
    "starter": 1200,
    "growth": 3500,
    "enterprise": 9000,
}


def normalize_plan(plan: str) -> str:
    return plan.lower()


def plan_price_cents(plan: str) -> int:
    normalized = normalize_plan(plan)
    if normalized not in PLAN_PRICES:
        raise ValueError(f"Unsupported plan: {normalized}")
    return PLAN_PRICES[normalized]


def billing_period_end(billing_day: date) -> date:
    return billing_day + timedelta(days=30)


def remaining_days_in_period(effective_on: date, billing_day: date) -> int:
    return max(0, (billing_period_end(billing_day) - effective_on).days)


def invoice_subscription(change: SubscriptionChange) -> BillingDecision:
    price = plan_price_cents(change.plan)
    invoice_cents = price
    credit_applied_cents = 0
    refund_cents = 0
    entitlement_starts_on = change.effective_on
    entitlement_ends_on = change.effective_on + timedelta(days=30)
    audit_summary = f"account={change.account_id} plan={change.plan} invoice={invoice_cents}"
    return BillingDecision(
        invoice_cents=invoice_cents,
        credit_applied_cents=credit_applied_cents,
        refund_cents=refund_cents,
        entitlement_starts_on=entitlement_starts_on,
        entitlement_ends_on=entitlement_ends_on,
        audit_summary=audit_summary,
    )
```

## `scenarios/subscription-billing/files/tests/test_billing.py`

```python
from datetime import date

import pytest

from dispatch_lab.billing import SubscriptionChange, invoice_subscription, normalize_plan


def test_new_growth_subscription_charges_seats_and_sets_entitlement_window():
    change = SubscriptionChange(
        account_id="acct_growth",
        plan=" Growth ",
        seats=3,
        billing_day=date(2026, 5, 1),
        effective_on=date(2026, 5, 1),
    )

    decision = invoice_subscription(change)

    assert normalize_plan(" Growth ") == "growth"
    assert decision.invoice_cents == 10500
    assert decision.credit_applied_cents == 0
    assert decision.refund_cents == 0
    assert decision.entitlement_starts_on == date(2026, 5, 1)
    assert decision.entitlement_ends_on == date(2026, 5, 31)
    assert "account=acct_growth" in decision.audit_summary
    assert "plan=growth" in decision.audit_summary
    assert "seats=3" in decision.audit_summary
    assert "invoice=10500" in decision.audit_summary
    assert "entitlement=2026-05-01..2026-05-31" in decision.audit_summary


def test_credit_reduces_invoice_without_negative_total():
    change = SubscriptionChange(
        account_id="acct_credit",
        plan="starter",
        seats=2,
        billing_day=date(2026, 5, 1),
        effective_on=date(2026, 5, 1),
        credit_cents=1000,
    )

    decision = invoice_subscription(change)

    assert decision.invoice_cents == 1400
    assert decision.credit_applied_cents == 1000
    assert decision.refund_cents == 0
    assert "credit=1000" in decision.audit_summary


def test_refund_uses_unapplied_credit_when_requested():
    change = SubscriptionChange(
        account_id="acct_refund",
        plan="starter",
        seats=1,
        billing_day=date(2026, 5, 1),
        effective_on=date(2026, 5, 1),
        credit_cents=2000,
        refund_requested=True,
    )

    decision = invoice_subscription(change)

    assert decision.invoice_cents == 0
    assert decision.credit_applied_cents == 1200
    assert decision.refund_cents == 800
    assert "refund=800" in decision.audit_summary


def test_midcycle_upgrade_charges_prorated_delta():
    change = SubscriptionChange(
        account_id="acct_upgrade",
        plan="growth",
        seats=2,
        previous_plan="starter",
        previous_seats=2,
        billing_day=date(2026, 5, 1),
        effective_on=date(2026, 5, 16),
    )

    decision = invoice_subscription(change)

    assert decision.invoice_cents == 2453
    assert decision.credit_applied_cents == 0
    assert decision.refund_cents == 0
    assert decision.entitlement_ends_on == date(2026, 5, 31)


def test_downgrade_creates_refund_without_negative_invoice():
    change = SubscriptionChange(
        account_id="acct_downgrade",
        plan="starter",
        seats=1,
        previous_plan="enterprise",
        previous_seats=1,
        billing_day=date(2026, 5, 1),
        effective_on=date(2026, 5, 16),
        refund_requested=True,
    )

    decision = invoice_subscription(change)

    assert decision.invoice_cents == 0
    assert decision.credit_applied_cents == 0
    assert decision.refund_cents > 0
    assert "refund=" in decision.audit_summary


def test_unknown_plan_and_invalid_seats_raise_clear_errors():
    with pytest.raises(ValueError, match="Unsupported plan: legacy"):
        invoice_subscription(
            SubscriptionChange(
                account_id="acct_legacy",
                plan=" legacy ",
                seats=1,
                billing_day=date(2026, 5, 1),
                effective_on=date(2026, 5, 1),
            )
        )

    with pytest.raises(ValueError, match="seats must be positive"):
        invoice_subscription(
            SubscriptionChange(
                account_id="acct_zero",
                plan="starter",
                seats=0,
                billing_day=date(2026, 5, 1),
                effective_on=date(2026, 5, 1),
            )
        )
```

## Expected Baseline Failures

The intentionally incomplete baseline should fail because it:

- does not strip whitespace in `normalize_plan`;
- ignores seat quantities;
- ignores credits/refunds;
- sets a 30-day rolling entitlement instead of billing-month end;
- does not prorate upgrade/downgrade deltas;
- omits audit fields required by the manager.

## Expected Worker Fix Shape

The future worker should normally need to change only materialized `src/dispatch_lab/billing.py` after `LAB_SCENARIO=subscription-billing ./lab reset --force`.

Likely correct implementation:

- `normalize_plan(plan)` returns `plan.strip().lower()`;
- `invoice_subscription` validates `seats > 0`;
- `billing_period_end` returns the last day of the billing month for this fixture;
- full invoice uses `plan_price_cents(plan) * seats`;
- upgrade/downgrade delta uses previous plan/seats when present;
- proration uses `(delta_cents * remaining_days + 15) // 30`;
- negative deltas become credit/refund rather than negative invoice;
- existing `credit_cents` reduces positive invoice first;
- refund is emitted only when `refund_requested`;
- audit summary includes all required manager-verifiable fields.
