# Setup Bundle Dogfood Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repeatable, on-rails dogfood coverage for the setup-bundle concierge so local and CI runs prove setup policy, ledger persistence, fail-closed preflight, and dry-run handoff behavior before any live autonomous ship-it run.

**Architecture:** Reuse the existing `qa-plan` / `qa-run` harness instead of creating a separate test runner. The CI-safe path creates temp ledgers, temp Codex homes, and a disposable local fixture repo; the live GitHub sandbox path is documented as an explicit opt-in operator drill with allowlisted repo/branch/iteration limits.

**Tech Stack:** TypeScript CLI runtime, Node test runner, SQLite ledger, local Git fixture repositories, Agent Conveyor QA receipts, GitHub CLI for optional live sandbox dogfoods.

---

## File Structure

- Modify `src/cli/typescript-runtime.ts`
  - Add `setup-bundle-dogfood` to `qa-plan` and `qa-run`.
  - Implement a CI-safe `qaRunSetupBundleDogfood()` receipt generator.
  - Create a tiny local fixture repo under the `qa-run` temp directory.
  - Prove rails without launching real Codex sessions or touching GitHub.
- Modify `src/cli/typescript-runtime.test.ts`
  - Add focused tests for the new `qa-plan` and `qa-run` scenario.
  - Assert receipt shape, guardrail checks, replay commands, and no-launch behavior.
- Modify `README.md`
  - Document `qa-plan setup-bundle-dogfood`.
  - Document `qa-run setup-bundle-dogfood --receipt-output ...`.
  - Clarify that this is CI-safe and does not create live PRs.
- Modify `docs/manual-qa-checklist.md`
  - Add the repeatable local setup-bundle dogfood command.
- Create `docs/qa/setup-bundle-dogfood.md`
  - Operator guide for the two-tier dogfood model: local fixture and live GitHub sandbox.
  - Specify sandbox repo rails, required flags, allowed branch prefix, max iterations, max PRs, and receipt requirements.

## Dogfood Rails

The local `qa-run setup-bundle-dogfood` must be safe by default:

- Use a temp DB unless `--path` is provided.
- Use a temp Codex home for required/optional skill preflight.
- Use a disposable local Git fixture repo under the QA artifact directory.
- Never call `gh`, never push, never create a PR, never merge.
- Never launch Codex app sessions.
- Prove launch handoff only through dry-run or generated replay commands.
- Write a receipt containing enough evidence to replay the same checks manually.

The live sandbox dogfood remains manual/explicit:

- Use only an allowlisted GitHub sandbox repo such as `neonwatty/agent-conveyor-dogfood-sandbox`.
- Use only branches prefixed with `dogfood/`.
- Require explicit operator consent before GitHub side effects.
- Require max PRs, max iterations, and max runtime.
- Require setup bundle `show` readback before manager/worker launch.
- Require CI, PR review, mergeability, manager decision, merge, post-merge verification, and adversarial proof before completion.

## Task 1: Add QA Scenario Registration

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write the failing qa-plan test**

Add this test near the existing `qa-plan` assertions in `src/cli/typescript-runtime.test.ts`:

```ts
test("TypeScript runtime qa-plan documents setup bundle dogfood rails", () => {
  const result = runTypescriptRuntimeCommand({
    args: ["qa-plan", "setup-bundle-dogfood", "--json"],
    env: {},
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout ?? "{}") as {
    acceptance_criteria: string[];
    authority_boundaries: string[];
    correlation_markers: Array<{ correlation_id: string; purpose: string }>;
    expected_observations: string[];
    scenario: string;
    steps: string[];
  };
  assert.equal(payload.scenario, "setup-bundle-dogfood");
  assert.ok(payload.authority_boundaries.some((item) => item.includes("No GitHub side effects")));
  assert.ok(payload.authority_boundaries.some((item) => item.includes("Do not launch manager or worker sessions")));
  assert.ok(payload.steps.some((item) => item.includes("preview is read-only")));
  assert.ok(payload.expected_observations.some((item) => item.includes("missing required Superpowers review backend blocks")));
  assert.ok(payload.acceptance_criteria.some((item) => item.includes("setup-bundle show is ledger truth")));
  assert.ok(payload.correlation_markers.some((item) => item.correlation_id === "setup-bundle-dogfood-missing-backend"));
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup bundle dogfood rails"
```

Expected: fail with unsupported `qa-plan` subtype or missing scenario fields.

- [ ] **Step 3: Register the QA scenario**

In `src/cli/typescript-runtime.ts`, add `setup-bundle-dogfood` to `SUPPORTED_QA_RUN_SCENARIOS`:

```ts
const SUPPORTED_QA_RUN_SCENARIOS = new Set([
  "adversarial-triggers",
  "build-clear-loop",
  "generic-loop-template",
  "generic-loop-template-browser",
  "ralph-loop-guardrails",
  "setup-bundle-dogfood",
  "ship-it-loop",
  "test-coverage-loop",
]);
```

Add a `qa-plan` branch in the existing QA plan builder:

```ts
if (scenario === "setup-bundle-dogfood") {
  return {
    acceptance_criteria: [
      "setup-bundle preview is read-only for every supported setup preset",
      "missing required Superpowers review backend blocks before launch",
      "approved setup bundles are persisted and setup-bundle show is ledger truth",
      "manager permissions and worker policy are derived from the selected preset",
      "worker-set intent remains a launch handoff and is not silently persisted as setup-bundle worker count",
    ],
    authority_boundaries: [
      "No GitHub side effects: do not run gh, do not push, do not create a PR, and do not merge.",
      "Do not launch manager or worker sessions during the CI-safe dogfood.",
      "Use only temp ledgers, temp Codex homes, and disposable local fixture repositories.",
      "Treat preview/apply/show JSON and direct SQLite inspection as proof, not generated summaries.",
    ],
    correlation_markers: [
      { correlation_id: "setup-bundle-dogfood-preview-readonly", purpose: "preview does not write setup_bundles" },
      { correlation_id: "setup-bundle-dogfood-missing-backend", purpose: "required review backend fails closed" },
      { correlation_id: "setup-bundle-dogfood-applied-readback", purpose: "show readback matches applied setup hash" },
      { correlation_id: "setup-bundle-dogfood-no-launch", purpose: "handoff is replay-only and no sessions are launched" },
    ],
    expected_observations: [
      "preview is read-only for autonomous, test coverage, UX, and PR/CI/merge presets",
      "missing required Superpowers review backend blocks with zero manager configs",
      "applied autonomous setup writes one setup bundle and one manager config",
      "setup-bundle show returns the same approved hash and policy used by apply",
      "receipt replay commands describe launch handoff without launching sessions",
    ],
    scenario,
    starter_prompt: "Run the CI-safe setup-bundle dogfood before trying live autonomous ship-it work.",
    steps: [
      "Create a temp fixture repo and temp Conveyor ledger.",
      "Create setup tasks for each preset.",
      "Preview each preset and verify preview is read-only.",
      "Apply a missing required Superpowers PR review setup and verify it blocks before manager config creation.",
      "Apply an autonomous ship-it setup with satisfied required skills and verify setup-bundle show readback.",
      "Record replay-only pair and worker-set launch handoff commands.",
      "Write a receipt with checks, artifact paths, and replay commands.",
    ],
  };
}
```

- [ ] **Step 4: Run the qa-plan test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup bundle dogfood rails"
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/typescript-runtime.ts src/cli/typescript-runtime.test.ts
git commit -m "test: add setup bundle dogfood qa plan"
```

## Task 2: Implement CI-Safe Setup Bundle Dogfood Receipt

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write the failing qa-run receipt test**

Add this test in `src/cli/typescript-runtime.test.ts` near the existing QA-run tests:

```ts
test("TypeScript runtime qa-run setup-bundle-dogfood writes CI-safe receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-dogfood."));
  try {
    const dbPath = join(root, "workerctl.db");
    const receiptPath = join(root, "setup-bundle-dogfood-receipt.json");
    const result = runTypescriptRuntimeCommand({
      args: ["qa-run", "setup-bundle-dogfood", "--path", dbPath, "--receipt-output", receiptPath, "--json"],
      env: {},
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(existsSync(receiptPath));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      artifacts: { db_path: string; fixture_repo: string };
      checks: Array<{ name: string; status: string }>;
      generated_tasks: Array<{ task_name: string }>;
      live_sandbox: { enabled: boolean; reason: string };
      replay_commands: string[];
      result: string;
      scenario: string;
    };
    assert.equal(receipt.scenario, "setup-bundle-dogfood");
    assert.equal(receipt.result, "passed");
    assert.equal(receipt.artifacts.db_path, dbPath);
    assert.ok(existsSync(receipt.artifacts.fixture_repo));
    assert.equal(receipt.live_sandbox.enabled, false);
    assert.match(receipt.live_sandbox.reason, /CI-safe/);
    for (const name of [
      "all_preset_previews_are_read_only",
      "missing_superpowers_review_backend_blocks_before_launch",
      "autonomous_ship_it_apply_persists_setup_and_manager_config",
      "setup_bundle_show_matches_applied_hash",
      "worker_set_intent_is_handoff_only",
      "no_sessions_created_during_dogfood",
    ]) {
      assert.ok(receipt.checks.some((check) => check.name === name && check.status === "passed"), name);
    }
    assert.ok(receipt.replay_commands.some((command) => command.includes("conveyor setup-bundle preview")));
    assert.ok(receipt.replay_commands.some((command) => command.includes("conveyor setup-bundle show")));
    assert.ok(receipt.replay_commands.some((command) => command.includes("conveyor pair") && command.includes("--dry-run")));

    const proofDb = openDatabaseSync(dbPath);
    try {
      assert.equal((proofDb.prepare("select count(*) as count from sessions").get() as { count: number }).count, 0);
      assert.equal((proofDb.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count >= 1, true);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing qa-run test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle-dogfood writes CI-safe receipt"
```

Expected: fail because `qa-run setup-bundle-dogfood` is not implemented.

- [ ] **Step 3: Add scenario dispatch**

In `runQaScenario()` in `src/cli/typescript-runtime.ts`, add:

```ts
if (scenario === "setup-bundle-dogfood") {
  return qaRunSetupBundleDogfood(context);
}
```

- [ ] **Step 4: Implement a fixture repo helper**

Add this helper near other QA helper functions in `src/cli/typescript-runtime.ts`:

```ts
function createQaSetupBundleFixtureRepo(context: QaRunContext, slug: string): string {
  const repo = join(dirname(context.dbPath), "qa-artifacts", "setup-bundle-dogfood", slug, "fixture-repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "setup-bundle-dogfood-fixture",
    private: true,
    scripts: { test: "node src/check.mjs" },
    type: "module",
  }, null, 2)}\n`);
  writeFileSync(join(repo, "src", "check.mjs"), "console.log('setup-bundle dogfood fixture ok');\n");
  writeFileSync(join(repo, "README.md"), "# Setup Bundle Dogfood Fixture\n\nDisposable local fixture repo for CI-safe dogfood.\n");
  const init = runCommandForQa(context, ["git", "init", "-b", "main"], repo);
  qaRequire(init.returncode === 0, `fixture git init failed: ${init.stderr}`);
  const add = runCommandForQa(context, ["git", "add", "."], repo);
  qaRequire(add.returncode === 0, `fixture git add failed: ${add.stderr}`);
  const commit = runCommandForQa(context, ["git", "-c", "user.name=Agent Conveyor QA", "-c", "user.email=qa@example.invalid", "commit", "-m", "fixture"], repo);
  qaRequire(commit.returncode === 0, `fixture git commit failed: ${commit.stderr}`);
  return repo;
}
```

If `runCommandForQa()` does not exist, add this minimal helper near the fixture helper:

```ts
function runCommandForQa(context: QaRunContext, args: string[], cwd: string): { returncode: number; stderr: string; stdout: string } {
  const child = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: context.runtimeOptions.env,
  });
  return {
    returncode: child.status ?? 1,
    stderr: child.stderr ?? "",
    stdout: child.stdout ?? "",
  };
}
```

Add required imports at the top of the file if missing:

```ts
import { spawnSync } from "node:child_process";
```

- [ ] **Step 5: Implement a command helper for setup dogfood**

Add this helper near QA helpers in `src/cli/typescript-runtime.ts`:

```ts
function runQaRuntimeJson(context: QaRunContext, args: string[], stdin?: string): Record<string, unknown> {
  const result = runTypescriptRuntimeCommand({
    ...context.runtimeOptions,
    args,
    env: {
      ...(context.runtimeOptions.env ?? {}),
      AGENT_CONVEYOR_TS_RUNTIME: "1",
    },
    stdin,
  });
  qaRequire(result.exitCode === 0, `${args.join(" ")} failed: ${result.stderr ?? result.stdout ?? ""}`);
  return JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
}

function runQaRuntimeExpectExit(context: QaRunContext, args: string[], expectedExitCode: number): Record<string, unknown> {
  const result = runTypescriptRuntimeCommand({
    ...context.runtimeOptions,
    args,
    env: {
      ...(context.runtimeOptions.env ?? {}),
      AGENT_CONVEYOR_TS_RUNTIME: "1",
    },
  });
  qaRequire(result.exitCode === expectedExitCode, `${args.join(" ")} exited ${result.exitCode}, expected ${expectedExitCode}: ${result.stderr ?? result.stdout ?? ""}`);
  return JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
}
```

- [ ] **Step 6: Implement `qaRunSetupBundleDogfood`**

Add this function near the other `qaRun...` functions:

```ts
function qaRunSetupBundleDogfood(context: QaRunContext): QaRunReceipt {
  const slug = randomUUID().slice(0, 8);
  const fixtureRepo = createQaSetupBundleFixtureRepo(context, slug);
  const checks: Array<Record<string, unknown>> = [];
  const generatedTasks: QaGeneratedTask[] = [];
  const codexHomeMissing = join(dirname(context.dbPath), "qa-artifacts", "setup-bundle-dogfood", slug, "codex-home-missing");
  const codexHomeReady = join(dirname(context.dbPath), "qa-artifacts", "setup-bundle-dogfood", slug, "codex-home-ready");
  mkdirSync(codexHomeMissing, { recursive: true });
  for (const skill of ["goal-prep", "codex-review", "requesting-code-review", "receiving-code-review", "security-diff-scan", "superpowers:requesting-code-review", "superpowers:receiving-code-review"]) {
    const parts = skill.split(":");
    const dir = parts.length === 2 ? parts[1] : skill;
    const name = skill;
    const skillDir = parts.length === 2
      ? join(codexHomeReady, "plugins", "cache", parts[0], parts[0], "1.0.0", "skills", dir)
      : join(codexHomeReady, "skills", dir);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  }

  const presets = ["autonomous_ship_it", "test_coverage_ralph", "ux_polish_ralph", "pr_ci_merge_ralph"];
  const previewSummaries: Array<Record<string, unknown>> = [];
  for (const preset of presets) {
    const taskName = `qa-setup-${preset}-${slug}`;
    runQaRuntimeJson(context, ["tasks", "--create", taskName, "--goal", `Dogfood setup preset ${preset}.`, "--path", context.dbPath, "--json"]);
    generatedTasks.push({ suffix: preset, task_id: taskName, task_name: taskName });
    const before = qaSetupBundleCount(context);
    const preview = runQaRuntimeJson(context, [
      "setup-bundle",
      "preview",
      taskName,
      "--preset",
      preset,
      "--codex-home",
      codexHomeReady,
      "--path",
      context.dbPath,
      "--json",
    ]);
    const after = qaSetupBundleCount(context);
    qaRequire(before === after, `preview for ${preset} mutated setup_bundles`);
    previewSummaries.push({
      draft_hash: preview.draft_hash,
      ok: (preview.preflight as { ok?: boolean } | undefined)?.ok,
      preset,
    });
  }
  checks.push({
    name: "all_preset_previews_are_read_only",
    previews: previewSummaries,
    status: "passed",
  });

  const blockedTask = `qa-setup-blocked-${slug}`;
  runQaRuntimeJson(context, ["tasks", "--create", blockedTask, "--goal", "Missing Superpowers review backend should block.", "--path", context.dbPath, "--json"]);
  generatedTasks.push({ suffix: "missing-superpowers", task_id: blockedTask, task_name: blockedTask });
  const blocked = runQaRuntimeExpectExit(context, [
    "setup-bundle",
    "apply",
    blockedTask,
    "--preset",
    "custom",
    "--planning-backend",
    "direct_prompt",
    "--pr-review-backend",
    "superpowers",
    "--pr-review-required",
    "--codex-home",
    codexHomeMissing,
    "--approve",
    "--path",
    context.dbPath,
    "--json",
  ], 1);
  qaRequire(blocked.blocked === true, "missing backend apply did not report blocked=true");
  qaRequire(qaManagerConfigCount(context, blockedTask) === 0, "blocked setup created manager config");
  checks.push({
    blocked,
    correlation_id: "setup-bundle-dogfood-missing-backend",
    name: "missing_superpowers_review_backend_blocks_before_launch",
    status: "passed",
  });

  const appliedTask = `qa-setup-applied-${slug}`;
  runQaRuntimeJson(context, ["tasks", "--create", appliedTask, "--goal", "Apply autonomous setup bundle.", "--path", context.dbPath, "--json"]);
  generatedTasks.push({ suffix: "applied-ship-it", task_id: appliedTask, task_name: appliedTask });
  const apply = runQaRuntimeJson(context, [
    "setup-bundle",
    "apply",
    appliedTask,
    "--preset",
    "autonomous_ship_it",
    "--codex-home",
    codexHomeReady,
    "--approve",
    "--path",
    context.dbPath,
    "--json",
  ]);
  qaRequire(apply.blocked === false, "autonomous apply reported blocked");
  qaRequire(qaManagerConfigCount(context, appliedTask) === 1, "autonomous apply did not create one manager config");
  checks.push({
    name: "autonomous_ship_it_apply_persists_setup_and_manager_config",
    setup_bundle: apply.setup_bundle,
    status: "passed",
  });

  const show = runQaRuntimeJson(context, ["setup-bundle", "show", appliedTask, "--path", context.dbPath, "--json"]);
  const appliedBundle = apply.setup_bundle as { approved_hash?: string; id?: string; policy?: { workers?: { count?: number } } };
  const shownBundle = show as { approved_hash?: string; id?: string; policy?: { workers?: { count?: number } } };
  qaRequire(shownBundle.id === appliedBundle.id, "show returned a different setup bundle id");
  qaRequire(shownBundle.approved_hash === appliedBundle.approved_hash, "show returned a different approved hash");
  checks.push({
    approved_hash: shownBundle.approved_hash,
    name: "setup_bundle_show_matches_applied_hash",
    status: "passed",
  });

  qaRequire(shownBundle.policy?.workers?.count === 1, "setup bundle unexpectedly persisted worker-set count");
  checks.push({
    name: "worker_set_intent_is_handoff_only",
    persisted_worker_count: shownBundle.policy?.workers?.count,
    recommended_handoff: "conveyor-create-worker-set after setup-bundle show confirms state=applied",
    status: "passed",
  });

  qaRequire(qaSessionCount(context) === 0, "setup dogfood created sessions");
  checks.push({
    name: "no_sessions_created_during_dogfood",
    session_count: 0,
    status: "passed",
  });

  return {
    artifacts: {
      codex_home_missing: codexHomeMissing,
      codex_home_ready: codexHomeReady,
      db_path: context.dbPath,
      fixture_repo: fixtureRepo,
    },
    checks,
    generated_at: new Date().toISOString(),
    generated_tasks: generatedTasks,
    live_sandbox: {
      enabled: false,
      reason: "CI-safe setup-bundle dogfood does not perform GitHub side effects or launch Codex sessions.",
    },
    replay_commands: [
      `conveyor setup-bundle preview ${appliedTask} --preset autonomous_ship_it --path ${context.dbPath} --json`,
      `conveyor setup-bundle show ${appliedTask} --path ${context.dbPath} --json`,
      `conveyor pair --task ${appliedTask} --worker-name dogfood-worker --manager-name dogfood-manager --cwd ${fixtureRepo} --path ${context.dbPath} --dry-run --json`,
      "Use conveyor-create-worker-set only after setup-bundle show confirms state=applied.",
      "Use docs/qa/setup-bundle-dogfood.md for the explicit live GitHub sandbox drill.",
    ],
    result: "passed",
    scenario: "setup-bundle-dogfood",
  };
}
```

- [ ] **Step 7: Add ledger inspection helpers**

Add these helpers near the QA helper section:

```ts
function qaSetupBundleCount(context: QaRunContext): number {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return (database.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function qaSessionCount(context: QaRunContext): number {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return (database.prepare("select count(*) as count from sessions").get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function qaManagerConfigCount(context: QaRunContext, taskName: string): number {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const row = database.prepare("select id from tasks where name = ? limit 1").get(taskName) as { id: string } | undefined;
    qaRequire(row !== undefined, `unknown task ${taskName}`);
    return (database.prepare("select count(*) as count from manager_configs where task_id = ?").get(row.id) as { count: number }).count;
  } finally {
    database.close();
  }
}
```

- [ ] **Step 8: Run the focused qa-run test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle-dogfood writes CI-safe receipt"
```

Expected: pass.

- [ ] **Step 9: Run the manual command**

Run:

```bash
conveyor qa-run setup-bundle-dogfood --receipt-output /tmp/setup-bundle-dogfood-receipt.json --json
```

Expected: JSON receipt with `scenario: "setup-bundle-dogfood"` and `result: "passed"`.

- [ ] **Step 10: Commit**

```bash
git add src/cli/typescript-runtime.ts src/cli/typescript-runtime.test.ts
git commit -m "feat: add setup bundle dogfood qa run"
```

## Task 3: Document the Local and Live Dogfood Rails

**Files:**
- Create: `docs/qa/setup-bundle-dogfood.md`
- Modify: `README.md`
- Modify: `docs/manual-qa-checklist.md`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write documentation assertions**

Add assertions to the existing README/manual docs test area in `src/cli/typescript-runtime.test.ts` if one exists. If no docs assertion block exists, add this test near other CLI documentation checks:

```ts
test("setup bundle dogfood docs describe local and live rails", () => {
  const guide = readFileSync("docs/qa/setup-bundle-dogfood.md", "utf8");
  assert.match(guide, /Local CI-safe dogfood/);
  assert.match(guide, /Live GitHub sandbox dogfood/);
  assert.match(guide, /agent-conveyor-dogfood-sandbox/);
  assert.match(guide, /dogfood\\//);
  assert.match(guide, /--allow-github-side-effects/);
  assert.match(guide, /setup-bundle show/);
  assert.match(guide, /adversarial proof/);

  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /qa-run setup-bundle-dogfood/);

  const checklist = readFileSync("docs/manual-qa-checklist.md", "utf8");
  assert.match(checklist, /setup-bundle-dogfood-receipt/);
});
```

- [ ] **Step 2: Run the failing documentation test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup bundle dogfood docs"
```

Expected: fail because the guide and README entries do not exist yet.

- [ ] **Step 3: Create the operator guide**

Create `docs/qa/setup-bundle-dogfood.md`:

```markdown
# Setup Bundle Dogfood

This guide keeps setup-bundle dogfooding on rails. There are two dogfood tiers:

1. Local CI-safe dogfood
2. Live GitHub sandbox dogfood

## Local CI-safe dogfood

Use this before live autonomous ship-it work:

```bash
conveyor qa-plan setup-bundle-dogfood
conveyor qa-run setup-bundle-dogfood \
  --receipt-output /tmp/setup-bundle-dogfood-receipt.json \
  --json
```

This flow uses temp ledgers, temp Codex homes, and a disposable local fixture
repo. It does not run `gh`, push branches, create PRs, merge, or launch manager
or worker sessions.

The receipt must prove:

- setup-bundle preview is read-only for every supported setup preset
- missing required Superpowers review backend blocks before launch
- approved setup bundles persist to `setup_bundles`
- `setup-bundle show` is ledger truth for approved hash and policy
- worker-set intent is only a launch handoff, not silently persisted worker count
- no sessions are created during the CI-safe dogfood

## Live GitHub sandbox dogfood

Use a dedicated sandbox repository such as:

```text
neonwatty/agent-conveyor-dogfood-sandbox
```

Required rails:

- The repo must be explicitly allowlisted by the operator.
- Branches must use the `dogfood/` prefix.
- The run must set max iterations, max PRs, and max runtime.
- The operator must explicitly approve GitHub side effects with an
  `--allow-github-side-effects` equivalent in the launch prompt or future CLI.
- The setup bundle must be applied and verified with `setup-bundle show` before
  manager or worker launch.
- The manager must stop before merge unless CI is green, PR review proof exists,
  mergeability is clean, and manager merge decision is recorded.
- The manager must record post-merge verification and adversarial proof before
  declaring the dogfood complete.

Recommended live flow:

```bash
TASK="setup-dogfood-live"
LEDGER="$PWD/.codex-workers/workerctl.db"

conveyor tasks --create "$TASK" \
  --goal "Run live setup-bundle dogfood in the sandbox repo." \
  --path "$LEDGER" \
  --json

conveyor setup-bundle preview "$TASK" \
  --preset autonomous_ship_it \
  --pr-review-backend composite \
  --pr-review-required \
  --whats-next execute_bounded \
  --whats-next-max-iterations 1 \
  --path "$LEDGER" \
  --json

conveyor setup-bundle apply "$TASK" \
  --preset autonomous_ship_it \
  --pr-review-backend composite \
  --pr-review-required \
  --whats-next execute_bounded \
  --whats-next-max-iterations 1 \
  --approve \
  --path "$LEDGER" \
  --json

conveyor setup-bundle show "$TASK" --path "$LEDGER" --json
```

Only after `show` confirms `state: "applied"`, launch the manager/worker setup
with the `conveyor-setup-bundle` handoff rules.

Final live receipt must include:

- sandbox repo URL
- setup preview hash
- applied setup bundle id and approved hash
- branch name with `dogfood/` prefix
- PR URL
- CI result
- PR review result
- mergeability result
- manager merge decision
- merge SHA
- post-merge verification command/result
- what’s-next iterations used
- adversarial proof with `failure_mode`, `check`, and `result`
```

- [ ] **Step 4: Update README**

In the QA Plans section of `README.md`, add `setup-bundle-dogfood`:

```markdown
- `qa-run setup-bundle-dogfood --receipt-output /tmp/setup-bundle-dogfood-receipt.json --json`
  proves setup-bundle preview/apply/show rails with temp ledgers, temp Codex
  homes, and a disposable local fixture repo. It is CI-safe: no GitHub side
  effects and no manager/worker session launch. For the live sandbox drill, see
  `docs/qa/setup-bundle-dogfood.md`.
```

- [ ] **Step 5: Update manual QA checklist**

Add to `docs/manual-qa-checklist.md` near the existing `qa-run` entries:

```markdown
- [ ] `conveyor qa-run setup-bundle-dogfood --receipt-output /tmp/setup-bundle-dogfood-receipt.json --json` writes a saved receipt proving setup-bundle preview is read-only, missing required Superpowers review backend blocks before launch, applied setup reads back through `setup-bundle show`, worker-set intent remains handoff-only, and no sessions are created in the CI-safe dogfood.
```

- [ ] **Step 6: Run documentation test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup bundle dogfood docs"
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add docs/qa/setup-bundle-dogfood.md README.md docs/manual-qa-checklist.md src/cli/typescript-runtime.test.ts
git commit -m "docs: document setup bundle dogfood rails"
```

## Task 4: Add Final Verification and Closeout Proof

**Files:**
- Modify only if prior checks reveal a defect.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup bundle dogfood|setup-bundle"
```

Expected: pass.

- [ ] **Step 2: Run the new QA receipt manually**

Run:

```bash
conveyor qa-run setup-bundle-dogfood \
  --receipt-output /tmp/setup-bundle-dogfood-receipt.json \
  --json
```

Expected: pass and write `/tmp/setup-bundle-dogfood-receipt.json`.

- [ ] **Step 3: Inspect the receipt for the strongest failure mode**

Run:

```bash
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("/tmp/setup-bundle-dogfood-receipt.json", "utf8"));
const names = new Set(r.checks.map((c) => c.name));
for (const required of [
  "missing_superpowers_review_backend_blocks_before_launch",
  "setup_bundle_show_matches_applied_hash",
  "no_sessions_created_during_dogfood"
]) {
  if (!names.has(required)) throw new Error(`missing check ${required}`);
}
console.log(JSON.stringify({
  scenario: r.scenario,
  result: r.result,
  live_sandbox_enabled: r.live_sandbox.enabled,
  checks: [...names].sort()
}, null, 2));
'
```

Expected: prints `scenario: "setup-bundle-dogfood"`, `result: "passed"`, and `live_sandbox_enabled: false`.

- [ ] **Step 4: Run lint and build**

Run:

```bash
npm run lint
npm run build
```

Expected: both pass.

- [ ] **Step 5: Run the full TypeScript runtime test file**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts
```

Expected: pass.

- [ ] **Step 6: Inspect for accidental live side effects**

Run:

```bash
rg -n "gh pr create|gh pr merge|git push|--allow-github-side-effects" src/cli/typescript-runtime.ts docs/qa/setup-bundle-dogfood.md README.md
```

Expected: `src/cli/typescript-runtime.ts` does not include live `gh pr create`, `gh pr merge`, or `git push` calls for `setup-bundle-dogfood`. The docs mention `--allow-github-side-effects` only as an explicit future/live-sandbox operator rail.

- [ ] **Step 7: Commit any final fixes**

If Step 6 reveals accidental live side effects or any verification fails, fix them and commit:

```bash
git add <changed-files>
git commit -m "fix: keep setup bundle dogfood rails local"
```

## Final Handoff Evidence

Use this closeout shape:

```text
Claim: setup-bundle dogfood rails are implemented for local/CI use, with a documented live sandbox path.
Disproof attempt: The strongest realistic failure mode is that the dogfood accidentally performs live GitHub/session side effects or accepts a setup that cannot be proven from the ledger.
Evidence: qa-run setup-bundle-dogfood receipt, focused setup-bundle tests, full TypeScript runtime test, lint/build, and rg side-effect scan.
Residual risk: Live sandbox automation remains manual until a future explicitly allowlisted GitHub side-effect command is implemented.
```

## Self-Review Notes

- Spec coverage: local fixture repo, sandbox repo rails, dry-run/no-launch behavior, receipts, missing required plugin halt, and setup-bundle ledger readback are all covered.
- Placeholder scan: no `TBD`, `TODO`, or unspecified "add tests" steps remain.
- Type consistency: scenario name is consistently `setup-bundle-dogfood`; receipt check names match the tests; live sandbox side effects are documentation-only in this tranche.
