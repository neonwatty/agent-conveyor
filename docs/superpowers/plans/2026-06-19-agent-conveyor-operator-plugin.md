# Agent Conveyor Operator Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the first in-repo Agent Conveyor Codex plugin tranche: operator-only, Codex-app-only skills for creating visible manager/worker pairs, creating visible worker sets, and checking per-project status.

**Architecture:** Keep the npm package as the engine and add `plugin/agent-conveyor/` as the Codex-native operator layer. Add TypeScript CLI plugin commands that copy the versioned plugin bundle into Codex's plugin cache and expose plugin skills through the current `~/.codex/skills` discovery path. Extend package and release checks so the npm tarball proves plugin presence, version lock, clean install, and skill exposure.

**Tech Stack:** Node.js/TypeScript CLI, `node:fs`, `node:path`, existing `runTypescriptRuntimeCommand` tests, bash release smoke scripts, Codex skill markdown files.

---

## Scope Check

The approved spec covers one coherent subsystem: packaging and installing an operator-facing Codex plugin for Agent Conveyor. It does not implement actual native thread creation beyond skill instructions in tranche one. The implementation is a package/install surface plus skill content and verification.

## File Structure

- Create `plugin/agent-conveyor/plugin.json`
  - Plugin metadata and version lock target.
- Create `plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md`
  - Operator skill for one visible Codex app manager/worker pair.
- Create `plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md`
  - Operator skill for one visible Codex app manager and N visible workers.
- Create `plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md`
  - Operator skill for compact status from the current project's ledger.
- Modify `package.json`
  - Include `plugin/**/*` in the npm package `files` list.
- Modify `src/cli/typescript-runtime.ts`
  - Add `install-plugin`, `plugin-status`, and `plugin-path` commands.
  - Reuse the existing install-skills copy style.
  - Add plugin path/version/status helpers.
- Modify `src/cli/typescript-runtime.test.ts`
  - Add unit coverage for plugin path/status/install command contracts.
- Modify `scripts/package-smoke`
  - Assert plugin files are packed and clean-installed plugin commands work.
- Modify `scripts/release-check`
  - Assert plugin files are packed and clean-installed plugin commands work.
- Modify `README.md` and `docs/package-release.md`
  - Document `conveyor install-plugin`, `conveyor plugin-status`, and release
    verification for the plugin.

---

### Task 1: Add Plugin Source Tree

**Files:**
- Create: `plugin/agent-conveyor/plugin.json`
- Create: `plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md`
- Create: `plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md`
- Create: `plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md`

- [ ] **Step 1: Create the plugin manifest**

Add `plugin/agent-conveyor/plugin.json`:

```json
{
  "name": "agent-conveyor",
  "version": "0.1.19",
  "description": "Codex operator skills for Agent Conveyor manager-worker setup.",
  "skills": [
    "conveyor-create-pair",
    "conveyor-create-worker-set",
    "conveyor-check-status"
  ],
  "requires": {
    "npmPackage": "agent-conveyor",
    "sessionKind": "codex_app",
    "ledger": "per_project"
  }
}
```

- [ ] **Step 2: Create `conveyor-create-pair` skill**

Add `plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md`:

```markdown
---
name: conveyor-create-pair
description: Create one visible Codex app manager and one visible Codex app worker for the current project using the globally installed Agent Conveyor CLI.
---

# Conveyor Create Pair

Use this skill when the operator wants a Codex-app-only manager/worker pair
from any target project. This skill is operator-facing. Do not use tmux in this
tranche.

## Rules

- Treat the current working directory as the target project.
- Use `.codex-workers/workerctl.db` under the target project unless the
  operator explicitly gives another path.
- Verify `conveyor` is available before setup:
  `command -v conveyor && conveyor plugin-status --json`.
- If `conveyor` is missing or the plugin is stale, tell the operator:
  `npm install -g agent-conveyor && conveyor install-plugin`.
- Use native Codex app thread tools when available to create visible manager
  and worker threads.
- Do not inspect product code as part of pair setup.
- Generated manager and worker prompts must require visible session sections:
  `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, and
  `DISPATCH`.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Operator Flow

1. Clarify the bounded task name only if the operator has not provided one.
2. Create one manager Codex app thread and one worker Codex app thread.
3. Run `conveyor create-disposable-binding` with the created thread ids and:
   `--path "$PWD/.codex-workers/workerctl.db" --json`.
4. Return the manager thread title/id, worker thread title/id, ledger path,
   task name, and exact status command:
   `TASK="example-task"; conveyor app-loop-status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json`.
```

- [ ] **Step 3: Create `conveyor-create-worker-set` skill**

Add `plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md`:

```markdown
---
name: conveyor-create-worker-set
description: Create one visible Codex app manager and multiple visible Codex app workers for the current project using Agent Conveyor.
---

# Conveyor Create Worker Set

Use this skill when the operator wants one Codex app manager supervising
multiple Codex app workers. This skill creates the set and bindings; it does
not run a campaign, Ralph loop, ship-it loop, or tmux workflow.

## Rules

- Operator-facing only.
- Codex app native sessions only.
- Use the current working directory as the target project.
- Use `.codex-workers/workerctl.db` under the target project by default.
- Create concise worker role names when the operator does not provide them.
- Do not inspect product code during setup.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Operator Flow

1. Determine worker count and role labels.
2. Create one manager Codex app thread.
3. Create one worker Codex app thread per role.
4. Create one Conveyor task and one app-session binding per worker role using
   `conveyor create-disposable-binding --path "$LEDGER" --json`.
5. Return a setup receipt listing every task, worker role, thread id/title,
   manager thread id/title, ledger path, and status command.
```

- [ ] **Step 4: Create `conveyor-check-status` skill**

Add `plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md`:

```markdown
---
name: conveyor-check-status
description: Check Agent Conveyor manager/worker or worker-set status from the current project's per-project ledger.
---

# Conveyor Check Status

Use this skill when the operator asks for the status of an Agent Conveyor pair
or worker set from any project.

## Rules

- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly provides another path.
- Do not inspect product code or private content.
- Treat ledger claims as claims unless backed by durable receipts.
- Prefer compact status receipts with exact next action.

## Commands

For a known task:

```bash
TASK="example-task"
conveyor app-loop-status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json
conveyor app-autopilot status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json
```

For an unknown task, list candidate records first:

```bash
conveyor tasks list --path "$PWD/.codex-workers/workerctl.db" --json
```

Report manager and worker thread ids/titles, stale roles, inbox backlog,
heartbeat/autopilot state, dispatch health, and the exact next action.
```

- [ ] **Step 5: Inspect the new files**

Run:

```bash
find plugin/agent-conveyor -maxdepth 4 -type f | sort
```

Expected output contains exactly:

```text
plugin/agent-conveyor/plugin.json
plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md
plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md
plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md
```

- [ ] **Step 6: Commit**

```bash
git add plugin/agent-conveyor
git commit -m "Add Agent Conveyor operator plugin skills"
```

---

### Task 2: Add Plugin Runtime Helpers And CLI Commands

**Files:**
- Modify: `src/cli/typescript-runtime.ts`

- [ ] **Step 1: Add command routing tests first**

This task's failing tests are written in Task 3. Do not implement command
routing until those tests exist and fail.

- [ ] **Step 2: Extend option parsing for `--codex-home`**

Modify the `--codex-home` parser branch in `src/cli/typescript-runtime.ts` to
allow the new plugin commands:

```ts
} else if (arg === "--codex-home") {
  if (
    command !== "install-skills"
    && command !== "install-plugin"
    && command !== "plugin-status"
    && command !== "plugin-path"
  ) {
    return { command, enabled, error: "Unsupported TypeScript runtime option: --codex-home", explicit, flags, task };
  }
  const value = valueAfter(queue, index, arg);
  if (value.error) {
    return { command, enabled, error: value.error, explicit, flags, task };
  }
  flags.codexHome = value.value;
  index += 1;
}
```

- [ ] **Step 3: Add command routing**

Add near the existing `install-skills` route:

```ts
if (parsed.command === "install-plugin") {
  return runInstallPluginCommand(parsed, options);
}
if (parsed.command === "plugin-status") {
  return runPluginStatusCommand(parsed, options);
}
if (parsed.command === "plugin-path") {
  return runPluginPathCommand(parsed, options);
}
```

- [ ] **Step 4: Add default runtime command names**

Add to `isDefaultRuntimeCommand`:

```ts
|| command === "install-plugin"
|| command === "plugin-status"
|| command === "plugin-path"
```

- [ ] **Step 5: Add plugin helper types and constants**

Place near `runInstallSkillsCommand`:

```ts
const AGENT_CONVEYOR_PLUGIN_NAME = "agent-conveyor";
const AGENT_CONVEYOR_PLUGIN_SKILLS = [
  "conveyor-create-pair",
  "conveyor-create-worker-set",
  "conveyor-check-status",
] as const;

interface AgentConveyorPluginManifest {
  description?: string;
  name: string;
  requires?: Record<string, unknown>;
  skills: string[];
  version: string;
}

interface AgentConveyorPluginPaths {
  codexHome: string;
  packageRoot: string;
  pluginCacheRoot: string;
  pluginInstallRoot: string;
  pluginSource: string;
  skillsInstallRoot: string;
}
```

- [ ] **Step 6: Add path and manifest helpers**

Add below the constants:

```ts
function resolveCodexHome(parsed: ParsedRuntimeArgs, options: { env?: NodeJS.ProcessEnv }): string {
  return resolve(expandUserPath(parsed.flags.codexHome ?? options.env?.CODEX_HOME ?? join(homedir(), ".codex")));
}

function packageVersionFromRoot(packageRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package.json version is missing.");
  }
  return manifest.version;
}

function pluginPaths(parsed: ParsedRuntimeArgs, options: { env?: NodeJS.ProcessEnv }): AgentConveyorPluginPaths {
  const codexHome = resolveCodexHome(parsed, options);
  const packageRoot = packageRootFromRuntimeModule();
  const version = packageVersionFromRoot(packageRoot);
  return {
    codexHome,
    packageRoot,
    pluginCacheRoot: join(codexHome, "plugins", "cache", AGENT_CONVEYOR_PLUGIN_NAME, AGENT_CONVEYOR_PLUGIN_NAME),
    pluginInstallRoot: join(codexHome, "plugins", "cache", AGENT_CONVEYOR_PLUGIN_NAME, AGENT_CONVEYOR_PLUGIN_NAME, version),
    pluginSource: join(packageRoot, "plugin", AGENT_CONVEYOR_PLUGIN_NAME),
    skillsInstallRoot: join(codexHome, "skills"),
  };
}

function readAgentConveyorPluginManifest(source: string): AgentConveyorPluginManifest {
  const manifestPath = join(source, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Bundled Agent Conveyor plugin not found in plugin/agent-conveyor.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AgentConveyorPluginManifest;
  if (manifest.name !== AGENT_CONVEYOR_PLUGIN_NAME) {
    throw new Error(`Unexpected Agent Conveyor plugin name: ${manifest.name}`);
  }
  return manifest;
}
```

- [ ] **Step 7: Add version validation helper**

Add:

```ts
function assertPluginVersionMatchesPackage(manifest: AgentConveyorPluginManifest, packageVersion: string): void {
  if (manifest.version !== packageVersion) {
    throw new Error(`Agent Conveyor plugin version ${manifest.version} does not match package version ${packageVersion}.`);
  }
}
```

- [ ] **Step 8: Add installed skill target helper**

Add:

```ts
function pluginSkillTargets(paths: AgentConveyorPluginPaths): Array<{ name: string; source: string; target: string }> {
  return AGENT_CONVEYOR_PLUGIN_SKILLS.map((name) => ({
    name,
    source: join(paths.pluginSource, "skills", name),
    target: join(paths.skillsInstallRoot, name),
  }));
}
```

- [ ] **Step 9: Add `runPluginPathCommand`**

Add:

```ts
function runPluginPathCommand(
  parsed: ParsedRuntimeArgs,
  options: { env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedPluginOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const paths = pluginPaths(parsed, options);
  const payload = {
    codex_home: paths.codexHome,
    package_root: paths.packageRoot,
    plugin_cache_root: paths.pluginCacheRoot,
    plugin_install_root: paths.pluginInstallRoot,
    plugin_source: paths.pluginSource,
    skills_install_root: paths.skillsInstallRoot,
  };
  if (parsed.flags.json) {
    return jsonResult(payload);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: [
      `plugin_source ${payload.plugin_source}`,
      `plugin_install_root ${payload.plugin_install_root}`,
      `skills_install_root ${payload.skills_install_root}`,
    ].join("\n") + "\n",
  };
}
```

- [ ] **Step 10: Add `runPluginStatusCommand`**

Add:

```ts
function runPluginStatusCommand(
  parsed: ParsedRuntimeArgs,
  options: { env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedPluginOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const paths = pluginPaths(parsed, options);
  const packageVersion = packageVersionFromRoot(paths.packageRoot);
  const manifest = readAgentConveyorPluginManifest(paths.pluginSource);
  const installedManifestPath = join(paths.pluginInstallRoot, "plugin.json");
  const installedManifest = existsSync(installedManifestPath)
    ? JSON.parse(readFileSync(installedManifestPath, "utf8")) as AgentConveyorPluginManifest
    : null;
  const skillTargets = pluginSkillTargets(paths);
  const skills = skillTargets.map((skill) => ({
    name: skill.name,
    installed: existsSync(join(skill.target, "SKILL.md")),
    source: skill.source,
    target: skill.target,
  }));
  const versionMatches = manifest.version === packageVersion
    && installedManifest?.version === packageVersion;
  const payload = {
    codex_home: paths.codexHome,
    installed: installedManifest !== null,
    installed_version: installedManifest?.version ?? null,
    package_version: packageVersion,
    plugin_install_root: paths.pluginInstallRoot,
    plugin_source: paths.pluginSource,
    plugin_version: manifest.version,
    skills,
    version_matches: versionMatches,
  };
  if (parsed.flags.json) {
    return jsonResult(payload);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: `agent-conveyor plugin ${payload.installed ? "installed" : "not installed"} package=${packageVersion} plugin=${manifest.version}\n`,
  };
}
```

- [ ] **Step 11: Add `runInstallPluginCommand`**

Add:

```ts
function runInstallPluginCommand(
  parsed: ParsedRuntimeArgs,
  options: { env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedPluginOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const paths = pluginPaths(parsed, options);
  const packageVersion = packageVersionFromRoot(paths.packageRoot);
  const manifest = readAgentConveyorPluginManifest(paths.pluginSource);
  assertPluginVersionMatchesPackage(manifest, packageVersion);
  const skillTargets = pluginSkillTargets(paths);
  for (const skill of skillTargets) {
    if (!existsSync(join(skill.source, "SKILL.md"))) {
      return unsupportedRuntimeResult(parsed, `Bundled Agent Conveyor plugin skill is missing: ${skill.name}`);
    }
  }
  if (!parsed.flags.dryRun) {
    rmSync(paths.pluginInstallRoot, { force: true, recursive: true });
    mkdirSync(dirname(paths.pluginInstallRoot), { recursive: true });
    cpSync(paths.pluginSource, paths.pluginInstallRoot, { recursive: true });
    for (const skill of skillTargets) {
      rmSync(skill.target, { force: true, recursive: true });
      mkdirSync(dirname(skill.target), { recursive: true });
      cpSync(skill.source, skill.target, { recursive: true });
    }
  }
  const payload = {
    codex_home: paths.codexHome,
    dry_run: parsed.flags.dryRun,
    installed: parsed.flags.dryRun ? false : true,
    installed_skills: parsed.flags.dryRun ? [] : skillTargets.map((skill) => skill.name),
    package_version: packageVersion,
    plugin_install_root: paths.pluginInstallRoot,
    plugin_source: paths.pluginSource,
    plugin_version: manifest.version,
    skills: skillTargets,
  };
  if (parsed.flags.json) {
    return jsonResult(payload);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: `${parsed.flags.dryRun ? "would install" : "installed"} agent-conveyor plugin ${manifest.version} in ${paths.pluginInstallRoot}\n`,
  };
}
```

- [ ] **Step 12: Add unsupported option helper**

Add:

```ts
function unsupportedPluginOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task !== null) {
    return `Unexpected argument: ${parsed.task}`;
  }
  return null;
}
```

- [ ] **Step 13: Reuse `resolveCodexHome` inside `runInstallSkillsCommand`**

Replace the current `codexHome` line in `runInstallSkillsCommand`:

```ts
const codexHome = resolveCodexHome(parsed, options);
```

- [ ] **Step 14: Run focused build**

Run:

```bash
npm run build:cli
```

Expected: TypeScript compile succeeds.

- [ ] **Step 15: Commit**

```bash
git add src/cli/typescript-runtime.ts
git commit -m "Add Agent Conveyor plugin install commands"
```

---

### Task 3: Add CLI Contract Tests

**Files:**
- Modify: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Add imports if missing**

At the top of `src/cli/typescript-runtime.test.ts`, ensure these are imported
from `node:fs`:

```ts
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
```

Preserve any existing imported names and only add missing names.

- [ ] **Step 2: Add plugin install/status/path test**

Add this test near the existing install-skills assertion:

```ts
test("TypeScript runtime handles Agent Conveyor plugin install status and path commands", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-plugin."));
  try {
    const codexHome = join(root, "codex-home");

    const pathResult = runTypescriptRuntimeCommand({
      args: ["plugin-path", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(pathResult.exitCode, 0, pathResult.stderr);
    const pathPayload = JSON.parse(pathResult.stdout ?? "{}") as {
      plugin_install_root?: string;
      plugin_source?: string;
      skills_install_root?: string;
    };
    assert.match(pathPayload.plugin_source ?? "", /plugin\/agent-conveyor$/);
    assert.match(pathPayload.plugin_install_root ?? "", /plugins\/cache\/agent-conveyor\/agent-conveyor\/0\.1\.19$/);
    assert.equal(pathPayload.skills_install_root, join(codexHome, "skills"));

    const before = runTypescriptRuntimeCommand({
      args: ["plugin-status", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(before.exitCode, 0, before.stderr);
    const beforePayload = JSON.parse(before.stdout ?? "{}") as {
      installed?: boolean;
      package_version?: string;
      plugin_version?: string;
      skills?: Array<{ installed: boolean; name: string }>;
      version_matches?: boolean;
    };
    assert.equal(beforePayload.installed, false);
    assert.equal(beforePayload.package_version, "0.1.19");
    assert.equal(beforePayload.plugin_version, "0.1.19");
    assert.equal(beforePayload.version_matches, false);
    assert.deepEqual(
      beforePayload.skills?.map((skill) => [skill.name, skill.installed]),
      [
        ["conveyor-create-pair", false],
        ["conveyor-create-worker-set", false],
        ["conveyor-check-status", false],
      ],
    );

    const install = runTypescriptRuntimeCommand({
      args: ["install-plugin", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(install.exitCode, 0, install.stderr);
    const installPayload = JSON.parse(install.stdout ?? "{}") as {
      installed?: boolean;
      installed_skills?: string[];
      package_version?: string;
      plugin_install_root?: string;
      plugin_version?: string;
    };
    assert.equal(installPayload.installed, true);
    assert.equal(installPayload.package_version, "0.1.19");
    assert.equal(installPayload.plugin_version, "0.1.19");
    assert.deepEqual(installPayload.installed_skills?.sort(), [
      "conveyor-check-status",
      "conveyor-create-pair",
      "conveyor-create-worker-set",
    ]);
    assert.ok(existsSync(join(codexHome, "plugins", "cache", "agent-conveyor", "agent-conveyor", "0.1.19", "plugin.json")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-create-pair", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-create-worker-set", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-check-status", "SKILL.md")));

    const manifest = JSON.parse(readFileSync(join(installPayload.plugin_install_root ?? "", "plugin.json"), "utf8")) as {
      version?: string;
    };
    assert.equal(manifest.version, "0.1.19");

    const after = runTypescriptRuntimeCommand({
      args: ["plugin-status", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(after.exitCode, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout ?? "{}") as {
      installed?: boolean;
      installed_version?: string;
      version_matches?: boolean;
    };
    assert.equal(afterPayload.installed, true);
    assert.equal(afterPayload.installed_version, "0.1.19");
    assert.equal(afterPayload.version_matches, true);

    const dryRun = runTypescriptRuntimeCommand({
      args: ["install-plugin", "--codex-home", join(root, "dry-home"), "--dry-run", "--json"],
      env: {},
    });
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    const dryRunPayload = JSON.parse(dryRun.stdout ?? "{}") as { installed?: boolean; installed_skills?: string[] };
    assert.equal(dryRunPayload.installed, false);
    assert.deepEqual(dryRunPayload.installed_skills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the new test before implementation if Task 2 has not run**

Run:

```bash
npm test -- --runInBand
```

Expected before Task 2: failure mentioning unknown command or unsupported
`--codex-home` for plugin commands. Expected after Task 2: all tests pass.

- [ ] **Step 4: Run focused full test command after implementation**

Run:

```bash
npm test -- --runInBand
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/typescript-runtime.test.ts
git commit -m "Test Agent Conveyor plugin install commands"
```

---

### Task 4: Package The Plugin And Verify Tarball Contents

**Files:**
- Modify: `package.json`
- Modify: `scripts/package-smoke`
- Modify: `scripts/release-check`

- [ ] **Step 1: Add plugin files to npm package**

Modify `package.json` `files` array to include:

```json
"plugin/**/*",
```

Place it after `"skills/**/*"` so package surfaces stay grouped.

- [ ] **Step 2: Extend `scripts/package-smoke` required tarball files**

Add these entries to the `required` array in `scripts/package-smoke`:

```js
"plugin/agent-conveyor/plugin.json",
"plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md",
"plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md",
"plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md",
```

- [ ] **Step 3: Add plugin manifest version assertion to `scripts/package-smoke`**

Inside the Node block that reads `pack.files`, add:

```js
const packageManifest = JSON.parse(fs.readFileSync(require("path").join(process.cwd(), "..", "package.json"), "utf8"));
```

If that path is not reliable inside the existing subshell, pass `"$ROOT/package.json"`
as an additional Node argument and read it as `process.argv[3]`.

Then assert:

```js
const pluginManifestFile = files.get("plugin/agent-conveyor/plugin.json");
if (!pluginManifestFile) {
  throw new Error("npm tarball missing Agent Conveyor plugin manifest");
}
```

Use a second Node block after `npm install -g` to validate the installed plugin
through the CLI, as described in Step 4.

- [ ] **Step 4: Add clean installed plugin smoke to `scripts/package-smoke`**

After the existing `install-skills` smoke, add:

```bash
CODEX_HOME="$CODEX_HOME_DIR" PATH="$PREFIX/bin:$PATH" "$CONVEYOR" install-plugin --codex-home "$CODEX_HOME_DIR" --json > "$SMOKE_DIR/install-plugin.json"
CODEX_HOME="$CODEX_HOME_DIR" PATH="$PREFIX/bin:$PATH" "$CONVEYOR" plugin-status --codex-home "$CODEX_HOME_DIR" --json > "$SMOKE_DIR/plugin-status.json"
```

Then validate:

```js
const installPlugin = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const pluginStatus = JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
if (installPlugin.package_version !== installPlugin.plugin_version) {
  throw new Error(`plugin version mismatch in install receipt: ${JSON.stringify(installPlugin)}`);
}
if (!pluginStatus.version_matches) {
  throw new Error(`plugin status does not report version match: ${JSON.stringify(pluginStatus)}`);
}
for (const name of ["conveyor-create-pair", "conveyor-create-worker-set", "conveyor-check-status"]) {
  if (!fs.existsSync(path.join(codexHome, "skills", name, "SKILL.md"))) {
    throw new Error(`expected installed plugin skill missing: ${name}`);
  }
}
if (!fs.existsSync(path.join(codexHome, "plugins", "cache", "agent-conveyor", "agent-conveyor", installPlugin.package_version, "plugin.json"))) {
  throw new Error("expected versioned plugin manifest missing");
}
```

- [ ] **Step 5: Extend `scripts/release-check` tarball assertions**

Add the same four plugin files to the `required` array in `scripts/release-check`:

```js
"plugin/agent-conveyor/plugin.json",
"plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md",
"plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md",
"plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md",
```

- [ ] **Step 6: Extend `scripts/release-check` clean install proof**

After the existing install-skills proof in `scripts/release-check`, add:

```bash
CODEX_HOME="$CODEX_HOME_DIR" PATH="$PREFIX/bin:$PATH" "$CONVEYOR" install-plugin --codex-home "$CODEX_HOME_DIR" --json > "$WORK_DIR/install-plugin.json"
CODEX_HOME="$CODEX_HOME_DIR" PATH="$PREFIX/bin:$PATH" "$CONVEYOR" plugin-status --codex-home "$CODEX_HOME_DIR" --json > "$WORK_DIR/plugin-status.json"
```

Add a Node validation block equivalent to Task 4 Step 4 and include plugin
version, plugin root, and plugin skills in the final release-check receipt.

- [ ] **Step 7: Run package smoke**

Run:

```bash
scripts/package-smoke
```

Expected: package tarball exposes CLI aliases, legacy bundled skills, and
versioned plugin install/status.

- [ ] **Step 8: Run release check**

Run:

```bash
scripts/release-check
```

Expected: packed tarball installs in a clean prefix and verifies plugin files,
plugin install, plugin status, and legacy skill compatibility.

- [ ] **Step 9: Commit**

```bash
git add package.json scripts/package-smoke scripts/release-check
git commit -m "Package Agent Conveyor operator plugin"
```

---

### Task 5: Add Portable Project Ledger Proof

**Files:**
- Modify: `src/cli/typescript-runtime.test.ts`
- Modify: `plugin/agent-conveyor/skills/conveyor-create-pair/SKILL.md`
- Modify: `plugin/agent-conveyor/skills/conveyor-create-worker-set/SKILL.md`
- Modify: `plugin/agent-conveyor/skills/conveyor-check-status/SKILL.md`

- [ ] **Step 1: Add a test that installed skills mention per-project ledger**

Add to the plugin test from Task 3 after install:

```ts
for (const name of ["conveyor-create-pair", "conveyor-create-worker-set", "conveyor-check-status"]) {
  const text = readFileSync(join(codexHome, "skills", name, "SKILL.md"), "utf8");
  assert.match(text, /\.codex-workers\/workerctl\.db/);
  assert.doesNotMatch(text, /\/Users\/neonwatty\/Desktop\/codex-terminal-manager\/\.codex-workers\/workerctl\.db/);
}
```

- [ ] **Step 2: Add a test that plugin skills stay Codex-app-only**

Add:

```ts
const pairSkill = readFileSync(join(codexHome, "skills", "conveyor-create-pair", "SKILL.md"), "utf8");
assert.match(pairSkill, /Codex app/);
assert.match(pairSkill, /Do not use tmux/);
```

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --runInBand
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/typescript-runtime.test.ts plugin/agent-conveyor/skills
git commit -m "Verify portable operator plugin skill contracts"
```

---

### Task 6: Documentation And Compatibility Handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/package-release.md`

- [ ] **Step 1: Add README install snippet**

Add a short plugin section near the package install instructions:

````markdown
### Codex Operator Plugin

Install the Agent Conveyor CLI and Codex operator plugin:

```bash
npm install -g agent-conveyor
conveyor install-plugin
conveyor plugin-status
```

The plugin installs operator skills for Codex-app-only manager/worker setup
from any project. Portable loops default to the target project's
`.codex-workers/workerctl.db` ledger.
````

- [ ] **Step 2: Update package release docs**

In `docs/package-release.md`, add `conveyor install-plugin` and
`conveyor plugin-status` to the clean-prefix verification commands:

```bash
CODEX_HOME="$tmp_home" PATH="$tmp_prefix/bin:$PATH" conveyor install-plugin --json
CODEX_HOME="$tmp_home" PATH="$tmp_prefix/bin:$PATH" conveyor plugin-status --json
pkg_version="$(node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); process.stdout.write(pkg.version)')"
test -f "$tmp_home/plugins/cache/agent-conveyor/agent-conveyor/$pkg_version/plugin.json"
test -f "$tmp_home/skills/conveyor-create-pair/SKILL.md"
test -f "$tmp_home/skills/conveyor-create-worker-set/SKILL.md"
test -f "$tmp_home/skills/conveyor-check-status/SKILL.md"
```

- [ ] **Step 3: Run docs grep**

Run:

```bash
rg -n "install-plugin|plugin-status|conveyor-create-pair|conveyor-create-worker-set|conveyor-check-status" README.md docs/package-release.md
```

Expected: both files mention plugin install/status and the skills.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/package-release.md
git commit -m "Document Agent Conveyor operator plugin install"
```

---

### Task 7: Final Verification And PR Prep

**Files:**
- No code changes expected.

- [ ] **Step 1: Run CLI build**

```bash
npm run build:cli
```

Expected: TypeScript compile passes.

- [ ] **Step 2: Run full tests**

```bash
npm test -- --runInBand
```

Expected: all tests pass.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: no lint failures.

- [ ] **Step 4: Run full build**

```bash
npm run build
```

Expected: CLI and dashboard build pass.

- [ ] **Step 5: Run package proof**

```bash
scripts/package-smoke
scripts/release-check
```

Expected: both pass with plugin install/status proof.

- [ ] **Step 6: Run diff hygiene**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional committed changes or a clean
tree after the final commit.

- [ ] **Step 7: Disproof attempt**

Try to disprove the main claim that the plugin can be installed from a clean
package and matches package version:

```bash
tmp_prefix="$(mktemp -d)"
tmp_home="$(mktemp -d)"
npm pack --json > /tmp/agent-conveyor-plugin-pack.json
tarball="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("/tmp/agent-conveyor-plugin-pack.json","utf8"))[0]; process.stdout.write(p.filename)')"
npm install -g --prefix "$tmp_prefix" "./$tarball"
CODEX_HOME="$tmp_home" PATH="$tmp_prefix/bin:$PATH" conveyor install-plugin --json
CODEX_HOME="$tmp_home" PATH="$tmp_prefix/bin:$PATH" conveyor plugin-status --json
test -f "$tmp_home/skills/conveyor-create-pair/SKILL.md"
rm -rf "$tmp_prefix" "$tmp_home" "$tarball" /tmp/agent-conveyor-plugin-pack.json
```

Expected: install succeeds, plugin status reports a version match, and the
operator skill file exists.

- [ ] **Step 8: Commit any verification doc or script fixes**

If verification required script/doc corrections, stage the files changed by
`git status --short` and commit them:

```bash
git status --short
git add package.json README.md docs/package-release.md scripts/package-smoke scripts/release-check src/cli/typescript-runtime.ts src/cli/typescript-runtime.test.ts plugin/agent-conveyor
git commit -m "Polish Agent Conveyor plugin verification"
```

- [ ] **Step 9: Open PR**

```bash
git push -u origin codex/agent-conveyor-operator-plugin
gh pr create --base main --head codex/agent-conveyor-operator-plugin --title "Add Agent Conveyor operator plugin" --body "$(cat <<'EOF'
## Summary
- add the in-repo Agent Conveyor operator plugin
- add install-plugin, plugin-status, and plugin-path commands
- package and release-check plugin install/status proof

## Verification
- npm run build:cli
- npm test -- --runInBand
- npm run lint
- npm run build
- scripts/package-smoke
- scripts/release-check
- clean npm-pack install-plugin disproof command from the implementation plan
EOF
)"
```

PR body must include:

- plugin source path;
- three operator skills;
- package version lock proof;
- `install-plugin` and `plugin-status` proof;
- `npm test -- --runInBand`;
- `npm run lint`;
- `npm run build`;
- `scripts/package-smoke`;
- `scripts/release-check`;
- disproof attempt result.

---

## Self-Review Checklist

- Spec coverage:
  - In-repo plugin source: Task 1.
  - Version lock to npm package: Tasks 1, 2, 3, 4, 7.
  - Operator-only Codex-app-only skills: Tasks 1 and 5.
  - Per-project ledger: Tasks 1 and 5.
  - `install-plugin`, `plugin-status`, `plugin-path`: Tasks 2 and 3.
  - npm tarball and release proof: Tasks 4 and 7.
  - Compatibility with `install-skills`: Task 4.
- Placeholder scan:
  - The plan contains no open-ended implementation placeholders.
- Type consistency:
  - Command names are `install-plugin`, `plugin-status`, and `plugin-path`.
  - Skill names are `conveyor-create-pair`, `conveyor-create-worker-set`, and
    `conveyor-check-status`.
  - Plugin name is `agent-conveyor`.
