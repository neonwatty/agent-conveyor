# T004 No-Tmux Inbox QA Drill

Date: 2026-05-30

## Setup

- Throwaway state root: `/var/folders/wt/nn4g5swd3gd139y9r6yw6x_80000gn/T/tmp.qq4wg8Gax4/state`
- Disposable task: `qa-inbox-ops-20260530045042`
- Worker session: `qa-inbox-ops-20260530045042-worker`
- Manager session: `qa-inbox-ops-20260530045042-manager`
- Dispatcher id: `qa-inbox-ops`
- Both sessions were registered without `--tmux-session`, so Dispatch used `delivery_mode='pull_required'`.

## Commands

```bash
export WORKERCTL_STATE_ROOT=/var/folders/wt/nn4g5swd3gd139y9r6yw6x_80000gn/T/tmp.qq4wg8Gax4/state
scripts/workerctl tasks --create qa-inbox-ops-20260530045042 --goal "Disposable no-tmux inbox QA drill" --json
scripts/workerctl register-worker --name qa-inbox-ops-20260530045042-worker --codex-session "$WORKER_ROLLOUT" --pid 11111 --cwd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl register-manager --name qa-inbox-ops-20260530045042-manager --codex-session "$MANAGER_ROLLOUT" --pid 22222 --cwd /Users/neonwatty/Desktop/codex-terminal-manager
scripts/workerctl bind --task qa-inbox-ops-20260530045042 --worker qa-inbox-ops-20260530045042-worker --manager qa-inbox-ops-20260530045042-manager
scripts/workerctl enqueue-nudge-worker qa-inbox-ops-20260530045042 --message "QA manager asks worker to acknowledge inbox polling." --correlation-id qa-manager-to-worker --json
scripts/workerctl dispatch --watch --watch-iterations 1 --dispatcher-id qa-inbox-ops --type nudge_worker --json
scripts/workerctl worker-inbox qa-inbox-ops-20260530045042 --json
scripts/workerctl worker-inbox qa-inbox-ops-20260530045042 --consume-next --json
scripts/workerctl ingest qa-inbox-ops-20260530045042-worker
scripts/workerctl dispatch --watch --watch-iterations 1 --dispatcher-id qa-inbox-ops --type worker_task_complete --json
scripts/workerctl manager-inbox qa-inbox-ops-20260530045042 --json
scripts/workerctl manager-inbox qa-inbox-ops-20260530045042 --consume-next --json
scripts/workerctl replay qa-inbox-ops-20260530045042 --json --limit 20
npx tsx -e 'import { dispatchChainEntries, dispatchInboxSummary, dispatchHealth } from "./dashboard/server/index.ts"; /* audited throwaway DB */'
```

## Manager To Worker

- `enqueue-nudge-worker` created command `command-a214aa2c-e7d5-4163-8ab8-0e690a2213c2` with correlation id `qa-manager-to-worker`.
- Dispatch processed it in watch iteration 1 and returned:
  - `state`: `pull_required`
  - `delivery_mode`: `pull_required`
  - `notification_id`: `1`
  - `target_session`: `qa-inbox-ops-20260530045042-worker`
  - `side_effect_started`: `false`
  - `side_effect_completed`: `false`
- `worker-inbox --json` before consumption showed one pending delivered item:
  - `signal_type`: `nudge_worker`
  - `delivery_mode`: `pull_required`
  - source session: `qa-inbox-ops-20260530045042-manager`
  - target session: `qa-inbox-ops-20260530045042-worker`
  - `consumed_at`: `null`
  - `consumed_by_session_id`: `null`
- `worker-inbox --consume-next --json` consumed notification `1`:
  - `consumed_by_session_id`: worker session id
  - `consumed_at`: `2026-05-30T11:50:43Z`

## Worker To Manager

- Appended a synthetic `task_complete` event to the worker rollout and ran `ingest`.
- Dispatch processed the completion in watch iteration 1 and returned:
  - `state`: `pull_required`
  - `delivery_mode`: `pull_required`
  - `notification_id`: `2`
  - `signal_type`: `worker_task_complete`
  - `source_event_id`: `2`
  - `target_session`: `qa-inbox-ops-20260530045042-manager`
- `manager-inbox --json` before consumption showed one pending delivered item:
  - `signal_type`: `worker_task_complete`
  - `delivery_mode`: `pull_required`
  - source session: `qa-inbox-ops-20260530045042-worker`
  - target session: `qa-inbox-ops-20260530045042-manager`
  - worker receipt: `QA worker completed inbox polling acknowledgement.`
  - `consumed_at`: `null`
  - `consumed_by_session_id`: `null`
- `manager-inbox --consume-next --json` consumed notification `2`:
  - `consumed_by_session_id`: manager session id
  - `consumed_at`: `2026-05-30T11:50:43Z`

## Replay And Dashboard Evidence

- `replay --json` included both routed notification entries with:
  - `delivery_mode`: `pull_required`
  - source and target session ids/names
  - delivered timestamps
  - consumed-by session ids/names
  - consumed timestamps
  - command attempt linkage for the `nudge_worker` command
- Dashboard helper output:
  - inbox `consumed_count`: `2`
  - inbox `pending_count`: `0`
  - inbox `pull_required_pending_count`: `0`
  - worker session consumed count: `1`
  - manager session consumed count: `1`
  - dispatch health: `active`
  - dispatcher id: `qa-inbox-ops`
  - processed count: `1`
  - queued/failed/stale/risk/suppressed counts: `0`
- Dashboard chain entries showed:
  - `nudge_worker` command -> attempt `1` -> notification `1`, delivered via `pull_required` to the worker and consumed by the worker.
  - `worker_task_complete` source event `2` -> notification `2`, delivered via `pull_required` to the manager and consumed by the manager.

## Result

Pass. The disposable no-tmux drill proved manager-to-worker and worker-to-manager dispatcher signals both work through inbox polling, with replay/dashboard evidence for delivery mode, session route, consumption owner/timestamp, heartbeat, and command attempt linkage.
