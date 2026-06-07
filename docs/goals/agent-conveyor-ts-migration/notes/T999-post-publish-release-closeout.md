# T999 Post-Publish Release Closeout

Date: 2026-06-07

## Summary

The Python-to-TypeScript migration is shipped through the npm package path.
The merged repository is `neonwatty/agent-conveyor`, and the public npm package
`agent-conveyor@0.1.2` is visible with `latest` pointing at `0.1.2`.

## Source And Releases

- Repository: https://github.com/neonwatty/agent-conveyor
- Published npm package: https://www.npmjs.com/package/agent-conveyor/v/0.1.2
- GitHub release tag: `v0.1.2`
- GitHub release: https://github.com/neonwatty/agent-conveyor/releases/tag/v0.1.2
- Release commit: `9a4f9f85faf776403f3a05c201a2c8fdc935b007`
- Main migration PR: https://github.com/neonwatty/agent-conveyor/pull/254
- Version bump PR: https://github.com/neonwatty/agent-conveyor/pull/255

## npm Registry Receipt

- name: `agent-conveyor`
- version: `0.1.2`
- dist-tag: `latest -> 0.1.2`
- tarball: https://registry.npmjs.org/agent-conveyor/-/agent-conveyor-0.1.2.tgz

## Verification

- `AGENT_CONVEYOR_ALLOW_NPM_PUBLISH=1 npm publish --dry-run` passed before
  publish and showed the expected 85-file tarball.
- `scripts/release-check --skip-live-smoke-repeat` passed against
  `agent-conveyor@0.1.2` before publish.
- `AGENT_CONVEYOR_ALLOW_NPM_PUBLISH=1 npm publish` succeeded and published
  `agent-conveyor@0.1.2`.
- `npm view agent-conveyor@0.1.2 version dist-tags --json` returned
  `version: 0.1.2` and `latest: 0.1.2`.
- Clean installed `agent-conveyor@0.1.2` into a temp prefix and verified both
  shipped binaries start: `conveyor --help` and `workerctl --help`.
- Public latest consumer smoke passed from a temp project:
  `npm install agent-conveyor@latest`, `npx conveyor --help`,
  `npx workerctl --help`, `npx conveyor classify --text ...`,
  `npx conveyor export-task --help`, and isolated
  `CODEX_HOME=... npx conveyor install-skills --json`.
- The isolated skill install verified both bundled skill directories and the
  executable `codex-review` helper.
- `npm whoami` returned `neonwatty` during the publish and verification window.

## PR And CI Receipts

- PR #254 merged: https://github.com/neonwatty/agent-conveyor/pull/254
- PR #255 merged: https://github.com/neonwatty/agent-conveyor/pull/255
- Both PRs were merged only after CI was green.

## Token Cleanup

The temporary granular npm publish token was created only for the 0.1.2 release
because npm required an OTP for the prior session token. It had read/write
package access, no organization access, 2FA bypass enabled for publish
automation, and a seven-day npm-enforced expiry.

After post-publish registry and public smoke verification,
`npm token revoke <temporary-publish-token-key>` returned `Removed 1 token`.
The local npm auth token line was also removed from `~/.npmrc`.

## Trusted Publishing Hardening

After the 0.1.2 token-based publish, npm package settings were hardened so
future releases do not require local publish tokens:

- npm Trusted Publisher is configured for `neonwatty/agent-conveyor`.
- Workflow filename: `publish.yml`.
- Environment: `npm-production`.
- Allowed action: `npm publish`.
- Publishing access is set to
  `Require two-factor authentication and disallow tokens (recommended)`.

PR #257 hardened the repository workflow and release docs:
https://github.com/neonwatty/agent-conveyor/pull/257

The no-publish GitHub Actions dry run passed:
https://github.com/neonwatty/agent-conveyor/actions/runs/27095940731

- Run input: `version=0.1.2`, `publish=false`.
- `Verify npm package artifact`: success.
- `Publish npm package with Trusted Publishing`: skipped as expected.
- Artifact: `agent-conveyor-0.1.2.tgz`.
- Artifact SHA-256:
  `2f68ec32e061908970a7ae1a89cdad71085199ebdd5316d6d3fe3b55e218496b`.
- The downloaded workflow artifact installed into a clean prefix and verified
  `conveyor --help`, `workerctl --help`, and isolated
  `conveyor install-skills --json`.

## Burden Of Proof

Strongest realistic failure mode: the registry could show `0.1.2` while the
published package is unusable or missing migrated TypeScript CLI surfaces.

Disproof evidence: `npm view` confirmed the public package and latest dist-tag;
a clean temp-prefix install of `agent-conveyor@0.1.2` ran both shipped binaries;
and a separate temp-project public latest smoke ran help, `classify`,
`export-task --help`, and isolated skill installation from the registry package.
