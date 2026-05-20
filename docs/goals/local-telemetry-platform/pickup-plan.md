# Local Telemetry Platform Pickup Plan

## Why This Handoff Exists

The original worktree at `/Users/neonwatty/Desktop/codex-terminal-manager` became unreadable to command-line tools while the telemetry work was in progress. The visible board copy was preserved under `/Users/neonwatty/goalbuddy-boards/local-telemetry-platform` and is now checked into this branch as the durable handoff.

This PR does not claim that the in-progress local code edits from the blocked Desktop worktree were recovered. It records the GoalBuddy plan, Scout/Judge receipts, the active task, and the exact restart condition so the work can be picked up without losing intent.

## Current Status

- Goal: implement the complete local-only telemetry package for realistic manager/worker QA.
- Board path: `docs/goals/local-telemetry-platform/`.
- Active task: `T003`.
- Active task objective: harden telemetry foundation helpers and validation required by later emitters.
- Blocker: `/Users/neonwatty/Desktop/codex-terminal-manager` still returns `Operation not permitted` for basic shell access.

## Restart Checklist

1. Restore access to the canonical Desktop worktree or explicitly choose this recovery clone as the new canonical worktree.
2. Before editing code, run:

   ```bash
   git status --short --branch
   sed -n '1,120p' docs/goals/local-telemetry-platform/state.yaml
   git diff --stat
   ```

3. If the Desktop worktree becomes readable, inspect and preserve any uncommitted telemetry edits before merging or replacing them.
4. Reconcile this checked-in board with the canonical board if both exist.
5. Continue T003 using the task constraints in `state.yaml`.

## T003 Acceptance Criteria

- `emit_telemetry_event` validates actor and severity before touching SQLite.
- `correlation` and `attributes` must be JSON objects.
- If `run_id` is provided, it resolves to an existing run and infers `task_id` when missing.
- If `task_id` is provided without `run_id`, the helper attaches the active run when one exists.
- If both `run_id` and `task_id` are provided, mismatches fail cleanly.
- FTS rows are inserted and queryable.
- Helper output is stable enough for upcoming CLI/report tasks.
- Replay and export behavior remain unchanged.

## T003 Suggested Verification

```bash
python3 -m unittest tests.test_workerctl.DatabaseTests -v
python3 -m py_compile workerctl/db.py
```

## Full Goal Oracle

The goal is complete only when a recorded realistic manager/worker run has a local telemetry report and export bundle that reconstructs the run end-to-end: pair creation, run identity, manager cycles, decisions, commands, nudges or interruption attempts, captures, transcript segments, handoffs, task completion, errors, durations, and search results, with all verification commands passing.
