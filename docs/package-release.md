# Agent Conveyor Package Release

Use this checklist before publishing `agent-conveyor` to TestPyPI or PyPI.
The goal is to prove the exact distribution artifact works, not merely that
the checkout works.

## Preconditions

- `main` is up to date with `origin/main`.
- The worktree is clean except for intentionally ignored local artifacts.
- The package version in `pyproject.toml` is the version you intend to publish.
- The release candidate has passed CI, including `scripts/package-smoke`.
- You have TestPyPI and PyPI credentials or trusted-publisher access ready.

## Trusted Publishing Setup

Prefer Trusted Publishing for TestPyPI and PyPI releases. It uses GitHub
Actions OIDC and PyPI-issued short-lived credentials instead of long-lived local
or repository secrets.

Configure these GitHub Actions trusted publisher values on TestPyPI and PyPI:

- Repository owner: `neonwatty`
- Repository name: `codex-terminal-manager`
- Workflow filename: `publish.yml`
- Environment name: `testpypi` for TestPyPI
- Environment name: `pypi` for PyPI

The repository workflow is `.github/workflows/publish.yml`. It is a manual
`workflow_dispatch` workflow with a `target` choice of `testpypi` or `pypi`.
Each publish job grants job-scoped `id-token: write`, builds and checks the
distributions, and uses `pypa/gh-action-pypi-publish@release/v1`.

Only dispatch the workflow for a version that has not already been uploaded to
the target index. TestPyPI and PyPI files cannot be overwritten.

The TestPyPI publish step uses:

```yaml
repository-url: https://test.pypi.org/legacy/
```

## Version And Build

1. Update `version` in `pyproject.toml`.
2. Run the repository gates:

   ```bash
   scripts/rc-check --skip-live-smoke-repeat
   scripts/package-smoke
   ```

3. Run the deterministic release artifact gate:

   ```bash
   scripts/release-check
   ```

   This builds clean wheel/sdist artifacts in a temporary directory.
   It fails on packaging warnings. Specifically, it catches
   `SetuptoolsDeprecationWarning` and `Package would be ignored`, runs
   `twine check`, installs the exact built wheel into a fresh virtualenv,
   verifies `conveyor` and `workerctl`, and confirms bundled skill
   installation.

4. If you need to debug the release gate manually, the equivalent core commands
   are:

   ```bash
   rm -rf dist build agent_conveyor.egg-info
   python3 -m pip install --upgrade build twine
   python3 -m build
   python3 -m twine check dist/*
   ```

5. Inspect the generated files:

   ```bash
   ls -lh dist/
   python3 -m pip install --force-reinstall dist/*.whl
   conveyor --help
   workerctl --help
   ```

## TestPyPI

1. If using Trusted Publishing, run the `Publish Package` workflow with
   `target=testpypi`.

2. If using a local token fallback, upload to TestPyPI:

   ```bash
   python3 -m twine upload --repository testpypi dist/*
   ```

3. In a clean shell, install the exact version from TestPyPI with PyPI as the
   dependency fallback:

   ```bash
   pipx uninstall agent-conveyor || true
   pipx install --pip-args '--index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/' 'agent-conveyor==<version>'
   conveyor --help
   workerctl --help
   ```

4. Verify skill installation from the TestPyPI package:

   ```bash
   tmp_home="$(mktemp -d)"
   CODEX_HOME="$tmp_home" conveyor install-skills --json
   test -f "$tmp_home/skills/manage-codex-workers/SKILL.md"
   test -x "$tmp_home/skills/codex-review/scripts/codex-review"
   rm -rf "$tmp_home"
   ```

## PyPI

1. If using Trusted Publishing, run the `Publish Package` workflow with
   `target=pypi`.

2. If using a local token fallback, upload the exact checked distributions:

   ```bash
   python3 -m twine upload dist/*
   ```

3. Verify the real install path:

   ```bash
   pipx uninstall agent-conveyor || true
   pipx install agent-conveyor
   conveyor --help
   workerctl --help
   conveyor install-skills
   conveyor doctor
   ```

4. Record the release receipt:

   - version
   - git tag or commit SHA
   - TestPyPI package URL
   - PyPI package URL
   - CI run URL
   - `pipx install agent-conveyor` result
   - `conveyor install-skills` result

## Rollback Notes

PyPI files cannot be overwritten. If a bad version is published, yank that
release on PyPI, fix forward with a new version, and update the release
receipt with the yanked version and replacement version.
