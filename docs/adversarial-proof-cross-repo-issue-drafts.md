# Cross-Repo Adversarial Proof Issue Drafts

Source: [codex-terminal-manager issue #176](https://github.com/neonwatty/codex-terminal-manager/issues/176)

Window used: local Git repositories with commits in the last 14 days as of
2026-05-31. Duplicate local checkouts that point at the same remote are folded
into one draft. Temporary Ralph-loop/canary checkouts are omitted unless they
are promoted to durable repos.

## Created Issues

- `mean-weasel/issuectl`: https://github.com/mean-weasel/issuectl/issues/580
- `mean-weasel/bleep-that-shit`: https://github.com/mean-weasel/bleep-that-shit/issues/1240
- `mean-weasel/seatify`: https://github.com/mean-weasel/seatify/issues/1292
- `mean-weasel/bugdrop`: https://github.com/mean-weasel/bugdrop/issues/195
- `mean-weasel/bugdrop-web`: https://github.com/mean-weasel/bugdrop-web/issues/48
- `neonwatty/blog`: https://github.com/neonwatty/blog/issues/226
- `neonwatty/stay-caffeinated`: https://github.com/neonwatty/stay-caffeinated/issues/3
- `mean-weasel/deckchecker`: https://github.com/mean-weasel/deckchecker/issues/1133
- `mean-weasel/prbar`: https://github.com/mean-weasel/prbar/issues/102
- `mean-weasel/playwright-dashboard`: https://github.com/mean-weasel/playwright-dashboard/issues/102
- `mean-weasel/foil`: https://github.com/mean-weasel/foil/issues/186
- `neonwatty/phone-lunk-alarm`: https://github.com/neonwatty/phone-lunk-alarm/issues/21
- `neonwatty/manager-test-app`: https://github.com/neonwatty/manager-test-app/issues/2
- `grumpy-pig/uni-debt-endow`: https://github.com/grumpy-pig/uni-debt-endow/issues/24
- `neonwatty/workerctl-dispatch-lab`: https://github.com/neonwatty/workerctl-dispatch-lab/issues/5
- `mean-weasel/macos-e2e-runners`: https://github.com/mean-weasel/macos-e2e-runners/issues/18
- `mean-weasel/smart-reminders`: https://github.com/mean-weasel/smart-reminders/issues/4

Skipped:
- `neonwatty/meme-search`, per user request.
- `neonwatty/codex-terminal-manager`; the source issue already exists as
  https://github.com/neonwatty/codex-terminal-manager/issues/176.

## Shared Addition

Use this wording for `AGENTS.md`, `CLAUDE.md`, contributor docs, QA runbooks,
manager prompts, release checklists, and workflow templates:

```md
Before declaring work complete, try to disprove the change. Identify the
strongest realistic failure mode, verify it with a command, test, trace,
screenshot, audit record, diff, or direct inspection, and include that evidence
in the final handoff.

Treat `done`, `tests passed`, worker claims, passing happy-path tests, generated
summaries, and optimistic UI as claims, not proof. Treat unverified assumptions
as blockers or explicit follow-ups.
```

For higher-risk areas, add:

```md
For auth, data loss, billing, release, automation, external integrations, SEO,
analytics, mobile packaging, or live-data work, include at least one negative
or adversarial case, not only the happy path.
```

## Draft Issues

### neonwatty/codex-terminal-manager

Title: Add adversarial burden-of-proof guidance to manager prompts and repo instructions

Body:

Add the issue #176 burden-of-proof stance to the surfaces future manager and
agent sessions actually read: `AGENTS.md`, `CLAUDE.md`,
`skills/manage-codex-workers/SKILL.md`, README manager docs, and the manager
bootstrap prompt.

Acceptance criteria:
- Manager bootstrap prompts say to disprove the change before declaring work complete.
- Repo-level agent instructions include the shared wording.
- Manager docs say worker claims, happy-path tests, and summaries are claims, not proof.
- Tests cover the prompt/docs wording.

Suggested verification: `python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v`.

### mean-weasel/issuectl

Title: Add adversarial proof gate to issue and PR orchestration instructions

Body:

Add the shared burden-of-proof guidance to `AGENTS.md`, `CLAUDE.md`, iOS smoke
runbooks, and any PR/issue automation handoff docs. This repo has high leverage
because it coordinates issues, PRs, preview app flows, and device/simulator
verification where "looks done" can hide stale state or incomplete routing.

Acceptance criteria:
- `AGENTS.md` and `CLAUDE.md` require a strongest realistic failure mode before final handoff.
- PR/issue automation docs require a command, simulator trace, screenshot, or inspection receipt.
- iOS preview/device smoke docs include at least one negative case for routing, auth, or state drift.
- Final handoffs list unresolved proof gaps as blockers or follow-ups.

Suggested verification: `npm run test`, plus the narrow iOS smoke command relevant to the changed docs.

### mean-weasel/bleep-that-shit

Title: Require falsification evidence for upload, download, payment, and analytics work

Body:

Add the shared adversarial proof wording to `AGENTS.md`, `CLAUDE.md`, QA docs,
and pre-PR verification docs. Emphasize flows where happy-path success is weak
proof: uploads, generated media, downloads, checkout sessions, mobile handoff,
PostHog analytics, and live preview/production smoke tests.

Acceptance criteria:
- Agent instructions require one negative or adversarial case for auth, billing, file, analytics, and release work.
- Verification docs distinguish "button appeared" from a receipt such as network trace, audit row, downloaded file inspection, or PostHog event.
- Live smoke handoffs name the strongest realistic failure mode and the evidence that rules it out.

Suggested verification: `npm run validate` when feasible, or the narrow `npm run test:unit`, `npm run test:smoke`, and relevant live/analytics script.

### mean-weasel/seatify

Title: Add adversarial proof gates for beta data, live QA, and mobile flows

Body:

Add the shared burden-of-proof guidance to `CLAUDE.md`, QA preset docs, beta
data import/enrichment docs, and mobile/Capacitor handoff notes. Seatify work
often involves authenticated state, live Supabase data, optimization output,
and mobile UI, so completion should require evidence beyond a passing happy path.

Acceptance criteria:
- `CLAUDE.md` requires a strongest realistic failure mode and evidence before final handoff.
- Beta/live QA docs require an audit row, trace, screenshot, or direct data inspection for risky flows.
- Data import/enrichment work includes a negative case for stale data, duplicate rows, or wrong-user visibility.
- Mobile handoffs include a simulator/device screenshot or trace when UI behavior changes.

Suggested verification: use the relevant focused command, such as `npm run test:run`,
`npm run test:e2e:qa-smoke`, or the matching live/guardrail script.

### mean-weasel/bugdrop

Title: Add burden-of-proof completion checks to Bugdrop agent and QA docs

Body:

Add the shared adversarial proof guidance to `CLAUDE.md`, `CONTRIBUTING.md`,
widget build docs, e2e docs, and Cloudflare/Wrangler release notes. Bugdrop has
SDK/widget and deployment surfaces where optimistic local success can miss
browser, bundling, or edge-runtime failures.

Acceptance criteria:
- `CLAUDE.md` and contributor docs require a falsification pass before done.
- Widget and deployment docs require evidence from build output, browser/e2e check, or Wrangler/dev trace.
- Final handoffs list the failure mode checked and the command or inspection used.

Suggested verification: `npm run validate`, or focused `npm run test`,
`npm run typecheck`, and `npm run test:e2e`.

### mean-weasel/bugdrop-web

Title: Add adversarial proof checks for SEO, conversion, and deployment changes

Body:

Add the shared burden-of-proof guidance to `AGENTS.md`, `CLAUDE.md`, SEO docs,
and launch/deployment checklists. For this marketing/web repo, the proof gate
should focus on SEO metadata, sitemap/indexing, CTA routing, performance, and
broken public paths.

Acceptance criteria:
- Agent instructions require falsification evidence before completion.
- SEO/deployment docs require direct inspection of metadata, sitemap output, rendered page, or route behavior.
- CTA/conversion changes include at least one negative case, such as missing env config or broken destination.

Suggested verification: `npm run lint`, `npm run build`, and the relevant SEO/indexing script or page inspection.

### neonwatty/blog

Title: Add adversarial proof gate to publishing, SEO, and content automation docs

Body:

Add the shared burden-of-proof guidance to `AGENTS.md`, publishing docs, SEO
checks, and visual/content automation runbooks. Blog work should verify not just
that a page builds, but that metadata, feeds, sitemap entries, links, and admin
paths remain correct.

Acceptance criteria:
- `AGENTS.md` requires a strongest realistic failure mode and evidence in final handoffs.
- Publishing docs require checks for RSS, sitemap, OG image, link integrity, and admin/editor regressions where relevant.
- Content automation handoffs include a direct inspection or test receipt, not only generated prose.

Suggested verification: `npm run validate`, or focused `npm run test`,
`npm run check:sitemap`, `npm run check:links`, and relevant e2e tests.

### neonwatty/stay-caffeinated

Title: Add adversarial proof guidance for game/site build, export, and e2e work

Body:

Add the shared proof-gate wording to contributor docs and, if absent, create
`AGENTS.md` and `CLAUDE.md`. Focus the adversarial check on generated assets,
static export, sprite generation, and e2e-visible behavior.

Acceptance criteria:
- Repo-level agent instructions exist and include the shared wording.
- Asset/build docs require evidence for missing sprites, stale generated images, broken static export, and route regressions.
- Final handoffs include the strongest realistic failure mode and a command, screenshot, or inspection receipt.

Suggested verification: `npm run precommit`, or focused `npm run test`,
`npm run build:prod`, and `npm run e2e`.

### neonwatty/meme-search

Title: Add cross-stack falsification checks to Rails, Python, and Playwright handoffs

Body:

Add the shared burden-of-proof guidance to `CLAUDE.md`, `CONTRIBUTING.md`, and
CI/e2e docs. This repo spans Rails, Python, and Playwright, so proof should name
which layer could still be wrong and include evidence from the matching test or
inspection.

Acceptance criteria:
- Agent instructions require a falsification pass before final handoff.
- CI docs require layer-specific proof for Rails, Python, e2e, and Docker e2e changes.
- Final handoffs distinguish skipped e2e from ruled-out e2e risk.

Suggested verification: `npm run test:ci`, or focused `npm run test:rails`,
`npm run test:python`, and `npm run test:e2e`.

### mean-weasel/deckchecker

Title: Add adversarial proof checks for deck analysis and generation workflows

Body:

Add the shared burden-of-proof guidance to root and web `CLAUDE.md` files plus
analysis/generator docs. Deckchecker changes should identify the strongest
realistic failure mode in parsing, detection, report generation, or web display
and verify it with a command, fixture, screenshot, or direct inspection.

Acceptance criteria:
- Both `CLAUDE.md` files include the shared wording.
- Detection/generator docs require fixture-backed negative or adversarial checks.
- Web UI work includes screenshot or browser inspection evidence when rendering changes.

Suggested verification: `pnpm test`, `pnpm lint`, `pnpm typecheck`, or the package-specific focused command.

### mean-weasel/prbar

Title: Add proof-gate guidance for macOS menu bar release and PR workflows

Body:

Create repo-level `AGENTS.md` and `CLAUDE.md` with the shared burden-of-proof
wording, then add the same stance to macOS release and mockup verification docs.
The key failure modes are stale PR state, broken menu bar behavior, packaging
drift, and version mismatch.

Acceptance criteria:
- Repo-level agent instruction files exist.
- Release/version docs require a strongest realistic failure mode and a receipt.
- UI work includes simulator/app screenshot, accessibility inspection, or direct app behavior evidence where practical.

Suggested verification: `npm run version:check`, `npm run verify:ios-mockups`, and the relevant Xcode build/test path.

### mean-weasel/playwright-dashboard

Title: Add adversarial completion checks to dashboard automation instructions

Body:

Add the shared burden-of-proof wording to `AGENTS.md` and dashboard QA docs.
Playwright dashboard work should verify that tests are not merely green but that
the dashboard reports the right run, browser, artifact, and failure state.

Acceptance criteria:
- `AGENTS.md` requires falsification evidence before done.
- QA docs require at least one negative case for missing artifact, stale run state, or wrong browser/project selection.
- Final handoffs include screenshot, trace, or direct data inspection evidence for UI-affecting changes.

Suggested verification: the repo's Swift/Playwright dashboard test command or focused manual screenshot/trace inspection.

### mean-weasel/foil

Title: Add adversarial proof guidance for macOS app and local workflow changes

Body:

Create `AGENTS.md` and `CLAUDE.md` with the shared burden-of-proof wording.
Add the same stance to macOS build/run docs once they exist. Foil changes should
name the realistic failure mode in app launch, menu/window state, persistence,
or packaging, then verify it with a build, app run, screenshot, or inspection.

Acceptance criteria:
- Repo-level agent instruction files exist.
- macOS workflow docs require a command or app inspection receipt before done.
- Final handoffs identify unresolved simulator/device/app evidence gaps as follow-ups.

Suggested verification: relevant Xcode build/test command plus direct app inspection for UI changes.

### neonwatty/phone-lunk-alarm

Title: Add adversarial proof checks for landing, alarm, and deployment flows

Body:

Create repo-level `AGENTS.md` and `CLAUDE.md` with the shared wording, then
mirror it in deployment and e2e docs. For alarm/landing work, the failure mode
should cover generated images, sitemap output, notification/alarm behavior,
broken routes, or env-dependent deployment behavior.

Acceptance criteria:
- Repo-level agent instructions exist.
- Build/deployment docs require evidence for route, metadata, generated image, and alarm behavior changes.
- Final handoffs include the strongest failure mode and command, screenshot, or direct inspection used.

Suggested verification: `npm run build`, `npm run test:ci`, `npm run test:e2e`, or `npm run test:deployment`.

### neonwatty/manager-test-app

Title: Add repo-level adversarial proof instructions for manager test fixtures

Body:

Create `AGENTS.md` and `CLAUDE.md` with the shared burden-of-proof wording.
Manager fixture apps are easy to over-trust because they are small; require a
negative check that proves the fixture still exercises the intended manager
behavior and has not become a happy-path-only demo.

Acceptance criteria:
- Repo-level instruction files exist.
- Test fixture docs require a strongest realistic failure mode and verification evidence.
- Final handoffs identify whether the fixture was verified with Vitest, build, browser inspection, or all three.

Suggested verification: `npm run test`, `npm run build`, and focused browser inspection when UI changes.

### grumpy-pig/uni-debt-endow

Title: Add adversarial proof checks for data refresh and visualization work

Body:

Create repo-level `AGENTS.md` and `CLAUDE.md` with the shared wording. For data
and visualization work, the strongest realistic failure mode is often stale
source data, bad normalization, misleading chart output, or a broken generated
artifact that still builds.

Acceptance criteria:
- Repo-level instruction files exist.
- Data refresh docs require `data:check` or direct output inspection before done.
- Visualization changes include a negative case for empty, stale, or malformed data.
- Final handoffs include the checked failure mode and command/inspection receipt.

Suggested verification: `npm run data:check`, `npm run test`, and `npm run build`.

### neonwatty/workerctl-dispatch-lab

Title: Add adversarial proof gates to Dispatch lab scenarios

Body:

Create repo-level `AGENTS.md` and `CLAUDE.md` with the shared wording. Add the
same burden-of-proof stance to lab scenario docs so each Dispatch test names
the strongest realistic coordination failure, such as stale command lease,
missing manager wakeup, wrong task binding, or false completion.

Acceptance criteria:
- Repo-level instruction files exist.
- Lab scenario docs require a negative Dispatch or state-drift check.
- Final handoffs include pytest output or direct SQLite/event inspection evidence.

Suggested verification: `pytest`.

### mean-weasel/macos-e2e-runners

Title: Add adversarial proof guidance for macOS e2e runner reliability

Body:

Create repo-level `AGENTS.md` and `CLAUDE.md` with the shared wording. Runner
work should assume "the run passed" may hide stale app state, wrong device,
missed artifact capture, or a silently skipped scenario until evidence proves
otherwise.

Acceptance criteria:
- Repo-level instruction files exist.
- Runner docs require proof of device/app identity, artifact capture, and skipped-test detection.
- Final handoffs name the failure mode and include command output, screenshot, log, or artifact inspection.

Suggested verification: the repo's runner smoke command once identified, plus direct artifact inspection.

### mean-weasel/smart-reminders

Title: Add adversarial proof checks for reminder scheduling and iOS/macOS behavior

Body:

Create repo-level `AGENTS.md` and `CLAUDE.md` with the shared wording. Reminder
apps need skeptical checks around scheduling, permissions, notification timing,
timezone behavior, and persistence across app lifecycle events.

Acceptance criteria:
- Repo-level instruction files exist.
- App QA docs require a negative case for permissions, timezone/scheduling drift, or persistence.
- Final handoffs include simulator/device evidence or direct model/storage inspection.

Suggested verification: relevant Xcode build/test command plus simulator inspection for behavior changes.

## Local-Only Candidates

These active directories had no `origin` remote in the scan, so create issues
only after confirming their canonical repo:

- `/Users/neonwatty/Documents/analytics`
- `/Users/neonwatty/Desktop/support-queue-reporter-late-attach`

Suggested title for both once mapped: Add adversarial burden-of-proof guidance
to repo instructions and QA handoffs.
