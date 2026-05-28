# T015 Resume Runbook

Use this when the environment has both:

- write access to `/Users/neonwatty/Desktop/workerctl-dispatch-lab`;
- git index write access in `/Users/neonwatty/Desktop/codex-terminal-manager`.

## 1. Preserve GoalBuddy Artifacts

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --short
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.7/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/subscription-billing-dispatch-qa/state.yaml
git add docs/goals/subscription-billing-dispatch-qa
git commit -m "Prepare subscription billing dispatch QA goal"
```

If a branch/PR is desired for the GoalBuddy artifacts:

```bash
git switch -c codex/subscription-billing-dispatch-qa-goal
git push -u origin codex/subscription-billing-dispatch-qa-goal
```

## 2. Apply The Lab Scenario Patch

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git status --short
git apply --recount /Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/subscription-billing-dispatch-qa/notes/T009-subscription-billing-lab.patch
```

Expected changed files:

```text
README.md
lab
scenarios/subscription-billing/files/src/dispatch_lab/__init__.py
scenarios/subscription-billing/files/src/dispatch_lab/billing.py
scenarios/subscription-billing/files/tests/test_billing.py
```

## 3. Verify The Scenario Fixture

If `uv` cache permissions are restricted, use a temp cache:

```bash
export UV_CACHE_DIR=/tmp/uv-cache-workerctl-dispatch-lab
```

Then run:

```bash
bash -n lab
LAB_SCENARIO=subscription-billing ./lab reset --force
.venv/bin/python -m pytest -q
git diff --check
```

Expected pre-worker result:

```text
6 failed
```

That red baseline is intentional. It proves the fixture creates the harder work package. Do not mark the goal complete here.

## 4. Run Dashboard QA

```bash
LAB_SCENARIO=subscription-billing ./lab qa-start
./lab cycle
```

Watch for the worker to finish. Then run:

```bash
./lab cycle
```

The dashboard must show:

- Dispatch core active.
- `worker_task_complete` delivered.
- source event id visible.
- manager cycle id visible.
- manager cycle explicitly consumed the routed fact.
- worker receipt includes final `.venv/bin/python -m pytest -q` pass evidence.
- `finish_task` succeeds only after manager-cycle consumption evidence exists.
- task state is `done`.
- accepted criteria are satisfied.

If the worker finishes but the dispatch chain is missing, stop and investigate product behavior before committing the lab scenario.

## 5. Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

## 6. Commit And Push Lab Scenario

Only after dashboard QA passes:

```bash
git add README.md lab scenarios/subscription-billing
git commit -m "Add subscription billing dispatch QA scenario"
git push
```

## 7. Final Audit Requirements

The GoalBuddy final audit can only mark complete if evidence proves:

- the lab scenario exists in the live lab repo;
- the lab scenario is committed and pushed;
- red baseline was verified before the worker fix;
- worker fix passed tests;
- dashboard showed Dispatch active;
- `worker_task_complete` routed from a source event;
- manager cycle consumed the routed fact;
- `finish_task` succeeded after consumption;
- task reached `done`;
- cleanup/reset returned the lab to a known fixture.
