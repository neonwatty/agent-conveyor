# Ralph loop operator guide

Use this guide when a manager should run a bounded manager/worker loop with Dispatch enforcing the rails. The core rule is:

> The manager asks; Dispatch decides.

The manager can request another worker iteration, but Dispatch blocks delivery unless the loop policy permits it. A blocked continuation must leave the worker inbox empty.

## Natural-language triggers

Use `scripts/workerctl loop-triggers --classify "<prompt>" --json` before turning operator prose into loop policy.

Controlled trigger examples:

- `Run this as an adversarially gated Ralph loop.`
- `Do not send the worker another iteration until adversarial proof exists.`
- `Do not mark this done until you have tried to disprove it.`
- `Ask the worker to identify the strongest realistic failure mode and prove it is handled.`
- `Each loop must include adversarial acceptance criteria from manager to worker.`

Generic caution does not arm a loop gate. For example, `be careful, run tests, and summarize risks` is guidance, not permission to create a loop policy.

## Standard operating sequence

1. Classify the prompt:

   ```bash
   scripts/workerctl loop-triggers --classify "Run this as an adversarially gated Ralph loop." --json
   ```

2. Create a template-backed loop run:

   ```bash
   scripts/workerctl loop-templates --create-run <task> --template <template> --max-iterations 3 --current-iteration 1 --json
   ```

3. Ask the worker for the first iteration through the normal manager/worker task flow.

4. Record required evidence before another iteration:

   ```bash
   scripts/workerctl loop-evidence add <task> --loop-run <run> --iteration 1 --evidence-type <evidence_type> --artifact-path <path>
   scripts/workerctl loop-evidence adversarial-check <task> --loop-run <run> --iteration 1 --failure-mode "<risk>" --check "<command or inspection>" --result "<why handled>"
   ```

5. Queue the manager-requested continuation:

   ```bash
   scripts/workerctl enqueue-continue-iteration <task> --loop-run <run> --requested-iteration 2 --message "Run the next bounded iteration." --json
   ```

6. Let Dispatch enforce policy:

   ```bash
   scripts/workerctl dispatch --once --type continue_iteration --json
   ```

7. For Codex app or no-tmux sessions, poll and consume the inbox:

   ```bash
   scripts/workerctl worker-inbox <task> --consume-next --wait --timeout 30 --json
   ```

8. Review status and telemetry before continuing:

   ```bash
   scripts/workerctl loop-status <task> --run <run> --json
   scripts/workerctl telemetry failures --task <task> --json
   ```

`loop-status` is the compact manager review command. A run is ready for review
when failures are zero, blocked attempts are explainable policy blocks, worker
inbox backlog is zero after consumption, and `dispatch_inbox_consumed` telemetry
is present for pull-required deliveries.

## Pass bar for real vertical slices

- `max_iterations` is present and blocks over-looping.
- `required_before_continue` is present for quality loops.
- Blocked Dispatch attempts have `state=blocked`, `delivered=false`, and worker inbox count `0`.
- Allowed Dispatch attempts include `run_id`, `loop_policy`, `requested_iteration`, `current_iteration`, `max_iterations`, and `missing_evidence=[]`.
- Worker inbox consumption emits searchable `dispatch_inbox_consumed` telemetry.
- The final report includes `loop-status`, `telemetry failures`, `audit`, `replay`, PR/CI/merge receipts when relevant, and an adversarial proof record.
