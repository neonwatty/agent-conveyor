# Adversarial Trigger QA

This QA plan proves that natural-language manager prompts drive the operational
adversarial gates, not just the general burden-of-proof guidance.

Run the generated plan first:

```bash
conveyor qa-plan adversarial-triggers
conveyor qa-plan adversarial-triggers --json
conveyor loop-triggers --classify "Run this as an adversarially gated Ralph loop." --json
conveyor qa-run adversarial-triggers \
  --receipt-output /tmp/adversarial-triggers-receipt.json \
  --json
```

Use `loop-triggers --classify` before automatically creating a loop policy or
continuation gate from manager/operator prose. Only matched controlled trigger
phrases should arm operational gates. Generic caution such as "be careful, run
tests, and summarize the risks" remains ordinary guidance and must not create a
Ralph-loop policy, enqueue a continuation, or require finish gates by itself.

The executable `qa-run adversarial-triggers` receipt proves the full controlled
path: prompt classification, no-tmux manager/worker continuation delivery,
blocked Dispatch before structured proof, fresh retry delivery after proof,
`finish-task --require-adversarial-proof`, worker-proposed proof recording, and
manager-created adversarial acceptance criteria.

## Trigger Scenarios

Use disposable tasks and a disposable `WORKERCTL_DB` for each scenario.

- `Run this as an adversarially gated Ralph loop.`
  The manager must create or use a Ralph-loop policy whose
  `required_before_continue` includes `adversarial_check`.
- `Do not send the worker another iteration until adversarial proof exists.`
  Dispatch must block `continue_iteration` before worker delivery until
  structured `loop-evidence adversarial-check` proof exists.
- `Do not mark this done until you have tried to disprove it.`
  The manager must use `finish-task --require-adversarial-proof`; the finish
  attempt must fail before structured proof and succeed after proof.
- `Ask the worker to identify the strongest realistic failure mode and prove it
  is handled.`
  The worker must return `failure_mode`, `check`, and `result`, and the manager
  must record them as `loop-evidence adversarial-check --source worker_proposed`.
- `Each loop must include adversarial acceptance criteria from manager to
  worker.`
  The manager must create `manager_inferred` accepted criteria naming negative
  Dispatch/evidence checks, then satisfy them only with audit, replay, command,
  inbox, and loop-evidence receipts.

## Pass Bar

A run passes when audit/replay/commands/export evidence can reconstruct:

1. Natural-language prompt.
2. Created loop policy or manager-created criteria.
3. Blocked Dispatch attempt or failed finish gate before proof.
4. Structured adversarial proof with non-empty `failure_mode`, `check`, and
   `result`.
5. Fresh allowed retry or final finish after proof.

Generic prose, worker claims, `tests passed` text, and generic
`loop-evidence add --evidence-type adversarial_check` without structured
metadata do not satisfy this QA.
