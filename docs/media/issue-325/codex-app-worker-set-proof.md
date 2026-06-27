# Codex App Manager/Worker Set Proof

Issue: <https://github.com/neonwatty/agent-conveyor/issues/325>

Run date: June 26, 2026

This proof package documents a live Codex app manager coordinating a three-worker
Codex app worker set through Agent Conveyor. It is intentionally scoped to the
manager/worker capability, not dashboard rendering and not fixture UI polish.

## App Threads

| Role | Codex app thread |
| --- | --- |
| Manager | `019f046b-2cc7-7a93-96c0-9bf85a33c97b` |
| Hero polish worker | `019f046b-2e04-7f53-ac09-7703cfead2df` |
| Responsive polish worker | `019f046b-2f5c-7753-b36b-0c2fa7e018d9` |
| Evidence polish worker | `019f046b-30f5-7ce1-8a68-61c136724985` |

The app-thread transcripts show the manager and workers standing by, smoke
receipts, manager fan-out, worker lifecycle sections, worker reports, and
manager review.

## Codex App Window Media

This package includes sanitized screenshots captured from the actual Codex app
window:

| File | What it shows |
| --- | --- |
| `codex-app-window-media/codex-app-manager-thread-sanitized.png` | Manager thread accepting worker result notifications `10`, `11`, and `12`. |
| `codex-app-window-media/codex-app-responsive-thread-sanitized.png` | Responsive worker thread with visible worker title and proof of post-smoke work/evidence. |
| `codex-app-window-media/codex-app-evidence-thread-sanitized.png` | Evidence worker thread with visible worker title and produced evidence attachments. |
| `codex-app-window-media/codex-app-hero-thread-sanitized.png` | Hero worker thread with visible worker title, receipt notification `7`, and manager notification `10`. |

The captures were cropped and redacted before commit to remove account footer
content, unrelated lower sidebar items, and local filesystem paths.

## Smoke Gate

`aggregate-smoke-status-before-fanout.json` recorded:

```json
{
  "recorded_at": "2026-06-26T15:01:52Z",
  "all_real_work_allowed": true
}
```

All three shards had `real_work_allowed: true` and no blockers.

## Worker Set Flow

| Worker task | Manager fan-out | Worker notification | Worker report | Manager notification |
| --- | --- | --- | --- | --- |
| `issue-325-capture-hero-polish` | `command-c8965404-b8ed-44ea-bc9f-28dde73244e6` | `7` | `command-6fc5dd4b-484d-43cc-8018-f339d713ed78` | `10` |
| `issue-325-capture-responsive-polish` | `command-2b1399ed-ecdb-4483-bdb6-974c1671f7ff` | `8` | `command-aff5feb3-f846-4907-81d9-3e98d1b690a3` | `11` |
| `issue-325-capture-evidence-polish` | `command-57da3e3b-5b86-41b8-8696-e5932f201a8a` | `9` | `command-f25f2d0f-8a4d-4bbe-9e36-d37309e62b8e` | `12` |

For every worker:

- the manager fan-out command succeeded;
- Dispatch delivered the worker notification;
- the worker consumed the notification;
- the worker recorded received and accepted acknowledgements;
- the worker report command succeeded;
- Dispatch delivered the manager notification;
- the manager consumed the notification;
- the manager recorded accepted acknowledgement receipts.

## Durable Receipts

This directory includes the sanitized receipt backing:

| File | Purpose |
| --- | --- |
| `aggregate-smoke-status-before-fanout.json` | Pre-fan-out app-smoke gate. |
| `codex-app-worker-set-proof-summary.json` | Extracted and asserted proof summary. |
| `codex-app-worker-set-proof.png` | Sanitized visual receipt card generated from the asserted summary. |

Raw `conveyor audit` exports were used locally to build and verify the summary,
but they are not included here because worker payloads can contain local paths.

## Verification

Run from the repository root:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';

const base = 'docs/media/issue-325';
const summary = JSON.parse(fs.readFileSync(`${base}/codex-app-worker-set-proof-summary.json`, 'utf8'));

if (!summary.smoke.all_real_work_allowed) {
  throw new Error('smoke gate did not allow real work');
}
if (summary.smoke.shards.some((shard) => !shard.real_work_allowed || shard.blocker_count !== 0)) {
  throw new Error('one or more smoke shards were blocked');
}
if (summary.workers.length !== 3) {
  throw new Error('expected three workers');
}
for (const worker of summary.workers) {
  if (!worker.workerLifecycle.received_ack || !worker.workerLifecycle.accepted_ack) {
    throw new Error(`${worker.task}: worker lifecycle ack missing`);
  }
  if (worker.workerReport.command_state !== 'succeeded') {
    throw new Error(`${worker.task}: worker report command did not succeed`);
  }
  if (!worker.workerReport.delivered_at || !worker.workerReport.consumed_at || !worker.workerReport.consumed_by) {
    throw new Error(`${worker.task}: manager delivery/consumption proof missing`);
  }
  if (worker.managerAcceptedCount < 1) {
    throw new Error(`${worker.task}: manager acceptance missing`);
  }
}
console.log(JSON.stringify({ ok: true, workers: summary.workers.length }));
NODE
```

## Limitation

Computer Use direct inspection of the Codex app remains blocked by app safety
policy, so window media was captured through macOS `screencapture` after Screen
Recording permission was granted. Raw captures were not committed; only
sanitized screenshots are included.
