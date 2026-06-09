# T005 Runtime Parity Audit

T005 ports the tmux, Codex rollout discovery, JSONL ingest, and classifier
runtime layer into TypeScript without switching the public CLI command handlers
away from the compatibility bridge yet.

## Ported TypeScript Surfaces

| Python source | TypeScript source | Proof |
| --- | --- | --- |
| archived `workerctl/tmux.py` command builders, permission text, paste-buffer cleanup, session pane targeting | `src/runtime/tmux.ts` | `src/runtime/runtime.test.ts` covers argument order, liveness checks, permission normalization, cleanup on failure, pane targets, and side-effect audit flags. |
| archived `workerctl/codex_session.py` session metadata, native pid selection, lsof rollout lookup, discovery result shape | `src/runtime/codex-session.ts` | `src/runtime/runtime.test.ts` covers metadata parsing, lsof path extraction, pid-to-native-child selection, and end-to-end discovery with fixtures. |
| archived `workerctl/ingest.py` JSONL parser and one-session ingest cycle | `src/runtime/ingest.ts` | `src/runtime/runtime.test.ts` covers offsets, malformed complete lines, partial trailing lines, event persistence, heartbeat/offset update, telemetry, idempotent re-ingest, appended partial completion, and shrink refusal. |
| archived `workerctl/classify.py` startup and busy-wait classifier | `src/runtime/classify.ts` | `src/runtime/runtime.test.ts` covers classifier scenarios: trust, ready, working, empty, error, MCP startup, rate limit, Enter confirmation, trust prompt, plan prompt, active approval, historical approval negative control, fresh status suppression, and recent-event long-running suppression. |

## Bridge Decision

This note records the historical T005 bridge decision. The public `conveyor`
and `workerctl` command handlers now use the TypeScript runtime; the Python
runtime is archived under `docs/archive/python-runtime`.

The remaining command-handler migration belongs to T006/T007:

- T006 owns lifecycle, Dispatch, inbox, audit/replay/export, and
  dashboard-facing CLI behavior.
- T007 owns npm package/install/release/CI/docs conversion and final tarball
  behavior.

T005 was complete when the TypeScript runtime helpers passed local gates while
the compatibility bridge was still present. Later migration stages removed the
bridge and archived the Python runtime.

## Strongest Failure Mode

The strongest realistic T005 failure mode is a false sense of migration
progress: helper functions pass in TypeScript, but a live/public command path
silently changes tmux target selection, rollout offsets, classifier decisions,
or CLI error behavior.

Disproof evidence:

- Node runtime tests exercise the TypeScript behavior directly.
- The archived command inventory and TypeScript migration audit preserve the
  historical CLI contract without executing Python.
- `npm run build` proves the TypeScript helper API compiles into the package.
- The GoalBuddy board keeps T006/T007 queued for public command-handler and
  package-routing migration before final completion.
