# Local Telemetry Platform

## Objective

Implement the complete local-only telemetry package for realistic manager/worker QA: automatic instrumentation, query/report surfaces, exportable evidence bundles, documentation, and one recorded realistic end-to-end drill proving the system can reconstruct what happened.

## Original Request

"Let's make a plan to implement the entire thing. I want to do this all in one Goal Buddy Prep Board."

## Goal Oracle

The oracle for this goal is:

`A recorded realistic manager/worker run has a local telemetry report and export bundle that reconstructs the run end-to-end: pair creation, run identity, manager cycles, decisions, commands, nudges/interruption attempts, captures, transcript segments, handoffs, task completion, errors, durations, and search results, with all verification commands passing.`

## Canonical Board

The canonical board files are in the repo at:

`docs/goals/local-telemetry-platform/`

This branch preserves the board after the original Desktop worktree became unreadable to command-line tools. If that worktree is restored, reconcile any uncommitted local telemetry code before continuing.

## Run Command

```text
/goal Follow docs/goals/local-telemetry-platform/goal.md.
```
