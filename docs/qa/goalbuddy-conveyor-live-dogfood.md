# GoalBuddy Conveyor Live Dogfood

Use this smoke after `workerctl qa-plan goalbuddy-conveyor` exists and you want
to verify the conveyor rails with a tiny, repeatable run.

## Shape

Create a parent GoalBuddy board with two child boards:

1. A no-op child that proves the reusable conveyor command is already
   `satisfied_on_main`.
2. A tiny docs or test child that must go through review, PR creation, CI
   monitoring, merge, and parent receipt update.

The parent should have exactly one active child at a time. After the first child
records `satisfied_on_main: true`, activate only the implementation child.

## Commands

Start from the reusable plan:

```bash
scripts/workerctl qa-plan goalbuddy-conveyor
```

Verify board state after each receipt mutation:

```bash
GOALBUDDY_SKILL_DIR=/path/to/goalbuddy-skill
GOALBUDDY_CHECKER="$GOALBUDDY_SKILL_DIR/scripts/check-goal-state.mjs"
node "$GOALBUDDY_CHECKER" docs/goals/<parent>/state.yaml
node "$GOALBUDDY_CHECKER" docs/goals/<parent>/subgoals/<child>/state.yaml
```

For a Codex plugin install, `/path/to/goalbuddy-skill` is the installed
GoalBuddy skill directory under the local Codex plugin cache.

## Failure Mode To Probe

The run fails if the parent activates two child boards at once, marks a child
done without `satisfied_on_main` or PR/CI/merge evidence, or records the final
parent receipt before the implementation child has merged.
