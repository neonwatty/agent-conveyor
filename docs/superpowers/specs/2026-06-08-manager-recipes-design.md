# Manager Recipes Design

## Purpose

Agent Conveyor should present a small set of common manager recipes instead of
making new users assemble modes, permissions, loop templates, evidence gates,
and cleanup policies from individual commands.

The setup conversation may stay natural and freeform, but before the manager is
cut loose it must resolve to either one named recipe or an explicit custom
configuration. The manager then saves the resulting settings with
`conveyor manager-config`, records any required loop run or handoff state, and
summarizes what it is allowed to do.

The recipes should be available both as documentation and as CLI-readable
metadata through `conveyor manager-recipes --list|--show RECIPE [--json]` so
setup prompts, docs, and future landing-page content can rely on the same
recipe names and settings.

## First Recipes

- **GoalBuddy Conveyor**: split broad work into one parent board and sequential
  child GoalBuddy boards. Work one child at a time and require PR/CI/merge,
  `satisfied_on_main`, or blocker receipts before moving on.
- **Test Coverage Loop**: ask the worker to improve or prove test coverage.
  Require coverage evidence and structured adversarial proof before the next
  pass.
- **UX Polish Loop**: ask the worker to iterate on visible quality. Require
  screenshot/browser/visual-diff evidence and structured adversarial proof
  before another visual pass.
- **Nudge / What's Next Manager**: observe, ask status questions, negotiate
  acceptance criteria, and keep permissions minimal.
- **PR/CI/Merge Ralph Loop**: manage delivery through PR readiness, CI
  monitoring/fixes, green merge, handoff, and worker compact/clear.

Two support patterns should be documented with the recipes:

- **Inbox / No-Tmux App Loop**: use `manager-inbox` and `worker-inbox` when
  manager or worker sessions cannot receive tmux pushes.
- **Recovery / Resume / Handoff**: use saved configuration, handoffs, replay,
  audit, and telemetry to resume a managed task safely.

## Setup Contract

Every manager setup should end with a locked summary:

```text
Selected recipe: GoalBuddy Conveyor
Mode: strict
Permissions: repo.open_pr, repo.merge_green_pr, worker_session.compact
Tools: verification.run_tests, context.fetch_prs
Epilogues: draft-pr, record-handoff
Cleanup: compact between child boards after saved handoff
Evidence gates: child receipt, focused verification, adversarial review, PR/CI/merge or satisfied_on_main
Not allowed: merge without green CI; compact/clear before handoff; run two child boards at once
User confirmed: yes
```

The manager must be able to answer:

1. Which recipe was selected?
2. Which permissions are granted?
3. Which actions are disallowed?
4. Which evidence gates block continuation or finish?
5. Whether compact or clear is enabled, and when it is allowed.

The CLI recipe metadata should include the display name, mode, permissions,
tools, epilogues, evidence gates, cleanup policy, disallowed actions, optional
loop template, suggested `manager-config` command, and locked setup summary
template.

## Database And Reporting

The documentation should describe the control database as the audit surface,
not as incidental implementation detail. Useful tables include
`manager_configs`, `tasks`, `sessions`, `bindings`, `commands`,
`command_attempts`, `routed_notifications`, `manager_cycles`,
`acceptance_criteria`, `worker_handoffs`, `runs`, `telemetry_events`, and
transcript/capture tables.

These records let users and maintainers reconstruct why a manager nudged,
continued, blocked, compacted, cleared, opened a PR, or finished. They also
turn dogfooding into product feedback: repeated PATH problems, stale Dispatch,
unclear setup prompts, missing handoffs, noisy completion signals, or overly
permissive recipes become visible issues instead of lost chat context.
