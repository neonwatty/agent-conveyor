# T005 Runtime Parity Audit

T005 ports the tmux, Codex rollout discovery, JSONL ingest, and classifier
runtime layer into TypeScript without switching the public CLI command handlers
away from the compatibility bridge yet.

## Ported TypeScript Surfaces

| Python source | TypeScript source | Proof |
| --- | --- | --- |
| `workerctl/tmux.py` command builders, permission text, paste-buffer cleanup, session pane targeting | `src/runtime/tmux.ts` | `src/runtime/runtime.test.ts` covers argument order, liveness checks, permission normalization, cleanup on failure, pane targets, and side-effect audit flags. |
| `workerctl/codex_session.py` session metadata, native pid selection, lsof rollout lookup, discovery result shape | `src/runtime/codex-session.ts` | `src/runtime/runtime.test.ts` covers metadata parsing, lsof path extraction, pid-to-native-child selection, and end-to-end discovery with fixtures. |
| `workerctl/ingest.py` JSONL parser and one-session ingest cycle | `src/runtime/ingest.ts` | `src/runtime/runtime.test.ts` covers offsets, malformed complete lines, partial trailing lines, event persistence, heartbeat/offset update, telemetry, idempotent re-ingest, appended partial completion, and shrink refusal. |
| `workerctl/classify.py` startup and busy-wait classifier | `src/runtime/classify.ts` | `src/runtime/runtime.test.ts` covers Python classifier scenarios: trust, ready, working, empty, error, MCP startup, rate limit, Enter confirmation, trust prompt, plan prompt, active approval, historical approval negative control, fresh status suppression, and recent-event long-running suppression. |

## Bridge Decision

Public `conveyor` and `workerctl` command handlers still intentionally route
through `src/cli/python-bridge.ts` for T005. That preserves the frozen CLI
contract while the runtime modules move to TypeScript in testable pieces.

The remaining command-handler migration belongs to T006/T007:

- T006 owns lifecycle, Dispatch, inbox, audit/replay/export, and
  dashboard-facing CLI behavior.
- T007 owns npm package/install/release/CI/docs conversion and final tarball
  behavior.

This means T005 is complete when the TypeScript runtime helpers pass local
gates and the Python compatibility suite still passes. It does not claim that
the public CLI no longer executes Python.

## Strongest Failure Mode

The strongest realistic T005 failure mode is a false sense of migration
progress: helper functions pass in TypeScript, but a live/public command path
silently changes tmux target selection, rollout offsets, classifier decisions,
or CLI error behavior.

Disproof evidence:

- Node runtime tests exercise the TypeScript behavior directly.
- The full Python compatibility suite still passes under an isolated state
  root, proving the bridge-backed public CLI behavior was not regressed.
- `npm run build` proves the TypeScript helper API compiles into the package.
- The GoalBuddy board keeps T006/T007 queued for public command-handler and
  package-routing migration before final completion.
