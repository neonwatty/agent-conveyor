# Agent Conveyor Package Release

Use this checklist before preparing or publishing the npm package
`agent-conveyor`. The goal is to prove the exact `.tgz` artifact works, not
merely that the checkout works.

Publishing is intentionally not part of the autonomous migration flow. Do not
run `npm publish` until the TypeScript migration final audit explicitly approves
that action.

## Preconditions

- `main` is up to date with `origin/main`.
- The worktree is clean except for intentionally ignored local artifacts.
- The package version in `package.json` is the version you intend to release.
- The release candidate has passed CI, including `scripts/package-smoke`.
- npm auth and two-factor settings have been checked by the operator.
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
artifact verification workflow. It runs the npm gates, produces a tarball, and
uploads the `.tgz` as a GitHub Actions artifact. It intentionally does not
publish.

Use it when you want a CI-produced package artifact for human review:

1. Run the `Package Verification` workflow.
2. Download the `agent-conveyor-npm-tarball` artifact.
3. Install it in a clean prefix and repeat the help and skill checks above.
4. Record the workflow URL and tarball filename in the release receipt.

## Publish Handoff

Publishing is a human-approved final action after the migration readiness audit.
When approved, publish the exact tarball that passed the artifact gates:

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
