# TypeScript Migration QA Gate Matrix

The migration must preserve the existing evidence ladder from
`docs/agent-evidence-playbook.md`: name the strongest realistic failure mode,
run or inspect evidence that would expose it, and record residual risk.

## Deterministic Local Gates

Current baseline before the migration board:

| Gate | Command | Current baseline |
| --- | --- | --- |
| Python unit tests | `python3 -m unittest discover -s tests -v` | pass, 645 tests |
| ResourceWarning gate | `scripts/check-resource-warnings` | pass, 645 tests |
| Python compile gate | `python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py` | pass |
| Node/dashboard tests | `npm test -- --runInBand` | pass, 161 tests |
| Dashboard build | `npm run build` | pass |
| TypeScript migration audit | `npm run migration:audit:final` | pass after package cutover; npm tarball has no Python runtime/bridge files |
| Shell syntax | `bash -n scripts/live-smoke scripts/live-smoke-repeat scripts/package-smoke scripts/release-check scripts/rc-check` | pass |

While Python remains in the repository, the Python gates remain required. A
TypeScript replacement may retire them only after equivalent TypeScript gates
and package smoke prove the migrated command surface no longer imports or
executes Python for the migrated paths.

## Release-Candidate Gate

`scripts/rc-check --skip-live-smoke-repeat` currently runs:

- Python unittest.
- ResourceWarning gate.
- Python compile gate.
- TypeScript migration audit.
- Dashboard tests.
- Dashboard build.
- Smoke script syntax checks.

The TypeScript migration must keep an equivalent deterministic RC gate. Broad
CLI, Dispatch, dashboard, or packaging changes should use the RC gate before
PR/merge claims.

## Package And Release Gates

Current gates are Python wheel/sdist based:

- `scripts/package-smoke`
- `scripts/release-check`
- `.github/workflows/publish.yml`
- `docs/package-release.md`

The migration must replace these with npm tarball semantics while preserving:

- `conveyor --help`
- `workerctl --help`
- `install-skills --json`
- bundled `manage-codex-workers` and `codex-review` assets
- executable `codex-review/scripts/codex-review`
- stale command text guard for installed skills
- TypeScript migration audit receipt; Board 13/14 must use
  `npm run migration:audit:final` after Python runtime removal.

## Live And Manual QA Gates

Live gates depend on local `tmux`, `codex`, and environment state:

- `scripts/live-smoke`
- `scripts/live-smoke-repeat 3`
- `scripts/workerctl sessions --state active`
- `scripts/workerctl reconcile --stale-cycles-seconds 1`

Manual and receipt-driven gates include:

- `docs/manual-qa-checklist.md`
- `docs/qa/README.md`
- `docs/qa/evidence-template.md`
- `conveyor qa-run ralph-loop-guardrails`
- `conveyor qa-run generic-loop-template`
- `conveyor qa-run generic-loop-template-browser`
- `conveyor qa-run test-coverage-loop`
- `conveyor qa-run adversarial-triggers`
- `conveyor qa-run build-clear-loop`

If live Codex/tmux is unavailable, record that as a specific blocker for the
live gate and continue deterministic local work.

## CI Gates

Current CI:

- `.github/workflows/test.yml` uses macOS, Node 24, `npm ci`,
  `scripts/rc-check --skip-live-smoke-repeat`, and `scripts/package-smoke`.
- `.github/workflows/live-smoke.yml` runs `scripts/live-smoke` only when Codex
  CLI is available.
- `.github/workflows/publish.yml` verifies the npm package artifact on manual
  dispatch and must not become an automatic npm publish path during autonomous
  overnight work.

## Strongest QA Failure Mode

The migration can appear done while the test suite only proves the dashboard or
new TS happy path. Completion is blocked until the QA matrix proves CLI,
database, tmux/Codex ingest, Dispatch, skill install, packaging, dashboard, and
docs/release contracts are either preserved or explicitly adjudicated.
