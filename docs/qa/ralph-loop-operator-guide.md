# Ralph loop operator guide

Use this guide when a manager should run a bounded manager/worker loop with Dispatch enforcing the rails. The core rule is:

> The manager asks; Dispatch decides.

The manager can request another worker iteration, but Dispatch blocks delivery unless the loop policy permits it. A blocked continuation must leave the worker inbox empty.

## Natural-language triggers

Use `conveyor loop-triggers --classify "<prompt>" --json` before turning operator prose into loop policy.

Controlled trigger examples:

- `Run this as an adversarially gated Ralph loop.`
- `Do not send the worker another iteration until adversarial proof exists.`
- `Do not mark this done until you have tried to disprove it.`
- `Ask the worker to identify the strongest realistic failure mode and prove it is handled.`
- `Each loop must include adversarial acceptance criteria from manager to worker.`

Generic caution does not arm a loop gate. For example, `be careful, run tests, and summarize risks` is guidance, not permission to create a loop policy.

## Standard operating sequence

For no-tmux managers/workers, create the disposable task/session binding first:

```bash
conveyor create-disposable-binding <task> --worker <worker-session> --manager <manager-session> --template <template> --adversarial --json
```

This writes real Codex rollout JSONL files, registers both sessions, binds them
to the task, and prints replay commands for Dispatch, inbox polling, and
`loop-status`. Use it for Codex app managers/workers that will poll with the
returned `communication.poll_command` instead of receiving tmux keystrokes.

1. Classify the prompt:

   ```bash
   conveyor loop-triggers --classify "Run this as an adversarially gated Ralph loop." --json
   ```

2. Create a template-backed loop run:

   ```bash
   conveyor loop-templates --create-run <task> --template <template> --max-iterations 3 --current-iteration 1 --json
   ```

3. Ask the worker for the first iteration through the normal manager/worker task flow.

4. Record required evidence before another iteration:

   ```bash
   conveyor loop-evidence add <task> --loop-run <run> --iteration 1 --evidence-type <evidence_type> --artifact-path <path>
   conveyor loop-evidence adversarial-check <task> --loop-run <run> --iteration 1 --failure-mode "<risk>" --check "<command or inspection>" --result "<why handled>"
   ```

5. Queue the manager-requested continuation:

   ```bash
   conveyor enqueue-continue-iteration <task> --loop-run <run> --requested-iteration 2 --message "Run the next bounded iteration." --json
   ```

6. Let Dispatch enforce policy:

   ```bash
   conveyor dispatch --once --type continue_iteration --json
   ```

7. For Codex app or no-tmux sessions, poll and consume the inbox with the exact
   generated `communication.poll_command`. It may include a local
   `PATH=.../bin:$PATH conveyor` prefix:

   ```bash
   PATH='/path/to/package/bin':$PATH conveyor worker-inbox <task> --consume-next --wait --timeout 60 --path /path/to/workerctl.db --json
   ```

   Consuming a `continue_iteration` item is the durable "iteration began"
   transition: Conveyor advances the run's `current_iteration` to the requested
   iteration and records `ralph_loop_iteration_advanced` telemetry.

8. Review status and telemetry before continuing:

   ```bash
   conveyor loop-status <task> --run <run> --json
   conveyor telemetry failures --task <task> --json
   ```

`loop-status` is the compact manager review command. A run is ready for review
when failures are zero, blocked attempts are explainable policy blocks, worker
inbox backlog is zero after consumption, `dispatch_inbox_consumed` telemetry is
present for pull-required deliveries, and `ralph_loop_iteration_advanced`
telemetry is present for consumed continuation items.

## Pass bar for real vertical slices

- `max_iterations` is present and blocks over-looping.
- `required_before_continue` is present for quality loops.
- Blocked Dispatch attempts have `state=blocked`, `delivered=false`, and worker inbox count `0`.
- Allowed Dispatch attempts include `run_id`, `loop_policy`, `requested_iteration`, `current_iteration`, `max_iterations`, and `missing_evidence=[]`.
- Worker inbox consumption emits searchable `dispatch_inbox_consumed` telemetry.
- Consumed continuation items emit searchable `ralph_loop_iteration_advanced` telemetry and advance the run's `current_iteration`.
- The final report includes `loop-status`, `telemetry failures`, `audit`, `replay`, PR/CI/merge receipts when relevant, and an adversarial proof record.
