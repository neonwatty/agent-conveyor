# Dispatch Issue Hygiene: #114-#117

Date: 2026-05-23

## Scope

Documentation and issue-hygiene pass only. No workerctl code, dashboard code,
or tests were edited.

## Current State Summary

- #114 worker/manager acks: implemented by #118. The CLI exposes
  `worker-ack` and `manager-ack`; acknowledgements are revisioned, visible in
  cycle context and replay/audit, and can gate `cycle`/`finish-task` when
  required.
- #115 categorized permissions: implemented by #118. `manager-config --permit`
  stores categorized taxonomy permissions, `--tool` records expected tools,
  `manager-permission` checks/list categories, and legacy flat permissions are
  accepted through compatibility aliases.
- #116 epilogue gates: implemented by #118. `manager-config --epilogue`,
  `workerctl epilogue`, `epilogue_runs`, replay/audit visibility, and
  `finish-task --require-epilogue` are present. `subagent-review` requires a
  recorded continuation review.
- #117 dual continuation review: mostly implemented by #118. The repo has
  `task_continuations`, `continuation_reviews`, `workerctl continuation`,
  worker-first ordering, manager read redaction before manager submission,
  `context.spawn_reviewer` permission gating, reviewer-isolation metadata, and
  divergent operator-routing metadata. The CLI records and validates reviewer
  output; it does not spawn the independent reviewer session itself.

## Recommendations

- Close #114 as implemented.
- Close #115 as implemented.
- Close #116 as implemented.
- Split #117: close the persistence/gating/redaction/replay portion as
  implemented, and open a focused follow-up for actual independent reviewer
  spawning/runner integration before considering the full original automation
  complete.

## Suggested Commands

```bash
gh issue comment 114 --body "Implemented by #118 and now documented in README.md: first-class worker/manager acknowledgement records, revisioned reads, cycle/replay/audit exposure, bootstrap guidance, and require-ack gates for cycle/finish-task. Recommend closing."
gh issue close 114 --comment "Closing as implemented by #118. README.md now documents the current ack commands and gates."

gh issue comment 115 --body "Implemented by #118 and now documented in README.md: categorized manager permissions via --permit, repeatable --tool, manager-permission checks/lists, cycle exposure, and legacy flat-permission compatibility. Recommend closing."
gh issue close 115 --comment "Closing as implemented by #118. README.md now documents the categorized permission taxonomy and legacy aliases."

gh issue comment 116 --body "Implemented by #118 and now documented in README.md: repeatable --epilogue, epilogue_runs, workerctl epilogue --step/--list/--status, replay/audit visibility, and finish-task --require-epilogue. Recommend closing."
gh issue close 116 --comment "Closing as implemented by #118. README.md now documents epilogue commands and finish gating."

gh issue comment 117 --body "The core persistence and gating pieces landed in #118 and are now documented in README.md: task_continuations, continuation_reviews, worker-first ordering, manager read redaction, context.spawn_reviewer permission gating, reviewer-isolation metadata validation, divergent routing metadata, replay visibility, and subagent-review epilogue integration. One part of the original issue should be split out before closing the full automation loop: workerctl records and validates reviewer output, but does not spawn the independent reviewer session itself. Recommended follow-up: add a reviewer runner/spawn command that launches an isolated read-only reviewer, feeds it only the allowed context, captures subagent_run metadata, and submits the structured continuation review."
gh issue create --title "Add independent continuation reviewer runner" --body "Follow-up split from #117. The current implementation persists and validates continuation reviews, enforces worker-first ordering, redacts manager reads until manager submission, gates review with context.spawn_reviewer, validates reviewer-isolation metadata, and exposes the result in replay/epilogue. Remaining work: add a reviewer runner/spawn command that launches an isolated read-only reviewer session, feeds it only the allowed context (paired proposals, accepted criteria, relevant diff/PR context, no manager rollout), captures subagent_run metadata including reviewer_session_id and manager_rollout_access=false, submits the structured continuation review, records failures as stop/non-approval, and adds tests for isolation, allowed context, failure recording, and replay visibility."
```

If the follow-up is created first, close #117 with a cross-reference to that
new issue. If not, leave #117 open with the comment above.
