# Codex QA: Autonomous Ship-It Loop

Use this scenario to prove the package-level ship-it lifecycle without needing
live GitHub credentials or a real merge. The deterministic harness creates
temporary Conveyor state, checks that repo side effects fail closed before
permission grants, and checks that a manager continuation cannot reach the
worker until all ship-it evidence exists.

## Scenario

- Template: `ship_it_loop`
- Recipe: `ship-it-loop`
- Permissions: `repo.push_branch`, `repo.open_pr`, `repo.monitor_ci`,
  `repo.resolve_conflicts`, `repo.merge_green_pr`
- Required evidence before closeout: `branch_ready`, `branch_pushed`,
  `pr_url`, `ci_green`, `mergeability_clean`, `manager_merge_decision`,
  `merge`, `post_merge_verification`, `adversarial_check`
- Manager role: verify worker claims, own merge readiness, record the merge
  decision, and stop on bounded conflict retry exhaustion
- Worker role: implement the bounded task, report branch/test/conflict facts,
  and never treat its own completion as merge authority
- Dispatcher role: mechanically enforce permissions and evidence gates

## Commands

```bash
conveyor qa-plan ship-it-loop
conveyor loop-templates --show ship_it_loop --json
conveyor manager-recipes --show ship-it-loop --json
conveyor qa-run ship-it-loop --receipt-output /tmp/ship-it-loop-receipt.json --json
```

## Acceptance Criteria

- `qa-plan ship-it-loop` names the permission boundaries, lifecycle evidence,
  manager-only merge decision, and bounded conflict blocker.
- `loop-templates --show ship_it_loop --json` requires every ship-it evidence
  type before manager-requested continuation can reach the worker.
- `manager-recipes --show ship-it-loop --json` includes the push, PR, CI,
  conflict, and merge permissions as explicit opt-ins.
- The saved `qa-run ship-it-loop` receipt shows denied push, PR, and merge
  commands failed before their permissions were granted.
- The same receipt shows allowed push, PR, and merge commands delivered after
  the manager config grants the matching permission.
- The lifecycle continuation blocks with all required evidence missing, then
  blocks again after partial branch/PR/CI evidence until mergeability, manager
  decision, merge, post-merge, and adversarial proof are recorded.
- Conflict retry exhaustion is recorded as a blocker with retry count, max
  retries, blocked status, and `conflict_retry_limit_reached`.
- No raw secrets, private phone content, archives, IPAs, or unsanitized
  transcripts are written to commits or QA artifacts.

## Real-Work Notes

For a live repo, the manager may grant these permissions only when the operator
has explicitly allowed them for that task. CI green is not a merge decision.
Before merge, the manager must cite fresh checks, mergeability, the exact merge
decision, post-merge verification plan, and the adversarial disproof attempt.
