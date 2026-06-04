# TypeScript Migration Dashboard Contract

The dashboard is already TypeScript and must remain green throughout the CLI
migration.

## Current TS Patterns To Preserve

- Root package uses ESM (`"type": "module"`).
- Dashboard runtime uses `tsx dashboard/server/index.ts`.
- Dashboard tests use native `node:test` through
  `dashboard/scripts/run-tests.mjs`.
- Local TS imports use explicit `.ts` extensions.
- `dashboard/tsconfig.json` is strict, no-emit, and dashboard-scoped.
- Workerctl dashboard integration builds argv arrays directly and avoids shell
  interpolation.
- PTY/tmux attach validates unsafe session names before spawning.
- Dashboard server tolerates optional audit/snapshot telemetry failures where
  current behavior does.

## Current Dashboard Test Coverage

`dashboard/server/workerctl.test.ts` currently covers:

- workerctl argv builders
- snapshot/audit/telemetry/task commands
- bind/create/pair/nudge/interrupt/finish/export args
- Dispatch correlation chains
- inbox delivery and consumption evidence
- blocked loop policy
- Dispatch heartbeat and health summaries
- terminal session name safety
- resize/control message parsing

The TS CLI migration must not remove this coverage or make dashboard tests pass
by stubbing out meaningful CLI behavior.

## Shared Code Boundary

Future shared TS CLI code should be introduced in a separate distributable
boundary, such as `src/**`, and imported by dashboard code only where it remains
browser/server-safe. Do not import `dashboard/server/index.ts` from CLI code.
Avoid dragging Vite/React/browser dependencies into the CLI runtime.

## T006 Runtime Boundary

T006 introduced an opt-in TypeScript runtime for the dashboard-facing migrated
audit, replay, and subset export surfaces. The default dashboard workerctl path
and runtime remain Python-backed until T007 package wiring decides the npm
install path and proves clean tarball behavior.

Allowed opt-in TS runtime surfaces:

- `audit <task> --json`
- `replay <task> --json`
- `export-task <task>` for the migrated audit subset only

The TypeScript runtime must reject unsupported commands and must reject full
export flags such as `--zip`, `--include-transcripts`, and
`--include-full-transcripts` until those surfaces have their own parity proof.
The dashboard command builder may construct guarded `--ts-runtime` argv arrays
only for audit, replay, and export.

## Verification

Required checks after dashboard-facing changes:

```bash
npm test -- --runInBand
npm run build
```

For frontend/dashboard user-facing changes, add browser inspection or screenshot
evidence according to `docs/agent-evidence-playbook.md`.

## Contract Drift Disproof Gate

The strongest dashboard-specific failure mode is a TS CLI refactor that leaves
unit tests green but breaks live dashboard command execution or PTY safety.
Disproof requires both argv/terminal tests and, for dashboard behavior changes,
an actual dashboard or browser-backed check that the page can still issue safe
commands through the expected executable.
