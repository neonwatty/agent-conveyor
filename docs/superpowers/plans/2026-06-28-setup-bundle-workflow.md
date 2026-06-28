# Setup Bundle Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first testable setup bundle tranche: preview and apply setup bundles, hard-fail missing required backends before launch, persist approved setup policy in the ledger, and prove dispatcher-facing manager permissions match the approved bundle.

**Architecture:** Add a dedicated `setup_bundles` ledger table and a focused runtime module that drafts preset bundles, preflights required skills/plugins/tools, applies approved bundles into `setup_bundles`, `manager_configs`, `acceptance_criteria`, `runs`, and audit events, and exposes readback through a CLI command. Keep session launch out of this tranche; instead prove the manager/dispatcher contract by enqueueing permission-gated commands against the manager config seeded from the bundle.

**Tech Stack:** TypeScript, Node.js `node:test`, `node:sqlite`, existing Agent Conveyor CLI runtime, existing manager permissions, manager recipes, loop templates, and per-project SQLite ledger.

---

## Scope Check

This plan implements the durable setup and proof surface, not the full visible Codex app launch flow. That is intentional: the riskiest questions from the design are whether setup fails closed and whether approved setup authority is actually recoverable from the ledger/dispatcher. Once this tranche lands, a later plan can wire `setup-bundle apply --launch` into `create-disposable-binding`, app smoke, and autopilot.

## File Structure

- Modify `src/state/schema-v23.ts`
  - Add `setup_bundles` table and indexes to the canonical schema.
- Modify `src/state/database.ts`
  - Add idempotent legacy migration for `setup_bundles`.
- Modify `src/state/sqlite-contract.ts`
  - Add required setup bundle table and indexes to database health checks.
- Create `src/runtime/setup-bundles.ts`
  - Own setup bundle types, preset defaults, backend preflight, validation, apply, and readback.
- Modify `src/index.ts`
  - Export setup bundle helpers for tests and future callers.
- Modify `src/cli/typescript-runtime.ts`
  - Add `setup-bundle preview|apply|show` command routing and option parsing.
- Modify `src/cli/typescript-runtime.test.ts`
  - Add tests for blocked preflight, approved ledger storage, Ralph loop metadata, and dispatcher permission proof.
- Modify `docs/manager-recipes.md`
  - Add a short note that setup bundles are the preferred higher-level setup surface once implemented.
- Modify `plugin/agent-conveyor/plugin.json`
  - Add future-facing `conveyor-setup-bundle` skill entry only if the skill is created in this tranche.
- Create `plugin/agent-conveyor/skills/conveyor-setup-bundle/SKILL.md`
  - Operator guidance for using `conveyor setup-bundle preview|apply|show` if adding the plugin skill in this tranche.

## Behavioral Contract

Use this command surface:

```bash
conveyor setup-bundle preview example-task --preset autonomous_ship_it --json
conveyor setup-bundle apply example-task --preset autonomous_ship_it --approve --json
conveyor setup-bundle show example-task --json
```

Important options:

```text
--preset autonomous_ship_it
--planning-backend goalbuddy
--planning-required
--loop-backend ralph_loop
--loop-preset ship_it_loop
--loop-max-iterations 2
--pr-review-backend composite
--pr-review-required
--whats-next execute_bounded
--whats-next-max-iterations 1
--whats-next-post-merge
--require-skill requesting-code-review
--optional-skill security-diff-scan
--codex-home /tmp/fake-codex-home
--approve
--dry-run
--json
```

Use `preview` for draft/preflight without ledger mutation. Use `apply` for approved ledger writes. For this tranche, failed `apply` with missing required backends must write one blocked `setup_bundles` row and must not create `manager_configs`, `runs`, `bindings`, `commands`, or sessions.

PR review policy is configurable at three levels. `pr_review` is the bundle
default. `manager.pr_review` defines the manager's review gate duties.
`workers.profiles[].pr_review` defines worker or role-specific review duties.
Changing any of these values creates a new approved setup bundle revision
rather than mutating the prior record, so the ledger can answer which PR review
policy was active for a launched manager or worker.

## Task 1: Add Setup Bundle Schema

**Files:**
- Modify: `src/state/schema-v23.ts`
- Modify: `src/state/database.ts`
- Modify: `src/state/sqlite-contract.ts`
- Test: `src/state/state.test.ts`

- [ ] **Step 1: Write the failing schema contract test**

Add this test near the table contract tests in `src/state/state.test.ts`:

```ts
test("database schema includes setup bundle ledger table and indexes", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundles-schema."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      const table = database.prepare(`
        select name
        from sqlite_master
        where type = 'table' and name = 'setup_bundles'
      `).get() as { name: string } | undefined;
      assert.equal(table?.name, "setup_bundles");

      const columns = database.prepare("pragma_table_info('setup_bundles')").all() as Array<{ name: string }>;
      assert.deepEqual(columns.map((column) => column.name), [
        "id",
        "task_id",
        "name",
        "preset",
        "state",
        "draft_hash",
        "approved_hash",
        "policy_json",
        "preflight_json",
        "approval_json",
        "applied_json",
        "blocked_reason",
        "created_at",
        "updated_at",
        "approved_at",
        "applied_at",
      ]);

      const indexes = database.prepare(`
        select name
        from sqlite_master
        where type = 'index' and tbl_name = 'setup_bundles'
        order by name
      `).all() as Array<{ name: string }>;
      assert.deepEqual(indexes.map((row) => row.name), [
        "setup_bundles_name",
        "setup_bundles_task_state",
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing schema test**

Run:

```bash
npm test -- src/state/state.test.ts --test-name-pattern "setup bundle ledger"
```

Expected: fail because `setup_bundles` does not exist.

- [ ] **Step 3: Add the canonical table and indexes**

In `src/state/schema-v23.ts`, insert the table after `schema_migrations` or near other setup/runtime tables:

```sql
CREATE TABLE setup_bundles(
          id text primary key,
          task_id text not null references tasks(id),
          name text not null,
          preset text not null,
          state text not null check (state in ('draft','blocked','approved','applied')),
          draft_hash text not null,
          approved_hash text,
          policy_json text not null check (json_valid(policy_json)),
          preflight_json text not null check (json_valid(preflight_json)),
          approval_json text not null check (json_valid(approval_json)),
          applied_json text not null check (json_valid(applied_json)),
          blocked_reason text,
          created_at text not null,
          updated_at text not null,
          approved_at text,
          applied_at text
        );
```

Add indexes near the other indexes:

```sql
CREATE UNIQUE INDEX setup_bundles_name
        on setup_bundles(name);

CREATE INDEX setup_bundles_task_state
        on setup_bundles(task_id, state, updated_at);
```

- [ ] **Step 4: Add legacy migration support**

In `src/state/database.ts`, inside `migrateLegacySchemaSync`, after existing `addColumnIfMissing(...)` calls, add:

```ts
    ensureSetupBundlesTable(database);
```

Add this helper near the other migration helpers:

```ts
function ensureSetupBundlesTable(database: DatabaseSync): void {
  if (hasTable(database, "setup_bundles")) {
    return;
  }
  database.exec(`
    CREATE TABLE setup_bundles(
      id text primary key,
      task_id text not null references tasks(id),
      name text not null,
      preset text not null,
      state text not null check (state in ('draft','blocked','approved','applied')),
      draft_hash text not null,
      approved_hash text,
      policy_json text not null check (json_valid(policy_json)),
      preflight_json text not null check (json_valid(preflight_json)),
      approval_json text not null check (json_valid(approval_json)),
      applied_json text not null check (json_valid(applied_json)),
      blocked_reason text,
      created_at text not null,
      updated_at text not null,
      approved_at text,
      applied_at text
    );

    CREATE UNIQUE INDEX setup_bundles_name
      on setup_bundles(name);

    CREATE INDEX setup_bundles_task_state
      on setup_bundles(task_id, state, updated_at);
  `);
}
```

- [ ] **Step 5: Update database health contract**

In `src/state/sqlite-contract.ts`, add:

```ts
"setup_bundles",
```

to `REQUIRED_TABLES`, and add:

```ts
"setup_bundles_name",
"setup_bundles_task_state",
```

to `REQUIRED_INDEXES`.

- [ ] **Step 6: Run schema tests**

Run:

```bash
npm test -- src/state/state.test.ts --test-name-pattern "setup bundle ledger|database schema"
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/state/schema-v23.ts src/state/database.ts src/state/sqlite-contract.ts src/state/state.test.ts
git commit -m "Add setup bundle ledger schema"
```

## Task 2: Add Runtime Bundle Draft, Preflight, And Apply Helpers

**Files:**
- Create: `src/runtime/setup-bundles.ts`
- Modify: `src/index.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write failing runtime-oriented CLI tests**

Add this helper near other CLI test helpers in `src/cli/typescript-runtime.test.ts`:

```ts
function makeCodexHomeWithSkills(skills: string[]): string {
  const codexHome = mkdtempSync(join(tmpdir(), "agent-conveyor-codex-home."));
  for (const skill of skills) {
    const skillDir = join(codexHome, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`);
  }
  return codexHome;
}
```

Add this failing test:

```ts
test("setup-bundle apply blocks before authority when required backend skill is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-blocked."));
  const codexHome = makeCodexHomeWithSkills([]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Ship a setup bundle task.",
        name: "bundle-task",
        now: "2026-06-28T10:00:00Z",
        taskId: "task-bundle",
      });
    } finally {
      database.close();
    }

    const blocked = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "apply",
        "bundle-task",
        "--preset",
        "autonomous_ship_it",
        "--pr-review-backend",
        "superpowers",
        "--pr-review-required",
        "--require-skill",
        "requesting-code-review",
        "--approve",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(blocked.exitCode, 1);
    const payload = JSON.parse(blocked.stdout ?? "{}") as {
      blocked: boolean;
      missing_required: string[];
      launched: boolean;
    };
    assert.equal(payload.blocked, true);
    assert.deepEqual(payload.missing_required, ["requesting-code-review"]);
    assert.equal(payload.launched, false);

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const bundle = verifyDb.prepare("select state, blocked_reason from setup_bundles where task_id = ?").get("task-bundle") as {
        blocked_reason: string;
        state: string;
      };
      assert.equal(bundle.state, "blocked");
      assert.match(bundle.blocked_reason, /missing required backend/i);
      assert.equal((verifyDb.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 0);
      assert.equal((verifyDb.prepare("select count(*) as count from bindings").get() as { count: number }).count, 0);
      assert.equal((verifyDb.prepare("select count(*) as count from commands").get() as { count: number }).count, 0);
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle apply blocks"
```

Expected: fail with unknown command `setup-bundle`.

- [ ] **Step 3: Create setup bundle runtime types**

Create `src/runtime/setup-bundles.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeManagerPermissions } from "./manager-permissions.js";

export type SetupBundleState = "draft" | "blocked" | "approved" | "applied";
export type PlanningBackend = "direct_prompt" | "codex_goal" | "goalbuddy" | "custom";
export type LoopBackend = "none" | "ralph_loop" | "loop_template" | "custom";
export type PrReviewBackend = "off" | "codex_review" | "superpowers" | "github" | "security" | "composite" | "custom";
export type WhatsNextMode = "off" | "suggest_only" | "execute_bounded";

export interface SetupBundlePolicy {
  evidence: {
    acceptance_criteria: string[];
    closeout_requires_disproof_attempt: boolean;
  };
  loop: {
    backend: LoopBackend;
    max_iterations: number;
    preset: string | null;
    required_evidence: string[];
  };
  manager: {
    denied_actions: string[];
    mode: "light" | "guided" | "strict";
    permissions: string[];
    pr_review: {
      backend: PrReviewBackend | "inherit";
      gate: "none" | "block_merge_until_review_receipts";
      role: "none" | "gatekeeper";
    };
    tools: string[];
  };
  planning: {
    backend: PlanningBackend;
    required: boolean;
    required_skills: string[];
  };
  pr_review: {
    backend: PrReviewBackend;
    required: boolean;
    required_skills: string[];
    optional_skills: string[];
    security_scan: "off" | "auto" | "always";
  };
  preset: string;
  whats_next: {
    enabled: boolean;
    max_iterations: number;
    mode: WhatsNextMode;
    post_merge_allowed: boolean;
  };
  workers: {
    count: number;
    profiles: Array<{
      approval: string;
      evidence_contract: string;
      pr_review: {
        backend: PrReviewBackend | "inherit";
        required_before_handoff: boolean;
      };
      role: string;
      sandbox: string;
    }>;
  };
}

export interface SetupBundlePreflight {
  missing_optional: string[];
  missing_required: string[];
  ok: boolean;
  checked_skills: string[];
}

export interface SetupBundleRecord {
  applied_at: string | null;
  approval_json: Record<string, unknown>;
  approved_at: string | null;
  approved_hash: string | null;
  blocked_reason: string | null;
  created_at: string;
  draft_hash: string;
  id: string;
  name: string;
  policy: SetupBundlePolicy;
  preflight: SetupBundlePreflight;
  preset: string;
  state: SetupBundleState;
  task_id: string;
  updated_at: string;
}
```

- [ ] **Step 4: Add draft and preflight helpers**

Append to `src/runtime/setup-bundles.ts`:

```ts
export function draftSetupBundlePolicy(options: {
  loopBackend?: LoopBackend;
  loopMaxIterations?: number | null;
  loopPreset?: string | null;
  optionalSkills?: string[];
  planningBackend?: PlanningBackend;
  planningRequired?: boolean;
  preset: string;
  prReviewBackend?: PrReviewBackend;
  prReviewRequired?: boolean;
  requiredSkills?: string[];
  whatsNextMaxIterations?: number | null;
  whatsNextMode?: WhatsNextMode;
  whatsNextPostMerge?: boolean;
}): SetupBundlePolicy {
  const preset = options.preset;
  const shipIt = preset === "autonomous_ship_it";
  const testCoverage = preset === "test_coverage_ralph";
  const uxPolish = preset === "ux_polish_ralph";
  const prCiMerge = preset === "pr_ci_merge_ralph";
  const loopPreset = options.loopPreset
    ?? (shipIt ? "ship_it_loop" : testCoverage ? "test_coverage_loop" : uxPolish ? "visual_diff_loop" : prCiMerge ? "pr_ci_merge_loop" : null);
  const requiredEvidence = loopPreset === "ship_it_loop"
    ? ["branch_ready", "branch_pushed", "pr_url", "ci_green", "mergeability_clean", "manager_merge_decision", "merge", "post_merge_verification", "adversarial_check"]
    : loopPreset === "test_coverage_loop"
      ? ["test_coverage", "adversarial_check"]
      : loopPreset === "visual_diff_loop"
        ? ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold", "adversarial_check"]
        : loopPreset === "pr_ci_merge_loop"
          ? ["pr_url", "ci_green", "merge", "adversarial_check"]
          : [];

  const managerPermissions = shipIt
    ? ["repo.push_branch", "repo.open_pr", "repo.monitor_ci", "repo.resolve_conflicts", "repo.merge_green_pr", "worker_session.compact", "worker_session.clear"]
    : prCiMerge
      ? ["repo.open_pr", "repo.merge_green_pr", "worker_session.compact", "worker_session.clear"]
      : [];

  return {
    evidence: {
      acceptance_criteria: requiredEvidence.map((evidence) => `${evidence} evidence is recorded.`),
      closeout_requires_disproof_attempt: true,
    },
    loop: {
      backend: options.loopBackend ?? (loopPreset === null ? "none" : "ralph_loop"),
      max_iterations: options.loopMaxIterations ?? (shipIt ? 2 : testCoverage ? 3 : uxPolish ? 4 : 1),
      preset: loopPreset,
      required_evidence: requiredEvidence,
    },
    manager: {
      denied_actions: [
        "Do not continue when required setup evidence is missing.",
        "Do not treat worker claims as proof without ledger receipts.",
      ],
      mode: shipIt || prCiMerge || testCoverage || uxPolish ? "strict" : "guided",
      permissions: managerPermissions,
      pr_review: {
        backend: shipIt ? "inherit" : "off",
        gate: shipIt ? "block_merge_until_review_receipts" : "none",
        role: shipIt ? "gatekeeper" : "none",
      },
      tools: shipIt || prCiMerge ? ["gh", "git", "verification.run_tests", "context.fetch_prs"] : testCoverage ? ["verification.run_tests"] : uxPolish ? ["verification.run_playwright"] : [],
    },
    planning: {
      backend: options.planningBackend ?? (shipIt ? "goalbuddy" : "codex_goal"),
      required: options.planningRequired ?? shipIt,
      required_skills: options.planningRequired || shipIt ? ["goal-prep"] : [],
    },
    pr_review: {
      backend: options.prReviewBackend ?? (shipIt ? "composite" : "off"),
      required: options.prReviewRequired ?? shipIt,
      required_skills: options.prReviewRequired || shipIt ? ["requesting-code-review", "receiving-code-review", "codex-review"] : [],
      optional_skills: options.optionalSkills ?? ["security-diff-scan"],
      security_scan: shipIt ? "auto" : "off",
    },
    preset,
    whats_next: {
      enabled: (options.whatsNextMode ?? (shipIt ? "execute_bounded" : "off")) !== "off",
      max_iterations: options.whatsNextMaxIterations ?? (shipIt ? 1 : 0),
      mode: options.whatsNextMode ?? (shipIt ? "execute_bounded" : "off"),
      post_merge_allowed: options.whatsNextPostMerge ?? shipIt,
    },
    workers: {
      count: 1,
      profiles: [{
        approval: "on-request",
        evidence_contract: shipIt ? "ship_it_worker_receipt" : "worker_receipt",
        pr_review: {
          backend: shipIt ? "inherit" : "off",
          required_before_handoff: shipIt,
        },
        role: "implementer",
        sandbox: "workspace-write",
      }],
    },
  };
}

export function preflightSetupBundle(policy: SetupBundlePolicy, options: { codexHome?: string | null }): SetupBundlePreflight {
  const required = uniqueStrings([
    ...policy.planning.required_skills,
    ...policy.pr_review.required_skills,
  ]);
  const optional = uniqueStrings(policy.pr_review.optional_skills);
  const checked = uniqueStrings([...required, ...optional]);
  const missingRequired = required.filter((skill) => !skillAvailable(skill, options.codexHome ?? null));
  const missingOptional = optional.filter((skill) => !skillAvailable(skill, options.codexHome ?? null));
  return {
    checked_skills: checked,
    missing_optional: missingOptional,
    missing_required: missingRequired,
    ok: missingRequired.length === 0,
  };
}

function skillAvailable(skill: string, codexHome: string | null): boolean {
  if (codexHome === null) {
    return false;
  }
  if (existsSync(join(codexHome, "skills", skill, "SKILL.md"))) {
    return true;
  }
  const pluginCache = join(codexHome, "plugins", "cache");
  return existsSync(pluginCache) && skill.includes(":") === false
    ? false
    : false;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort();
}
```

- [ ] **Step 5: Add apply and readback helpers**

Append:

```ts
export function setupBundleHash(policy: SetupBundlePolicy): string {
  return createHash("sha256").update(stableJson(policy)).digest("hex");
}

export function applySetupBundleSync(database: DatabaseSync, options: {
  approve: boolean;
  codexHome?: string | null;
  name?: string | null;
  now: string;
  policy: SetupBundlePolicy;
  taskId: string;
}): { blocked: boolean; missing_required: string[]; record: SetupBundleRecord } {
  const preflight = preflightSetupBundle(options.policy, { codexHome: options.codexHome ?? null });
  const id = `setup-${randomUUID()}`;
  const name = options.name ?? `${options.taskId}-${options.policy.preset}`;
  const draftHash = setupBundleHash(options.policy);
  const blocked = !preflight.ok;
  const state: SetupBundleState = blocked ? "blocked" : "applied";
  const approvedHash = blocked ? null : draftHash;
  const blockedReason = blocked ? `missing required backend: ${preflight.missing_required.join(", ")}` : null;
  const approvalJson = blocked ? {} : { approved: options.approve, source: "setup-bundle apply" };
  const appliedJson = blocked ? {} : applyBundleDerivedRecords(database, {
    now: options.now,
    policy: options.policy,
    setupBundleId: id,
    taskId: options.taskId,
  });

  database.prepare(`
    insert into setup_bundles(
      id, task_id, name, preset, state, draft_hash, approved_hash, policy_json,
      preflight_json, approval_json, applied_json, blocked_reason,
      created_at, updated_at, approved_at, applied_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    options.taskId,
    name,
    options.policy.preset,
    state,
    draftHash,
    approvedHash,
    stableJson(options.policy),
    stableJson(preflight),
    stableJson(approvalJson),
    stableJson(appliedJson),
    blockedReason,
    options.now,
    options.now,
    blocked ? null : options.now,
    blocked ? null : options.now,
  );

  const record = setupBundleForTaskSync(database, options.taskId);
  if (record === null) {
    throw new Error(`setup bundle was not recorded for task ${options.taskId}`);
  }
  return { blocked, missing_required: preflight.missing_required, record };
}

function applyBundleDerivedRecords(database: DatabaseSync, options: {
  now: string;
  policy: SetupBundlePolicy;
  setupBundleId: string;
  taskId: string;
}): Record<string, unknown> {
  const permissions = normalizeManagerPermissions(Object.fromEntries(options.policy.manager.permissions.map((permission) => [permission, true])));
  database.prepare(`
    insert into manager_configs(
      task_id, recipe_name, supervision_mode, objective, guidelines_json,
      acceptance_criteria_json, reference_paths_json, permissions_json,
      tools_json, epilogues_json, nudge_on_completion, require_acks,
      revision, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 0, 1, ?, ?)
    on conflict(task_id) do update set
      recipe_name = excluded.recipe_name,
      supervision_mode = excluded.supervision_mode,
      objective = excluded.objective,
      guidelines_json = excluded.guidelines_json,
      acceptance_criteria_json = excluded.acceptance_criteria_json,
      permissions_json = excluded.permissions_json,
      tools_json = excluded.tools_json,
      epilogues_json = excluded.epilogues_json,
      nudge_on_completion = excluded.nudge_on_completion,
      revision = manager_configs.revision + 1,
      updated_at = excluded.updated_at
  `).run(
    options.taskId,
    options.policy.preset,
    options.policy.manager.mode,
    `Setup bundle ${options.policy.preset}`,
    stableJson(options.policy.manager.denied_actions),
    stableJson(options.policy.evidence.acceptance_criteria),
    stableJson(permissions),
    stableJson(options.policy.manager.tools),
    stableJson(["record-handoff"]),
    options.policy.whats_next.enabled ? "auto-review" : "ask-operator",
    options.now,
    options.now,
  );
  return {
    manager_config: true,
    setup_bundle_id: options.setupBundleId,
  };
}

export function setupBundleForTaskSync(database: DatabaseSync, taskId: string): SetupBundleRecord | null {
  const row = database.prepare(`
    select id, task_id, name, preset, state, draft_hash, approved_hash,
           policy_json, preflight_json, approval_json, applied_json,
           blocked_reason, created_at, updated_at, approved_at, applied_at
    from setup_bundles
    where task_id = ?
    order by updated_at desc, id desc
    limit 1
  `).get(taskId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    applied_at: row.applied_at as string | null,
    approval_json: JSON.parse(row.approval_json as string) as Record<string, unknown>,
    approved_at: row.approved_at as string | null,
    approved_hash: row.approved_hash as string | null,
    blocked_reason: row.blocked_reason as string | null,
    created_at: row.created_at as string,
    draft_hash: row.draft_hash as string,
    id: row.id as string,
    name: row.name as string,
    policy: JSON.parse(row.policy_json as string) as SetupBundlePolicy,
    preflight: JSON.parse(row.preflight_json as string) as SetupBundlePreflight,
    preset: row.preset as string,
    state: row.state as SetupBundleState,
    task_id: row.task_id as string,
    updated_at: row.updated_at as string,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}
```

- [ ] **Step 6: Export runtime helpers**

In `src/index.ts`, add:

```ts
export {
  applySetupBundleSync,
  draftSetupBundlePolicy,
  preflightSetupBundle,
  setupBundleForTaskSync,
  setupBundleHash,
} from "./runtime/setup-bundles.js";
export type {
  SetupBundlePolicy,
  SetupBundlePreflight,
  SetupBundleRecord,
  SetupBundleState,
} from "./runtime/setup-bundles.js";
```

- [ ] **Step 7: Run the failing test again**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle apply blocks"
```

Expected: still fail with unknown command because CLI routing is not wired yet.

## Task 3: Add CLI `setup-bundle preview|apply|show`

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Add CLI imports**

In `src/cli/typescript-runtime.ts`, add imports near other runtime imports:

```ts
import {
  applySetupBundleSync,
  draftSetupBundlePolicy,
  preflightSetupBundle,
  setupBundleForTaskSync,
  setupBundleHash,
  type LoopBackend,
  type PlanningBackend,
  type PrReviewBackend,
  type WhatsNextMode,
} from "../runtime/setup-bundles.js";
```

- [ ] **Step 2: Add parsed flags**

Extend the parsed flags interface/defaults with:

```ts
setupBundleAction: null as string | null,
setupBundlePreset: null as string | null,
planningBackend: null as PlanningBackend | null,
planningRequired: false,
loopBackend: null as LoopBackend | null,
loopPreset: null as string | null,
loopMaxIterations: null as number | null,
prReviewBackend: null as PrReviewBackend | null,
prReviewRequired: false,
requiredSkills: [] as string[],
optionalSkills: [] as string[],
whatsNextMode: null as WhatsNextMode | null,
whatsNextMaxIterations: null as number | null,
whatsNextPostMerge: false,
approve: false,
```

Use the exact names above consistently in parser and command code.

- [ ] **Step 3: Add command routing**

In `runTypescriptRuntimeCommand`, before `manager-config`, add:

```ts
    if (parsed.command === "setup-bundle") {
      return runSetupBundleCommand(parsed, options);
    }
```

- [ ] **Step 4: Parse `setup-bundle` action and flags**

In positional parsing, treat the first positional after `setup-bundle` as the action and the second as task. If the current parser is centralized around `task`, use this logic after queue setup:

```ts
if (command === "setup-bundle" && task === null && !arg.startsWith("-")) {
  if (flags.setupBundleAction === null) {
    flags.setupBundleAction = arg;
  } else {
    task = arg;
  }
}
```

Add option branches:

```ts
} else if (arg === "--preset") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --preset", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  flags.setupBundlePreset = value.value;
  index += 1;
} else if (arg === "--planning-backend") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --planning-backend", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  if (!["direct_prompt", "codex_goal", "goalbuddy", "custom"].includes(value.value)) return { command, enabled, error: `Unsupported planning backend: ${value.value}`, explicit, flags, task };
  flags.planningBackend = value.value as PlanningBackend;
  index += 1;
} else if (arg === "--planning-required") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --planning-required", explicit, flags, task };
  flags.planningRequired = true;
} else if (arg === "--loop-backend") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --loop-backend", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  if (!["none", "ralph_loop", "loop_template", "custom"].includes(value.value)) return { command, enabled, error: `Unsupported loop backend: ${value.value}`, explicit, flags, task };
  flags.loopBackend = value.value as LoopBackend;
  index += 1;
} else if (arg === "--loop-preset") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --loop-preset", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  flags.loopPreset = value.value;
  index += 1;
} else if (arg === "--loop-max-iterations") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --loop-max-iterations", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  const parsedNumber = Number(value.value);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 0) return { command, enabled, error: "--loop-max-iterations must be a non-negative integer", explicit, flags, task };
  flags.loopMaxIterations = parsedNumber;
  index += 1;
} else if (arg === "--pr-review-backend") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --pr-review-backend", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  if (!["off", "codex_review", "superpowers", "github", "security", "composite", "custom"].includes(value.value)) return { command, enabled, error: `Unsupported PR review backend: ${value.value}`, explicit, flags, task };
  flags.prReviewBackend = value.value as PrReviewBackend;
  index += 1;
} else if (arg === "--pr-review-required") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --pr-review-required", explicit, flags, task };
  flags.prReviewRequired = true;
} else if (arg === "--require-skill") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --require-skill", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  flags.requiredSkills.push(value.value);
  index += 1;
} else if (arg === "--optional-skill") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --optional-skill", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  flags.optionalSkills.push(value.value);
  index += 1;
} else if (arg === "--whats-next") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --whats-next", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  if (!["off", "suggest_only", "execute_bounded"].includes(value.value)) return { command, enabled, error: `Unsupported whats-next mode: ${value.value}`, explicit, flags, task };
  flags.whatsNextMode = value.value as WhatsNextMode;
  index += 1;
} else if (arg === "--whats-next-max-iterations") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --whats-next-max-iterations", explicit, flags, task };
  const value = valueAfter(queue, index, arg);
  if (value.error) return { command, enabled, error: value.error, explicit, flags, task };
  const parsedNumber = Number(value.value);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 0) return { command, enabled, error: "--whats-next-max-iterations must be a non-negative integer", explicit, flags, task };
  flags.whatsNextMaxIterations = parsedNumber;
  index += 1;
} else if (arg === "--whats-next-post-merge") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --whats-next-post-merge", explicit, flags, task };
  flags.whatsNextPostMerge = true;
} else if (arg === "--approve") {
  if (command !== "setup-bundle") return { command, enabled, error: "Unsupported TypeScript runtime option: --approve", explicit, flags, task };
  flags.approve = true;
```

Extend `--codex-home` support to allow `setup-bundle`.

- [ ] **Step 5: Implement command handler**

Add near `runManagerConfigCommand`:

```ts
function runSetupBundleCommand(parsed: ParsedRuntimeArgs, options: TypescriptRuntimeOptions): TypescriptRuntimeResult {
  const action = parsed.flags.setupBundleAction;
  if (action !== "preview" && action !== "apply" && action !== "show") {
    return errorResult("setup-bundle requires action preview, apply, or show.");
  }
  if (!parsed.task) {
    return errorResult("setup-bundle requires a task name or id.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, parsed.task);
    if (task === null) {
      return errorResult(`Unknown task: ${parsed.task}`);
    }
    if (action === "show") {
      const record = setupBundleForTaskSync(database, task.id);
      if (record === null) {
        return errorResult(`No setup bundle recorded for task: ${parsed.task}`);
      }
      return jsonResult(record);
    }
    const policy = draftSetupBundlePolicy({
      loopBackend: parsed.flags.loopBackend,
      loopMaxIterations: parsed.flags.loopMaxIterations,
      loopPreset: parsed.flags.loopPreset,
      optionalSkills: parsed.flags.optionalSkills,
      planningBackend: parsed.flags.planningBackend,
      planningRequired: parsed.flags.planningRequired,
      preset: parsed.flags.setupBundlePreset ?? "custom",
      prReviewBackend: parsed.flags.prReviewBackend,
      prReviewRequired: parsed.flags.prReviewRequired,
      requiredSkills: parsed.flags.requiredSkills,
      whatsNextMaxIterations: parsed.flags.whatsNextMaxIterations,
      whatsNextMode: parsed.flags.whatsNextMode,
      whatsNextPostMerge: parsed.flags.whatsNextPostMerge,
    });
    policy.planning.required_skills = uniqueRuntimeStrings([...policy.planning.required_skills, ...parsed.flags.requiredSkills]);
    const preflight = preflightSetupBundle(policy, { codexHome: parsed.flags.codexHome });
    if (action === "preview") {
      return jsonResult({
        action,
        draft_hash: setupBundleHash(policy),
        policy,
        preflight,
      });
    }
    if (!parsed.flags.approve) {
      return errorResult("setup-bundle apply requires --approve.");
    }
    const result = applySetupBundleSync(database, {
      approve: true,
      codexHome: parsed.flags.codexHome,
      now: nowIsoSeconds(options),
      policy,
      taskId: task.id,
    });
    return result.blocked
      ? { exitCode: 1, handled: true, stdout: `${JSON.stringify({ blocked: true, launched: false, missing_required: result.missing_required, setup_bundle: result.record })}\n` }
      : jsonResult({ blocked: false, launched: false, setup_bundle: result.record });
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  } finally {
    database.close();
  }
}

function uniqueRuntimeStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
```

- [ ] **Step 6: Run blocked-preflight test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle apply blocks"
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/runtime/setup-bundles.ts src/index.ts src/cli/typescript-runtime.ts src/cli/typescript-runtime.test.ts
git commit -m "Add setup bundle CLI preflight"
```

## Task 4: Prove Approved Bundle Writes Ledger And Dispatcher Authority

**Files:**
- Modify: `src/runtime/setup-bundles.ts`
- Modify: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Add approved-apply ledger test**

Add:

```ts
test("setup-bundle apply stores approved ship-it policy and manager permissions in ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-applied."));
  const codexHome = makeCodexHomeWithSkills(["goal-prep", "requesting-code-review", "receiving-code-review", "codex-review"]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Ship with setup bundle.",
        name: "ship-task",
        now: "2026-06-28T10:00:00Z",
        taskId: "task-ship",
      });
    } finally {
      database.close();
    }

    const applied = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "apply",
        "ship-task",
        "--preset",
        "autonomous_ship_it",
        "--approve",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(applied.exitCode, 0);
    const payload = JSON.parse(applied.stdout ?? "{}") as {
      blocked: boolean;
      setup_bundle: {
        policy: {
          loop: { preset: string; required_evidence: string[] };
          manager: { pr_review: { gate: string; role: string } };
          pr_review: { backend: string; required: boolean };
          whats_next: { max_iterations: number; post_merge_allowed: boolean };
          workers: { profiles: Array<{ pr_review: { required_before_handoff: boolean } }> };
        };
        state: string;
      };
    };
    assert.equal(payload.blocked, false);
    assert.equal(payload.setup_bundle.state, "applied");
    assert.equal(payload.setup_bundle.policy.loop.preset, "ship_it_loop");
    assert.equal(payload.setup_bundle.policy.manager.pr_review.gate, "block_merge_until_review_receipts");
    assert.equal(payload.setup_bundle.policy.manager.pr_review.role, "gatekeeper");
    assert.equal(payload.setup_bundle.policy.pr_review.backend, "composite");
    assert.equal(payload.setup_bundle.policy.pr_review.required, true);
    assert.equal(payload.setup_bundle.policy.workers.profiles[0]?.pr_review.required_before_handoff, true);
    assert.equal(payload.setup_bundle.policy.whats_next.max_iterations, 1);
    assert.equal(payload.setup_bundle.policy.whats_next.post_merge_allowed, true);
    assert.ok(payload.setup_bundle.policy.loop.required_evidence.includes("manager_merge_decision"));

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const bundle = verifyDb.prepare("select state, policy_json, applied_json from setup_bundles where task_id = ?").get("task-ship") as {
        applied_json: string;
        policy_json: string;
        state: string;
      };
      assert.equal(bundle.state, "applied");
      assert.equal(JSON.parse(bundle.applied_json).manager_config, true);

      const managerConfig = verifyDb.prepare("select recipe_name, permissions_json, acceptance_criteria_json, nudge_on_completion from manager_configs where task_id = ?").get("task-ship") as {
        acceptance_criteria_json: string;
        nudge_on_completion: string;
        permissions_json: string;
        recipe_name: string;
      };
      assert.equal(managerConfig.recipe_name, "autonomous_ship_it");
      assert.equal(managerConfig.nudge_on_completion, "auto-review");
      const permissions = JSON.parse(managerConfig.permissions_json) as { repo: string[] };
      assert.deepEqual(permissions.repo, ["merge_green_pr", "monitor_ci", "open_pr", "push_branch", "resolve_conflicts"]);
      const criteria = JSON.parse(managerConfig.acceptance_criteria_json) as string[];
      assert.ok(criteria.some((criterion) => criterion.includes("manager_merge_decision")));
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run approved-apply test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle apply stores approved"
```

Expected: pass if Task 3 is complete.

- [ ] **Step 3: Add dispatcher permission proof test**

Add:

```ts
test("setup-bundle seeded manager permissions are used by dispatcher gates", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-dispatch."));
  const codexHome = makeCodexHomeWithSkills(["goal-prep", "requesting-code-review", "receiving-code-review", "codex-review"]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Prove dispatcher gates.",
        name: "dispatch-ship-task",
        now: "2026-06-28T10:00:00Z",
        taskId: "task-dispatch-ship",
      });
      database.prepare(`
        insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path, cwd, registered_at, state)
        values ('session-worker-ship', 'worker-ship', 'worker', 'worker-token-ship', 'codex-worker-ship', '/tmp/worker.jsonl', ?, '2026-06-28T10:00:00Z', 'active')
      `).run(root);
      database.prepare(`
        insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path, cwd, registered_at, state)
        values ('session-manager-ship', 'manager-ship', 'manager', 'manager-token-ship', 'codex-manager-ship', '/tmp/manager.jsonl', ?, '2026-06-28T10:00:00Z', 'active')
      `).run(root);
      bindSessionsSync(database, {
        managerSessionName: "manager-ship",
        now: "2026-06-28T10:00:00Z",
        taskName: "dispatch-ship-task",
        workerSessionName: "worker-ship",
      });
    } finally {
      database.close();
    }

    const applied = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "apply", "dispatch-ship-task", "--preset", "autonomous_ship_it", "--approve", "--codex-home", codexHome, "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(applied.exitCode, 0);

    const enqueue = runTypescriptRuntimeCommand({
      args: [
        "enqueue-nudge-worker",
        "dispatch-ship-task",
        "--message",
        "Push branch after setup approval.",
        "--required-permission",
        "repo.push_branch",
        "--correlation-id",
        "setup-bundle-dispatch-permission",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(enqueue.exitCode, 0);

    const dispatch = runTypescriptRuntimeCommand({
      args: ["dispatch", "--once", "--type", "nudge_worker", "--dispatcher-id", "dispatch-local", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(dispatch.exitCode, 0);
    const dispatchPayload = JSON.parse(dispatch.stdout ?? "{}") as {
      processed: Array<{ state: string }>;
    };
    assert.equal(dispatchPayload.processed[0]?.state, "succeeded");

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const checked = verifyDb.prepare(`
        select event_type, attributes_json
        from telemetry_events
        where event_type = 'dispatch_command_permission_checked'
        order by id desc
        limit 1
      `).get() as { attributes_json: string; event_type: string };
      assert.equal(checked.event_type, "dispatch_command_permission_checked");
      const attributes = JSON.parse(checked.attributes_json) as { allowed: boolean; required_permission: string };
      assert.equal(attributes.required_permission, "repo.push_branch");
      assert.equal(attributes.allowed, true);
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run dispatcher proof test**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle seeded manager permissions"
```

Expected: pass, proving the dispatcher reads the authority seeded from the setup bundle through `manager_configs`.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/runtime/setup-bundles.ts src/cli/typescript-runtime.test.ts
git commit -m "Prove setup bundle ledger authority"
```

## Task 5: Add Ralph Preset And Show Command Coverage

**Files:**
- Modify: `src/cli/typescript-runtime.test.ts`
- Modify: `src/runtime/setup-bundles.ts`

- [ ] **Step 1: Add Ralph loop preset tests**

Add:

```ts
test("setup-bundle preview supports test coverage and UX Ralph loops", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-ralph."));
  const codexHome = makeCodexHomeWithSkills([]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Preview Ralph loops.",
        name: "ralph-task",
        now: "2026-06-28T10:00:00Z",
        taskId: "task-ralph",
      });
    } finally {
      database.close();
    }

    const coverage = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "preview", "ralph-task", "--preset", "test_coverage_ralph", "--codex-home", codexHome, "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(coverage.exitCode, 0);
    const coveragePayload = JSON.parse(coverage.stdout ?? "{}") as { policy: { loop: { max_iterations: number; preset: string; required_evidence: string[] } } };
    assert.equal(coveragePayload.policy.loop.preset, "test_coverage_loop");
    assert.equal(coveragePayload.policy.loop.max_iterations, 3);
    assert.deepEqual(coveragePayload.policy.loop.required_evidence, ["test_coverage", "adversarial_check"]);

    const ux = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "preview", "ralph-task", "--preset", "ux_polish_ralph", "--codex-home", codexHome, "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(ux.exitCode, 0);
    const uxPayload = JSON.parse(ux.stdout ?? "{}") as { policy: { loop: { max_iterations: number; preset: string; required_evidence: string[] } } };
    assert.equal(uxPayload.policy.loop.preset, "visual_diff_loop");
    assert.equal(uxPayload.policy.loop.max_iterations, 4);
    assert.ok(uxPayload.policy.loop.required_evidence.includes("candidate_screenshot"));
    assert.ok(uxPayload.policy.loop.required_evidence.includes("visual_diff_report"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add `show` readback test**

Add:

```ts
test("setup-bundle show confirms stored policy from ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-show."));
  const codexHome = makeCodexHomeWithSkills(["goal-prep", "requesting-code-review", "receiving-code-review", "codex-review"]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Show stored setup.",
        name: "show-task",
        now: "2026-06-28T10:00:00Z",
        taskId: "task-show",
      });
    } finally {
      database.close();
    }

    const apply = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "apply", "show-task", "--preset", "autonomous_ship_it", "--approve", "--codex-home", codexHome, "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(apply.exitCode, 0);

    const shown = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "show", "show-task", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(shown.exitCode, 0);
    const shownPayload = JSON.parse(shown.stdout ?? "{}") as {
      policy: { planning: { backend: string }; pr_review: { backend: string }; whats_next: { mode: string } };
      state: string;
    };
    assert.equal(shownPayload.state, "applied");
    assert.equal(shownPayload.policy.planning.backend, "goalbuddy");
    assert.equal(shownPayload.policy.pr_review.backend, "composite");
    assert.equal(shownPayload.policy.whats_next.mode, "execute_bounded");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run Ralph and show tests**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle preview supports|setup-bundle show confirms"
```

Expected: pass.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/runtime/setup-bundles.ts src/cli/typescript-runtime.test.ts
git commit -m "Cover setup bundle presets and readback"
```

## Task 6: Add Operator Skill And Docs

**Files:**
- Create: `plugin/agent-conveyor/skills/conveyor-setup-bundle/SKILL.md`
- Modify: `plugin/agent-conveyor/plugin.json`
- Modify: `docs/manager-recipes.md`
- Modify: `scripts/package-smoke`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Add plugin manifest test**

Extend the existing plugin install/status test in `src/cli/typescript-runtime.test.ts` to expect `conveyor-setup-bundle` wherever the plugin skill list is asserted:

```ts
assert.ok(installedSkills.includes("conveyor-setup-bundle"));
```

If the test uses exact arrays, add `"conveyor-setup-bundle"` to the exact expected array in sorted order.

- [ ] **Step 2: Add plugin skill**

Create `plugin/agent-conveyor/skills/conveyor-setup-bundle/SKILL.md`:

```markdown
---
name: conveyor-setup-bundle
description: Draft, preflight, apply, and inspect Agent Conveyor setup bundles for manager-worker operating cells.
---

# Conveyor Setup Bundle

Use this skill when the operator wants to configure a manager/worker pair or
worker set with explicit planning, loop, PR review, what's-next, permissions,
and evidence policy before launch.

## Rules

- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly provides another path.
- Run `conveyor setup-bundle preview` before `apply`.
- If a required backend is missing, stop. Do not create sessions, bindings, or
  work prompts.
- Treat `conveyor setup-bundle show` as the ledger truth for what setup policy
  was approved.

## Commands

```bash
TASK="example-task"
LEDGER="$PWD/.codex-workers/workerctl.db"

conveyor setup-bundle preview "$TASK" \
  --preset autonomous_ship_it \
  --path "$LEDGER" \
  --json

conveyor setup-bundle apply "$TASK" \
  --preset autonomous_ship_it \
  --approve \
  --path "$LEDGER" \
  --json

conveyor setup-bundle show "$TASK" \
  --path "$LEDGER" \
  --json
```

Report the preset, planning backend, loop preset, PR review backend,
what's-next policy, missing required backends, approved hash, and exact next
action.
```

- [ ] **Step 3: Update plugin manifest**

In `plugin/agent-conveyor/plugin.json`, add:

```json
"conveyor-setup-bundle"
```

to the `skills` list.

- [ ] **Step 4: Update docs**

In `docs/manager-recipes.md`, add this note after "Runtime Notes":

```markdown
## Setup Bundles

`conveyor setup-bundle` is the preferred high-level setup surface when the
operator needs planning, Ralph-style loops, PR review rigor, what's-next
nudging, permissions, and evidence gates configured together. Manager recipes
remain the reusable preset metadata; setup bundles compile those recipes into a
locked, preflighted ledger record before manager/worker launch.

Use:

```bash
conveyor setup-bundle preview example-task --preset autonomous_ship_it --json
conveyor setup-bundle apply example-task --preset autonomous_ship_it --approve --json
conveyor setup-bundle show example-task --json
```
```

- [ ] **Step 5: Update package smoke**

In `scripts/package-smoke`, add:

```bash
"plugin/agent-conveyor/skills/conveyor-setup-bundle/SKILL.md"
```

to the expected package files list, and add:

```bash
"conveyor-setup-bundle"
```

to expected installed plugin skills.

- [ ] **Step 6: Run plugin tests**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "plugin"
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add plugin/agent-conveyor plugin/agent-conveyor/skills/conveyor-setup-bundle/SKILL.md docs/manager-recipes.md scripts/package-smoke src/cli/typescript-runtime.test.ts
git commit -m "Document setup bundle operator flow"
```

## Task 7: End-To-End Verification And Evidence

**Files:**
- Modify only if verification exposes failures.

- [ ] **Step 1: Run focused setup bundle tests**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle"
```

Expected: all setup bundle tests pass.

- [ ] **Step 2: Run schema health tests**

Run:

```bash
npm test -- src/state/state.test.ts --test-name-pattern "setup bundle ledger|database schema"
```

Expected: pass.

- [ ] **Step 3: Run broad runtime test file if focused tests pass**

Run:

```bash
npm test -- src/cli/typescript-runtime.test.ts
```

Expected: pass. If this is too slow or fails for unrelated existing reasons, record exact failing test names and run the focused setup bundle tests again after fixes.

- [ ] **Step 4: Run package smoke if plugin skill changed**

Run:

```bash
scripts/package-smoke
```

Expected: package includes the setup bundle skill and plugin status/install checks pass.

- [ ] **Step 5: Record final disproof evidence**

Use this evidence in the final handoff:

```text
Claim: setup bundles fail closed when required backends are missing and persist approved setup policy into the ledger.
Disproof attempt: configured autonomous ship-it with required review/planning backends missing, then checked no manager config, binding, command, or session authority was created; configured it with fake required skills present, then checked setup_bundles, manager_configs, and dispatch permission telemetry.
Evidence: npm test -- src/cli/typescript-runtime.test.ts --test-name-pattern "setup-bundle"; npm test -- src/state/state.test.ts --test-name-pattern "setup bundle ledger|database schema"; scripts/package-smoke if plugin changed.
Residual risk: visible Codex app launch is not part of this tranche; later work must wire applied bundles into pair/worker-set launch.
```

- [ ] **Step 6: Commit any verification fixes**

If verification required fixes, run:

```bash
git add src/runtime/setup-bundles.ts src/cli/typescript-runtime.ts src/cli/typescript-runtime.test.ts src/state/schema-v23.ts src/state/database.ts src/state/sqlite-contract.ts src/state/state.test.ts docs/manager-recipes.md scripts/package-smoke plugin/agent-conveyor/plugin.json plugin/agent-conveyor/skills/conveyor-setup-bundle/SKILL.md
git commit -m "Verify setup bundle workflow"
```

If no fixes were needed, do not create an empty commit.

## Acceptance Criteria

- `setup_bundles` exists in fresh and migrated ledgers and is part of database health.
- `setup-bundle apply` with missing required skills exits nonzero and records a blocked setup attempt without manager config, binding, command, or session side effects.
- `setup-bundle apply` with required fake skills present records an applied setup bundle and seeds manager config permissions and evidence criteria.
- `setup-bundle preview` supports at least autonomous ship-it, test coverage Ralph, UX Ralph, and PR/CI/Merge Ralph presets.
- `setup-bundle show` reads approved policy from the ledger.
- A dispatcher permission-gated command succeeds after autonomous ship-it setup because the setup-seeded manager config grants `repo.push_branch`.
- Plugin/docs expose the setup bundle flow if the operator skill is included in this tranche.

## Notes For Implementers

- Keep launch separate. Do not call `create-disposable-binding`, app smoke, or autopilot from `setup-bundle apply` in this tranche.
- Prefer exact ledger assertions over snapshot tests.
- Treat CLI JSON output as a public contract; tests should parse JSON and assert stable fields.
- Missing required backend means no authority grants. That is the central safety property.
