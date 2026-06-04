# TypeScript Migration Package And Install Contract

The npm package name is `agent-conveyor`.

As of the pre-board and T001 checks:

- `npm whoami` returned `neonwatty`.
- `npm view agent-conveyor name version --json` returned npm E404.
- The pre-migration `package.json` was private dashboard tooling, not a
  publishable CLI package.
- The pre-migration `pyproject.toml` was the authoritative package metadata for
  the Python package.

The package name must be re-checked near final packaging and before any publish
handoff because registry state can change.

## Historical Python Package Contract

Before the TypeScript packaging tranche, install docs used the Python package
path: `pipx install agent-conveyor`, followed by `conveyor install-skills` and
`conveyor doctor`. That path is retained here only as historical contract
context for migration review, not as the current primary install instruction.

The historical Python metadata exposed:

- package name `agent-conveyor`
- console script `conveyor`
- compatibility console script `workerctl`
- bundled `workerctl/assets/skills/**/*`

The historical wheel package smoke proved:

- wheel builds
- installed `conveyor --help` starts with `usage: conveyor`
- installed `workerctl --help` starts with `usage: workerctl`
- `install-skills --json` installs expected skills
- installed `codex-review/scripts/codex-review` is executable
- installed `manage-codex-workers` skill does not contain stale copyable legacy
  command text

## Current npm Package Contract

The TypeScript migration now produces an npm package that:

- is named `agent-conveyor`
- is not `private`
- declares supported Node engines
- exposes `bin.conveyor`
- exposes `bin.workerctl`
- includes built CLI code
- includes required dashboard assets if dashboard remains part of the package
- includes `workerctl/assets/skills/**` bundled skill assets
- preserves executable mode for the installed `codex-review` helper
- avoids automatic npm publish from local scripts or CI unless explicitly
  approved by the operator

## Runtime Cutover Boundary

T007 proves the package can expose the Node `conveyor` and `workerctl` bins
while keeping the Python bridge as the default compatibility path. The T006
TypeScript runtime is opt-in and covers only the migrated audit, replay, and
non-zip subset export surfaces.

Full `export-task` parity remains Python-backed until a later verified slice
ports prompts, transcript captures/segments, terminal captures, telemetry
reports, mutation audit, archive creation, and full-transcript replay output.
Package smoke must not treat a migrated subset export as a replacement for the
full Python export contract.

## Tarball Smoke Contract

Before any public publish, the board must prove a local tarball install:

```bash
npm pack --json
tmp_prefix="$(mktemp -d)"
npm install -g --prefix "$tmp_prefix" ./agent-conveyor-*.tgz
PATH="$tmp_prefix/bin:$PATH" conveyor --help
PATH="$tmp_prefix/bin:$PATH" workerctl --help
CODEX_HOME="$(mktemp -d)" PATH="$tmp_prefix/bin:$PATH" conveyor install-skills --json
```

The smoke must inspect:

- both commands resolve from `PATH`
- both help first lines are correct
- installed skill files exist
- `codex-review/scripts/codex-review` is executable
- npm tarball contents include only intended package files

## Docs And CI Contract

Docs and CI must use npm as the primary path. Stale Python package publish or
install commands may remain only as historical migration notes or temporary
compatibility instructions with explicit labels.

## Publish Constraint

Preparing package metadata, tarball, install smoke, CI, and docs is approved.
Publishing `agent-conveyor` to npm is not approved for autonomous overnight work
and must remain a blocked/operator-approved final action.
