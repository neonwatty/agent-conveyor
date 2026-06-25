# Landing Media Capture Plan

Use this plan to produce public landing-page screenshots or a short video of
Agent Conveyor controlling visible Codex app manager and worker sessions.

## Goal

Capture one credible app-native run:

- An operator starts from a normal target project.
- Agent Conveyor proves `operator_ready=true`.
- The operator creates one visible Codex app manager and multiple visible Codex
  app workers.
- Required app smoke passes for every worker shard before real work starts.
- The manager fans out UX polish work, ideally using Limner for screenshot-led
  review.
- Workers return screenshot or visual-diff evidence through Conveyor receipts.
- Replay or audit output proves why the manager continued, stopped, or closed.

## Suggested Demo

Use a low-risk fixture project with a visible UI issue, not private product
code. A good demo is a small web page with three intentionally rough sections:
hero spacing, mobile navigation, and button/card polish.

Ask the operator session:

```text
Use the conveyor-create-worker-set skill.

Set up a Codex app worker set for UX polish on this fixture project.
Create one manager and three workers:
- hero polish
- responsive polish
- evidence polish

Require app smoke before real work. Use Limner or screenshot/visual-diff
evidence for every worker result. Do not touch private files.
```

## Capture Beats

Record these moments in order:

1. `conveyor doctor --json` reports `ok=true` and `operator_ready=true`.
2. The Codex app shows one manager thread and multiple worker threads with
   readable titles.
3. Required `app-smoke` runs before any task prompt is sent.
4. `app-smoke status` reports `real_work_allowed=true` for every shard.
5. `app-autopilot status` reports readiness, or the operator explicitly marks
   the setup as manual-poll only.
6. The manager sends visible UX polish slices through Dispatch.
7. Each worker prints the visible session sections:
   `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, and
   `DISPATCH`.
8. Workers return screenshot paths, visual-diff reports, or Limner review
   receipts.
9. `conveyor replay "$TASK"` or `conveyor audit "$TASK" --json` shows the
   durable proof behind the visible app story.

## Assets To Save

Save the raw capture outside the repo first. After review, commit only polished,
non-sensitive assets.

- `docs/media/agent-conveyor-app-smoke-worker-set.mp4`
- `docs/media/agent-conveyor-app-smoke-worker-set-poster.png`
- `docs/media/agent-conveyor-ux-polish-receipts.png`

Keep the video under 90 seconds if possible. Crop to the Codex app and terminal
surfaces needed for the story. Blur project names, file paths, account names,
emails, and private code.

## Landing Page Acceptance

Do not add the media to `docs/landing-page.html` until the asset proves all of:

- It shows real Codex app threads, not a static diagram.
- It includes the smoke gate before real work.
- It includes manager and worker activity after smoke passes.
- It includes at least one screenshot, visual-diff, or Limner evidence receipt.
- It includes replay, audit, or status output as durable proof.

After adding media, run:

```bash
node scripts/check-landing-page.mjs
```

Then inspect the generated desktop and mobile screenshots before handoff.
