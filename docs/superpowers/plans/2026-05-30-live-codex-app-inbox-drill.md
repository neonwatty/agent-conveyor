# Live Codex App Inbox Drill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that real Codex app-based manager and worker sessions can use Dispatch inbox polling end to end, with durable evidence for manager-to-worker and worker-to-manager signals.

**Architecture:** Run a disposable workerctl task bound to two real Codex app sessions registered without tmux. Dispatch remains mechanical: it claims queued commands or ingested worker completion events, records `pull_required` routed notifications, and the addressed Codex app session consumes its inbox with `manager-inbox` or `worker-inbox`. Capture command output, audit, replay, dashboard observations, and a friction log; only open a fix PR if the live drill reveals product or docs gaps.

**Tech Stack:** `scripts/workerctl`, local SQLite workerctl database, Codex app rollout JSONL sessions, Dispatch, dashboard TypeScript/React UI, Python unittest, npm tests/build if code changes are needed.

---

## File Structure

- Create: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/superpowers/plans/2026-05-30-live-codex-app-inbox-drill.md`
  - This execution plan.
- Create during execution: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`
  - Human-readable receipt for the live drill: session ids, commands, inbox JSON, dashboard/replay notes, and friction.
- Create during execution: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/`
  - Raw command outputs from registration, dispatch, inbox consumption, audit, replay, and optional dashboard screenshots.
- Modify only if the drill reveals a fixable issue:
  - `/Users/neonwatty/Desktop/codex-terminal-manager/README.md`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/docs/manual-qa-checklist.md`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/workerctl/commands.py`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/tests/test_workerctl.py`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/dashboard/server/index.ts`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/dashboard/client/main.tsx`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/dashboard/client/styles.css`
  - `/Users/neonwatty/Desktop/codex-terminal-manager/dashboard/server/workerctl.test.ts`

No production code change is expected for a clean drill. If a product defect appears, make the smallest test-backed fix and create a normal PR.

---

### Task 1: Prepare the Drill Surface

**Files:**
- Create during execution: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/`
- Create during execution: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`

- [ ] **Step 1: Create and switch to the execution branch**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git switch -c codex/live-codex-app-inbox-drill
```

Expected: branch changes to `codex/live-codex-app-inbox-drill`.

- [ ] **Step 2: Confirm the repo starts clean**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --short --branch
```

Expected output starts with:

```text
## codex/live-codex-app-inbox-drill
```

and contains no changed files except this plan if it was not committed before execution.

- [ ] **Step 3: Create evidence directories**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
mkdir -p artifacts/live-codex-app-inbox-drill-20260530/commands
mkdir -p artifacts/live-codex-app-inbox-drill-20260530/dashboard
mkdir -p docs/goals/live-codex-app-inbox-drill/notes
```

Expected: all three directories exist.

- [ ] **Step 4: Create the receipt skeleton**

Create `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md` with this content:

```markdown
# T001 Live Codex App Inbox Drill

## Session Discovery

- Manager session:
- Worker session:
- Rollout JSONL paths:
- PIDs:

## Registration

- Task:
- Manager registration:
- Worker registration:
- Binding:

## Manager To Worker

- Queued command:
- Dispatch result:
- Worker inbox pending result:
- Worker consume result:
- Worker acted on message:

## Worker To Manager

- Worker completion signal:
- Ingest result:
- Dispatch result:
- Manager inbox pending result:
- Manager consume result:
- Manager acted on message:

## Dashboard And Replay

- Dashboard inbox summary:
- Replay routed notification rows:
- Audit routed notification rows:

## Friction Log

- Polling cadence:
- Discovering rollout path:
- Registering no-tmux sessions:
- Consuming the correct inbox:
- Reading dashboard/replay evidence:

## Verdict

- Result:
- Follow-up PR needed:
- Follow-up issue/goal:
```

Expected: the file exists and gives the live run one place to record all evidence.

- [ ] **Step 5: Capture local health before the drill**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl db-doctor | tee artifacts/live-codex-app-inbox-drill-20260530/commands/00-db-doctor.txt
scripts/workerctl doctor-self --json | tee artifacts/live-codex-app-inbox-drill-20260530/commands/01-doctor-self.json
```

Expected: `db-doctor` exits `0`; `doctor-self` writes valid JSON. If `doctor-self` warns that the current session cannot self-manage, proceed because the live manager and worker sessions will be registered explicitly.

---

### Task 2: Discover Two Real Codex App Sessions

**Files:**
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/commands/`
- Update: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`

- [ ] **Step 1: Open two real Codex app sessions**

Open one Codex app session that will act as manager and one Codex app session that will act as worker. Each session should be in `/Users/neonwatty/Desktop/codex-terminal-manager`.

Expected: there are two separate Codex app conversations, not tmux panes.

- [ ] **Step 2: Give the worker session its polling instruction**

Paste this prompt into the worker Codex app session:

```text
You are the worker for a live Dispatch inbox drill in /Users/neonwatty/Desktop/codex-terminal-manager. Do not use tmux. At the beginning of each turn after I give you a task name, run:

scripts/workerctl worker-inbox live-codex-app-inbox-20260530 --consume-next --json

Treat any consumed dispatcher message as your instruction source. When you complete the requested work, reply normally so your rollout JSONL records the completion event. Keep a concise note of each command you run.
```

Expected: worker acknowledges it will poll `worker-inbox` once a task name is supplied.

- [ ] **Step 3: Give the manager session its polling instruction**

Paste this prompt into the manager Codex app session:

```text
You are the manager for a live Dispatch inbox drill in /Users/neonwatty/Desktop/codex-terminal-manager. Do not use tmux. At the beginning of each turn after I give you a task name, run:

scripts/workerctl manager-inbox live-codex-app-inbox-20260530 --consume-next --json

Treat any consumed dispatcher message as your signal from Dispatch. Use manager judgment after reading the signal, and keep a concise note of each command you run.
```

Expected: manager acknowledges it will poll `manager-inbox` once a task name is supplied.

- [ ] **Step 4: Find the manager and worker rollout JSONL paths and PIDs**

In each Codex app session, run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl doctor-self --json
```

Record each session's `pid` and rollout JSONL path in `docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`.

Expected: both sessions produce enough information to pass either `--pid` or `--codex-session` during registration. If `doctor-self` cannot find the rollout path, use the PID and let `register-manager` or `register-worker` attempt `lsof` discovery.

- [ ] **Step 5: Record session discovery evidence**

Copy each `doctor-self --json` output into:

```text
artifacts/live-codex-app-inbox-drill-20260530/commands/02-manager-doctor-self.json
artifacts/live-codex-app-inbox-drill-20260530/commands/03-worker-doctor-self.json
```

Expected: evidence files exist and include the actual manager and worker session metadata.

- [ ] **Step 6: Export the discovered runtime values in the PM shell**

Run these commands after replacing the quoted values with the exact values from `02-manager-doctor-self.json`, `03-worker-doctor-self.json`, or the Codex app session metadata:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
export LIVE_MANAGER_PID='paste-manager-pid-here'
export LIVE_WORKER_PID='paste-worker-pid-here'
export LIVE_MANAGER_ROLLOUT_JSONL='paste-manager-rollout-jsonl-path-here'
export LIVE_WORKER_ROLLOUT_JSONL='paste-worker-rollout-jsonl-path-here'
printf '%s\n' "$LIVE_MANAGER_PID" "$LIVE_WORKER_PID" "$LIVE_MANAGER_ROLLOUT_JSONL" "$LIVE_WORKER_ROLLOUT_JSONL"
```

Expected: the final `printf` prints the four live values. If a rollout path is unavailable, leave that rollout variable empty and use the PID-only registration command in Task 3.

---

### Task 3: Register and Bind the No-Tmux Sessions

**Files:**
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/commands/`
- Update: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`

- [ ] **Step 1: Define stable drill names**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
export LIVE_TASK=live-codex-app-inbox-20260530
export LIVE_MANAGER=live-app-manager-20260530
export LIVE_WORKER=live-app-worker-20260530
```

Expected: the shell has stable names for the whole drill.

- [ ] **Step 2: Register the worker without tmux**

Run one of these commands, preferring explicit rollout JSONL when available:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl register-worker \
  --name "$LIVE_WORKER" \
  --pid "$LIVE_WORKER_PID" \
  --codex-session "$LIVE_WORKER_ROLLOUT_JSONL" \
  --cwd /Users/neonwatty/Desktop/codex-terminal-manager \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/04-register-worker.txt
```

or:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl register-worker \
  --name "$LIVE_WORKER" \
  --pid "$LIVE_WORKER_PID" \
  --cwd /Users/neonwatty/Desktop/codex-terminal-manager \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/04-register-worker.txt
```

Expected: worker registration succeeds and the command does not include `--tmux-session`.

- [ ] **Step 3: Register the manager without tmux**

Run one of these commands, preferring explicit rollout JSONL when available:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl register-manager \
  --name "$LIVE_MANAGER" \
  --pid "$LIVE_MANAGER_PID" \
  --codex-session "$LIVE_MANAGER_ROLLOUT_JSONL" \
  --cwd /Users/neonwatty/Desktop/codex-terminal-manager \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/05-register-manager.txt
```

or:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl register-manager \
  --name "$LIVE_MANAGER" \
  --pid "$LIVE_MANAGER_PID" \
  --cwd /Users/neonwatty/Desktop/codex-terminal-manager \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/05-register-manager.txt
```

Expected: manager registration succeeds and the command does not include `--tmux-session`.

- [ ] **Step 4: Create the disposable task**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl tasks \
  --create "$LIVE_TASK" \
  --goal "Prove real Codex app manager and worker sessions can consume Dispatch inbox signals without tmux." \
  --summary "Live Codex app manager/worker Dispatch inbox drill." \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/06-create-task.txt
```

Expected: task creation succeeds.

- [ ] **Step 5: Bind worker and manager to the task**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl bind \
  --task "$LIVE_TASK" \
  --worker "$LIVE_WORKER" \
  --manager "$LIVE_MANAGER" \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/07-bind.txt
```

Expected: binding succeeds.

- [ ] **Step 6: Verify active sessions**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl sessions --state active | tee artifacts/live-codex-app-inbox-drill-20260530/commands/08-sessions-active.txt
```

Expected: output includes `live-app-manager-20260530` as manager and `live-app-worker-20260530` as worker. Neither active row should show a tmux session.

- [ ] **Step 7: Send the task name to both app sessions**

Paste this into the worker app session:

```text
Your task name is live-codex-app-inbox-20260530. Poll your worker inbox now with:

scripts/workerctl worker-inbox live-codex-app-inbox-20260530 --consume-next --json

If there is no message yet, say that clearly and wait for the next instruction.
```

Paste this into the manager app session:

```text
Your task name is live-codex-app-inbox-20260530. Poll your manager inbox now with:

scripts/workerctl manager-inbox live-codex-app-inbox-20260530 --consume-next --json

If there is no message yet, say that clearly and wait for the next signal.
```

Expected: both real app sessions have the same task name and inbox command.

---

### Task 4: Prove Manager-To-Worker Delivery

**Files:**
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/commands/`
- Update: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`

- [ ] **Step 1: Queue a manager-to-worker nudge through Dispatch**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl enqueue-nudge-worker "$LIVE_TASK" \
  --message "Live drill: poll your worker inbox, acknowledge this dispatcher-routed message, then complete with a short note saying manager-to-worker pull delivery worked." \
  --correlation-id live-app-manager-to-worker-20260530 \
  --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/09-enqueue-nudge-worker.json
```

Expected: JSON command row is created with correlation id `live-app-manager-to-worker-20260530`.

- [ ] **Step 2: Run a bounded Dispatch pass for the nudge**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl dispatch \
  --watch \
  --watch-iterations 1 \
  --interval 0 \
  --dispatcher-id live-app-drill-20260530 \
  --type nudge_worker \
  --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/10-dispatch-nudge-worker.json
```

Expected: Dispatch records a routed notification for the worker. Because the worker is not tmux-backed, delivery mode should be `pull_required`.

- [ ] **Step 3: Verify the worker inbox has one pending item before consumption**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl worker-inbox "$LIVE_TASK" --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/11-worker-inbox-pending.json
```

Expected: JSON shows at least one pending notification for `live-app-worker-20260530`.

- [ ] **Step 4: Have the actual worker app session consume the item**

Prompt the worker app session:

```text
Poll and consume your worker inbox now:

scripts/workerctl worker-inbox live-codex-app-inbox-20260530 --consume-next --json

After consuming it, acknowledge the dispatcher-routed message and finish with a concise completion response.
```

Expected: the worker app session runs the command itself, consumes the notification, and writes a normal assistant response based on the consumed message.

- [ ] **Step 5: Capture the worker inbox after consumption**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl worker-inbox "$LIVE_TASK" --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/12-worker-inbox-after-consume.json
```

Expected: pending count for the worker is lower than in `11-worker-inbox-pending.json`, and the consumed notification has `consumed_by_session_name` equal to `live-app-worker-20260530`.

- [ ] **Step 6: Record the worker action in the receipt**

Update `docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md` under `Manager To Worker` with:

```markdown
- Queued command: artifacts/live-codex-app-inbox-drill-20260530/commands/09-enqueue-nudge-worker.json
- Dispatch result: artifacts/live-codex-app-inbox-drill-20260530/commands/10-dispatch-nudge-worker.json
- Worker inbox pending result: artifacts/live-codex-app-inbox-drill-20260530/commands/11-worker-inbox-pending.json
- Worker consume result: worker app session consumed with `worker-inbox --consume-next --json`
- Worker acted on message: yes/no, with one sentence of evidence
```

Expected: the receipt states whether the worker actually acted on the inbox message, not merely whether the PM thread consumed it.

---

### Task 5: Prove Worker-To-Manager Delivery

**Files:**
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/commands/`
- Update: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`

- [ ] **Step 1: Ingest the worker session after its completion response**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl ingest "$LIVE_WORKER" \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/13-ingest-worker.txt
```

Expected: worker rollout events are ingested. If no new events are ingested, ask the worker app session to send one more short response and rerun this command.

- [ ] **Step 2: Run a bounded Dispatch pass for worker completion**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl dispatch \
  --watch \
  --watch-iterations 1 \
  --interval 0 \
  --dispatcher-id live-app-drill-20260530 \
  --type worker_task_complete \
  --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/14-dispatch-worker-complete.json
```

Expected: Dispatch routes a worker completion notification to the bound manager. Because the manager is not tmux-backed, delivery mode should be `pull_required`.

- [ ] **Step 3: Verify the manager inbox has one pending item before consumption**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl manager-inbox "$LIVE_TASK" --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/15-manager-inbox-pending.json
```

Expected: JSON shows at least one pending notification for `live-app-manager-20260530`.

- [ ] **Step 4: Have the actual manager app session consume the item**

Prompt the manager app session:

```text
Poll and consume your manager inbox now:

scripts/workerctl manager-inbox live-codex-app-inbox-20260530 --consume-next --json

After consuming it, summarize what the worker completed and state the next manager decision you would make.
```

Expected: the manager app session runs the command itself, consumes the notification, and responds based on the dispatcher-routed worker completion.

- [ ] **Step 5: Capture the manager inbox after consumption**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl manager-inbox "$LIVE_TASK" --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/16-manager-inbox-after-consume.json
```

Expected: pending count for the manager is lower than in `15-manager-inbox-pending.json`, and the consumed notification has `consumed_by_session_name` equal to `live-app-manager-20260530`.

- [ ] **Step 6: Record the manager action in the receipt**

Update `docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md` under `Worker To Manager` with:

```markdown
- Worker completion signal: worker response ingested from real app session
- Ingest result: artifacts/live-codex-app-inbox-drill-20260530/commands/13-ingest-worker.txt
- Dispatch result: artifacts/live-codex-app-inbox-drill-20260530/commands/14-dispatch-worker-complete.json
- Manager inbox pending result: artifacts/live-codex-app-inbox-drill-20260530/commands/15-manager-inbox-pending.json
- Manager consume result: manager app session consumed with `manager-inbox --consume-next --json`
- Manager acted on message: yes/no, with one sentence of evidence
```

Expected: the receipt proves the manager saw the worker completion through the same pull inbox model that tmux-backed managers bypass with push delivery.

---

### Task 6: Verify Audit, Replay, and Dashboard Evidence

**Files:**
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/commands/`
- Evidence: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/dashboard/`
- Update: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`

- [ ] **Step 1: Capture audit JSON**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl audit "$LIVE_TASK" --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/17-audit.json \
  | python3 -m json.tool >/dev/null
```

Expected: command exits `0`; audit JSON includes routed notifications for both directions.

- [ ] **Step 2: Capture replay JSON**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl replay "$LIVE_TASK" --json \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/18-replay.json \
  | python3 -m json.tool >/dev/null
```

Expected: command exits `0`; replay JSON includes entries with `delivery_mode`, `target_session_name`, `consumed_by_session_name`, and `consumed_at`.

- [ ] **Step 3: Capture compact replay text**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl replay "$LIVE_TASK" --format compact \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/19-replay-compact.txt
```

Expected: compact replay text is understandable without reading raw JSON.

- [ ] **Step 4: Launch dashboard with Dispatch enforcement**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl dashboard --task "$LIVE_TASK" --ensure-dispatch --dispatcher-id live-app-drill-dashboard-20260530
```

Expected: the dashboard opens and its Dispatch panel shows inbox pending/consumed counts and routed notification rows for the live task.

- [ ] **Step 5: Capture dashboard evidence**

Save a screenshot or concise manual note at:

```text
artifacts/live-codex-app-inbox-drill-20260530/dashboard/dispatch-inbox-summary.txt
```

The note must include:

```text
Dashboard task:
Inbox pending count:
Inbox consumed count:
Manager notification row:
Worker notification row:
Any confusing labels:
```

Expected: the dashboard evidence is understandable enough to debug the run later.

- [ ] **Step 6: Record audit/replay/dashboard verdict**

Update `docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md` under `Dashboard And Replay` with:

```markdown
- Dashboard inbox summary: artifacts/live-codex-app-inbox-drill-20260530/dashboard/dispatch-inbox-summary.txt
- Replay routed notification rows: artifacts/live-codex-app-inbox-drill-20260530/commands/18-replay.json
- Audit routed notification rows: artifacts/live-codex-app-inbox-drill-20260530/commands/17-audit.json
```

Expected: the receipt points to every durable evidence surface.

---

### Task 7: Decide Whether a Fix PR Is Needed

**Files:**
- Update if docs-only friction appears: `/Users/neonwatty/Desktop/codex-terminal-manager/README.md`
- Update if checklist friction appears: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/manual-qa-checklist.md`
- Update if CLI/dashboard behavior is wrong: relevant files listed in File Structure
- Test if code changes occur: `/Users/neonwatty/Desktop/codex-terminal-manager/tests/test_workerctl.py`
- Test if dashboard changes occur: `/Users/neonwatty/Desktop/codex-terminal-manager/dashboard/server/workerctl.test.ts`

- [ ] **Step 1: Classify every friction item**

Use this table in `docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`:

```markdown
| Friction | Type | Severity | Fix before live QA? | Evidence |
| --- | --- | --- | --- | --- |
|  | docs | low | no |  |
|  | workflow | medium | yes/no |  |
|  | product | high | yes |  |
```

Expected: no friction item is left unclassified.

- [ ] **Step 2: If no fix is needed, record the no-fix verdict**

Add this under `Verdict`:

```markdown
- Result: pass
- Follow-up PR needed: no
- Follow-up issue/goal: none
```

Expected: the plan ends with evidence only; no code or docs changes beyond the receipt are required.

- [ ] **Step 3: If docs or checklist changes are needed, make the smallest edit**

For README friction, add or refine the Codex app polling note near the existing Dispatch inbox documentation. The wording should include:

```markdown
Codex app-based managers and workers are first-class pull targets: register them without `--tmux-session`, let Dispatch record `pull_required`, and have the app session poll `manager-inbox live-codex-app-inbox-20260530 --consume-next --json` or `worker-inbox live-codex-app-inbox-20260530 --consume-next --json` at the start of each turn.
```

For manual QA friction, add this checklist item to `/Users/neonwatty/Desktop/codex-terminal-manager/docs/manual-qa-checklist.md`:

```markdown
- [ ] Real Codex app manager and worker sessions registered without tmux can consume dispatcher inbox messages in both directions; audit/replay/dashboard show `pull_required`, target session, consumed-by session, and consumed timestamp.
```

Expected: docs explain exactly what the live drill taught us.

- [ ] **Step 4: If product behavior is wrong, write a failing test first**

For CLI/audit/replay friction, add a focused test in `/Users/neonwatty/Desktop/codex-terminal-manager/tests/test_workerctl.py` that reproduces the missing or confusing behavior.

For dashboard friction, add a focused test in `/Users/neonwatty/Desktop/codex-terminal-manager/dashboard/server/workerctl.test.ts` that reproduces the missing inbox summary or label.

Expected: the new test fails before implementation and names the live-drill behavior in its test name.

- [ ] **Step 5: Implement the smallest product fix**

Modify only the files needed to satisfy the failing test. Keep Dispatch mechanical: it may route, claim, deliver, and record evidence, but it must not decide task success, finish tasks, or choose manager strategy.

Expected: the failing test now passes and no unrelated behavior changes.

- [ ] **Step 6: Run verification if any docs or code changed**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
python3 -m unittest tests.test_workerctl -v
npm test
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 7: Run review before PR if any product code changed**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
codex review --uncommitted
```

Expected: no actionable correctness issues. Fix any actionable issue before creating the PR.

---

### Task 8: Close Out the Drill

**Files:**
- Update: `/Users/neonwatty/Desktop/codex-terminal-manager/docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md`
- Optional export: `/Users/neonwatty/Desktop/codex-terminal-manager/artifacts/live-codex-app-inbox-drill-20260530/export/`

- [ ] **Step 1: Export the task evidence**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl export-task "$LIVE_TASK" \
  --output artifacts/live-codex-app-inbox-drill-20260530/export \
  | tee artifacts/live-codex-app-inbox-drill-20260530/commands/20-export-task.txt
```

Expected: export directory includes task status, audit, replay, and manifest files.

- [ ] **Step 2: Add final acceptance criteria results**

Add this checklist to the `Verdict` section:

```markdown
## Acceptance Criteria

- [ ] Real Codex app manager session registered without tmux.
- [ ] Real Codex app worker session registered without tmux.
- [ ] Manager-to-worker signal routed by Dispatch and consumed by the worker app session.
- [ ] Worker-to-manager completion routed by Dispatch and consumed by the manager app session.
- [ ] Both routed notifications show `delivery_mode` as `pull_required`.
- [ ] Audit, replay, and dashboard show source/target/consumed evidence.
- [ ] Any friction is either fixed in the branch or captured as a follow-up with severity.
```

Expected: every box is checked or has a one-sentence reason beside it.

- [ ] **Step 3: Commit the plan and evidence/fixes**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --short
git add docs/superpowers/plans/2026-05-30-live-codex-app-inbox-drill.md
git add docs/goals/live-codex-app-inbox-drill/notes/T001-live-drill.md
git add artifacts/live-codex-app-inbox-drill-20260530
git add README.md docs/manual-qa-checklist.md workerctl/commands.py tests/test_workerctl.py dashboard/server/index.ts dashboard/client/main.tsx dashboard/client/styles.css dashboard/server/workerctl.test.ts 2>/dev/null || true
git commit -m "Document live Codex app inbox drill"
```

Expected: commit succeeds. If no fix was needed and artifacts should remain local only, commit the plan and receipt but omit the raw `artifacts/` directory.

- [ ] **Step 4: Create PR only if there are repo changes worth merging**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git push -u origin codex/live-codex-app-inbox-drill
gh pr create \
  --title "Document live Codex app inbox drill" \
  --body "Adds the live Codex app manager/worker inbox drill plan and receipt. If the drill found fixes, this PR includes the smallest test-backed updates." \
  --base main \
  --head codex/live-codex-app-inbox-drill
```

Expected: PR is created. If code changed, wait for CI and merge only when green.

---

## Self-Review

- Spec coverage: The plan covers real Codex app manager and worker registration, no-tmux pull delivery, manager-to-worker routing, worker-to-manager completion routing, app-session consumption, audit/replay/dashboard evidence, friction triage, verification, and PR closeout.
- Placeholder scan: The executable commands use stable names or shell variables populated from live session discovery. The only paste-required values are explicitly exported in Task 2 Step 6.
- Type consistency: The task, manager, worker, dispatcher id, correlation ids, file paths, and command names are consistent across tasks.
