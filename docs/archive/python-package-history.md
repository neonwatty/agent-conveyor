# Python Package History

Agent Conveyor is now distributed as the npm package `agent-conveyor`.
Install and release instructions live in `README.md` and `docs/package-release.md`.

This file archives the former Python/PyPI packaging path so old receipts and
migration notes remain understandable without presenting Python packaging as the
current release path.

## Historical Install Path

Before the TypeScript/npm migration, users installed Agent Conveyor from the
Python package metadata:

```bash
pipx install agent-conveyor
conveyor install-skills
conveyor doctor
```

The historical package exposed two console scripts:

- `conveyor`
- `workerctl`

It bundled the skill assets from `workerctl/assets/skills/**/*`.

## Current Install Path

The current package is npm-primary:

```bash
npm install -g agent-conveyor
conveyor install-skills
conveyor doctor
```

The npm tarball must not include `scripts/workerctl`, `workerctl/**/*.py`, or a
Python bridge. `scripts/package-smoke`, `scripts/release-check`, and
`npm run migration:audit:final` enforce that boundary.

## Compatibility Source

The source tree still contains the historical Python implementation and tests as
compatibility fixtures. That code is useful for contract checks, schema parity,
and migration audit receipts, but it is not the current distribution path.

Do not add new PyPI release instructions unless a future maintainer explicitly
reopens Python packaging as a supported distribution channel.
