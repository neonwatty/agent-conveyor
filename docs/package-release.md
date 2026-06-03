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

## Version And Build

1. Update `version` in `pyproject.toml`.
2. Run the repository gates:

   ```bash
   scripts/rc-check --skip-live-smoke-repeat
   scripts/package-smoke
   ```

3. Build clean distributions:

   ```bash
   rm -rf dist build agent_conveyor.egg-info
   python3 -m pip install --upgrade build twine
   python3 -m build
   python3 -m twine check dist/*
   ```

4. Inspect the generated files:

   ```bash
   ls -lh dist/
   python3 -m pip install --force-reinstall dist/*.whl
   conveyor --help
   workerctl --help
   ```

## TestPyPI

1. Upload to TestPyPI:

   ```bash
   python3 -m twine upload --repository testpypi dist/*
   ```

2. In a clean shell, install the exact version from TestPyPI with PyPI as the
   dependency fallback:

   ```bash
   pipx uninstall agent-conveyor || true
   pipx install --pip-args '--index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/' 'agent-conveyor==<version>'
   conveyor --help
   workerctl --help
   ```

3. Verify skill installation from the TestPyPI package:

   ```bash
   tmp_home="$(mktemp -d)"
   CODEX_HOME="$tmp_home" conveyor install-skills --json
   test -f "$tmp_home/skills/manage-codex-workers/SKILL.md"
   test -x "$tmp_home/skills/codex-review/scripts/codex-review"
   rm -rf "$tmp_home"
   ```

## PyPI

1. Upload the exact checked distributions:

   ```bash
   python3 -m twine upload dist/*
   ```

2. Verify the real install path:

   ```bash
   pipx uninstall agent-conveyor || true
   pipx install agent-conveyor
   conveyor --help
   workerctl --help
   conveyor install-skills
   conveyor doctor
   ```

3. Record the release receipt:

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
