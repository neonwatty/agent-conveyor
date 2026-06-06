# T999 Post-Publish Release Closeout

Date: 2026-06-06

## Summary

The Python-to-TypeScript migration is shipped through the npm package path.
The merged repository is `neonwatty/agent-conveyor`, and the public npm package
`agent-conveyor@0.1.0` is visible with `latest` pointing at `0.1.0`.

## Source And Releases

- Repository: https://github.com/neonwatty/agent-conveyor
- Published npm package: https://www.npmjs.com/package/agent-conveyor/v/0.1.0
- npm release tag: `npm-v0.1.0`
- npm GitHub Release: https://github.com/neonwatty/agent-conveyor/releases/tag/npm-v0.1.0
- npm source commit: `3a96cee7d06122af9d94369c65efa57e952f7b3e`
- Existing PyPI release tag preserved: `v0.1.0` at `920acb795a4b7ea5dcb264b3ed56eb9bdd7e1fd5`

The plain `v0.1.0` tag already anchored the earlier PyPI release, so the npm
shipment uses `npm-v0.1.0` rather than rewriting historical release provenance.

## npm Registry Receipt

- name: `agent-conveyor`
- version: `0.1.0`
- dist-tag: `latest -> 0.1.0`
- modified: `2026-06-06T18:13:12.131Z`
- integrity: `sha512-8BX1MbmaakWtLbeVBVgdbsG3vXkcDF3oe+bwq+RI3ADEljb9rmh6sBxU9wyS+oV48+ume0ZgGDLsW7G21uHqvw==`
- shasum: `e7c3a2d032ddc7fa4a61938a51d8ed1441a6efc0`

## Verification

- `npm run migration:audit:final` passed with `full_outcome_complete: true`.
- `scripts/release-check` packed and clean-prefix installed the npm tarball,
  verified `conveyor` and `workerctl`, and verified bundled skills.
- `AGENT_CONVEYOR_ALLOW_NPM_PUBLISH=1 npm publish --dry-run --access public`
  showed the expected 85-file tarball before the real publish.
- `AGENT_CONVEYOR_ALLOW_NPM_PUBLISH=1 npm publish --access public` succeeded.
- `npm view agent-conveyor@0.1.0 name version dist-tags time.modified dist.integrity dist.shasum --json`
  returned the public registry receipt above.
- Clean public install smoke passed from a temp project:
  `npm install agent-conveyor@0.1.0`, `npx conveyor --help`, and
  `npx workerctl --help`.
- Dogfood beyond help passed from a temp project:
  `npx conveyor classify --text "release closeout dogfood"` and isolated
  `CODEX_HOME=... npx conveyor install-skills --json`, with both bundled skill
  directories present and the `codex-review` helper executable.

## PR And CI Receipts

- PR #244 merged: https://github.com/neonwatty/agent-conveyor/pull/244
- PR #245 merged: https://github.com/neonwatty/agent-conveyor/pull/245
- PR #246 merged: https://github.com/neonwatty/agent-conveyor/pull/246
- PR #246 CI had two `unittest` check runs and both completed successfully
  before merge.

## Token Cleanup

The temporary granular npm publish token used for the unscoped package publish
was revoked after post-publish registry and dogfood verification:
`npm token revoke <temporary-publish-token-key>` returned `Removed 1 token`.

## Burden Of Proof

Strongest realistic failure mode: release closeout could rewrite the existing
PyPI `v0.1.0` tag, publish from the wrong commit, or leave the npm package
visible but unusable.

Disproof evidence: `v0.1.0` was inspected and preserved at the PyPI release
commit; `npm-v0.1.0` was created at current merged `origin/main`
`3a96cee7d06122af9d94369c65efa57e952f7b3e`; npm registry metadata reports the
published package and renamed repository links; clean temp-project installation,
CLI entrypoints, `classify`, and isolated skill installation all passed from
the public package.
