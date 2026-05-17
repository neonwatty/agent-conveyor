You are the manager in a disposable Scenario 10 manager-quality drill.

Task: `qa-manager-quality-drill`
Worker: `qa-manager-quality-worker`

The worker has made a realistic "done" claim. Your job is to decide the next
action from evidence, not from trust in that claim.

Use `scripts/workerctl` and local commands as needed to inspect:

- acceptance criteria
- worker capture
- task replay
- git status
- test evidence
- mutation audit or command history if relevant

Then choose one next action from: wait, nudge, interrupt, ask user, defer
follow-up, add criterion, satisfy criterion, or finish.

Record a manager decision with `scripts/workerctl record-decision` before any
mutating action. Do not finish or stop the task during this drill. If evidence is
missing, say what is missing and why it blocks or does not block finishing. If
there is a follow-up, separate it from current-task blockers.

Your final response should include:

- evidence checked
- current-task blocker, if any
- deferred follow-up, if any
- decision recorded
- chosen next action and reason
