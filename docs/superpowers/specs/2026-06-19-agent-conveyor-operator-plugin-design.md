# Agent Conveyor Operator Plugin Design

## Summary

Agent Conveyor should grow a first-class, in-repo Codex plugin that makes the
global npm package easier to use from any target project. The npm package
remains the engine. The plugin is the Codex-native operator layer: a small set
of focused skills and scripts that help an operator create visible Codex app
manager/worker pairs or worker sets, then inspect their status through the
per-project Conveyor ledger.

The first tranche is intentionally narrow:

- operator-facing skills only;
- Codex app native sessions only;
- no tmux support in this tranche;
- per-project ledger by default;
- plugin version locked to the npm package version.

## Goals

- Let an operator run `npm install -g agent-conveyor` and
  `conveyor install-plugin`, then use Conveyor skills from inside any project.
- Keep the plugin source in this repository so plugin skills, scripts, docs,
  tests, and package release checks evolve with the CLI.
- Install a versioned plugin whose version exactly matches `package.json`.
- Provide narrow operator skills for the first workflows we know we want:
  creating one manager/worker pair, creating one manager with multiple workers,
  and checking status.
- Default all portable operator flows to the current target project's ledger:
  `.codex-workers/workerctl.db`.
- Preserve visible Codex app thread work as the primary human-reviewable
  transcript while keeping the Conveyor ledger as durable audit proof.

## Non-Goals

- Do not build worker-session behavior skills in tranche one.
- Do not support tmux in tranche one.
- Do not add a global shared ledger as the default.
- Do not implement a full campaign/Ralph/ship-it loop plugin in tranche one.
  Those can build on the pair/set/status foundations.
- Do not require the operator to run from the Agent Conveyor repository.
- Do not publish a separate npm package or external plugin repository.

## Repository Shape

Add a plugin source tree under:

```text
plugin/agent-conveyor/
  plugin.json
  skills/
    conveyor-create-pair/SKILL.md
    conveyor-create-worker-set/SKILL.md
    conveyor-check-status/SKILL.md
  scripts/
    plugin-status.mjs
```

`plugin.json` is the repository manifest for Agent Conveyor's plugin bundle. If
Codex later requires a different metadata filename, generate or copy that file
from `plugin.json` during install rather than moving plugin source out of
`plugin/agent-conveyor/`. The root `package.json` should include this tree in
the npm tarball.

## Versioning

The plugin version must equal the npm package version. During install,
`conveyor install-plugin` reads the installed package version and installs the
plugin into a matching versioned cache path, for example:

```text
~/.codex/plugins/cache/agent-conveyor/agent-conveyor/0.1.20/
```

If the plugin manifest version and package version diverge, release checks must
fail. The install command should report the package version, plugin version,
install target, and installed skills.

## CLI Additions

Add these commands:

```bash
conveyor install-plugin [--codex-home <path>] [--dry-run] [--json]
conveyor plugin-status [--codex-home <path>] [--json]
conveyor plugin-path [--codex-home <path>] [--json]
```

`conveyor install-plugin` copies the versioned plugin bundle into the Codex
plugin cache and installs the plugin's exposed skills into the Codex skills
directory when that is required for discovery. Existing
`conveyor install-skills` remains as a compatibility command, but docs should
make `install-plugin` the preferred path.

`conveyor plugin-status` reports whether the installed plugin is present,
whether its version matches the global package, and which skills are available.

`conveyor plugin-path` is a debugging helper that prints the expected source
and destination paths.

## First Operator Skills

### `conveyor-create-pair`

Purpose: create one visible Codex app manager and one visible Codex app worker
for the current target project.

Behavior:

- Verify `conveyor` is globally available.
- Use the current working directory as the target project.
- Use `.codex-workers/workerctl.db` under that project unless the user
  explicitly provides another path.
- Use Codex app native thread creation when available.
- Create a Conveyor task and app-session binding for one manager and one worker.
- Emit exact next commands for status, heartbeat/autopilot setup, and dispatch.
- Require generated manager/worker prompts to instruct sessions to work visibly,
  not silently in the ledger.

The skill should not inspect product code unless the operator's task requires a
separate later worker flow. Pair creation itself is project-control setup.

### `conveyor-create-worker-set`

Purpose: create one visible Codex app manager and N visible Codex app workers
for the current target project.

Behavior:

- Accept a desired worker count and optional role names.
- Choose concise manager and worker names when the operator does not provide
  them.
- Use `.codex-workers/workerctl.db` under the target project.
- Create one Conveyor task and one app-session binding per worker role so
  status can distinguish every worker without relying on a global ledger.
- Bind created Codex app thread ids/titles to their roles.
- Return a compact setup receipt with thread names, ids, ledger path, task id,
  and next status command.

This skill should establish the worker set but not launch a full campaign loop
yet. Campaign assignment and asset receipt behavior can layer on later.

### `conveyor-check-status`

Purpose: give the operator a compact status receipt for an existing pair or
worker set.

Behavior:

- Use the current project's `.codex-workers/workerctl.db` by default.
- Report manager and worker thread ids/titles.
- Report task state, stale roles, inbox backlog, heartbeat/autopilot state,
  dispatch health, and exact next action.
- Avoid inspecting product code or private content.
- Treat ledger claims as claims unless they are backed by durable receipts.

## Data Flow

1. Operator invokes a plugin skill from a target project.
2. Skill verifies the global `conveyor` CLI and project ledger path.
3. Skill creates Codex app threads when thread tools are available.
4. Skill calls Conveyor commands with `--path "$PWD/.codex-workers/workerctl.db"`.
5. Conveyor writes task/session/binding state to the per-project ledger.
6. Skill returns human-readable thread titles, ids, commands, and next action.
7. Follow-up status uses `conveyor-check-status` from the same project.

## Error Handling

- If `conveyor` is missing, fail with:
  `npm install -g agent-conveyor && conveyor install-plugin`.
- If the installed plugin version does not match the package version, instruct
  the operator to rerun `conveyor install-plugin`.
- If Codex app thread tools are unavailable, stop with a clear blocker for
  tranche one. Do not fall back to tmux.
- If `.codex-workers/workerctl.db` cannot be created, report the filesystem
  error and do not create sessions.
- If thread creation partially succeeds, report every created thread id/title
  and the missing binding step so cleanup can be explicit.

## Testing And Release Proof

Automated checks should prove:

- npm tarball includes `plugin/agent-conveyor/**`;
- plugin manifest version equals root `package.json` version;
- clean global install can run `conveyor install-plugin --json`;
- `conveyor plugin-status --json` reports the installed version and skills;
- installed plugin exposes `conveyor-create-pair`,
  `conveyor-create-worker-set`, and `conveyor-check-status`;
- from a temporary project, generated commands default to
  `.codex-workers/workerctl.db`;
- existing `conveyor install-skills` compatibility still works.

Release checks should include plugin verification before publish. Post-publish
verification should install `agent-conveyor@<version>` in a clean prefix, run
`conveyor install-plugin`, and confirm the plugin version equals the package
version.

## Future Tranches

After tranche one proves portable operator setup, add focused skills for:

- bounded Ralph loops;
- heartbeat/autopilot start/status/stop;
- one-manager/many-worker campaign assignment;
- creative-ops campaigns across channels;
- autonomous ship-it loops with PR/CI/merge authority;
- worker rotation and owned-thread archiving;
- stuck-loop diagnosis and evidence closeout.

These should remain narrow skills rather than merging into a single catch-all
operator skill.
