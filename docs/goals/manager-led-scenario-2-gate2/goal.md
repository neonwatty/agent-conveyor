# Manager-Led Scenario 2 Gate 2

## Objective

Unlock or precisely block Gate 2 emergent criteria readiness by running the
full manager-led Scenario 2 variant with a real disposable worker/manager pair.

## Original Request

Set up the next GoalBuddy goal after merging the live emergent-criteria QA PR.
The follow-up should target the recorded Gate 2 gap: proving the manager can
perform the whole emergent acceptance criteria loop without PM mutation help.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Jeremy and future meaningful dogfood runs.
- Authority: `requested`
- Proof type: `artifact`
- Completion proof: A live evidence bundle and `docs/live-qa-log.md` entry show
  whether Gate 2 passed, with a Judge/PM receipt mapping the run to Scenario 2
  and promotion-gate acceptance criteria.
- Likely misfire: The PM thread could again perform the criteria mutations,
  producing useful control-plane evidence while failing to prove manager-led
  behavior.
- Blind spots considered:
  - The manager may need explicit setup answers before it can supervise.
  - The manager may need safe authority to run `criteria-plan` and
    `criteria` commands, but not compact/clear, PR, merge, or product edits.
  - Evidence bundles may leak local paths or session tokens unless scrubbed.
  - A failure may identify a product/helper gap rather than a QA failure.
- Existing plan facts:
  - `docs/superpowers/plans/2026-05-16-dogfood-reliability-ladder.md`
    defines Scenario 2 and Gate 2.
  - `docs/live-qa-log.md` records Gate 1 passed and Gate 2 partial.
  - `docs/goals/dogfood-reliability-ladder/state.yaml` records the exact
    blocker: the manager did not perform the full criteria loop end to end.

## Goal Kind

`existing_plan`

## Current Tranche

Run a full manager-led Scenario 2 Gate 2 QA slice. The PM may start the
disposable pair, persist a narrow manager config, and observe evidence. After
that, the manager session must drive the criteria loop: notice no criteria,
ask the worker for separated must-have/follow-up criteria, run `criteria-plan`,
record accepted/deferred criteria, verify premature audited finish is blocked,
obtain proof, satisfy/defer/reject criteria, replay/export evidence, and finish
with cleanup.

## Non-Negotiable Constraints

- Do not use the app for meaningful project work.
- Keep the worker status-only: no tracked product edits.
- PM must not perform criteria add/satisfy/defer/reject mutations unless a
  stop condition has already triggered and the action is only for cleanup.
- The manager may use only `workerctl` task/session commands.
- Do not allow compact/clear, PR creation, merge, or destructive cleanup.
- Every important command/result must be recorded in the evidence bundle.
- Scrub evidence before packaging if it contains session tokens or private
  absolute paths.
- Stop on unexpected tracked product-file drift, missing manager context,
  unsafe manager behavior, criteria mutation by the wrong actor, or cleanup
  that would require destructive tmux/git recovery.

## Stop Rule

Stop only when a final Judge/PM audit proves one of:

- Gate 2 passed with real manager-led end-to-end criteria negotiation and
  closure evidence; or
- Gate 2 remains blocked and the exact missing behavior, tool limitation, or
  unsafe action is recorded with evidence.

Do not stop after pair creation, first cycle, planning, or partial manager
behavior if safe live QA can continue.

## Canonical Board

Machine truth lives at:

`docs/goals/manager-led-scenario-2-gate2/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/manager-led-scenario-2-gate2/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available.
4. Work only on the active board task.
5. Preserve evidence before mutating board state.
6. Keep PM activity out of the manager-led criteria loop except setup,
   observation, audit, packaging, and emergency cleanup.
7. Write compact task receipts.
8. Finish only with a Judge/PM audit receipt that maps evidence back to Gate 2.
