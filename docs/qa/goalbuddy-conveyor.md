# GoalBuddy Conveyor QA

Use this when a manager should drive a broad body of work through sequential
GoalBuddy child boards instead of a single flat task list.

## Trigger

The canonical natural-language trigger is:

```text
Create an autonomous GoalBuddy conveyor for this project.
```

The manager should translate that into one parent conveyor board and
vertical-slice child boards. Only one child may be active at a time.

## Required Proof

- Parent board records the child queue, the active child, and the final oracle.
- Each child records completion proof, verification commands, and adversarial
  review before PR creation or completion.
- Each implemented child records PR URL, CI result, merge SHA, and parent
  handoff after merge.
- A child already satisfied on main is recorded as `satisfied_on_main` only
  after code evidence and focused tests prove it.
- Failed CI is handled by log inspection, fixes, push, and re-monitoring.
- Parent and child GoalBuddy state checkers pass after each receipt mutation.

## Reusable Plan

Run:

```bash
scripts/workerctl qa-plan goalbuddy-conveyor
```

For machine-readable output:

```bash
scripts/workerctl qa-plan goalbuddy-conveyor --json
```

The plan includes the starter prompt, authority boundaries, acceptance
criteria, correlation markers, expected observations, and negative QA checks.
