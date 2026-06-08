# Agent Conveyor Package Release

Use this checklist before preparing or publishing the npm package
`agent-conveyor`. The goal is to prove the exact `.tgz` artifact works, not
merely that the checkout works.

The old Python/PyPI package path is archived in
[`docs/archive/python-package-history.md`](archive/python-package-history.md).
Do not use PyPI or `pipx install agent-conveyor` for current releases.

Publishing is intentionally not part of the autonomous migration flow. Do not
run `npm publish` until the TypeScript migration final audit explicitly approves
that action.

## Preconditions

- `main` is up to date with `origin/main`.
- The worktree is clean except for intentionally ignored local artifacts.
- The package version in `package.json` is the version you intend to release.
- The release candidate has passed CI, including `scripts/package-smoke`.
- npm auth and two-factor settings have been checked by the operator for local
  publishing, or npm Trusted Publishing is configured for the GitHub Actions
  workflow.
- `npm view agent-conveyor name version --json` has been rechecked near release
  time, because registry state can change.

## Local Artifact Gates

Run the repository gates:

```bash
npm ci
npm test -- --runInBand
npm run build
scripts/rc-check --skip-live-smoke-repeat
scripts/package-smoke
```

Run the deterministic release artifact gate:

```bash
scripts/release-check
```

`scripts/release-check` builds the CLI and dashboard, runs `npm pack`, asserts
the package name, bin aliases, prepublish guard, tarball contents, executable
asset modes, clean-prefix install, `conveyor` and `workerctl` help output, and
isolated skill installation. It does not publish.

SQLite-backed commands may emit Node's `node:sqlite` `ExperimentalWarning` to
stderr on Node versions that still mark that API experimental. Do not treat that
warning alone as a failed release gate when the command exits 0 and the JSON
health result reports `"ok": true`; record it in the receipt so first-run stderr
is not confused with package failure.

Live tmux dogfood may pause newly spawned Codex sessions on a "Hooks need
review" prompt before Codex writes session metadata. For release smoke, choose
"Continue without trusting" unless the operator explicitly wants to trust the
hook changes for that workspace. If an unrelated MCP server such as PostHog
fails to start because of local credentials, treat that as environmental noise
for Agent Conveyor release gates when `conveyor doctor`, `conveyor db-doctor`,
cycle/audit/replay/export, and cleanup receipts still pass.

If you need to debug the release gate manually, use the equivalent core
commands:

```bash
npm ci
npm run build
npm pack --json
tmp_prefix="$(mktemp -d)"
npm install -g --prefix "$tmp_prefix" ./agent-conveyor-*.tgz
PATH="$tmp_prefix/bin:$PATH" conveyor --help
PATH="$tmp_prefix/bin:$PATH" workerctl --help
tmp_home="$(mktemp -d)"
CODEX_HOME="$tmp_home" PATH="$tmp_prefix/bin:$PATH" conveyor install-skills --json
test -f "$tmp_home/skills/manage-codex-workers/SKILL.md"
test -x "$tmp_home/skills/codex-review/scripts/codex-review"
rm -rf "$tmp_prefix" "$tmp_home"
```

Inspect the generated tarball contents:

```bash
npm pack --dry-run --json
```

The tarball must include:

- `dist/cli/main.js`
- `dist/index.js`
- `skills/manage-codex-workers/SKILL.md`
- `skills/codex-review/SKILL.md`
- `skills/codex-review/scripts/codex-review`

The npm tarball must not contain `scripts/workerctl`, `workerctl/**/*.py`, or
`dist/cli/python-bridge.*`. The `codex-review` helper must be executable in the
tarball.

## GitHub Artifact Workflow

The repository workflow `.github/workflows/publish.yml` is a manual package
artifact verification workflow by default. It runs the npm gates, produces a
tarball, and uploads the `.tgz` as a GitHub Actions artifact.

Use it when you want a CI-produced package artifact for human review:

1. Run the `Package Verification` workflow with `publish` left as `false`.
2. Download the `agent-conveyor-npm-tarball` artifact.
3. Install it in a clean prefix and repeat the help and skill checks above.
4. Record the workflow URL and tarball filename in the release receipt.

For a verification-only dry run before bumping the package version, use the
current `package.json` version and leave `publish=false`. A future release run
must bump `package.json` first, then pass the same new version as the workflow
input.

The same workflow can publish through npm Trusted Publishing when all of these
are true:

- npm package settings trust GitHub Actions for
  `neonwatty/agent-conveyor`, workflow filename `publish.yml`, environment
  `npm-production`, and allowed action `npm publish`.
- The workflow input `publish` is explicitly set to `true`.
- The workflow input `version` matches `package.json`.
- The version is not already present on npm.
- The GitHub `npm-production` environment approval, if configured, is granted.

Trusted Publishing requires npm CLI 11.5.1+ and Node 22.14.0+. GitHub-hosted
Node 24 runners satisfy the Node requirement. npm generates provenance
automatically for public packages published from public repositories through
Trusted Publishing.

Configure the npm package-side trusted publisher at
`https://www.npmjs.com/package/agent-conveyor/settings/trusted-publishers`:

- Publisher: GitHub Actions
- Organization or user: `neonwatty`
- Repository: `agent-conveyor`
- Workflow filename: `publish.yml`
- Environment name: `npm-production`
- Allowed action: `npm publish`

The workflow must keep `id-token: write` on the publishing job. npm checks the
configured workflow filename and environment during publish, and `npm whoami`
does not prove OIDC readiness because OIDC authentication happens only for the
publish operation.

After Trusted Publishing is verified, prefer the npm package setting
`Require two-factor authentication and disallow tokens`; this disables
traditional publish tokens while leaving the trusted publisher path usable.

## Publish Handoff

Publishing is a human-approved final action after the migration readiness audit.
The preferred path is the Trusted Publishing workflow above. For emergency
local publishing only, publish the exact tarball that passed the artifact gates:

```bash
npm publish ./agent-conveyor-<version>.tgz --access public
```

After publish, verify the real install path:

```bash
tmp_prefix="$(mktemp -d)"
npm install -g --prefix "$tmp_prefix" agent-conveyor@<version>
PATH="$tmp_prefix/bin:$PATH" conveyor --help
PATH="$tmp_prefix/bin:$PATH" workerctl --help
tmp_home="$(mktemp -d)"
CODEX_HOME="$tmp_home" PATH="$tmp_prefix/bin:$PATH" conveyor install-skills --json
test -f "$tmp_home/skills/manage-codex-workers/SKILL.md"
test -x "$tmp_home/skills/codex-review/scripts/codex-review"
rm -rf "$tmp_prefix" "$tmp_home"
```

Record the release receipt:

- version
- git tag or commit SHA
- npm package URL
- CI run URL
- tarball filename and integrity
- clean-prefix install result
- `conveyor install-skills` result

## Rollback Notes

npm package versions cannot be overwritten. If a bad version is published,
deprecate that version, fix forward with a new version, and update the release
receipt with the deprecated version and replacement version.
