# Conveyor Closeout Criteria Hygiene

## Objective

Plan and execute a bounded Conveyor hardening tranche so manager closeout proof is kept out of blocking task acceptance criteria, while preserving legitimate Conveyor QA cases that intentionally test `finish-task`.

## Original Request

Plan out, with GoalBuddy prep, whether the lesson from dogfood needs package or skill work: avoid self-referential criteria like "prove finish-task works" as open acceptance criteria, and put closeout proof in the manager final report instead.

## Intake Summary

- Input shape: `specific`
- Audience: Conveyor maintainers and operators running manager-worker loops.
- Authority: `requested`
- Proof type: `test`
- Completion proof: A final audit shows the package, docs, and skill guidance prevent or warn on closeout-mechanics criteria without breaking legitimate Conveyor QA, with targeted tests and direct inspection receipts.
- Goal oracle: `npm test -- --runInBand src/cli/typescript-runtime.test.ts` or the narrower current test command selected by Scout/Judge, plus direct inspection proving generated prompts/docs separate task acceptance criteria from manager final closeout proof.
- Likely misfire: The run adds vague documentation but does not change generated prompts, criteria-plan behavior, or recipe metadata, so future manager-worker sessions can still seed self-referential blocking criteria.
- Blind spots considered: legitimate Conveyor QA may need to test `finish-task`; installed user skill text may differ from packaged skill source; a hard blocker could reject valid manager-inferred acceptance criteria; docs-only changes may not affect app-visible dogfood prompts.
- Existing plan facts:
  - Package should likely add a warning or classifier for closeout-mechanics criteria rather than a hard `finish-task` blocker.
  - Manager recipes or generated prompts should expose final-report or closeout-proof requirements separately from acceptance criteria.
  - The `manage-codex-workers` skill should instruct managers to reject/defer worker-proposed closeout mechanics as criteria and record closeout proof in final handoff.
  - Worker-facing prompts should continue to say workers do not call `conveyor finish-task`.

## Goal Oracle

The oracle for this goal is:

`A receipt-backed implementation where generated Conveyor setup guidance, criteria planning, and skill/docs all separate worker/task acceptance criteria from manager closeout proof, verified by targeted tests and direct text inspection.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a clean-looking board, or a docs-only patch is not enough if generated prompts or package behavior still allow the dogfood failure mode.

## Goal Kind

`specific`

## Current Tranche

Complete one coherent hardening tranche: discover the exact package and skill surfaces, implement the smallest useful guardrails, verify with targeted tests and inspection, and finish with an audit that explicitly tries to disprove the fix.

## Non-Negotiable Constraints

- Do not edit unrelated product behavior or Foil iOS code.
- Do not turn closeout criteria hygiene into a hard universal blocker; legitimate Conveyor QA may intentionally test `finish-task`.
- Keep acceptance criteria focused on worker/task outcomes.
- Treat manager closeout proof as final handoff, audit, replay, epilogue, or final-report evidence, not as a blocking worker criterion.
- Preserve existing Conveyor CLI semantics unless a test proves a behavior change is intentional.
- Follow `docs/agent-evidence-playbook.md` before declaring the tranche complete.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

For this tranche, the preferred Worker package is one coherent patch covering the generated prompt/docs/test surface selected by Judge. Split only if Scout finds materially different ownership boundaries or risky behavior changes.

## Canonical Board

Machine truth lives at:

`docs/goals/conveyor-closeout-criteria-hygiene/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/conveyor-closeout-criteria-hygiene/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake: original request, input shape, authority, proof, blind spots, existing plan facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless blocked.
10. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.
