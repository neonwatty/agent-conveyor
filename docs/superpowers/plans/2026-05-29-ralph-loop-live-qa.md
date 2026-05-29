# Ralph Loop Live QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the newly merged `ralph-loop` QA scenario end to end before treating the managed PR/CI/merge/context-clear flow as live.

**Architecture:** Run one preflight against the manager repo to prove the plan and evidence surfaces are available, then run a disposable GitHub canary repo with real CI so the manager/worker loop exercises PR creation, CI failure repair, green merge, handoff, audited worker clear, and replay. Keep Dispatch mechanical: it may route and execute durable commands, while manager decisions remain recorded through manager decision, criteria, epilogue, handoff, command, audit, replay, and telemetry receipts.

**Tech Stack:** `scripts/workerctl`, tmux-backed Codex manager/worker sessions, local SQLite task/audit/telemetry store, GitHub CLI, GitHub Actions.

---

## File Structure

- Create: `docs/superpowers/plans/2026-05-29-ralph-loop-live-qa.md`
  - Execution plan and checklist for the live QA canary.
- Create during execution: `/Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529`
  - Disposable target repository used by the managed worker.
- Create during execution: `artifacts/ralph-loop-live-qa-20260529/`
  - Final evidence bundle copied out of workerctl exports and command outputs.
- No production code changes are expected during this plan. If the canary reveals a dispatcher, logging, or QA-plan bug, stop this plan after evidence capture and open a focused fix branch.

---

### Task 1: Manager Repo Preflight

**Files:**
- Read: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/qa/ralph-loop.md`
- Read: `/Users/neonwatty/Desktop/codex-terminal-manager/workerctl/commands.py`
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/preflight/`

- [ ] **Step 1: Create the local evidence directory**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
mkdir -p artifacts/ralph-loop-live-qa-20260529/preflight
```

Expected: directory exists at `artifacts/ralph-loop-live-qa-20260529/preflight`.

- [ ] **Step 2: Verify the merged branch is clean**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --short --branch | tee artifacts/ralph-loop-live-qa-20260529/preflight/manager-git-status.txt
```

Expected output starts with:

```text
## main...origin/main
```

- [ ] **Step 3: Render the human QA plan**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl qa-plan ralph-loop | tee artifacts/ralph-loop-live-qa-20260529/preflight/qa-plan.txt
```

Expected: output contains `QA plan: ralph-loop`, `ralph-iter-1-clear`, and `ralph-iter-2-replay`.

- [ ] **Step 4: Validate the JSON QA plan**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl qa-plan ralph-loop --json \
  | tee artifacts/ralph-loop-live-qa-20260529/preflight/qa-plan.json \
  | python3 -m json.tool >/dev/null
```

Expected: command exits `0`.

- [ ] **Step 5: Run focused local tests before live canary**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
python3 -m unittest \
  tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_outputs_managed_delivery_loop \
  tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_includes_correlation_and_receipt_template \
  -v | tee artifacts/ralph-loop-live-qa-20260529/preflight/focused-tests.txt
```

Expected: both tests pass.

- [ ] **Step 6: Commit only this plan if we want the execution checklist versioned**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git add docs/superpowers/plans/2026-05-29-ralph-loop-live-qa.md
git commit -m "Plan Ralph loop live QA canary"
```

Expected: commit succeeds. Skip this step if the plan should remain local scratch.

---

### Task 2: Disposable GitHub Canary Repo

**Files:**
- Create: `/Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529`
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/canary-repo/`

- [ ] **Step 1: Create a disposable local repo with intentionally failing CI**

```bash
rm -rf /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
mkdir -p /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529/.github/workflows
cd /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
git init
git branch -M main
printf 'def add(a, b):\n    return a - b\n' > calculator.py
printf 'import unittest\n\nfrom calculator import add\n\n\nclass CalculatorTests(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n\nif __name__ == "__main__":\n    unittest.main()\n' > test_calculator.py
printf 'name: Tests\non: [push, pull_request]\njobs:\n  unittest:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n      - run: python -m unittest discover -v\n' > .github/workflows/tests.yml
git add .
git commit -m "Initial failing calculator"
```

Expected: local commit succeeds and `python3 -m unittest discover -v` fails before the worker fixes it.

- [ ] **Step 2: Create the private GitHub repo and push main**

```bash
cd /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
gh repo create neonwatty/codex-ralph-loop-canary-20260529 --private --source . --remote origin --push
```

Expected: GitHub repository `neonwatty/codex-ralph-loop-canary-20260529` exists with `main` pushed.

- [ ] **Step 3: Record canary repo metadata**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
mkdir -p artifacts/ralph-loop-live-qa-20260529/canary-repo
cd /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
gh repo view --json nameWithOwner,url,defaultBranchRef \
  | tee /Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/canary-repo/repo.json
git status --short --branch \
  | tee /Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/canary-repo/git-status.txt
```

Expected: repo JSON includes `neonwatty/codex-ralph-loop-canary-20260529`.

---

### Task 3: Iteration 1 Manager/Worker Loop

**Files:**
- Target repo: `/Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529`
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/iter-1/`

- [ ] **Step 1: Define the exact seed prompt and hash**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
mkdir -p artifacts/ralph-loop-live-qa-20260529/iter-1
export TARGET_REPO=/Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
export SEED_PROMPT='You are working in the disposable calculator canary repo. Fix the failing unit test by correcting the implementation, verify tests locally, open a pull request, monitor CI, fix CI if needed, and merge only when green. Record concise evidence for every decision.'
export SEED_PROMPT_SHA256="$(printf '%s' "$SEED_PROMPT" | shasum -a 256 | awk '{print $1}')"
printf '%s\n' "$SEED_PROMPT" > artifacts/ralph-loop-live-qa-20260529/seed-prompt.txt
printf '%s\n' "$SEED_PROMPT_SHA256" > artifacts/ralph-loop-live-qa-20260529/seed-prompt.sha256
```

Expected SHA-256 is stable across both iterations.

- [ ] **Step 2: Start Dispatch watch**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl dispatch --watch --dispatcher-id qa-ralph-loop
```

Expected: Dispatch watch stays active and emits heartbeat telemetry. Leave it running in its own terminal or tmux pane.

- [ ] **Step 3: Create iteration 1 manager/worker pair**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl pair \
  --task qa-ralph-loop-iter-1 \
  --worker-name qa-ralph-worker-1 \
  --manager-name qa-ralph-manager \
  --cwd "$TARGET_REPO" \
  --task-goal "Managed Ralph loop iteration 1" \
  --task-summary "PR/CI/merge/context-clear QA" \
  --task-prompt "$SEED_PROMPT"
```

Expected: task, worker session, manager session, and bindings are created.

- [ ] **Step 4: Prove permission gates fail closed**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
{
  scripts/workerctl manager-permission qa-ralph-loop-iter-1 repo.open_pr --require || true
  scripts/workerctl manager-permission qa-ralph-loop-iter-1 repo.merge_green_pr --require || true
  scripts/workerctl manager-permission qa-ralph-loop-iter-1 worker_compact_clear --require --require-handoff || true
} | tee artifacts/ralph-loop-live-qa-20260529/iter-1/permission-denied-preconfig.txt
```

Expected: each required permission is denied before configuration.

- [ ] **Step 5: Enable the allowed manager policy**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl manager-config qa-ralph-loop-iter-1 \
  --allow-pr \
  --allow-merge-green \
  --allow-worker-compact-clear \
  --epilogue draft-pr \
  --epilogue record-handoff \
  --tool verification.run_tests \
  --tool context.fetch_prs
```

Expected: saved config lists `repo.open_pr`, `repo.merge_green_pr`, and `worker_compact_clear`.

- [ ] **Step 6: Run manager cycles until worker reports completion**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl cycle qa-ralph-loop-iter-1 | tee artifacts/ralph-loop-live-qa-20260529/iter-1/cycle-1.txt
scripts/workerctl cycle qa-ralph-loop-iter-1 | tee artifacts/ralph-loop-live-qa-20260529/iter-1/cycle-2.txt
scripts/workerctl status qa-ralph-loop-iter-1 --json | tee artifacts/ralph-loop-live-qa-20260529/iter-1/status-after-cycles.json
```

Expected: manager consumes worker completion and records the next manager action. Continue `cycle` with incrementing evidence filenames if the worker is still active.

- [ ] **Step 7: Record PR-readiness decision and epilogue**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl record-decision qa-ralph-loop-iter-1 inspect \
  --reason "Iteration 1 is PR-ready after criteria and verification evidence." \
  --payload-json "{\"ralph_loop\":{\"iteration\":1,\"phase\":\"pr\",\"correlation_id\":\"ralph-iter-1-pr\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"
scripts/workerctl epilogue qa-ralph-loop-iter-1 \
  --step draft-pr \
  --correlation-id ralph-iter-1-pr
```

Expected: decision and epilogue appear in `audit` and `replay`.

- [ ] **Step 8: Capture PR URL evidence**

```bash
cd /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
export PR_URL="$(gh pr view --json url --jq .url)"
cd /Users/neonwatty/Desktop/codex-terminal-manager
export PR_URL_CRITERION_ID="$(scripts/workerctl criteria qa-ralph-loop-iter-1 \
  --add \
  --criterion "Iteration 1 PR URL is recorded" \
  --source manager_inferred \
  --status accepted | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')"
scripts/workerctl criteria qa-ralph-loop-iter-1 \
  --satisfy "$PR_URL_CRITERION_ID" \
  --evidence-json "{\"correlation_id\":\"ralph-iter-1-pr\",\"pr_url\":\"$PR_URL\"}"
printf '%s\n' "$PR_URL" | tee artifacts/ralph-loop-live-qa-20260529/iter-1/pr-url.txt
```

Expected: `pr-url.txt` contains a GitHub PR URL.

- [ ] **Step 9: Exercise CI failure and fix routing**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl record-decision qa-ralph-loop-iter-1 nudge \
  --reason "CI failed or was observed failing; route a focused CI-fix retry to the worker." \
  --payload-json "{\"ralph_loop\":{\"iteration\":1,\"phase\":\"ci_fix\",\"correlation_id\":\"ralph-iter-1-ci-fix\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"
scripts/workerctl nudge qa-ralph-loop-iter-1 \
  --message "correlation_id=ralph-iter-1-ci-fix; inspect the PR CI result, fix the failing test or CI issue, push the update, and report the new commit and CI URL."
```

Expected: manager decision, nudge command, worker fix receipt, and updated PR are visible in audit/replay/commands.

- [ ] **Step 10: Merge only when CI is green**

```bash
cd /Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
gh pr checks --watch
export MERGE_RESULT="$(gh pr merge --squash --delete-branch --subject 'Fix calculator add implementation' 2>&1)"
printf '%s\n' "$MERGE_RESULT" | tee /Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/iter-1/merge-result.txt
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl record-decision qa-ralph-loop-iter-1 inspect \
  --reason "CI is green and repo.merge_green_pr permission is present." \
  --payload-json "{\"ralph_loop\":{\"iteration\":1,\"phase\":\"merge\",\"correlation_id\":\"ralph-iter-1-merge\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"
```

Expected: PR checks are green and merge result shows a successful merge.

- [ ] **Step 11: Record handoff and audited clear**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl handoff qa-ralph-loop-iter-1 \
  --summary "Iteration 1 merged; replay same seed prompt after clear." \
  --next-step "Start iteration 2 after audited clear in fresh-worker isolation." \
  --payload-json "{\"iteration\":1,\"pr\":\"$PR_URL\",\"ci\":\"green\",\"merge\":\"merged\",\"clear_correlation_id\":\"ralph-iter-1-clear\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\",\"correlation_ids\":[\"ralph-iter-1-pr\",\"ralph-iter-1-ci\",\"ralph-iter-1-ci-fix\",\"ralph-iter-1-merge\",\"ralph-iter-1-clear\"]}"
scripts/workerctl compact-worker qa-ralph-loop-iter-1 \
  --clear \
  --reason "Clear worker context between Ralph loop iterations; correlation_id=ralph-iter-1-clear" \
  --message "correlation_id=ralph-iter-1-clear; clear worker context between Ralph loop iterations after saved handoff"
```

Expected: `worker_compact_clear` is permitted only after handoff and records a durable clear receipt.

---

### Task 4: Iteration 2 Replay And Fresh-Worker Isolation

**Files:**
- Target repo: `/Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529`
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/iter-2/`

- [ ] **Step 1: Start iteration 2 with the exact same seed prompt**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
mkdir -p artifacts/ralph-loop-live-qa-20260529/iter-2
export TARGET_REPO=/Users/neonwatty/Desktop/codex-ralph-loop-canary-20260529
export SEED_PROMPT="$(cat artifacts/ralph-loop-live-qa-20260529/seed-prompt.txt)"
export SEED_PROMPT_SHA256="$(cat artifacts/ralph-loop-live-qa-20260529/seed-prompt.sha256)"
scripts/workerctl pair \
  --task qa-ralph-loop-iter-2 \
  --worker-name qa-ralph-worker-2 \
  --manager-name qa-ralph-manager-2 \
  --cwd "$TARGET_REPO" \
  --task-goal "Managed Ralph loop iteration 2" \
  --task-summary "Replay after audited clear with fresh-worker isolation" \
  --task-prompt "$SEED_PROMPT"
```

Expected: fresh task, fresh worker, and fresh manager are created.

- [ ] **Step 2: Capture initial isolation evidence**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl capture-transcript qa-ralph-loop-iter-2 \
  --role worker \
  --label initial-replay \
  --require-nonempty
scripts/workerctl replay qa-ralph-loop-iter-2 \
  | tee artifacts/ralph-loop-live-qa-20260529/iter-2/initial-replay.txt
scripts/workerctl commands --task qa-ralph-loop-iter-1 --json \
  | tee artifacts/ralph-loop-live-qa-20260529/iter-2/iter-1-clear-commands.json
```

Expected: iteration 2 replay starts from the same seed prompt and iteration 1 commands contain `ralph-iter-1-clear`.

- [ ] **Step 3: Run the second manager-led delivery loop**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl manager-config qa-ralph-loop-iter-2 \
  --allow-pr \
  --allow-merge-green \
  --allow-worker-compact-clear \
  --epilogue draft-pr \
  --epilogue record-handoff \
  --tool verification.run_tests \
  --tool context.fetch_prs
scripts/workerctl cycle qa-ralph-loop-iter-2 | tee artifacts/ralph-loop-live-qa-20260529/iter-2/cycle-1.txt
scripts/workerctl cycle qa-ralph-loop-iter-2 | tee artifacts/ralph-loop-live-qa-20260529/iter-2/cycle-2.txt
```

Expected: manager owns completion judgment and asks what remains or records no useful remaining work.

- [ ] **Step 4: Record replay decision marker**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl record-decision qa-ralph-loop-iter-2 inspect \
  --reason "Iteration 2 replay used the same seed prompt after audited clear with fresh-worker isolation." \
  --payload-json "{\"ralph_loop\":{\"iteration\":2,\"phase\":\"replay\",\"correlation_id\":\"ralph-iter-2-replay\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"
```

Expected: `ralph-iter-2-replay` appears in audit and replay.

---

### Task 5: Evidence Bundle And Go/No-Go

**Files:**
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/ralph-loop-live-qa-20260529/final/`

- [ ] **Step 1: Export both tasks**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
mkdir -p artifacts/ralph-loop-live-qa-20260529/final
for TASK in qa-ralph-loop-iter-1 qa-ralph-loop-iter-2; do
  scripts/workerctl replay "$TASK" | tee "artifacts/ralph-loop-live-qa-20260529/final/$TASK-replay.txt"
  scripts/workerctl audit "$TASK" --json | tee "artifacts/ralph-loop-live-qa-20260529/final/$TASK-audit.json"
  scripts/workerctl commands --task "$TASK" --json | tee "artifacts/ralph-loop-live-qa-20260529/final/$TASK-commands.json"
  scripts/workerctl telemetry --task "$TASK" --json | tee "artifacts/ralph-loop-live-qa-20260529/final/$TASK-telemetry.json"
  scripts/workerctl telemetry --task "$TASK" --summary --json | tee "artifacts/ralph-loop-live-qa-20260529/final/$TASK-telemetry-summary.json"
  scripts/workerctl export-task "$TASK" --zip --include-transcripts
done
```

Expected: each task has replay, audit, commands, telemetry, telemetry summary, and export zip output.

- [ ] **Step 2: Verify marker linkage**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
for MARKER in ralph-iter-1-pr ralph-iter-1-ci-fix ralph-iter-1-merge ralph-iter-1-clear ralph-iter-2-replay; do
  rg "$MARKER" artifacts/ralph-loop-live-qa-20260529/final \
    | tee "artifacts/ralph-loop-live-qa-20260529/final/marker-$MARKER.txt"
done
```

Expected: every marker appears in at least one audit, replay, command, decision, epilogue, handoff, or telemetry artifact.

- [ ] **Step 3: Confirm dispatcher health**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl telemetry snapshot --task qa-ralph-loop-iter-1 --json \
  | tee artifacts/ralph-loop-live-qa-20260529/final/iter-1-telemetry-snapshot.json
scripts/workerctl telemetry snapshot --task qa-ralph-loop-iter-2 --json \
  | tee artifacts/ralph-loop-live-qa-20260529/final/iter-2-telemetry-snapshot.json
scripts/workerctl reconcile --stale-cycles-seconds 1 \
  | tee artifacts/ralph-loop-live-qa-20260529/final/reconcile.txt
```

Expected: no stuck command, stale cycle, or missing manager/worker routing condition blocks the run.

- [ ] **Step 4: Write the final go/no-go note**

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
cat > artifacts/ralph-loop-live-qa-20260529/final/go-no-go.md <<'EOF'
# Ralph Loop Live QA Go/No-Go

## Decision
GO only if every checklist item below is true.

## Checklist
- Two managed iterations ran from the same seed prompt hash.
- Iteration 1 recorded PR readiness, PR URL, CI failure/fix routing, green merge, handoff, and audited clear.
- Iteration 2 started after the audited clear receipt in fresh-worker isolation.
- Dispatch routed mechanically and did not decide task readiness, merge readiness, or continue/stop.
- Manager decisions are linked to worker and dispatcher receipts through correlation markers.
- Audit, replay, commands, telemetry summary, and export artifacts exist for both tasks.
- Reconcile found no stale cycles or stuck commands.

## Follow-ups
- If marker linkage is missing, fix dispatcher command/audit logging before go-live.
- If Dispatch cannot ping manager and worker consistently, add explicit liveness receipt logging before go-live.
- If clear/replay proof is ambiguous, add a same-session clear QA variant before go-live.
EOF
```

Expected: `go-no-go.md` records whether the merged QA flow is ready for live use or needs a focused follow-up fix.

---

## Go-Live Criteria

- The manager can ping or otherwise verify both manager and worker session liveness before PR, CI-fix, merge, handoff, and clear phases.
- Dispatch telemetry shows command attempts and route outcomes for the manager and worker at every phase where it routes work.
- Correlation markers connect manager decisions to worker receipts and dispatch command attempts without relying on free-text telemetry search.
- `finish-task --require-criteria-audit --require-epilogue` fails before evidence closure and succeeds only after evidence closure.
- The CI failure path is observed or deliberately simulated and then repaired by a manager-routed worker retry.
- The second iteration uses the same seed prompt hash after the iteration 1 audited clear receipt.

## Stop Conditions

- Stop immediately if the worker tries to merge a non-disposable PR.
- Stop immediately if Dispatch appears to decide readiness instead of routing the manager's decision.
- Stop immediately if permissions allow PR, merge, or clear before manager config permits them.
- Stop and open a fix branch if audit/replay/commands cannot connect manager dispatcher and worker dispatcher receipts.
