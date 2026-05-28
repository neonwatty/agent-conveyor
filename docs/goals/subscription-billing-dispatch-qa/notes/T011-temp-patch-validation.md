# T011 Temporary Patch Validation

## Purpose

Validate the subscription-billing lab patch without writing to `/Users/neonwatty/Desktop/workerctl-dispatch-lab`, because the live lab repo is still blocked by the sandbox.

## Commands

```bash
rm -rf /tmp/workerctl-dispatch-lab-subscription-qa
cp -R /Users/neonwatty/Desktop/workerctl-dispatch-lab /tmp/workerctl-dispatch-lab-subscription-qa
cd /tmp/workerctl-dispatch-lab-subscription-qa
git apply --recount /Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/subscription-billing-dispatch-qa/notes/T009-subscription-billing-lab.patch
git status --short
bash -n lab
LAB_SCENARIO=subscription-billing ./lab reset --force
.venv/bin/python -m pytest -q
git diff --check
find scenarios/subscription-billing -type f | sort
```

## Result

The patch applied in the temporary lab copy, `bash -n lab` passed, reset recognized and applied the new `subscription-billing` scenario, and pytest produced the expected intentionally red baseline:

```text
Applied scenario: subscription-billing
6 failed in 0.02s
```

The failures cover the intended contract gaps:

- plan normalization does not strip whitespace;
- seat quantities are ignored;
- credits are ignored;
- refunds are ignored;
- midcycle upgrade proration is wrong;
- downgrade/refund handling is wrong;
- unsupported plan errors preserve whitespace, so the clear-error contract fails.

`git diff --check` passed in the temporary copy.

The scenario files present after patch application:

```text
scenarios/subscription-billing/files/src/dispatch_lab/__init__.py
scenarios/subscription-billing/files/src/dispatch_lab/billing.py
scenarios/subscription-billing/files/tests/test_billing.py
```

## Environment Note

During `LAB_SCENARIO=subscription-billing ./lab reset --force`, `uv` reported:

```text
Failed to initialize cache at `/Users/neonwatty/.cache/uv`
Operation not permitted
```

The existing `.venv` was still sufficient for pytest to run. A future writable lab run should either have normal `uv` cache access or set `UV_CACHE_DIR` to a writable temp cache if the same environment restriction appears.

## Completion Impact

This proves the patch artifact is usable and the scenario baseline is intentionally red. It does not satisfy the goal oracle yet because the live lab repo still needs the scenario applied, committed, pushed, and exercised through the dashboard with Dispatch evidence.
