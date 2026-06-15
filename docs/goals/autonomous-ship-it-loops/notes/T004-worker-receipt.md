# T004 Worker Receipt - Ship-It Operator Docs And Skill Prompts

Completed: 2026-06-15T16:03:17Z

## Summary

Updated operator-facing docs and the repo skill prompt so "ship it" resolves to
an explicit `ship-it-loop` recipe with `ship_it_loop` lifecycle evidence, not
an implicit merge instruction. The skill now names the recipe, requires
operator-confirmed repo side-effect permissions, and preserves manager-only
merge readiness.

## Changed Files

- `README.md`
- `docs/agent-evidence-playbook.md`
- `docs/manager-recipes.md`
- `docs/manual-qa-checklist.md`
- `docs/qa/README.md`
- `docs/qa/ship-it-loop.md`
- `skills/manage-codex-workers/SKILL.md`
- `docs/goals/autonomous-ship-it-loops/state.yaml`
- `docs/goals/autonomous-ship-it-loops/notes/T004-worker-receipt.md`

## Evidence

- `npm test -- --runInBand`
  - Passed 178 tests.
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/autonomous-ship-it-loops/state.yaml`
  - Passed with `ok=true` before receipt update.
- `git diff --check`
  - Passed.
- `rg -n "ship-it-loop|ship_it_loop|repo.push_branch|repo.monitor_ci|repo.resolve_conflicts|manager_merge_decision|qa-run ship-it-loop" ...`
  - Found the new recipe, template, permission, manager decision, and QA
    receipt language in the skill, README, recipe docs, QA docs, manual
    checklist, and evidence playbook.

## Disproof Attempt

Strongest realistic failure mode: future Codex manager/worker setup prompts
could still interpret "merge when green" as permission to merge based only on
CI or worker claims.

Evidence against it: targeted inspection found `ship-it-loop` guidance in
`skills/manage-codex-workers/SKILL.md` requiring explicit operator confirmation
for `repo.push_branch`, `repo.open_pr`, `repo.monitor_ci`,
`repo.resolve_conflicts`, and `repo.merge_green_pr`; it also requires fresh CI,
mergeability, manager merge decision, merge receipt, post-merge verification,
and adversarial proof before merge.

## Residual Risk

The repo skill copy is updated. The installed skill under the user's Codex skill
directory is a separate deployment surface and should be reconciled by the
release/install step after this branch is merged.
