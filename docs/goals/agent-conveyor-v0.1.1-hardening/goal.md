# Agent Conveyor v0.1.1 Hardening

## Outcome

Prepare the next patch release after the npm `0.1.0` shipment by hardening the
release path and smoothing first-run friction without destabilizing the newly
published package.

The goal is complete only when the board records evidence for:

- npm Trusted Publishing workflow readiness and the exact remaining npm-side
  trust configuration, if CLI auth cannot configure it directly;
- a real public-package smoke beyond `--help`;
- local workspace/path cleanup after the repo rename;
- a decision on Node SQLite warning handling;
- docs polish for install, release, and post-publish operations;
- a final v0.1.1 scope recommendation with tests and release gates named.

## Non-Goals

- Do not publish `0.1.1` from this board unless the operator explicitly asks.
- Do not rewrite or move the existing PyPI `v0.1.0` release tag.
- Do not delete unmerged branches or untracked user docs without direct
  evidence that they are disposable generated artifacts.
- Do not weaken `scripts/release-check`, package smoke, migration audit, or
  prepublish guard behavior.

## Oracle

The PM should keep comparing task receipts to this oracle:

`A future maintainer can cut v0.1.1 from GitHub Actions with npm Trusted Publishing or knows the precise remaining auth step; a fresh clone exists at the renamed repo path; generated local artifacts are cleaned without losing user work; a public-package disposable workflow smoke passes; and the v0.1.1 board lists bounded polish tasks with verification commands.`

Planning alone is not enough. A final audit must map receipts and verification
back to the oracle and record `full_outcome_complete: true` or list exact
blockers.

## Board

`docs/goals/agent-conveyor-v0.1.1-hardening/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status,
active task, receipts, verification freshness, and completion truth.

