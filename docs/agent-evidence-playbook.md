# Agent Evidence Playbook

Use this playbook when closing out work in Codex Terminal Manager. The goal is
not to maximize ceremony. The goal is to make completion claims hard to fool.

## Closeout Rule

Before declaring work complete:

1. Name the strongest realistic failure mode for the change.
2. Run or inspect evidence that would expose that failure mode.
3. Report the result in the final handoff.
4. Turn anything still unverified into a blocker or explicit follow-up.

Treat `done`, `tests passed`, worker claims, passing happy-path tests, generated
summaries, and optimistic UI as claims, not proof.

## Evidence Ladder

Pick evidence that matches the risk and surface area of the change.

| Change type | Useful evidence |
| --- | --- |
| Agent instructions or docs | `git diff`, targeted `rg`, direct inspection of changed sections, rendered Markdown when formatting matters |
| Python or CLI behavior | focused command output, focused unit test, `conveyor cycle <task>`, `scripts/rc-check` for broad behavior |
| Dashboard or frontend behavior | `npm run build`, browser inspection, screenshot, visible Dispatch/dashboard state |
| Worker, manager, or Dispatch behavior | `conveyor qa-plan dispatch-completion`, `conveyor qa-run adversarial-triggers --receipt-output /tmp/adversarial-triggers-receipt.json --json`, `conveyor audit <task> --json`, `conveyor replay <task>` |
| Acceptance criteria | `conveyor criteria <task> --list`, satisfied criteria evidence JSON, deferred or rejected criteria rationale |
| PR or ship loop | `conveyor qa-run ship-it-loop --receipt-output /tmp/ship-it-loop-receipt.json --json` for local policy proof; for live work, PR URL, CI-green receipt, mergeability, manager merge decision, merge or main-branch receipt, post-merge verification, final diff inspection, and guarded `codex-review` when requested or when review risk justifies it |

Small documentation edits do not need full release-candidate checks. Broad CLI,
Dispatch, or dashboard changes usually do.

## Recording Proof

Prefer structured receipts when a workflow already has them:

```bash
conveyor criteria <task> --satisfy <id> \
  --evidence-json '{"command":"<command run>","status":"pass","summary":"<what it proved>"}'

conveyor loop-evidence adversarial-check <task> \
  --loop-run <run-id> \
  --iteration <n> \
  --failure-mode "<strongest realistic failure mode>" \
  --check "<command, audit, screenshot, trace, diff, or inspection>" \
  --result "<why the check rules it out or what remains unresolved>"
```

Use `loop-evidence adversarial-check` for gated adversarial workflows. For
ordinary closeout, the final handoff can carry the same fields in prose.

## Final Handoff Shape

Use this compact shape:

```text
Claim: <what is complete>
Disproof attempt: <strongest realistic failure mode>
Evidence: <command, trace, screenshot, audit record, diff inspection, or direct inspection>
Residual risk: <none known, or explicit follow-up/blocker>
```

If a worker or manager claims completion, inspect the evidence behind the claim
before repeating it as fact.
