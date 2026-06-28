import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { runTypescriptRuntimeCommand } from "./typescript-runtime.js";
import type { TmuxRunner } from "../runtime/tmux.js";
import {
  claimNextDispatchCommandSync,
  createCommandSync,
} from "../runtime/commands.js";
import { executeDispatchCommandSync } from "../runtime/dispatch.js";
import { recordLoopEvidenceSync } from "../runtime/loop-evidence.js";
import { managerConfigSync } from "../runtime/manager-config.js";
import {
  applySetupBundleSync,
  draftSetupBundlePolicy,
  preflightSetupBundle,
  setupBundleForTaskSync,
  setupBundleHash,
} from "../runtime/setup-bundles.js";
import { writePngRgba } from "../runtime/visual-diff.js";
import {
  bindSessionsSync,
  createTaskSync,
} from "../runtime/tasks.js";
import {
  initializeDatabaseSync,
  openDatabaseSync,
} from "../state/database.js";
import {
  configPath,
  defaultDbPath,
  eventsPath,
  statusPath,
  transcriptPath,
  workerDir,
} from "../state/files.js";

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;

function tildePath(path: string): string {
  const home = homedir();
  assert.ok(path.startsWith(`${home}/`), `path must be under home directory: ${path}`);
  return `~/${path.slice(home.length + 1)}`;
}

function withTemporaryHome(callback: (home: string) => void): void {
  const fakeHome = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-home."));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    callback(fakeHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function makeCodexHomeWithSkills(skills: string[]): string {
  const codexHome = mkdtempSync(join(tmpdir(), "agent-conveyor-codex-home."));
  for (const skill of skills) {
    const skillDir = join(codexHome, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`);
  }
  return codexHome;
}

function seedCliAppLoopFixture(
  dbPath: string,
  options: {
    dispatcherHeartbeatAt: string | null;
    managerHeartbeatAt: string | null;
    now?: string;
    workerHeartbeatAt: string | null;
  },
): void {
  const now = options.now ?? "2026-06-11T12:00:00Z";
  const database = openDatabaseSync(dbPath);
  initializeDatabaseSync(database);
  try {
    database.prepare("insert into tasks(id, name, goal, summary, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)").run(
      "task-app-loop",
      "app-loop-task",
      "Exercise app loop CLI.",
      null,
      "managed",
      now,
      now,
    );
    database.prepare(`
      insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
        codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "session-worker-app",
      "worker-app",
      "worker",
      "worker-token",
      "codex-worker",
      "/tmp/worker.jsonl",
      "thread-worker",
      "Worker App",
      "/repo",
      now,
      options.workerHeartbeatAt,
      "active",
    );
    database.prepare(`
      insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
        codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "session-manager-app",
      "manager-app",
      "manager",
      "manager-token",
      "codex-manager",
      "/tmp/manager.jsonl",
      "thread-manager",
      "Manager App",
      "/repo",
      now,
      options.managerHeartbeatAt,
      "active",
    );
    database.prepare("insert into bindings(id, task_id, worker_session_id, manager_session_id, state, created_at) values (?, ?, ?, ?, ?, ?)").run(
      "binding-app-loop",
      "task-app-loop",
      "session-worker-app",
      "session-manager-app",
      "active",
      now,
    );
    if (options.dispatcherHeartbeatAt) {
      database.prepare(`
        insert into telemetry_events(id, actor, event_type, severity, summary, timestamp, correlation_json, attributes_json)
        values (?, 'dispatch', 'dispatch_watch_heartbeat', 'info', 'Dispatch watch heartbeat 1.', ?, ?, ?)
      `).run(
        "telemetry-dispatch-app-loop",
        options.dispatcherHeartbeatAt,
        JSON.stringify({ dispatcher_id: "dispatch-local", iteration: 1 }),
        JSON.stringify({ dry_run: false, processed_count: 0 }),
      );
    }
  } finally {
    database.close();
  }
}

function seedCampaignCliSession(dbPath: string, options: { id: string; role: "manager" | "worker"; threadId: string }): void {
  const database = openDatabaseSync(dbPath);
  initializeDatabaseSync(database);
  try {
    database.prepare(`
      insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
        codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options.id,
      options.id,
      options.role,
      `${options.id}-token`,
      `codex-${options.id}`,
      `/tmp/${options.id}.jsonl`,
      options.threadId,
      `${options.id} thread`,
      "/repo",
      "2026-06-16T12:00:00Z",
      null,
      "active",
    );
  } finally {
    database.close();
  }
}

test("setup bundle runtime drafts actor-scoped PR review defaults and stable preflight", () => {
  const codexHome = makeCodexHomeWithSkills([
    "aa-extra",
    "codex-review",
    "goal-prep",
    "requesting-code-review",
    "security-diff-scan",
  ]);
  try {
    const policy = draftSetupBundlePolicy({
      optionalSkills: ["security-diff-scan", "optional-extra"],
      preset: "autonomous_ship_it",
      requiredSkills: ["zz-extra", "aa-extra"],
    });
    assert.equal(policy.pr_review.backend, "composite");
    assert.equal(policy.pr_review.required, true);
    assert.deepEqual(policy.pr_review.required_skills, [
      "requesting-code-review",
      "receiving-code-review",
      "codex-review",
      "zz-extra",
      "aa-extra",
    ]);
    assert.deepEqual(policy.manager.pr_review, {
      backend: "inherit",
      gate: "block_merge_until_review_receipts",
      role: "gatekeeper",
    });
    assert.deepEqual(policy.workers.profiles[0]?.pr_review, {
      backend: "inherit",
      required_before_handoff: true,
    });

    const preflight = preflightSetupBundle(policy, { codexHome });
    assert.equal(preflight.ok, false);
    assert.deepEqual(preflight.missing_required, ["receiving-code-review", "zz-extra"]);
    assert.deepEqual(preflight.missing_optional, ["optional-extra"]);
    assert.deepEqual(preflight.checked_skills, [
      "aa-extra",
      "codex-review",
      "goal-prep",
      "optional-extra",
      "receiving-code-review",
      "requesting-code-review",
      "security-diff-scan",
      "zz-extra",
    ]);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup bundle runtime applies blocked bundle without manager authority", () => {
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
      const policy = draftSetupBundlePolicy({ preset: "autonomous_ship_it" });
      const result = applySetupBundleSync(database, {
        approve: true,
        codexHome,
        now: "2026-06-28T10:01:00Z",
        policy,
        taskId: "task-bundle",
      });

      assert.equal(result.blocked, true);
      assert.deepEqual(result.missing_required, [
        "codex-review",
        "goal-prep",
        "receiving-code-review",
        "requesting-code-review",
      ]);
      assert.equal(result.record.state, "blocked");
      assert.match(result.record.blocked_reason ?? "", /missing required backend/i);
      assert.equal(result.record.policy.manager.pr_review.gate, "block_merge_until_review_receipts");
      assert.equal(result.record.policy.workers.profiles[0]?.pr_review.required_before_handoff, true);
      assert.equal((database.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 0);
      assert.equal((database.prepare("select count(*) as count from setup_bundles where task_id = ?").get("task-bundle") as { count: number }).count, 1);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup bundle runtime blocks unapproved apply without manager authority", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-unapproved."));
  const codexHome = makeCodexHomeWithSkills([
    "codex-review",
    "goal-prep",
    "receiving-code-review",
    "requesting-code-review",
  ]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Do not grant authority without approval.",
        name: "unapproved-bundle-task",
        now: "2026-06-28T10:30:00Z",
        taskId: "task-unapproved-bundle",
      });
      const policy = draftSetupBundlePolicy({ preset: "autonomous_ship_it" });
      const result = applySetupBundleSync(database, {
        approve: false,
        codexHome,
        now: "2026-06-28T10:31:00Z",
        policy,
        taskId: "task-unapproved-bundle",
      });

      assert.equal(result.blocked, true);
      assert.deepEqual(result.missing_required, []);
      assert.equal(result.record.state, "blocked");
      assert.equal(result.record.blocked_reason, "missing approval");
      assert.deepEqual(result.record.approval_json, {
        approved: false,
        source: "setup-bundle apply",
      });
      assert.equal((database.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 0);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup bundle runtime applies approved bundle and reads latest setup record", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-approved."));
  const codexHome = makeCodexHomeWithSkills([
    "codex-review",
    "goal-prep",
    "receiving-code-review",
    "requesting-code-review",
  ]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Ship an approved setup bundle task.",
        name: "approved-bundle-task",
        now: "2026-06-28T11:00:00Z",
        taskId: "task-approved-bundle",
      });
      const policy = draftSetupBundlePolicy({ preset: "autonomous_ship_it" });
      const result = applySetupBundleSync(database, {
        approve: true,
        codexHome,
        now: "2026-06-28T11:01:00Z",
        policy,
        taskId: "task-approved-bundle",
      });

      assert.equal(result.blocked, false);
      assert.deepEqual(result.missing_required, []);
      assert.equal(result.record.state, "applied");
      assert.equal(result.record.approved_hash, setupBundleHash(policy));
      assert.equal(result.record.policy.manager.pr_review.role, "gatekeeper");
      assert.equal(result.record.policy.workers.profiles[0]?.pr_review.backend, "inherit");

      const latest = setupBundleForTaskSync(database, "task-approved-bundle");
      assert.equal(latest?.id, result.record.id);
      assert.equal(latest?.preflight.ok, true);
      assert.deepEqual(latest?.preflight.missing_required, []);

      const managerConfig = managerConfigSync(database, "task-approved-bundle");
      assert.equal(managerConfig?.recipe_name, "autonomous_ship_it");
      assert.equal(managerConfig?.supervision_mode, "strict");
      assert.deepEqual(managerConfig?.permissions.repo, ["merge_green_pr", "monitor_ci", "open_pr", "push_branch", "resolve_conflicts"]);
      assert.deepEqual(managerConfig?.permissions.worker_session, ["clear", "compact"]);
      assert.deepEqual(managerConfig?.tools, ["gh", "git", "verification.run_pytest", "context.fetch_prs"]);
      assert.ok(managerConfig?.acceptance_criteria.includes("adversarial_check evidence is recorded."));
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup bundle runtime reads latest setup record by insertion order when timestamps tie", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-latest."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Read latest setup bundle deterministically.",
        name: "latest-bundle-task",
        now: "2026-06-28T12:00:00Z",
        taskId: "task-latest-bundle",
      });
      const oldPolicy = draftSetupBundlePolicy({ preset: "autonomous_ship_it" });
      const newPolicy = draftSetupBundlePolicy({ loopMaxIterations: 5, preset: "autonomous_ship_it" });
      const oldPreflight = preflightSetupBundle(oldPolicy, { codexHome: null });
      const newPreflight = preflightSetupBundle(newPolicy, { codexHome: null });

      const insert = database.prepare(`
        insert into setup_bundles(
          id, task_id, name, preset, state, draft_hash, approved_hash, policy_json,
          preflight_json, approval_json, applied_json, blocked_reason,
          created_at, updated_at, approved_at, applied_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        "setup-z-old",
        "task-latest-bundle",
        "latest-old",
        oldPolicy.preset,
        "blocked",
        setupBundleHash(oldPolicy),
        null,
        JSON.stringify(oldPolicy),
        JSON.stringify(oldPreflight),
        "{}",
        "{}",
        "old row",
        "2026-06-28T12:01:00Z",
        "2026-06-28T12:02:00Z",
        null,
        null,
      );
      insert.run(
        "setup-a-new",
        "task-latest-bundle",
        "latest-new",
        newPolicy.preset,
        "blocked",
        setupBundleHash(newPolicy),
        null,
        JSON.stringify(newPolicy),
        JSON.stringify(newPreflight),
        "{}",
        "{}",
        "new row",
        "2026-06-28T12:01:30Z",
        "2026-06-28T12:02:00Z",
        null,
        null,
      );

      const latest = setupBundleForTaskSync(database, "task-latest-bundle");
      assert.equal(latest?.id, "setup-a-new");
      assert.equal(latest?.blocked_reason, "new row");
      assert.equal(latest?.policy.loop.max_iterations, 5);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup bundle runtime treats unsafe skill names as missing", () => {
  const codexHome = makeCodexHomeWithSkills(["safe-skill"]);
  mkdirSync(join(codexHome, "outside"), { recursive: true });
  writeFileSync(join(codexHome, "outside", "SKILL.md"), "---\nname: outside\n---\n# outside\n");
  try {
    const policy = draftSetupBundlePolicy({
      preset: "custom",
      requiredSkills: [".", "..", "../outside", "nested/skill", "nested\\skill", "safe-skill"],
    });
    const preflight = preflightSetupBundle(policy, { codexHome });

    assert.equal(preflight.ok, false);
    assert.equal(preflight.missing_required.includes("safe-skill"), false);
    assert.equal(preflight.missing_required.includes("."), true);
    assert.equal(preflight.missing_required.includes(".."), true);
    assert.equal(preflight.missing_required.includes("../outside"), true);
    assert.equal(preflight.missing_required.includes("nested/skill"), true);
    assert.equal(preflight.missing_required.includes("nested\\skill"), true);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup-bundle CLI apply records blocked bundle when required backend is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-blocked."));
  const codexHome = makeCodexHomeWithSkills([]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Block missing setup bundle backends.",
        name: "cli-bundle-blocked",
        now: "2026-06-28T13:00:00Z",
        taskId: "task-cli-bundle-blocked",
      });
    } finally {
      database.close();
    }

    const applied = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "apply",
        "cli-bundle-blocked",
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
      now: () => new Date("2026-06-28T13:01:00Z"),
    });
    assert.equal(applied.exitCode, 1);
    const payload = JSON.parse(applied.stdout ?? "{}") as {
      blocked: boolean;
      launched: boolean;
      missing_required: string[];
      setup_bundle: { state: string };
    };
    assert.equal(payload.blocked, true);
    assert.equal(payload.launched, false);
    assert.deepEqual(payload.missing_required, [
      "codex-review",
      "goal-prep",
      "receiving-code-review",
      "requesting-code-review",
    ]);
    assert.equal(payload.setup_bundle.state, "blocked");

    const proofDb = openDatabaseSync(dbPath);
    try {
      assert.equal((proofDb.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count, 1);
      assert.equal((proofDb.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 0);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup-bundle CLI preview includes required skill preflight without mutating ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-preview."));
  const codexHome = makeCodexHomeWithSkills([]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Preview setup bundle only.",
        name: "cli-bundle-preview",
        now: "2026-06-28T13:10:00Z",
        taskId: "task-cli-bundle-preview",
      });
    } finally {
      database.close();
    }

    const preview = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "preview",
        "cli-bundle-preview",
        "--preset",
        "custom",
        "--require-skill",
        "requesting-code-review",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(preview.exitCode, 0);
    const payload = JSON.parse(preview.stdout ?? "{}") as {
      action: string;
      policy: { pr_review: { required_skills: string[] } };
      preflight: { missing_required: string[]; ok: boolean };
    };
    assert.equal(payload.action, "preview");
    assert.deepEqual(payload.policy.pr_review.required_skills, ["requesting-code-review"]);
    assert.equal(payload.preflight.ok, false);
    assert.deepEqual(payload.preflight.missing_required, ["requesting-code-review"]);

    const proofDb = openDatabaseSync(dbPath);
    try {
      assert.equal((proofDb.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count, 0);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup-bundle CLI apply requires approval before ledger mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-approval."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Require explicit setup bundle approval.",
        name: "cli-bundle-approval",
        now: "2026-06-28T13:20:00Z",
        taskId: "task-cli-bundle-approval",
      });
    } finally {
      database.close();
    }

    const applied = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "apply", "cli-bundle-approval", "--preset", "custom", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(applied.exitCode, 2);
    assert.match(applied.stderr ?? "", /setup-bundle apply requires --approve\./);

    const proofDb = openDatabaseSync(dbPath);
    try {
      assert.equal((proofDb.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count, 0);
      assert.equal((proofDb.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 0);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup-bundle CLI apply dry-run does not mutate ledger with approval", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-dry-run."));
  const codexHome = makeCodexHomeWithSkills([
    "codex-review",
    "goal-prep",
    "receiving-code-review",
    "requesting-code-review",
  ]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Dry-run approved setup bundle apply.",
        name: "cli-bundle-dry-run",
        now: "2026-06-28T13:25:00Z",
        taskId: "task-cli-bundle-dry-run",
      });
    } finally {
      database.close();
    }

    const dryRun = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "apply",
        "cli-bundle-dry-run",
        "--preset",
        "autonomous_ship_it",
        "--approve",
        "--dry-run",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(dryRun.exitCode, 0);
    const payload = JSON.parse(dryRun.stdout ?? "{}") as {
      action: string;
      blocked: boolean;
      draft_hash: string;
      dry_run: boolean;
      launched: boolean;
      policy: { preset: string };
      preflight: { missing_required: string[]; ok: boolean };
    };
    assert.equal(payload.action, "apply");
    assert.equal(payload.dry_run, true);
    assert.equal(payload.blocked, false);
    assert.equal(payload.launched, false);
    assert.match(payload.draft_hash, /^[a-f0-9]{64}$/);
    assert.equal(payload.policy.preset, "autonomous_ship_it");
    assert.equal(payload.preflight.ok, true);
    assert.deepEqual(payload.preflight.missing_required, []);

    const proofDb = openDatabaseSync(dbPath);
    try {
      assert.equal((proofDb.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count, 0);
      assert.equal((proofDb.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 0);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup-bundle apply stores approved ship-it policy and manager permissions in ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-approved-ledger."));
  const codexHome = makeCodexHomeWithSkills([
    "goal-prep",
    "requesting-code-review",
    "receiving-code-review",
    "codex-review",
  ]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Prove approved setup bundle authority.",
        name: "ship-task",
        now: "2026-06-28T13:24:00Z",
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
      now: () => new Date("2026-06-28T13:24:30Z"),
    });
    assert.equal(applied.exitCode, 0);
    const payload = JSON.parse(applied.stdout ?? "{}") as {
      blocked: boolean;
      setup_bundle: {
        policy: {
          loop: { preset: string | null; required_evidence: string[] };
          manager: { pr_review: { gate: string; role: string } };
          pr_review: { backend: string; required: boolean };
          whats_next: { max_iterations: number; post_merge_allowed: boolean };
          workers: { profiles: Array<{ pr_review: { required_before_handoff: boolean } }> };
        };
        state: string;
      };
    };
    const policy = payload.setup_bundle.policy;
    assert.equal(payload.blocked, false);
    assert.equal(payload.setup_bundle.state, "applied");
    assert.equal(policy.loop.preset, "ship_it_loop");
    assert.ok(policy.loop.required_evidence.includes("manager_merge_decision"));
    assert.equal(policy.pr_review.backend, "composite");
    assert.equal(policy.pr_review.required, true);
    assert.equal(policy.manager.pr_review.gate, "block_merge_until_review_receipts");
    assert.equal(policy.manager.pr_review.role, "gatekeeper");
    assert.equal(policy.workers.profiles[0]?.pr_review.required_before_handoff, true);
    assert.equal(policy.whats_next.max_iterations, 1);
    assert.equal(policy.whats_next.post_merge_allowed, true);

    const proofDb = openDatabaseSync(dbPath);
    try {
      const setupBundle = proofDb.prepare(`
        select state, applied_json
        from setup_bundles
        where task_id = ?
      `).get("task-ship") as { applied_json: string; state: string };
      assert.equal(setupBundle.state, "applied");
      assert.equal((JSON.parse(setupBundle.applied_json) as { manager_config?: boolean }).manager_config, true);

      const managerConfig = proofDb.prepare(`
        select recipe_name, nudge_on_completion, permissions_json, acceptance_criteria_json
        from manager_configs
        where task_id = ?
      `).get("task-ship") as {
        acceptance_criteria_json: string;
        nudge_on_completion: string;
        permissions_json: string;
        recipe_name: string;
      };
      assert.equal(managerConfig.recipe_name, "autonomous_ship_it");
      assert.equal(managerConfig.nudge_on_completion, "auto-review");
      assert.deepEqual((JSON.parse(managerConfig.permissions_json) as { repo: string[] }).repo, [
        "merge_green_pr",
        "monitor_ci",
        "open_pr",
        "push_branch",
        "resolve_conflicts",
      ]);
      assert.ok((JSON.parse(managerConfig.acceptance_criteria_json) as string[]).some((criterion) => criterion.includes("manager_merge_decision")));
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup-bundle CLI resolves default Codex home for preview and apply", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-default-home."));
  const codexHome = makeCodexHomeWithSkills([
    "codex-review",
    "goal-prep",
    "receiving-code-review",
    "requesting-code-review",
  ]);
  const emptyCodexHome = makeCodexHomeWithSkills([]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Preview with default Codex home.",
        name: "cli-bundle-default-preview",
        now: "2026-06-28T13:26:00Z",
        taskId: "task-cli-bundle-default-preview",
      });
      createTaskSync(database, {
        goal: "Apply with default Codex home.",
        name: "cli-bundle-default-apply",
        now: "2026-06-28T13:27:00Z",
        taskId: "task-cli-bundle-default-apply",
      });
    } finally {
      database.close();
    }

    const preview = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "preview", "cli-bundle-default-preview", "--preset", "autonomous_ship_it", "--path", dbPath, "--json"],
      env: { CODEX_HOME: codexHome },
    });
    assert.equal(preview.exitCode, 0);
    const previewPayload = JSON.parse(preview.stdout ?? "{}") as {
      preflight: { missing_required: string[]; ok: boolean };
    };
    assert.equal(previewPayload.preflight.ok, true);
    assert.deepEqual(previewPayload.preflight.missing_required, []);

    const applied = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "apply", "cli-bundle-default-apply", "--preset", "autonomous_ship_it", "--approve", "--path", dbPath, "--json"],
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-28T13:28:00Z"),
    });
    assert.equal(applied.exitCode, 0);
    const appliedPayload = JSON.parse(applied.stdout ?? "{}") as {
      blocked: boolean;
      setup_bundle: { preflight: { missing_required: string[]; ok: boolean }; state: string };
    };
    assert.equal(appliedPayload.blocked, false);
    assert.equal(appliedPayload.setup_bundle.state, "applied");
    assert.equal(appliedPayload.setup_bundle.preflight.ok, true);
    assert.deepEqual(appliedPayload.setup_bundle.preflight.missing_required, []);

    const override = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "preview",
        "cli-bundle-default-preview",
        "--preset",
        "autonomous_ship_it",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: { CODEX_HOME: emptyCodexHome },
    });
    assert.equal(override.exitCode, 0);
    const overridePayload = JSON.parse(override.stdout ?? "{}") as {
      preflight: { missing_required: string[]; ok: boolean };
    };
    assert.equal(overridePayload.preflight.ok, true);
    assert.deepEqual(overridePayload.preflight.missing_required, []);

    const proofDb = openDatabaseSync(dbPath);
    try {
      assert.equal((proofDb.prepare("select count(*) as count from setup_bundles").get() as { count: number }).count, 1);
      assert.equal((proofDb.prepare("select count(*) as count from manager_configs").get() as { count: number }).count, 1);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(emptyCodexHome, { recursive: true, force: true });
  }
});

test("setup-bundle CLI rejects invalid enum and iteration options", () => {
  const cases: Array<{ args: string[]; error: RegExp }> = [
    {
      args: ["setup-bundle", "preview", "cli-bundle-invalid", "--planning-backend", "magic"],
      error: /Unsupported planning backend: magic/,
    },
    {
      args: ["setup-bundle", "preview", "cli-bundle-invalid", "--loop-backend", "magic"],
      error: /Unsupported loop backend: magic/,
    },
    {
      args: ["setup-bundle", "preview", "cli-bundle-invalid", "--pr-review-backend", "magic"],
      error: /Unsupported PR review backend: magic/,
    },
    {
      args: ["setup-bundle", "preview", "cli-bundle-invalid", "--whats-next", "magic"],
      error: /Unsupported whats-next mode: magic/,
    },
    {
      args: ["setup-bundle", "preview", "cli-bundle-invalid", "--loop-max-iterations", "-1"],
      error: /--loop-max-iterations must be a non-negative integer\./,
    },
    {
      args: ["setup-bundle", "preview", "cli-bundle-invalid", "--whats-next-max-iterations", "1.5"],
      error: /--whats-next-max-iterations must be a non-negative integer\./,
    },
  ];
  for (const item of cases) {
    const result = runTypescriptRuntimeCommand({ args: item.args, env: {} });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr ?? "", item.error);
  }
});

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
      args: [
        "setup-bundle",
        "preview",
        "ralph-task",
        "--preset",
        "test_coverage_ralph",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(coverage.exitCode, 0);
    const coveragePayload = JSON.parse(coverage.stdout ?? "{}") as {
      policy: { loop: { max_iterations: number; preset: string; required_evidence: string[] } };
    };
    assert.equal(coveragePayload.policy.loop.preset, "test_coverage_loop");
    assert.equal(coveragePayload.policy.loop.max_iterations, 3);
    assert.deepEqual(coveragePayload.policy.loop.required_evidence, ["test_coverage", "adversarial_check"]);

    const ux = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "preview",
        "ralph-task",
        "--preset",
        "ux_polish_ralph",
        "--codex-home",
        codexHome,
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(ux.exitCode, 0);
    const uxPayload = JSON.parse(ux.stdout ?? "{}") as {
      policy: { loop: { max_iterations: number; preset: string; required_evidence: string[] } };
    };
    assert.equal(uxPayload.policy.loop.preset, "visual_diff_loop");
    assert.equal(uxPayload.policy.loop.max_iterations, 4);
    assert.ok(uxPayload.policy.loop.required_evidence.includes("candidate_screenshot"));
    assert.ok(uxPayload.policy.loop.required_evidence.includes("visual_diff_report"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("setup-bundle show confirms stored policy from ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-setup-bundle-show."));
  const codexHome = makeCodexHomeWithSkills([
    "codex-review",
    "goal-prep",
    "receiving-code-review",
    "requesting-code-review",
  ]);
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

    const applied = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "apply",
        "show-task",
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
      now: () => new Date("2026-06-28T13:31:00Z"),
    });
    assert.equal(applied.exitCode, 0);
    const applyPayload = JSON.parse(applied.stdout ?? "{}") as {
      blocked: boolean;
      launched: boolean;
      setup_bundle: { id: string };
    };
    assert.equal(applyPayload.blocked, false);
    assert.equal(applyPayload.launched, false);

    const shown = runTypescriptRuntimeCommand({
      args: ["setup-bundle", "show", "show-task", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(shown.exitCode, 0);
    const showPayload = JSON.parse(shown.stdout ?? "{}") as {
      id: string;
      policy: {
        manager: { pr_review: { role: string } };
        planning: { backend: string };
        pr_review: { backend: string };
        whats_next: { mode: string };
        workers: { profiles: Array<{ pr_review: { required_before_handoff: boolean } }> };
      };
      state: string;
    };
    assert.equal(showPayload.id, applyPayload.setup_bundle.id);
    assert.equal(showPayload.state, "applied");
    assert.equal(showPayload.policy.planning.backend, "goalbuddy");
    assert.equal(showPayload.policy.pr_review.backend, "composite");
    assert.equal(showPayload.policy.whats_next.mode, "execute_bounded");
    assert.equal(showPayload.policy.manager.pr_review.role, "gatekeeper");
    assert.equal(showPayload.policy.workers.profiles[0]?.pr_review.required_before_handoff, true);

    const proofDb = openDatabaseSync(dbPath);
    try {
      const stored = proofDb.prepare(`
        select id, policy_json, state
        from setup_bundles
        where task_id = ?
      `).get("task-show") as { id: string; policy_json: string; state: string };
      assert.equal(stored.id, showPayload.id);
      assert.equal(stored.state, showPayload.state);
      assert.deepEqual(JSON.parse(stored.policy_json), showPayload.policy);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("unknown TypeScript runtime command fails without Python fallback", () => {
  const result = runTypescriptRuntimeCommand({
    args: ["adversarial-check", "--json"],
    env: {},
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /unknown command: adversarial-check/);
});

test("TypeScript runtime help honors workerctl program name", () => {
  const topLevel = runTypescriptRuntimeCommand({
    args: ["--help"],
    env: {},
    program: "workerctl",
  });
  assert.equal(topLevel.exitCode, 0);
  assert.match(topLevel.stdout ?? "", /^usage: workerctl /);

  const command = runTypescriptRuntimeCommand({
    args: ["start", "--help"],
    env: {},
    program: "workerctl",
  });
  assert.equal(command.exitCode, 0);
  assert.match(command.stdout ?? "", /^usage: workerctl start /);

  const workerAck = runTypescriptRuntimeCommand({
    args: ["worker-ack", "--help"],
    env: {},
    program: "workerctl",
  });
  assert.equal(workerAck.exitCode, 0);
  assert.match(workerAck.stdout ?? "", /usage: workerctl worker-ack <task> --from-stdin/);
  assert.match(workerAck.stdout ?? "", /"goal_restatement"/);
  assert.match(workerAck.stdout ?? "", /--path <workerctl\.db>/);

  const managerAck = runTypescriptRuntimeCommand({
    args: ["manager-ack", "--help"],
    env: {},
  });
  assert.equal(managerAck.exitCode, 0);
  assert.match(managerAck.stdout ?? "", /usage: conveyor manager-ack <task> --from-stdin/);
  assert.match(managerAck.stdout ?? "", /"supervision_contract"/);

  const criteria = runTypescriptRuntimeCommand({
    args: ["criteria", "--help"],
    env: {},
  });
  assert.equal(criteria.exitCode, 0);
  assert.match(criteria.stdout ?? "", /criteria <task> \[--list\|--add --criterion <text> --source <source>\|--accept ID/);
  assert.match(criteria.stdout ?? "", /--criterion "Note file exists" --source manager_inferred/);

  const finishTask = runTypescriptRuntimeCommand({
    args: ["finish-task", "--help"],
    env: {},
  });
  assert.equal(finishTask.exitCode, 0);
  assert.match(finishTask.stdout ?? "", /finish-task <task> --reason <reason>/);
  assert.match(finishTask.stdout ?? "", /--require-criteria-audit/);
  assert.match(finishTask.stdout ?? "", /--json/);

  const campaign = runTypescriptRuntimeCommand({
    args: ["campaign", "--help"],
    env: {},
  });
  assert.equal(campaign.exitCode, 0);
  assert.match(campaign.stdout ?? "", /campaign <create\|add-slot\|attach-slot\|rotate-slot\|archive-slot\|brief\|assign\|asset\|status\|dashboard\|closeout>/);
  assert.match(campaign.stdout ?? "", /Supported subcommands: create\|add-slot\|attach-slot\|rotate-slot\|archive-slot\|brief\|assign\|asset\|status\|dashboard\|closeout/);
  assert.match(campaign.stdout ?? "", /there is no separate `assets` subcommand/);
  assert.match(campaign.stdout ?? "", /campaign status --name launch --json/);
  assert.match(campaign.stdout ?? "", /campaign dashboard --name launch --json/);
  assert.match(campaign.stdout ?? "", /campaign closeout --name launch --failure-mode "hidden duplicate receipt" --json/);

  const unsupportedCampaignAction = runTypescriptRuntimeCommand({
    args: ["campaign", "assets", "--name", "launch"],
    env: {},
  });
  assert.equal(unsupportedCampaignAction.exitCode, 2);
  assert.match(unsupportedCampaignAction.stderr ?? "", /Unsupported campaign action: assets/);
  assert.match(unsupportedCampaignAction.stderr ?? "", /expected one of: create, add-slot, attach-slot, rotate-slot, archive-slot, brief, assign, asset, status, dashboard, closeout/);
  assert.match(unsupportedCampaignAction.stderr ?? "", /campaign dashboard --name <campaign> --json/);

  const pair = runTypescriptRuntimeCommand({
    args: ["pair", "--help"],
    env: {},
  });
  assert.equal(pair.exitCode, 0);
  assert.match(pair.stdout ?? "", /pair --task <task> --worker-name <worker> --manager-name <manager>/);
  assert.match(pair.stdout ?? "", /--task-goal <text>/);
  assert.match(pair.stdout ?? "", /--task-prompt <text>/);
  assert.match(pair.stdout ?? "", /--manager-acceptance <text>/);
  assert.match(pair.stdout ?? "", /--cwd <dir>/);
  assert.match(pair.stdout ?? "", /--accept-trust/);
  assert.match(pair.stdout ?? "", /--no-dispatch/);
  assert.match(pair.stdout ?? "", /--dry-run/);
  assert.match(pair.stdout ?? "", /--json/);

  const nudge = runTypescriptRuntimeCommand({
    args: ["nudge", "--help"],
    env: {},
  });
  assert.equal(nudge.exitCode, 0);
  assert.match(nudge.stdout ?? "", /enqueue-nudge-worker/);
});

test("TypeScript runtime handles manager recipes by default", () => {
  const listed = runTypescriptRuntimeCommand({
    args: ["manager-recipes", "--list", "--json"],
    env: {},
  });
  assert.equal(listed.exitCode, 0, listed.stderr);
  const listedPayload = JSON.parse(listed.stdout ?? "{}") as {
    recipes: Array<{
      description: string;
      loop_template: string | null;
      mode: string;
      name: string;
    }>;
  };
  assert.deepEqual(listedPayload.recipes.map((recipe) => recipe.name), [
    "campaign-duplicate-guard-dogfood",
    "goalbuddy-conveyor",
    "nudge-whats-next",
    "pr-ci-merge-ralph-loop",
    "ship-it-loop",
    "test-coverage-loop",
    "ux-polish-loop",
  ]);
  assert.equal(listedPayload.recipes.find((recipe) => recipe.name === "test-coverage-loop")?.loop_template, "test_coverage_loop");
  assert.equal(listedPayload.recipes.find((recipe) => recipe.name === "ship-it-loop")?.loop_template, "ship_it_loop");
  assert.equal(
    listedPayload.recipes.find((recipe) => recipe.name === "campaign-duplicate-guard-dogfood")?.mode,
    "strict",
  );

  const shown = runTypescriptRuntimeCommand({
    args: ["manager-recipes", "--show", "goalbuddy", "--json"],
    env: {},
  });
  assert.equal(shown.exitCode, 0, shown.stderr);
  const shownPayload = JSON.parse(shown.stdout ?? "{}") as {
    recipe: {
      display_name: string;
      final_report_requirements: string[];
      locked_summary_template: string;
      manager_config_command: string[];
      mode: string;
      name: string;
      permissions: string[];
    };
  };
  assert.equal(shownPayload.recipe.name, "goalbuddy-conveyor");
  assert.equal(shownPayload.recipe.display_name, "GoalBuddy Conveyor");
  assert.equal(shownPayload.recipe.mode, "strict");
  assert.ok(shownPayload.recipe.permissions.includes("repo.merge_green_pr"));
  assert.match(shownPayload.recipe.final_report_requirements.join(" "), /final report/i);
  assert.match(shownPayload.recipe.final_report_requirements.join(" "), /finish-task|closeout/i);
  assert.deepEqual(shownPayload.recipe.manager_config_command.slice(0, 5), [
    "conveyor",
    "manager-config",
    "<task>",
    "--mode",
    "strict",
  ]);
  assert.ok(shownPayload.recipe.manager_config_command.includes("--allow-worker-compact-clear"));
  assert.match(shownPayload.recipe.locked_summary_template, /Selected recipe: GoalBuddy Conveyor/);
  assert.match(shownPayload.recipe.locked_summary_template, /Final report:/);
  assert.doesNotMatch(shownPayload.recipe.manager_config_command.join(" "), /final report/i);

  const shipIt = runTypescriptRuntimeCommand({
    args: ["manager-recipes", "--show", "ship it", "--json"],
    env: {},
  });
  assert.equal(shipIt.exitCode, 0, shipIt.stderr);
  const shipItPayload = JSON.parse(shipIt.stdout ?? "{}") as {
    recipe: {
      evidence_gates: string[];
      manager_config_command: string[];
      permissions: string[];
    };
  };
  assert.ok(shipItPayload.recipe.permissions.includes("repo.push_branch"));
  assert.ok(shipItPayload.recipe.permissions.includes("repo.resolve_conflicts"));
  assert.ok(shipItPayload.recipe.manager_config_command.includes("repo.monitor_ci"));
  assert.ok(shipItPayload.recipe.evidence_gates.includes("manager_merge_decision"));

  const duplicateGuard = runTypescriptRuntimeCommand({
    args: ["manager-recipes", "--show", "duplicate guard dogfood", "--json"],
    env: {},
  });
  assert.equal(duplicateGuard.exitCode, 0, duplicateGuard.stderr);
  const duplicateGuardPayload = JSON.parse(duplicateGuard.stdout ?? "{}") as {
    recipe: {
      display_name: string;
      evidence_gates: string[];
      final_report_requirements: string[];
      guidelines: string[];
      manager_config_command: string[];
      name: string;
      permissions: string[];
      tools: string[];
    };
  };
  assert.equal(duplicateGuardPayload.recipe.name, "campaign-duplicate-guard-dogfood");
  assert.equal(duplicateGuardPayload.recipe.display_name, "Campaign Duplicate-Guard Dogfood");
  assert.deepEqual(duplicateGuardPayload.recipe.permissions, []);
  assert.ok(duplicateGuardPayload.recipe.evidence_gates.includes("post_probe_dashboard_no_extra_asset"));
  assert.ok(duplicateGuardPayload.recipe.guidelines.some((guideline) => guideline.includes("campaign dashboard --name <campaign> --json")));
  assert.ok(duplicateGuardPayload.recipe.final_report_requirements.join(" ").includes("duplicate error text"));
  assert.ok(duplicateGuardPayload.recipe.tools.includes("campaign.dashboard"));
  assert.ok(!duplicateGuardPayload.recipe.manager_config_command.includes("--allow-additional-receipt"));

  const text = runTypescriptRuntimeCommand({
    args: ["manager-recipes", "--show", "ux polish"],
    env: {},
  });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout ?? "", /Selected recipe: UX Polish Loop/);
  assert.match(text.stdout ?? "", /loop template: visual_diff_loop/);
});

test("TypeScript runtime app-heartbeat refreshes bound manager session and returns poll commands", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-heartbeat."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:30Z",
      managerHeartbeatAt: "2026-06-11T11:40:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-heartbeat",
        "app-loop-task",
        "--role",
        "manager",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      heartbeat: { recorded_at: string; state: string };
      next: { direct_inbox_command: string; poll_command: string };
      role: string;
      status: { manager: { lease: { state: string } } };
      task: { name: string };
    };
    assert.equal(output.role, "manager");
    assert.equal(output.task.name, "app-loop-task");
    assert.equal(output.heartbeat.state, "recorded");
    assert.equal(output.heartbeat.recorded_at, "2026-06-11T12:00:00Z");
    assert.match(output.next.poll_command, /app-heartbeat 'app-loop-task' --role manager/);
    assert.match(output.next.direct_inbox_command, /manager-inbox 'app-loop-task' --consume-next/);
    assert.equal(output.status.manager.lease.state, "healthy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-loop-status reports stale worker and start-dispatch action", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-loop-status."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: null,
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:45:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-loop-status",
        "app-loop-task",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      dispatch: { state: string };
      next_actions: Array<{ kind: string }>;
      ok: boolean;
      worker: { lease: { state: string } };
    };
    assert.equal(output.ok, false);
    assert.equal(output.dispatch.state, "missing");
    assert.equal(output.worker.lease.state, "stale");
    assert.equal(output.next_actions.some((action) => action.kind === "start_dispatch"), true);
    assert.equal(output.next_actions.some((action) => action.kind === "wake_worker"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app smoke required mode blocks until bound roles have sent receipts, fresh heartbeats, and nonce acknowledgements", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-smoke-required."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const start = runTypescriptRuntimeCommand({
      args: [
        "app-smoke",
        "start",
        "app-loop-task",
        "--smoke-id",
        "smoke-required",
        "--nonce",
        "nonce-required",
        "--mode",
        "required",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(start.exitCode, 0, start.stderr);
    const initial = JSON.parse(start.stdout ?? "{}") as {
      status: { blockers: string[]; ok: boolean; real_work_allowed: boolean };
    };
    assert.equal(initial.status.ok, false);
    assert.equal(initial.status.real_work_allowed, false);
    assert.ok(initial.status.blockers.includes("manager smoke prompt has not been recorded as sent"));
    assert.ok(initial.status.blockers.includes("worker has not recorded smoke received"));

    for (const args of [
      ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-required", "--nonce", "nonce-required", "--role", "manager", "--status", "sent", "--thread-id", "thread-manager", "--path", dbPath, "--json"],
      ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-required", "--nonce", "nonce-required", "--role", "worker", "--status", "sent", "--thread-id", "thread-worker", "--path", dbPath, "--json"],
      ["app-heartbeat", "app-loop-task", "--role", "manager", "--path", dbPath, "--json"],
      ["app-heartbeat", "app-loop-task", "--role", "worker", "--path", dbPath, "--json"],
      ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-required", "--nonce", "nonce-required", "--role", "manager", "--status", "accepted", "--thread-id", "thread-manager", "--from-stdin", "--path", dbPath, "--json"],
      ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-required", "--nonce", "nonce-required", "--role", "worker", "--status", "received", "--thread-id", "thread-worker", "--from-stdin", "--path", dbPath, "--json"],
      ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-required", "--nonce", "nonce-required", "--role", "worker", "--status", "accepted", "--thread-id", "thread-worker", "--from-stdin", "--path", dbPath, "--json"],
    ]) {
      const result = runTypescriptRuntimeCommand({
        args,
        env: {},
        now: () => new Date("2026-06-11T12:00:05Z"),
        stdin: "{\"summary\":\"nonce-required smoke evidence\"}",
      });
      assert.equal(result.exitCode, 0, result.stderr);
    }

    const status = runTypescriptRuntimeCommand({
      args: ["app-smoke", "status", "app-loop-task", "--smoke-id", "smoke-required", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:10Z"),
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const payload = JSON.parse(status.stdout ?? "{}") as {
      blockers: string[];
      ok: boolean;
      real_work_allowed: boolean;
      roles: { manager: { accepted: boolean; heartbeat_fresh: boolean; sent: boolean }; worker: { accepted: boolean; heartbeat_fresh: boolean; received: boolean; sent: boolean } };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.real_work_allowed, true);
    assert.deepEqual(payload.blockers, []);
    assert.equal(payload.roles.manager.sent, true);
    assert.equal(payload.roles.manager.heartbeat_fresh, true);
    assert.equal(payload.roles.manager.accepted, true);
    assert.equal(payload.roles.worker.sent, true);
    assert.equal(payload.roles.worker.heartbeat_fresh, true);
    assert.equal(payload.roles.worker.received, true);
    assert.equal(payload.roles.worker.accepted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app smoke uses latest terminal role receipt so a retry can recover a blocked smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-smoke-retry."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const start = runTypescriptRuntimeCommand({
      args: ["app-smoke", "start", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--mode", "required", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(start.exitCode, 0, start.stderr);

    const steps: Array<{ args: string[]; now: string; stdin?: string }> = [
      { args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--role", "manager", "--status", "sent", "--thread-id", "thread-manager", "--path", dbPath, "--json"], now: "2026-06-11T12:00:01Z" },
      { args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--role", "worker", "--status", "sent", "--thread-id", "thread-worker", "--path", dbPath, "--json"], now: "2026-06-11T12:00:01Z" },
      { args: ["app-heartbeat", "app-loop-task", "--role", "manager", "--path", dbPath, "--json"], now: "2026-06-11T12:00:02Z" },
      { args: ["app-heartbeat", "app-loop-task", "--role", "worker", "--path", dbPath, "--json"], now: "2026-06-11T12:00:02Z" },
      { args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--role", "worker", "--status", "received", "--thread-id", "thread-worker", "--from-stdin", "--path", dbPath, "--json"], now: "2026-06-11T12:00:03Z", stdin: "{\"summary\":\"worker received nonce-retry\"}" },
      { args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--role", "worker", "--status", "accepted", "--thread-id", "thread-worker", "--from-stdin", "--path", dbPath, "--json"], now: "2026-06-11T12:00:04Z", stdin: "{\"summary\":\"worker accepted nonce-retry\"}" },
      { args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--role", "manager", "--status", "blocked", "--thread-id", "thread-manager", "--from-stdin", "--path", dbPath, "--json"], now: "2026-06-11T12:00:05Z", stdin: "{\"summary\":\"manager timed out waiting for worker report\"}" },
    ];
    for (const step of steps) {
      const result = runTypescriptRuntimeCommand({
        args: step.args,
        env: {},
        now: () => new Date(step.now),
        stdin: step.stdin,
      });
      assert.equal(result.exitCode, 0, result.stderr);
    }

    const blocked = runTypescriptRuntimeCommand({
      args: ["app-smoke", "status", "app-loop-task", "--smoke-id", "smoke-retry", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:06Z"),
    });
    assert.equal(blocked.exitCode, 0, blocked.stderr);
    const blockedPayload = JSON.parse(blocked.stdout ?? "{}") as {
      blockers: string[];
      real_work_allowed: boolean;
      roles: { manager: { accepted: boolean; blocked: boolean } };
    };
    assert.equal(blockedPayload.real_work_allowed, false);
    assert.equal(blockedPayload.roles.manager.accepted, false);
    assert.equal(blockedPayload.roles.manager.blocked, true);
    assert.ok(blockedPayload.blockers.some((blocker) => /manager smoke blocked/.test(blocker)));

    const accepted = runTypescriptRuntimeCommand({
      args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-retry", "--nonce", "nonce-retry", "--role", "manager", "--status", "accepted", "--thread-id", "thread-manager", "--from-stdin", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:07Z"),
      stdin: "{\"summary\":\"manager consumed late worker report and accepted nonce-retry\"}",
    });
    assert.equal(accepted.exitCode, 0, accepted.stderr);

    const recovered = runTypescriptRuntimeCommand({
      args: ["app-smoke", "status", "app-loop-task", "--smoke-id", "smoke-retry", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:08Z"),
    });
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    const recoveredPayload = JSON.parse(recovered.stdout ?? "{}") as {
      blockers: string[];
      ok: boolean;
      real_work_allowed: boolean;
      roles: { manager: { accepted: boolean; blocked: boolean } };
    };
    assert.equal(recoveredPayload.ok, true);
    assert.equal(recoveredPayload.real_work_allowed, true);
    assert.deepEqual(recoveredPayload.blockers, []);
    assert.equal(recoveredPayload.roles.manager.accepted, true);
    assert.equal(recoveredPayload.roles.manager.blocked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app smoke rejects stale nonce receipts and unbound thread ids", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-smoke-nonce."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const startOld = runTypescriptRuntimeCommand({
      args: ["app-smoke", "start", "app-loop-task", "--smoke-id", "smoke-old", "--nonce", "nonce-old", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(startOld.exitCode, 0, startOld.stderr);
    const oldReceipt = runTypescriptRuntimeCommand({
      args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-old", "--nonce", "nonce-old", "--role", "worker", "--status", "accepted", "--thread-id", "thread-worker", "--from-stdin", "--path", dbPath, "--json"],
      env: {},
      stdin: "{\"summary\":\"old nonce\"}",
    });
    assert.equal(oldReceipt.exitCode, 0, oldReceipt.stderr);

    const startNew = runTypescriptRuntimeCommand({
      args: ["app-smoke", "start", "app-loop-task", "--smoke-id", "smoke-new", "--nonce", "nonce-new", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });
    assert.equal(startNew.exitCode, 0, startNew.stderr);
    const statusNew = JSON.parse(startNew.stdout ?? "{}") as { status: { blockers: string[]; ok: boolean } };
    assert.equal(statusNew.status.ok, false);
    assert.ok(statusNew.status.blockers.includes("worker has not accepted smoke"));

    const staleNonce = runTypescriptRuntimeCommand({
      args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-new", "--nonce", "nonce-old", "--role", "worker", "--status", "accepted", "--thread-id", "thread-worker", "--from-stdin", "--path", dbPath, "--json"],
      env: {},
      stdin: "{\"summary\":\"wrong nonce\"}",
    });
    assert.equal(staleNonce.exitCode, 2);
    assert.match(staleNonce.stderr ?? "", /Smoke nonce mismatch/);

    const wrongThread = runTypescriptRuntimeCommand({
      args: ["app-smoke", "record", "app-loop-task", "--smoke-id", "smoke-new", "--nonce", "nonce-new", "--role", "worker", "--status", "sent", "--thread-id", "unbound-thread", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(wrongThread.exitCode, 2);
    assert.match(wrongThread.stderr ?? "", /Thread id mismatch for worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app smoke advisory mode reports blockers without blocking real work", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-smoke-advisory."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-smoke",
        "start",
        "app-loop-task",
        "--smoke-id",
        "smoke-advisory",
        "--nonce",
        "nonce-advisory",
        "--mode",
        "advisory",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as { status: { blockers: string[]; ok: boolean; real_work_allowed: boolean } };
    assert.equal(payload.status.ok, false);
    assert.equal(payload.status.real_work_allowed, true);
    assert.ok(payload.status.blockers.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app smoke preflight reports missing thread metadata and skip mode records an explicit bypass", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-smoke-preflight."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update sessions set codex_app_thread_id = null where role = 'worker'").run();
    } finally {
      database.close();
    }

    const preflight = runTypescriptRuntimeCommand({
      args: ["app-smoke", "preflight", "app-loop-task", "--mode", "required", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(preflight.exitCode, 0, preflight.stderr);
    const preflightPayload = JSON.parse(preflight.stdout ?? "{}") as {
      blockers: string[];
      checks: Array<{ name: string; ok: boolean }>;
      ok: boolean;
      real_work_allowed: boolean;
    };
    assert.equal(preflightPayload.ok, false);
    assert.equal(preflightPayload.real_work_allowed, false);
    assert.ok(preflightPayload.checks.some((check) => check.name === "worker_thread_metadata" && check.ok === false));

    const skip = runTypescriptRuntimeCommand({
      args: ["app-smoke", "start", "app-loop-task", "--smoke-id", "smoke-skip", "--nonce", "nonce-skip", "--mode", "skip", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(skip.exitCode, 0, skip.stderr);
    const skipPayload = JSON.parse(skip.stdout ?? "{}") as {
      receipt: { event_type: string };
      status: { blockers: string[]; ok: boolean; real_work_allowed: boolean };
    };
    assert.equal(skipPayload.receipt.event_type, "app_smoke_skipped");
    assert.equal(skipPayload.status.ok, true);
    assert.equal(skipPayload.status.real_work_allowed, true);
    assert.deepEqual(skipPayload.status.blockers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app smoke worker-set scope fails closed for a single task with multiple required workers", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-smoke-worker-set."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:00Z",
      workerHeartbeatAt: "2026-06-11T11:59:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-smoke",
        "start",
        "app-loop-task",
        "--smoke-id",
        "smoke-worker-set",
        "--nonce",
        "nonce-worker-set",
        "--scope",
        "worker-set",
        "--worker-count",
        "2",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as { status: { blockers: string[]; ok: boolean; real_work_allowed: boolean } };
    assert.equal(payload.status.ok, false);
    assert.equal(payload.status.real_work_allowed, false);
    assert.ok(payload.status.blockers.some((blocker) => /proves 1 of 2 workers/.test(blocker)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-plan prints app-thread prompts for stale roles", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-plan."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:00Z",
      managerHeartbeatAt: "2026-06-11T11:45:00Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-plan",
        "app-loop-task",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      wakeups: Array<{
        prompt: string;
        role: string;
        thread: { id: string | null; title: string | null };
      }>;
    };
    assert.equal(output.wakeups.length, 2);
    assert.equal(output.wakeups[0].role, "manager");
    assert.equal(output.wakeups[0].thread.id, "thread-manager");
    assert.match(output.wakeups[0].prompt, /conveyor app-heartbeat 'app-loop-task' --role manager/);
    assert.match(output.wakeups[0].prompt, /verify worker claims/);
    assert.equal(output.wakeups[1].role, "worker");
    assert.equal(output.wakeups[1].thread.id, "thread-worker");
    assert.match(output.wakeups[1].prompt, /conveyor app-heartbeat 'app-loop-task' --role worker/);
    assert.match(output.wakeups[1].prompt, /execute only that single worker instruction/);
    assert.match(output.wakeups[1].prompt, /conveyor enqueue-notify-manager 'app-loop-task'/);
    assert.match(output.wakeups[1].prompt, /conveyor dispatch --watch --watch-iterations 1 --interval 2 --dispatcher-id dispatch-local/);
    assert.match(output.wakeups[1].prompt, /direct app-thread final answer is not a manager receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-dispatch records ready stale app wake actions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-dispatch."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:45:00Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-dispatch",
        "app-loop-task",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      actions: Array<{ prompt: string | null; role: string; send_ready: boolean; status: string; thread: { id: string | null } }>;
      receipt: { event_id: string; event_type: string; recorded_at: string };
      summary: { blocked: number; dispatcher_required: boolean; ready_to_send: number; skipped: number };
    };
    assert.equal(output.summary.ready_to_send, 2);
    assert.equal(output.summary.blocked, 0);
    assert.equal(output.summary.skipped, 0);
    assert.equal(output.summary.dispatcher_required, false);
    assert.equal(output.actions[0].role, "manager");
    assert.equal(output.actions[0].status, "ready_to_send");
    assert.equal(output.actions[0].send_ready, true);
    assert.equal(output.actions[0].thread.id, "thread-manager");
    assert.match(output.actions[0].prompt ?? "", /conveyor app-heartbeat 'app-loop-task' --role manager/);
    assert.equal(output.actions[1].role, "worker");
    assert.equal(output.actions[1].status, "ready_to_send");
    assert.equal(output.actions[1].send_ready, true);
    assert.equal(output.actions[1].thread.id, "thread-worker");
    assert.equal(output.receipt.event_type, "app_wakeup_dispatch_planned");
    assert.equal(output.receipt.recorded_at, "2026-06-11T12:00:00Z");

    const database = openDatabaseSync(dbPath);
    try {
      const telemetry = database.prepare(`
        select event_type, severity, correlation_json, attributes_json
        from telemetry_events
        where id = ?
      `).get(output.receipt.event_id) as { attributes_json: string; correlation_json: string; event_type: string; severity: string } | undefined;
      assert.ok(telemetry);
      assert.equal(telemetry.event_type, "app_wakeup_dispatch_planned");
      assert.equal(telemetry.severity, "info");
      assert.deepEqual(JSON.parse(telemetry.correlation_json), {
        command: "app-wakeup-dispatch",
        dispatcher_id: "dispatch-local",
      });
      const attributes = JSON.parse(telemetry.attributes_json) as {
        actions: Array<{ role: string; status: string }>;
        summary: { ready_to_send: number };
      };
      assert.equal(attributes.summary.ready_to_send, 2);
      assert.deepEqual(attributes.actions.map((action) => `${action.role}:${action.status}`), [
        "manager:ready_to_send",
        "worker:ready_to_send",
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-dispatch skips healthy roles and keeps missing dispatch visible", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-dispatch-healthy."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: null,
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:59:40Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-dispatch",
        "app-loop-task",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      actions: Array<{ prompt: string | null; role: string; send_ready: boolean; status: string }>;
      dispatcher: { required: boolean; state: string };
      status: { ok: boolean };
      summary: { dispatcher_required: boolean; ready_to_send: number; skipped: number };
    };
    assert.equal(output.status.ok, false);
    assert.equal(output.dispatcher.state, "missing");
    assert.equal(output.dispatcher.required, true);
    assert.equal(output.summary.dispatcher_required, true);
    assert.equal(output.summary.ready_to_send, 0);
    assert.equal(output.summary.skipped, 2);
    assert.deepEqual(output.actions.map((action) => `${action.role}:${action.status}:${action.send_ready}:${action.prompt}`), [
      "manager:skipped_healthy:false:null",
      "worker:skipped_healthy:false:null",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-dispatch blocks stale role without app thread id", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-dispatch-blocked."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update sessions set codex_app_thread_id = null, codex_app_thread_title = null where id = 'session-worker-app'").run();
    } finally {
      database.close();
    }
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-dispatch",
        "app-loop-task",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      actions: Array<{ blocker: string | null; prompt: string | null; role: string; send_ready: boolean; status: string; thread: { id: string | null } }>;
      summary: { blocked: number; ready_to_send: number; skipped: number };
    };
    assert.equal(output.summary.ready_to_send, 0);
    assert.equal(output.summary.blocked, 1);
    assert.equal(output.summary.skipped, 1);
    const worker = output.actions.find((action) => action.role === "worker");
    assert.ok(worker);
    assert.equal(worker.status, "blocked_missing_thread");
    assert.equal(worker.send_ready, false);
    assert.equal(worker.thread.id, null);
    assert.match(worker.blocker ?? "", /No Codex app thread id/);
    assert.match(worker.prompt ?? "", /conveyor app-heartbeat 'app-loop-task' --role worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-record-delivery records sent only for send-ready source actions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-record-sent."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: null,
      managerHeartbeatAt: "2026-06-11T11:45:00Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const dispatch = runTypescriptRuntimeCommand({
      args: ["app-wakeup-dispatch", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(dispatch.exitCode, 0, dispatch.stderr);
    const dispatchOutput = JSON.parse(dispatch.stdout ?? "{}") as {
      receipt: { event_id: string };
      summary: { dispatcher_required: boolean; ready_to_send: number };
    };
    assert.equal(dispatchOutput.summary.ready_to_send, 2);
    assert.equal(dispatchOutput.summary.dispatcher_required, true);

    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-record-delivery",
        "app-loop-task",
        "--role",
        "manager",
        "--dispatch-receipt",
        dispatchOutput.receipt.event_id,
        "--delivery-status",
        "sent",
        "--thread-id",
        "thread-manager",
        "--reason",
        "send_message_to_thread returned ok",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      delivery: { role: string; source_action_status: string; source_send_ready: boolean; status: string; thread_id: string };
      receipt: { event_id: string; event_type: string; recorded_at: string };
      source: { dispatch_receipt: string; dispatch_required: boolean };
    };
    assert.equal(output.delivery.role, "manager");
    assert.equal(output.delivery.status, "sent");
    assert.equal(output.delivery.source_action_status, "ready_to_send");
    assert.equal(output.delivery.source_send_ready, true);
    assert.equal(output.delivery.thread_id, "thread-manager");
    assert.equal(output.source.dispatch_receipt, dispatchOutput.receipt.event_id);
    assert.equal(output.source.dispatch_required, true);
    assert.equal(output.receipt.event_type, "app_wakeup_delivery_recorded");
    assert.equal(output.receipt.recorded_at, "2026-06-11T12:01:00Z");

    const database = openDatabaseSync(dbPath);
    try {
      const telemetry = database.prepare("select event_type, attributes_json from telemetry_events where id = ?")
        .get(output.receipt.event_id) as { attributes_json: string; event_type: string } | undefined;
      assert.ok(telemetry);
      assert.equal(telemetry.event_type, "app_wakeup_delivery_recorded");
      const attributes = JSON.parse(telemetry.attributes_json) as {
        delivery_status: string;
        dispatch_required: boolean;
        dispatch_receipt: string;
        role: string;
        source_action_status: string;
        source_send_ready: boolean;
        thread_id: string;
      };
      assert.equal(attributes.delivery_status, "sent");
      assert.equal(attributes.dispatch_required, true);
      assert.equal(attributes.dispatch_receipt, dispatchOutput.receipt.event_id);
      assert.equal(attributes.role, "manager");
      assert.equal(attributes.source_action_status, "ready_to_send");
      assert.equal(attributes.source_send_ready, true);
      assert.equal(attributes.thread_id, "thread-manager");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-record-delivery records blocked send failures for ready actions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-record-blocked-ready."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: null,
      managerHeartbeatAt: "2026-06-11T11:45:00Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const dispatch = runTypescriptRuntimeCommand({
      args: ["app-wakeup-dispatch", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(dispatch.exitCode, 0, dispatch.stderr);
    const dispatchOutput = JSON.parse(dispatch.stdout ?? "{}") as {
      receipt: { event_id: string };
      summary: { ready_to_send: number };
    };
    assert.equal(dispatchOutput.summary.ready_to_send, 2);

    const missingReason = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-record-delivery",
        "app-loop-task",
        "--role",
        "worker",
        "--dispatch-receipt",
        dispatchOutput.receipt.event_id,
        "--delivery-status",
        "blocked",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });
    assert.equal(missingReason.exitCode, 2);
    assert.match(missingReason.stderr ?? "", /ready-to-send source actions require --reason/);

    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-record-delivery",
        "app-loop-task",
        "--role",
        "worker",
        "--dispatch-receipt",
        dispatchOutput.receipt.event_id,
        "--delivery-status",
        "blocked",
        "--reason",
        "send_message_to_thread unavailable",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:02:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      delivery: { reason: string; role: string; source_action_status: string; source_send_ready: boolean; status: string; thread_id: string };
      receipt: { event_type: string };
    };
    assert.equal(output.delivery.role, "worker");
    assert.equal(output.delivery.status, "blocked");
    assert.equal(output.delivery.reason, "send_message_to_thread unavailable");
    assert.equal(output.delivery.source_action_status, "ready_to_send");
    assert.equal(output.delivery.source_send_ready, true);
    assert.equal(output.delivery.thread_id, "thread-worker");
    assert.equal(output.receipt.event_type, "app_wakeup_delivery_recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-record-delivery rejects sent for skipped healthy actions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-record-reject-skipped."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:59:40Z",
    });
    const dispatch = runTypescriptRuntimeCommand({
      args: ["app-wakeup-dispatch", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(dispatch.exitCode, 0, dispatch.stderr);
    const dispatchOutput = JSON.parse(dispatch.stdout ?? "{}") as {
      receipt: { event_id: string };
      summary: { skipped: number };
    };
    assert.equal(dispatchOutput.summary.skipped, 2);

    const result = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-record-delivery",
        "app-loop-task",
        "--role",
        "manager",
        "--dispatch-receipt",
        dispatchOutput.receipt.event_id,
        "--delivery-status",
        "sent",
        "--thread-id",
        "thread-manager",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr ?? "", /Cannot record sent wakeup for manager; source action is skipped_healthy/);
    const database = openDatabaseSync(dbPath);
    try {
      const count = database.prepare("select count(*) as count from telemetry_events where event_type = 'app_wakeup_delivery_recorded'")
        .get() as { count: number };
      assert.equal(count.count, 0);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-wakeup-record-delivery records blocked missing-thread actions and rejects sent", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-record-blocked."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update sessions set codex_app_thread_id = null, codex_app_thread_title = null where id = 'session-worker-app'").run();
    } finally {
      database.close();
    }
    const dispatch = runTypescriptRuntimeCommand({
      args: ["app-wakeup-dispatch", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(dispatch.exitCode, 0, dispatch.stderr);
    const dispatchOutput = JSON.parse(dispatch.stdout ?? "{}") as {
      receipt: { event_id: string };
      summary: { blocked: number };
    };
    assert.equal(dispatchOutput.summary.blocked, 1);

    const rejected = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-record-delivery",
        "app-loop-task",
        "--role",
        "worker",
        "--dispatch-receipt",
        dispatchOutput.receipt.event_id,
        "--delivery-status",
        "sent",
        "--thread-id",
        "thread-worker",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });
    assert.equal(rejected.exitCode, 2);
    assert.match(rejected.stderr ?? "", /Cannot record sent wakeup for worker; source action is blocked_missing_thread/);

    const recorded = runTypescriptRuntimeCommand({
      args: [
        "app-wakeup-record-delivery",
        "app-loop-task",
        "--role",
        "worker",
        "--dispatch-receipt",
        dispatchOutput.receipt.event_id,
        "--delivery-status",
        "blocked",
        "--reason",
        "missing app thread id",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:02:00Z"),
    });
    assert.equal(recorded.exitCode, 0, recorded.stderr);
    const output = JSON.parse(recorded.stdout ?? "{}") as {
      delivery: { source_action_status: string; source_send_ready: boolean; status: string; thread_id: string | null };
    };
    assert.equal(output.delivery.status, "blocked");
    assert.equal(output.delivery.source_action_status, "blocked_missing_thread");
    assert.equal(output.delivery.source_send_ready, false);
    assert.equal(output.delivery.thread_id, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-worker-rotation plans and records only the active bound worker thread", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-worker-rotation."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:40Z",
      workerHeartbeatAt: "2026-06-11T11:58:00Z",
    });
    const database = openDatabaseSync(dbPath);
    try {
      database.prepare(`
        insert into worker_handoffs(task_id, worker_session_id, summary, next_steps_json, payload_json, created_at)
        values ('task-app-loop', 'session-worker-app', 'Ready for fresh worker.', '["poll worker inbox"]', '{}', '2026-06-11T11:59:00Z')
      `).run();
    } finally {
      database.close();
    }

    const planned = runTypescriptRuntimeCommand({
      args: [
        "app-worker-rotation-plan",
        "app-loop-task",
        "--old-worker-thread-id",
        "thread-worker",
        "--require-handoff",
        "--reason",
        "fresh worker context",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(planned.exitCode, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout ?? "{}") as {
      actions: Array<{
        prompt?: string;
        send_ready: boolean;
        status: string;
        thread: { id: string | null; title: string | null };
        type: string;
      }>;
      blockers: string[];
      eligible: boolean;
      guard: {
        binding_id: string;
        exact_thread_match: boolean;
        manager_thread_id: string;
        role: string;
        worker_session_id: string;
      };
      handoff: { id: number; summary: string; worker_session_id: string };
      record_command: string;
      receipt: { event_id: string; event_type: string };
    };
    assert.equal(plan.eligible, true);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.guard.binding_id, "binding-app-loop");
    assert.equal(plan.guard.role, "worker");
    assert.equal(plan.guard.worker_session_id, "session-worker-app");
    assert.equal(plan.guard.manager_thread_id, "thread-manager");
    assert.equal(plan.guard.exact_thread_match, true);
    assert.equal(plan.handoff.summary, "Ready for fresh worker.");
    assert.equal(plan.handoff.worker_session_id, "session-worker-app");
    assert.equal(plan.actions.length, 2);
    const createAction = plan.actions.find((action) => action.type === "create_replacement_worker_thread");
    const archiveAction = plan.actions.find((action) => action.type === "archive_old_worker_thread");
    assert.ok(createAction);
    assert.ok(archiveAction);
    assert.equal(createAction.send_ready, true);
    assert.equal(createAction.status, "ready_to_create");
    assert.equal(createAction.thread.id, null);
    assert.equal(createAction.thread.title, "Worker App fresh");
    assert.match(createAction.prompt ?? "", /Saved handoff id: 1/);
    assert.match(createAction.prompt ?? "", /Visible session protocol, required for operator review/);
    assert.match(createAction.prompt ?? "", /conveyor app-heartbeat 'app-loop-task' --role worker/);
    assert.equal(archiveAction.send_ready, true);
    assert.equal(archiveAction.status, "ready_to_archive");
    assert.equal(archiveAction.thread.id, "thread-worker");
    assert.notEqual(archiveAction.thread.id, plan.guard.manager_thread_id);
    assert.match(plan.record_command, /app-worker-rotation-record 'app-loop-task'/);
    assert.equal(plan.receipt.event_type, "app_worker_rotation_planned");

    const recorded = runTypescriptRuntimeCommand({
      args: [
        "app-worker-rotation-record",
        "app-loop-task",
        "--old-worker-thread-id",
        "thread-worker",
        "--new-worker-thread-id",
        "thread-worker-fresh",
        "--new-worker-thread-title",
        "Worker App fresh",
        "--archive-status",
        "archived",
        "--reason",
        "set_thread_archived returned ok",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });
    assert.equal(recorded.exitCode, 0, recorded.stderr);
    const recordPayload = JSON.parse(recorded.stdout ?? "{}") as {
      archive: { old_worker_thread_id: string; status: string };
      new_worker: { codex_app_thread_id: string; session_id: string; session_updated: boolean };
      receipt: { event_type: string };
    };
    assert.equal(recordPayload.archive.status, "archived");
    assert.equal(recordPayload.archive.old_worker_thread_id, "thread-worker");
    assert.equal(recordPayload.new_worker.session_id, "session-worker-app");
    assert.equal(recordPayload.new_worker.codex_app_thread_id, "thread-worker-fresh");
    assert.equal(recordPayload.new_worker.session_updated, true);
    assert.equal(recordPayload.receipt.event_type, "app_worker_rotation_recorded");

    const updatedDb = openDatabaseSync(dbPath);
    try {
      const worker = updatedDb.prepare(`
        select codex_app_thread_id, codex_app_thread_title, last_heartbeat_at
        from sessions
        where id = 'session-worker-app'
      `).get() as { codex_app_thread_id: string; codex_app_thread_title: string; last_heartbeat_at: string | null };
      assert.equal(worker.codex_app_thread_id, "thread-worker-fresh");
      assert.equal(worker.codex_app_thread_title, "Worker App fresh");
      assert.equal(worker.last_heartbeat_at, null);
      const telemetry = updatedDb.prepare(`
        select count(*) as count
        from telemetry_events
        where event_type in ('app_worker_rotation_planned', 'app_worker_rotation_recorded')
      `).get() as { count: number };
      assert.equal(telemetry.count, 2);
    } finally {
      updatedDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-worker-rotation refuses manager or unrelated thread ids", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-worker-rotation-refuse."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:40Z",
      workerHeartbeatAt: "2026-06-11T11:58:00Z",
    });
    const database = openDatabaseSync(dbPath);
    try {
      database.prepare(`
        insert into worker_handoffs(task_id, worker_session_id, summary, next_steps_json, payload_json, created_at)
        values ('task-app-loop', 'session-worker-app', 'Ready for fresh worker.', '[]', '{}', '2026-06-11T11:59:00Z')
      `).run();
    } finally {
      database.close();
    }

    const planned = runTypescriptRuntimeCommand({
      args: [
        "app-worker-rotation-plan",
        "app-loop-task",
        "--old-worker-thread-id",
        "thread-manager",
        "--require-handoff",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(planned.exitCode, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout ?? "{}") as {
      actions: unknown[];
      blockers: string[];
      eligible: boolean;
      record_command: string | null;
    };
    assert.equal(plan.eligible, false);
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.record_command, null);
    assert.ok(plan.blockers.includes("old_worker_thread_id_mismatch"));

    const recorded = runTypescriptRuntimeCommand({
      args: [
        "app-worker-rotation-record",
        "app-loop-task",
        "--old-worker-thread-id",
        "thread-manager",
        "--new-worker-thread-id",
        "thread-worker-fresh",
        "--archive-status",
        "archived",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:01:00Z"),
    });
    assert.equal(recorded.exitCode, 2);
    assert.match(recorded.stderr ?? "", /active worker ownership check failed: old_worker_thread_id_mismatch/);

    const updatedDb = openDatabaseSync(dbPath);
    try {
      const worker = updatedDb.prepare(`
        select codex_app_thread_id
        from sessions
        where id = 'session-worker-app'
      `).get() as { codex_app_thread_id: string };
      assert.equal(worker.codex_app_thread_id, "thread-worker");
      const recordedCount = updatedDb.prepare(`
        select count(*) as count
        from telemetry_events
        where event_type = 'app_worker_rotation_recorded'
      `).get() as { count: number };
      assert.equal(recordedCount.count, 0);
    } finally {
      updatedDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-autopilot start emits automation specs and durable receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-autopilot-start."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: null,
      managerHeartbeatAt: "2026-06-11T11:45:00Z",
      workerHeartbeatAt: "2026-06-11T11:44:00Z",
    });
    const result = runTypescriptRuntimeCommand({
      args: [
        "app-autopilot",
        "start",
        "app-loop-task",
        "--dispatcher-id",
        "dispatch-app-loop",
        "--interval",
        "30",
        "--watch-iterations",
        "500",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "{}") as {
      action: string;
      plan: {
        automation_specs: Array<{ can_create: boolean; prompt: string; role: string; rrule: string; target_thread_id: string | null }>;
        control: { dispatcher_command: string; note: string; wakeup_dispatch_command: string };
        desired_state: string;
        readiness: { autonomous_ready: boolean; blockers: string[]; state: string };
        summary: { autonomous_ready: boolean; blocked_automations: number; creatable_automations: number; dispatcher_required: boolean };
      };
      receipt: { event_id: string; event_type: string; recorded_at: string };
    };
    assert.equal(output.action, "start");
    assert.equal(output.plan.desired_state, "active");
    assert.equal(output.plan.summary.creatable_automations, 2);
    assert.equal(output.plan.summary.blocked_automations, 0);
    assert.equal(output.plan.summary.dispatcher_required, true);
    assert.equal(output.plan.summary.autonomous_ready, false);
    assert.equal(output.plan.readiness.state, "setup_required");
    assert.equal(output.plan.readiness.autonomous_ready, false);
    assert.ok(output.plan.readiness.blockers.some((blocker) => /Dispatch dispatch-app-loop is missing/.test(blocker)));
    assert.ok(output.plan.readiness.blockers.some((blocker) => /manager heartbeat automation has not been recorded as applied/.test(blocker)));
    assert.match(output.plan.control.dispatcher_command, /dispatch --watch --watch-iterations 500 --interval 30 --dispatcher-id 'dispatch-app-loop'/);
    assert.match(output.plan.control.wakeup_dispatch_command, /app-wakeup-dispatch 'app-loop-task' --dispatcher-id 'dispatch-app-loop'/);
    assert.match(output.plan.control.note, /plain shell CLI cannot call Codex app thread tools/);
    assert.deepEqual(output.plan.automation_specs.map((spec) => `${spec.role}:${spec.can_create}:${spec.target_thread_id}`), [
      "manager:true:thread-manager",
      "worker:true:thread-worker",
    ]);
    assert.equal(output.plan.automation_specs[0].rrule, "FREQ=MINUTELY;INTERVAL=2");
    assert.match(output.plan.automation_specs[0].prompt, /conveyor app-heartbeat 'app-loop-task' --role manager/);
    assert.match(output.plan.automation_specs[0].prompt, /Visible session protocol, required for operator review/);
    assert.match(output.plan.automation_specs[0].prompt, /CONVEYOR RECEIVED/);
    assert.match(output.plan.automation_specs[0].prompt, /CONVEYOR SEND/);
    assert.match(output.plan.automation_specs[1].prompt, /conveyor app-heartbeat 'app-loop-task' --role worker/);
    assert.match(output.plan.automation_specs[1].prompt, /Visible session protocol, required for operator review/);
    assert.match(output.plan.automation_specs[1].prompt, /CONVEYOR RECEIVED/);
    assert.match(output.plan.automation_specs[1].prompt, /DISPATCH/);
    assert.equal(output.receipt.event_type, "app_autopilot_started");
    assert.equal(output.receipt.recorded_at, "2026-06-11T12:00:00Z");

    const database = openDatabaseSync(dbPath);
    try {
      const telemetry = database.prepare("select event_type, actor, correlation_json, attributes_json from telemetry_events where id = ?")
        .get(output.receipt.event_id) as { actor: string; attributes_json: string; correlation_json: string; event_type: string } | undefined;
      assert.ok(telemetry);
      assert.equal(telemetry.event_type, "app_autopilot_started");
      assert.equal(telemetry.actor, "operator");
      assert.deepEqual(JSON.parse(telemetry.correlation_json), {
        action: "start",
        command: "app-autopilot",
        dispatcher_id: "dispatch-app-loop",
      });
      const attributes = JSON.parse(telemetry.attributes_json) as {
        automation_specs: Array<{ role: string; target_thread_id: string | null }>;
        desired_state: string;
      };
      assert.equal(attributes.desired_state, "active");
      assert.deepEqual(attributes.automation_specs.map((spec) => `${spec.role}:${spec.target_thread_id}`), [
        "manager:thread-manager",
        "worker:thread-worker",
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-autopilot readiness becomes autonomous only after dispatcher, leases, and automation receipts are healthy", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-autopilot-readiness."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:59:50Z",
    });
    const started = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "start", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(started.exitCode, 0, started.stderr);
    const startOutput = JSON.parse(started.stdout ?? "{}") as {
      plan: {
        automation_state: { applied_count: number; missing_roles: string[] };
        readiness: { autonomous_ready: boolean; blockers: string[]; dispatcher_ready: boolean; state: string };
        summary: { autonomous_ready: boolean };
      };
    };
    assert.equal(startOutput.plan.readiness.dispatcher_ready, true);
    assert.equal(startOutput.plan.readiness.state, "setup_required");
    assert.equal(startOutput.plan.readiness.autonomous_ready, false);
    assert.equal(startOutput.plan.summary.autonomous_ready, false);
    assert.equal(startOutput.plan.automation_state.applied_count, 0);
    assert.deepEqual(startOutput.plan.automation_state.missing_roles, ["manager", "worker"]);

    const managerApplied = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "record-automation", "app-loop-task", "--role", "manager", "--automation-id", "conveyor-app-loop-manager-heartbeat", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:05Z"),
    });
    assert.equal(managerApplied.exitCode, 0, managerApplied.stderr);
    const managerOutput = JSON.parse(managerApplied.stdout ?? "{}") as {
      plan: {
        automation_state: { applied_count: number; applied_roles: string[]; missing_roles: string[] };
        readiness: { autonomous_ready: boolean; blockers: string[]; state: string };
      };
      receipt: { event_type: string };
    };
    assert.equal(managerOutput.receipt.event_type, "app_autopilot_automation_applied");
    assert.equal(managerOutput.plan.automation_state.applied_count, 1);
    assert.deepEqual(managerOutput.plan.automation_state.applied_roles, ["manager"]);
    assert.deepEqual(managerOutput.plan.automation_state.missing_roles, ["worker"]);
    assert.equal(managerOutput.plan.readiness.state, "setup_required");
    assert.ok(managerOutput.plan.readiness.blockers.some((blocker) => /worker heartbeat automation has not been recorded as applied/.test(blocker)));

    const workerApplied = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "record-automation", "app-loop-task", "--role", "worker", "--automation-id", "conveyor-app-loop-worker-heartbeat", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:06Z"),
    });
    assert.equal(workerApplied.exitCode, 0, workerApplied.stderr);
    const workerOutput = JSON.parse(workerApplied.stdout ?? "{}") as {
      plan: {
        automation_state: { applied_count: number; applied_roles: string[]; missing_roles: string[] };
        readiness: { autonomous_ready: boolean; blockers: string[]; state: string };
        summary: { applied_automations: number; autonomous_ready: boolean };
      };
    };
    assert.equal(workerOutput.plan.automation_state.applied_count, 2);
    assert.deepEqual(workerOutput.plan.automation_state.applied_roles, ["manager", "worker"]);
    assert.deepEqual(workerOutput.plan.automation_state.missing_roles, []);
    assert.equal(workerOutput.plan.summary.applied_automations, 2);
    assert.equal(workerOutput.plan.summary.autonomous_ready, true);
    assert.equal(workerOutput.plan.readiness.state, "autonomous_ready");
    assert.equal(workerOutput.plan.readiness.autonomous_ready, true);
    assert.deepEqual(workerOutput.plan.readiness.blockers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-autopilot stop and status read last policy", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-autopilot-stop."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:59:40Z",
    });
    const started = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "start", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(started.exitCode, 0, started.stderr);

    const stopped = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "stop", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    const stopOutput = JSON.parse(stopped.stdout ?? "{}") as {
      plan: { desired_state: string; last_policy_event: { event_type: string } };
      receipt: { event_id: string; event_type: string };
    };
    assert.equal(stopOutput.plan.desired_state, "stopped");
    assert.equal(stopOutput.plan.last_policy_event.event_type, "app_autopilot_stopped");
    assert.equal(stopOutput.receipt.event_type, "app_autopilot_stopped");

    const status = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "status", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:02:00Z"),
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const statusOutput = JSON.parse(status.stdout ?? "{}") as {
      plan: { desired_state: string; last_policy_event: { event_id: string; event_type: string } | null };
      receipt: null;
    };
    assert.equal(statusOutput.plan.desired_state, "stopped");
    assert.equal(statusOutput.plan.last_policy_event?.event_id, stopOutput.receipt.event_id);
    assert.equal(statusOutput.receipt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-autopilot status recommends stop after quiet healthy cycles", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-autopilot-quiet."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:50Z",
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:59:50Z",
    });
    const started = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "start", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(started.exitCode, 0, started.stderr);

    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update sessions set last_heartbeat_at = ? where id in (?, ?)").run(
        "2026-06-11T12:03:50Z",
        "session-manager-app",
        "session-worker-app",
      );
      database.prepare(`
        insert into telemetry_events(id, actor, event_type, severity, summary, timestamp, task_id, correlation_json, attributes_json)
        values (?, 'dispatch', 'dispatch_watch_heartbeat', 'info', 'Dispatch watch heartbeat 2.', ?, 'task-app-loop', ?, ?)
      `).run(
        "telemetry-dispatch-app-loop-quiet",
        "2026-06-11T12:03:50Z",
        JSON.stringify({ dispatcher_id: "dispatch-local", iteration: 2 }),
        JSON.stringify({ dry_run: false, processed_count: 0 }),
      );
      const insertHeartbeat = database.prepare(`
        insert into telemetry_events(id, actor, event_type, severity, summary, timestamp, task_id, correlation_json, attributes_json)
        values (?, ?, 'app_heartbeat', 'info', ?, ?, 'task-app-loop', ?, ?)
      `);
      for (const [index, timestamp] of ["2026-06-11T12:01:00Z", "2026-06-11T12:02:00Z", "2026-06-11T12:03:00Z"].entries()) {
        insertHeartbeat.run(
          `telemetry-manager-quiet-${index}`,
          "manager",
          "manager app heartbeat for app-loop-task.",
          timestamp,
          JSON.stringify({ command: "app-heartbeat" }),
          JSON.stringify({ role: "manager", task: "app-loop-task" }),
        );
        insertHeartbeat.run(
          `telemetry-worker-quiet-${index}`,
          "worker",
          "worker app heartbeat for app-loop-task.",
          timestamp,
          JSON.stringify({ command: "app-heartbeat" }),
          JSON.stringify({ role: "worker", task: "app-loop-task" }),
        );
      }
    } finally {
      database.close();
    }

    const status = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "status", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:04:00Z"),
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const output = JSON.parse(status.stdout ?? "{}") as {
      plan: {
        quiescence: {
          quiet_after: string | null;
          quiet_cycles: number;
          recommended_action: string;
          state: string;
          threshold_cycles: number;
        };
        status: { next_actions: unknown[]; ok: boolean };
        summary: { quiescence_recommended: boolean };
      };
    };
    assert.equal(output.plan.status.ok, true);
    assert.deepEqual(output.plan.status.next_actions, []);
    assert.equal(output.plan.quiescence.quiet_after, "2026-06-11T12:00:00Z");
    assert.equal(output.plan.quiescence.quiet_cycles, 3);
    assert.equal(output.plan.quiescence.threshold_cycles, 3);
    assert.equal(output.plan.quiescence.state, "stop_recommended");
    assert.equal(output.plan.quiescence.recommended_action, "stop_autopilot");
    assert.equal(output.plan.summary.quiescence_recommended, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime app-autopilot status keeps monitoring when quiet cycles still have pending health actions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-autopilot-quiet-pending."));
  const dbPath = join(root, "workerctl.db");
  try {
    seedCliAppLoopFixture(dbPath, {
      dispatcherHeartbeatAt: null,
      managerHeartbeatAt: "2026-06-11T11:59:50Z",
      workerHeartbeatAt: "2026-06-11T11:59:50Z",
    });
    const started = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "start", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:00:00Z"),
    });
    assert.equal(started.exitCode, 0, started.stderr);

    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update sessions set last_heartbeat_at = ? where id in (?, ?)").run(
        "2026-06-11T12:03:50Z",
        "session-manager-app",
        "session-worker-app",
      );
      const insertHeartbeat = database.prepare(`
        insert into telemetry_events(id, actor, event_type, severity, summary, timestamp, task_id, correlation_json, attributes_json)
        values (?, ?, 'app_heartbeat', 'info', ?, ?, 'task-app-loop', ?, ?)
      `);
      for (const [index, timestamp] of ["2026-06-11T12:01:00Z", "2026-06-11T12:02:00Z", "2026-06-11T12:03:00Z"].entries()) {
        insertHeartbeat.run(
          `telemetry-manager-quiet-pending-${index}`,
          "manager",
          "manager app heartbeat for app-loop-task.",
          timestamp,
          JSON.stringify({ command: "app-heartbeat" }),
          JSON.stringify({ role: "manager", task: "app-loop-task" }),
        );
        insertHeartbeat.run(
          `telemetry-worker-quiet-pending-${index}`,
          "worker",
          "worker app heartbeat for app-loop-task.",
          timestamp,
          JSON.stringify({ command: "app-heartbeat" }),
          JSON.stringify({ role: "worker", task: "app-loop-task" }),
        );
      }
    } finally {
      database.close();
    }

    const status = runTypescriptRuntimeCommand({
      args: ["app-autopilot", "status", "app-loop-task", "--path", dbPath, "--json"],
      env: {},
      now: () => new Date("2026-06-11T12:04:00Z"),
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const output = JSON.parse(status.stdout ?? "{}") as {
      plan: {
        quiescence: {
          quiet_cycles: number;
          recommended_action: string;
          reason: string | null;
          state: string;
          threshold_cycles: number;
        };
        status: { next_actions: Array<{ kind: string }>; ok: boolean };
        summary: { quiescence_recommended: boolean };
      };
    };
    assert.equal(output.plan.status.ok, false);
    assert.deepEqual(output.plan.status.next_actions.map((action) => action.kind), ["start_dispatch"]);
    assert.equal(output.plan.quiescence.quiet_cycles, 3);
    assert.equal(output.plan.quiescence.threshold_cycles, 3);
    assert.equal(output.plan.quiescence.state, "monitoring");
    assert.equal(output.plan.quiescence.recommended_action, "continue");
    assert.match(output.plan.quiescence.reason ?? "", /pending health actions/);
    assert.equal(output.plan.summary.quiescence_recommended, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles task create list and active filtering by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-tasks."));
  try {
    const dbPath = join(root, "workerctl.db");
    const created = runTypescriptRuntimeCommand({
      args: [
        "tasks",
        "--path",
        dbPath,
        "--create",
        "auth-refactor",
        "--goal",
        "Finish auth refactor.",
        "--summary",
        "Middleware replaced.",
      ],
      env: {},
    });
    assert.equal(created.exitCode, 0);
    assert.equal(created.handled, true);
    const createdPayload = JSON.parse(created.stdout ?? "{}") as {
      created: boolean;
      id: string;
      name: string;
    };
    assert.equal(createdPayload.created, true);
    assert.match(createdPayload.id, /^task-/);
    assert.equal(createdPayload.name, "auth-refactor");

    const listed = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(listed.exitCode, 0);
    const tasks = JSON.parse(listed.stdout ?? "[]") as Array<{
      budget: null;
      goal: string;
      name: string;
      state: string;
      summary: string | null;
    }>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].budget, null);
    assert.equal(tasks[0].goal, "Finish auth refactor.");
    assert.equal(tasks[0].name, "auth-refactor");
    assert.equal(tasks[0].state, "candidate");
    assert.equal(tasks[0].summary, "Middleware replaced.");

    const text = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath],
      env: {},
    });
    assert.equal(text.stdout, "auth-refactor\tcandidate\tFinish auth refactor.\n");

    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update tasks set state = 'done' where name = ?").run("auth-refactor");
    } finally {
      database.close();
    }

    const active = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath, "--active", "--json"],
      env: {},
    });
    assert.equal(active.stdout, "[]\n");

    const missingGoal = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath, "--create", "missing-goal"],
      env: {},
    });
    assert.equal(missingGoal.exitCode, 2);
    assert.match(missingGoal.stderr ?? "", /--goal is required with tasks --create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles campaign create slot brief assignment asset and status by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-campaign."));
  try {
    const dbPath = join(root, "workerctl.db");

    const create = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "create",
        "--name",
        "launch",
        "--objective",
        "Create multi-channel launch assets.",
        "--metadata-json",
        "{\"owner\":\"ops\"}",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(create.exitCode, 0, create.stderr);
    const createPayload = JSON.parse(create.stdout ?? "{}") as {
      campaign_id?: string;
      created?: boolean;
      ledger_readback?: { checks: Array<{ entity: string }>; ok: boolean };
    };
    assert.equal(createPayload.created, true);
    assert.match(createPayload.campaign_id ?? "", /^campaign-/);
    assert.equal(createPayload.ledger_readback?.ok, true);
    assert.deepEqual(createPayload.ledger_readback?.checks.map((check) => check.entity), ["campaign"]);

    const slot = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "add-slot",
        "--name",
        "launch",
        "--slot-key",
        "tiktok",
        "--role-label",
        "TikTok worker",
        "--channel",
        "tiktok",
        "--thread-id",
        "thread-tiktok",
        "--thread-title",
        "TikTok Worker",
        "--state",
        "active",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(slot.exitCode, 0, slot.stderr);
    const slotPayload = JSON.parse(slot.stdout ?? "{}") as {
      ledger_readback?: { checks: Array<{ entity: string }>; ok: boolean };
      slot_id?: string;
    };
    assert.match(slotPayload.slot_id ?? "", /^campaign-slot-/);
    assert.equal(slotPayload.ledger_readback?.ok, true);
    assert.deepEqual(slotPayload.ledger_readback?.checks.map((check) => check.entity), ["campaign", "slot"]);

    const brief = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "brief",
        "--name",
        "launch",
        "--channel",
        "tiktok",
        "--brief-json",
        "{\"format\":\"9:16\",\"tone\":\"direct\"}",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(brief.exitCode, 0, brief.stderr);
    const briefPayload = JSON.parse(brief.stdout ?? "{}") as {
      ledger_readback?: { checks: Array<{ entity: string }>; ok: boolean };
    };
    assert.equal(briefPayload.ledger_readback?.ok, true);
    assert.deepEqual(briefPayload.ledger_readback?.checks.map((check) => check.entity), ["campaign", "brief"]);

    const assignment = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "assign",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--title",
        "Draft hooks",
        "--instructions",
        "Create three short hooks.",
        "--status",
        "active",
        "--metadata-json",
        "{\"round\":1}",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(assignment.exitCode, 0, assignment.stderr);
    const assignmentPayload = JSON.parse(assignment.stdout ?? "{}") as {
      assignment_id?: string;
      ledger_readback?: { checks: Array<{ entity: string }>; ok: boolean };
    };
    assert.match(assignmentPayload.assignment_id ?? "", /^campaign-assignment-/);
    assert.equal(assignmentPayload.ledger_readback?.ok, true);
    assert.deepEqual(assignmentPayload.ledger_readback?.checks.map((check) => check.entity), ["campaign", "slot", "assignment"]);

    const asset = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "asset",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--assignment",
        assignmentPayload.assignment_id ?? "",
        "--asset-type",
        "copy",
        "--title",
        "Hooks v1",
        "--status",
        "needs_review",
        "--artifact-path",
        "receipts/launch/tiktok-hooks.md",
        "--prompt-summary",
        "sterile prompt summary",
        "--review-notes",
        "needs operator review",
        "--metadata-json",
        "{\"variants\":3}",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(asset.exitCode, 0, asset.stderr);
    const assetPayload = JSON.parse(asset.stdout ?? "{}") as { asset_receipt_id?: string };
    assert.match(assetPayload.asset_receipt_id ?? "", /^campaign-asset-/);

    const status = runTypescriptRuntimeCommand({
      args: ["campaign", "status", "--name", "launch", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout ?? "{}") as {
      asset_counts?: Record<string, number>;
      assignment_counts?: Record<string, number>;
      campaign?: { metadata?: Record<string, unknown>; name?: string };
      channel_briefs?: Array<{ brief: Record<string, unknown>; channel: string }>;
      slots?: Array<{ active_assignments: number; asset_receipts: number; codex_app_thread_id: string | null; state: string }>;
    };
    assert.equal(statusPayload.campaign?.name, "launch");
    assert.equal(statusPayload.campaign?.metadata?.owner, "ops");
    assert.equal(statusPayload.slots?.length, 1);
    assert.equal(statusPayload.slots?.[0]?.state, "active");
    assert.equal(statusPayload.slots?.[0]?.codex_app_thread_id, "thread-tiktok");
    assert.equal(statusPayload.slots?.[0]?.active_assignments, 1);
    assert.equal(statusPayload.slots?.[0]?.asset_receipts, 1);
    assert.equal(statusPayload.channel_briefs?.[0]?.channel, "tiktok");
    assert.equal(statusPayload.channel_briefs?.[0]?.brief.format, "9:16");
    assert.equal(statusPayload.assignment_counts?.active, 1);
    assert.equal(statusPayload.asset_counts?.needs_review, 1);

    const dashboard = runTypescriptRuntimeCommand({
      args: ["campaign", "dashboard", "--name", "launch", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(dashboard.exitCode, 0, dashboard.stderr);
    const dashboardPayload = JSON.parse(dashboard.stdout ?? "{}") as {
      approvals?: Record<string, number>;
      next_manager_action?: { action: string; reason: string };
      slots?: Array<{ lifecycle: { state: string }; session: null | { id: string }; slot_key: string }>;
      summary?: { asset_total: number; stale_slots: number };
    };
    assert.equal(dashboardPayload.next_manager_action?.action, "review_assets");
    assert.match(dashboardPayload.next_manager_action?.reason ?? "", /Assets need review/);
    assert.equal(dashboardPayload.approvals?.needs_review, 1);
    assert.equal(dashboardPayload.summary?.asset_total, 1);
    assert.equal(dashboardPayload.summary?.stale_slots, 0);
    assert.equal(dashboardPayload.slots?.[0]?.slot_key, "tiktok");
    assert.equal(dashboardPayload.slots?.[0]?.lifecycle.state, "active");
    assert.equal(dashboardPayload.slots?.[0]?.session, null);

    const closeout = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "closeout",
        "--name",
        "launch",
        "--failure-mode",
        "hidden duplicate receipt",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(closeout.exitCode, 0, closeout.stderr);
    const closeoutPayload = JSON.parse(closeout.stdout ?? "{}") as {
      action?: string;
      failure_mode?: { evidence?: string; strongest_realistic_failure_mode?: string };
      proof_checks?: Array<{ check: string; status: string }>;
      receipt_counts_by_assignment?: Array<{ assignment_id: string; receipt_count: number; slot_key: string }>;
      verdict?: string;
      workers?: Array<{ codex_app_thread_id: string | null; receipt_ids: string[]; slot_key: string }>;
    };
    assert.equal(closeoutPayload.action, "closeout");
    assert.equal(closeoutPayload.verdict, "needs_review");
    assert.equal(closeoutPayload.failure_mode?.strongest_realistic_failure_mode, "hidden duplicate receipt");
    assert.match(closeoutPayload.failure_mode?.evidence ?? "", /asset_total=1/);
    assert.equal(closeoutPayload.receipt_counts_by_assignment?.[0]?.assignment_id, assignmentPayload.assignment_id);
    assert.equal(closeoutPayload.receipt_counts_by_assignment?.[0]?.receipt_count, 1);
    assert.equal(closeoutPayload.receipt_counts_by_assignment?.[0]?.slot_key, "tiktok");
    assert.equal(closeoutPayload.workers?.[0]?.codex_app_thread_id, "thread-tiktok");
    assert.deepEqual(closeoutPayload.workers?.[0]?.receipt_ids, [assetPayload.asset_receipt_id]);
    assert.equal(closeoutPayload.proof_checks?.find((check) => check.check === "blockers_absent")?.status, "passed");
    assert.equal(closeoutPayload.proof_checks?.find((check) => check.check === "assignment_receipt_counts")?.status, "passed");

    const text = runTypescriptRuntimeCommand({
      args: ["campaign", "status", "--name", "launch", "--path", dbPath],
      env: {},
    });
    assert.equal(text.exitCode, 0, text.stderr);
    assert.match(text.stdout ?? "", /campaign launch active/);
    assert.match(text.stdout ?? "", /slots 1/);

    const createText = runTypescriptRuntimeCommand({
      args: ["campaign", "create", "--name", "text-proof", "--objective", "Text proof.", "--path", dbPath],
      env: {},
    });
    assert.equal(createText.exitCode, 0, createText.stderr);
    assert.match(createText.stdout ?? "", /ledger_readback ok campaign=campaign-/);

    const dashboardText = runTypescriptRuntimeCommand({
      args: ["campaign", "dashboard", "--name", "launch", "--path", dbPath],
      env: {},
    });
    assert.equal(dashboardText.exitCode, 0, dashboardText.stderr);
    assert.match(dashboardText.stdout ?? "", /campaign launch active/);
    assert.match(dashboardText.stdout ?? "", /next review_assets/);
    assert.match(dashboardText.stdout ?? "", /slot tiktok active active/);

    const closeoutText = runTypescriptRuntimeCommand({
      args: ["campaign", "closeout", "--name", "launch", "--path", dbPath],
      env: {},
    });
    assert.equal(closeoutText.exitCode, 0, closeoutText.stderr);
    assert.match(closeoutText.stdout ?? "", /closeout verdict needs_review/);
    assert.match(closeoutText.stdout ?? "", /proof passed blockers_absent/);
    assert.match(closeoutText.stdout ?? "", /assignment_receipts tiktok/);

    const badJson = runTypescriptRuntimeCommand({
      args: ["campaign", "create", "--name", "bad", "--objective", "Bad JSON.", "--metadata-json", "[]", "--path", dbPath],
      env: {},
    });
    assert.equal(badJson.exitCode, 2);
    assert.match(badJson.stderr ?? "", /--metadata-json must be a JSON object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime campaign setup fails before returning ids when readback is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-campaign-readback-fail."));
  try {
    const dbPath = join(root, "workerctl.db");

    const create = runTypescriptRuntimeCommand({
      args: ["campaign", "create", "--name", "launch", "--objective", "Create assets.", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(create.exitCode, 0, create.stderr);

    const slot = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "add-slot",
        "--name",
        "launch",
        "--slot-key",
        "linkedin",
        "--role-label",
        "LinkedIn worker",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(slot.exitCode, 0, slot.stderr);
    const slotPayload = JSON.parse(slot.stdout ?? "{}") as { slot_id?: string };

    const assignment = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "assign",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--title",
        "Draft LinkedIn post",
        "--instructions",
        "Create one sanitized LinkedIn draft.",
        "--path",
        dbPath,
        "--json",
      ],
      campaignReadbackBeforeVerify: ({ databasePath, readback }) => {
        const database = openDatabaseSync(databasePath);
        try {
          database.prepare("delete from campaign_assignments where id = ?").run(readback.assignment ?? "");
        } finally {
          database.close();
        }
      },
      env: {},
    });
    assert.equal(assignment.exitCode, 2);
    assert.match(assignment.stderr ?? "", /campaign ledger readback failed after setup write/);
    assert.match(assignment.stderr ?? "", /unknown campaign assignment/);
    assert.equal(assignment.stdout ?? "", "");

    const status = runTypescriptRuntimeCommand({
      args: ["campaign", "status", "--name", "launch", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout ?? "{}") as { assignment_counts?: Record<string, number> };
    assert.equal(statusPayload.assignment_counts?.queued, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime rejects duplicate campaign assignment receipts unless allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-campaign-assets."));
  try {
    const dbPath = join(root, "workerctl.db");

    assert.equal(runTypescriptRuntimeCommand({
      args: ["campaign", "create", "--name", "launch", "--objective", "Create assets.", "--path", dbPath, "--json"],
      env: {},
    }).exitCode, 0);

    const slot = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "add-slot",
        "--name",
        "launch",
        "--slot-key",
        "linkedin",
        "--role-label",
        "LinkedIn worker",
        "--thread-id",
        "thread-linkedin",
        "--state",
        "active",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(slot.exitCode, 0, slot.stderr);
    const slotPayload = JSON.parse(slot.stdout ?? "{}") as { slot_id?: string };

    const assignment = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "assign",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--title",
        "Draft LinkedIn post",
        "--instructions",
        "Create one sanitized LinkedIn draft.",
        "--status",
        "active",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(assignment.exitCode, 0, assignment.stderr);
    const assignmentPayload = JSON.parse(assignment.stdout ?? "{}") as { assignment_id?: string };

    const first = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "asset",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--assignment",
        assignmentPayload.assignment_id ?? "",
        "--asset-type",
        "copy",
        "--title",
        "LinkedIn draft v1",
        "--status",
        "needs_review",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(first.exitCode, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout ?? "{}") as { asset_receipt_id?: string };

    const duplicate = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "asset",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--assignment",
        assignmentPayload.assignment_id ?? "",
        "--asset-type",
        "copy",
        "--title",
        "LinkedIn draft duplicate",
        "--status",
        "needs_review",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(duplicate.exitCode, 2);
    assert.match(duplicate.stderr ?? "", new RegExp(`assignment already has asset receipt ${firstPayload.asset_receipt_id}`));
    assert.match(duplicate.stderr ?? "", /--allow-additional-receipt/);

    const allowed = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "asset",
        "--name",
        "launch",
        "--slot",
        slotPayload.slot_id ?? "",
        "--assignment",
        assignmentPayload.assignment_id ?? "",
        "--asset-type",
        "copy",
        "--title",
        "LinkedIn draft intentional variant",
        "--status",
        "needs_review",
        "--allow-additional-receipt",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(allowed.exitCode, 0, allowed.stderr);

    const status = runTypescriptRuntimeCommand({
      args: ["campaign", "status", "--name", "launch", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout ?? "{}") as { asset_counts?: Record<string, number> };
    assert.equal(statusPayload.asset_counts?.needs_review, 2);

    const closeout = runTypescriptRuntimeCommand({
      args: ["campaign", "closeout", "--name", "launch", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(closeout.exitCode, 0, closeout.stderr);
    const closeoutPayload = JSON.parse(closeout.stdout ?? "{}") as {
      proof_checks?: Array<{ check: string; evidence: string; status: string }>;
      receipt_counts_by_assignment?: Array<{ assignment_id: string; receipt_count: number }>;
    };
    assert.equal(closeoutPayload.receipt_counts_by_assignment?.[0]?.assignment_id, assignmentPayload.assignment_id);
    assert.equal(closeoutPayload.receipt_counts_by_assignment?.[0]?.receipt_count, 2);
    const assignmentReceiptCheck = closeoutPayload.proof_checks?.find((check) => check.check === "assignment_receipt_counts");
    assert.equal(assignmentReceiptCheck?.status, "attention");
    assert.match(assignmentReceiptCheck?.evidence ?? "", new RegExp(`${assignmentPayload.assignment_id}:2`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles campaign worker slot app lifecycle guardrails", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-campaign-lifecycle."));
  try {
    const dbPath = join(root, "workerctl.db");
    seedCampaignCliSession(dbPath, { id: "session-worker", role: "worker", threadId: "thread-worker" });
    seedCampaignCliSession(dbPath, { id: "session-manager", role: "manager", threadId: "thread-manager" });

    const create = runTypescriptRuntimeCommand({
      args: ["campaign", "create", "--name", "lifecycle", "--objective", "Manage workers.", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(create.exitCode, 0, create.stderr);
    const other = runTypescriptRuntimeCommand({
      args: ["campaign", "create", "--name", "other", "--objective", "Other campaign.", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(other.exitCode, 0, other.stderr);

    const slot = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "add-slot",
        "--name",
        "lifecycle",
        "--slot-key",
        "video",
        "--role-label",
        "Video worker",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(slot.exitCode, 0, slot.stderr);
    const slotPayload = JSON.parse(slot.stdout ?? "{}") as { slot_id?: string };
    const slotId = slotPayload.slot_id ?? "";
    assert.match(slotId, /^campaign-slot-/);

    const managerAttach = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "attach-slot",
        "--name",
        "lifecycle",
        "--slot",
        slotId,
        "--session-id",
        "session-manager",
        "--thread-id",
        "thread-manager",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(managerAttach.exitCode, 2);
    assert.match(managerAttach.stderr ?? "", /requires a worker session/);

    const attach = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "attach-slot",
        "--name",
        "lifecycle",
        "--slot",
        slotId,
        "--session-id",
        "session-worker",
        "--thread-id",
        "thread-worker",
        "--thread-title",
        "Video Worker",
        "--state",
        "active",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(attach.exitCode, 0, attach.stderr);
    const attachPayload = JSON.parse(attach.stdout ?? "{}") as { slot?: { codex_app_thread_id?: string | null; session_id?: string | null; state?: string } };
    assert.equal(attachPayload.slot?.session_id, "session-worker");
    assert.equal(attachPayload.slot?.codex_app_thread_id, "thread-worker");
    assert.equal(attachPayload.slot?.state, "active");

    const wrongRotate = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "rotate-slot",
        "--name",
        "lifecycle",
        "--slot",
        slotId,
        "--expected-thread-id",
        "wrong-thread",
        "--thread-id",
        "thread-worker-2",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(wrongRotate.exitCode, 2);
    assert.match(wrongRotate.stderr ?? "", /thread guard does not match/);

    const rotate = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "rotate-slot",
        "--name",
        "lifecycle",
        "--slot",
        slotId,
        "--expected-thread-id",
        "thread-worker",
        "--thread-id",
        "thread-worker-2",
        "--thread-title",
        "Video Worker 2",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(rotate.exitCode, 0, rotate.stderr);
    const rotatePayload = JSON.parse(rotate.stdout ?? "{}") as { slot?: { codex_app_thread_id?: string | null; state?: string } };
    assert.equal(rotatePayload.slot?.codex_app_thread_id, "thread-worker-2");
    assert.equal(rotatePayload.slot?.state, "active");

    const crossCampaignArchive = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "archive-slot",
        "--name",
        "other",
        "--slot",
        slotId,
        "--expected-thread-id",
        "thread-worker-2",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(crossCampaignArchive.exitCode, 2);
    assert.match(crossCampaignArchive.stderr ?? "", /slot does not belong to campaign/);

    const archive = runTypescriptRuntimeCommand({
      args: [
        "campaign",
        "archive-slot",
        "--name",
        "lifecycle",
        "--slot",
        slotId,
        "--expected-thread-id",
        "thread-worker-2",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(archive.exitCode, 0, archive.stderr);
    const archivePayload = JSON.parse(archive.stdout ?? "{}") as { slot?: { codex_app_thread_id?: string | null; state?: string } };
    assert.equal(archivePayload.slot?.codex_app_thread_id, "thread-worker-2");
    assert.equal(archivePayload.slot?.state, "archived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles criteria add list and status transitions by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-criteria."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Prove the criteria ledger.",
        name: "criteria-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-criteria",
      });
    } finally {
      database.close();
    }

    const dryRunAdd = runTypescriptRuntimeCommand({
      args: [
        "criteria",
        "criteria-task",
        "--add",
        "--criterion",
        "Dry-run must not mutate.",
        "--source",
        "worker_proposed",
        "--dry-run",
        "--path",
        dbPath,
      ],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(dryRunAdd.exitCode, 2);
    assert.match(dryRunAdd.stderr ?? "", /Unsupported TypeScript runtime option for criteria/);
    const afterDryRun = openDatabaseSync(dbPath);
    try {
      const criteria = afterDryRun.prepare("select count(*) as count from acceptance_criteria where task_id = ?")
        .get("task-criteria") as { count: number };
      assert.equal(criteria.count, 0);
    } finally {
      afterDryRun.close();
    }

    const added = runTypescriptRuntimeCommand({
      args: [
        "criteria",
        "criteria-task",
        "--add",
        "--criterion",
        "CLI criteria mutations are durable.",
        "--source",
        "worker_proposed",
        "--status",
        "accepted",
        "--proof",
        "node:test exercised the CLI.",
        "--evidence-json",
        "{\"suite\":\"cli\"}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(added.exitCode, 0);
    assert.equal(added.handled, true);
    const addedPayload = JSON.parse(added.stdout ?? "{}") as {
      affected_criterion: { id: number; status: string };
      summary: Record<string, number>;
    };
    assert.equal(addedPayload.affected_criterion.status, "accepted");
    assert.equal(addedPayload.summary.accepted, 1);

    const duplicate = runTypescriptRuntimeCommand({
      args: [
        "criteria",
        "criteria-task",
        "--add",
        "--criterion",
        "CLI criteria mutations are durable.",
        "--source",
        "worker_proposed",
        "--status",
        "rejected",
        "--path",
        dbPath,
      ],
      env: {},
    });
    const duplicatePayload = JSON.parse(duplicate.stdout ?? "{}") as {
      affected_criterion: { id: number; status: string };
    };
    assert.equal(duplicatePayload.affected_criterion.id, addedPayload.affected_criterion.id);
    assert.equal(duplicatePayload.affected_criterion.status, "accepted");

    const rejected = runTypescriptRuntimeCommand({
      args: [
        "criteria",
        "criteria-task",
        "--reject",
        String(addedPayload.affected_criterion.id),
        "--proof",
        "The first proof was incomplete.",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(rejected.exitCode, 0);

    const reopened = runTypescriptRuntimeCommand({
      args: [
        "criteria",
        "criteria-task",
        "--accept",
        String(addedPayload.affected_criterion.id),
        "--rationale",
        "Reopened after stronger proof.",
        "--evidence-json",
        "{\"review\":\"complete\"}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(reopened.exitCode, 0);
    const listed = runTypescriptRuntimeCommand({
      args: ["criteria", "criteria-task", "--list", "--status", "accepted", "--path", dbPath],
      env: {},
    });
    const listedPayload = JSON.parse(listed.stdout ?? "{}") as {
      criteria: Array<{ evidence: Record<string, unknown>; rationale: string | null; status: string }>;
      summary: Record<string, number>;
    };
    assert.equal(listedPayload.criteria.length, 1);
    assert.deepEqual(listedPayload.criteria[0].evidence, { review: "complete" });
    assert.equal(listedPayload.criteria[0].rationale, "Reopened after stronger proof.");
    assert.equal(listedPayload.summary.accepted, 1);

    const eventRows = openDatabaseSync(dbPath);
    try {
      const events = eventRows.prepare("select type from events where task_id = ? and type like 'acceptance_criterion_%' order by id")
        .all("task-criteria") as Array<{ type: string }>;
      assert.deepEqual(events.map((row) => row.type), [
        "acceptance_criterion_added",
        "acceptance_criterion_updated",
        "acceptance_criterion_updated",
      ]);
    } finally {
      eventRows.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime criteria-plan suggests add commands without mutating criteria", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-criteria-plan."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Plan criteria.",
        name: "plan-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-plan",
      });
    } finally {
      database.close();
    }
    const result = runTypescriptRuntimeCommand({
      args: [
        "criteria-plan",
        "plan-task",
        "--from-text",
        "Must-have:\n- Unit tests pass\nFollow-up:\n- Browser QA",
        "--json",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      suggestions: Array<{ classification: null; command: string[]; criterion: string; rationale: string | null; status: string }>;
      warnings: string[];
    };
    assert.deepEqual(payload.warnings, []);
    assert.equal(payload.suggestions[0].criterion, "Unit tests pass");
    assert.equal(payload.suggestions[0].classification, null);
    assert.equal(payload.suggestions[0].status, "accepted");
    assert.deepEqual(payload.suggestions[0].command.slice(0, 6), [
      "conveyor",
      "criteria",
      "plan-task",
      "--add",
      "--criterion",
      "Unit tests pass",
    ]);
    assert.equal(payload.suggestions[1].status, "deferred");
    assert.equal(payload.suggestions[1].rationale, "Follow-up after this QA slice.");

    const closeout = runTypescriptRuntimeCommand({
      args: [
        "criteria-plan",
        "plan-task",
        "--from-text",
        "Must-have:\n- finish-task --require-criteria-audit marks the task done\n- Unit tests pass",
        "--json",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(closeout.exitCode, 0, closeout.stderr);
    const closeoutPayload = JSON.parse(closeout.stdout ?? "{}") as {
      suggestions: Array<{ classification: { kind: string; recommendation: string } | null; command: string[]; criterion: string; status: string }>;
      warnings: string[];
    };
    assert.equal(closeoutPayload.suggestions[0].status, "accepted");
    assert.equal(closeoutPayload.suggestions[0].classification?.kind, "manager_closeout_proof");
    assert.equal(closeoutPayload.suggestions[0].classification?.recommendation, "keep_out_of_acceptance_criteria");
    assert.ok(closeoutPayload.suggestions[0].command.includes("finish-task --require-criteria-audit marks the task done"));
    assert.match(closeoutPayload.warnings.join("\n"), /manager closeout\/control-plane proof/);
    assert.match(closeoutPayload.warnings.join("\n"), /unless this task is explicitly Conveyor closeout QA/);

    const after = openDatabaseSync(dbPath);
    try {
      const criteria = after.prepare("select count(*) as count from acceptance_criteria where task_id = ?")
        .get("task-plan") as { count: number };
      assert.equal(criteria.count, 0);
    } finally {
      after.close();
    }

    withTemporaryHome((homeRoot) => {
      const homeDbPath = join(homeRoot, "workerctl.db");
      const responsePath = join(homeRoot, "response.md");
      const homeDatabase = openDatabaseSync(homeDbPath);
      try {
        initializeDatabaseSync(homeDatabase);
        createTaskSync(homeDatabase, {
          goal: "Plan criteria from a home-relative file.",
          name: "home-plan-task",
          now: "2026-05-23T10:00:00Z",
          taskId: "task-home-plan",
        });
      } finally {
        homeDatabase.close();
      }
      writeFileSync(responsePath, "Must-have:\n- Home response file is readable\n");
      const fromFile = runTypescriptRuntimeCommand({
        args: [
          "criteria-plan",
          "home-plan-task",
          "--from-worker-response",
          tildePath(responsePath),
          "--json",
          "--path",
          tildePath(homeDbPath),
        ],
        env: {},
      });
      assert.equal(fromFile.exitCode, 0, fromFile.stderr);
      const fromFilePayload = JSON.parse(fromFile.stdout ?? "{}") as {
        suggestions: Array<{ command: string[]; criterion: string }>;
      };
      assert.equal(fromFilePayload.suggestions[0].criterion, "Home response file is readable");
      assert.deepEqual(fromFilePayload.suggestions[0].command.slice(-2), ["--path", homeDbPath]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles telemetry runs create list show and finish by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-runs."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "runs-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-runs",
      });
    } finally {
      database.close();
    }
    const dryRunCreate = runTypescriptRuntimeCommand({
      args: ["runs", "--create", "runs-task", "--dry-run", "--path", dbPath],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(dryRunCreate.exitCode, 2);
    assert.match(dryRunCreate.stderr ?? "", /Unsupported TypeScript runtime option for runs/);
    const afterDryRun = openDatabaseSync(dbPath);
    try {
      const runs = afterDryRun.prepare("select count(*) as count from runs where task_id = ?")
        .get("task-runs") as { count: number };
      assert.equal(runs.count, 0);
    } finally {
      afterDryRun.close();
    }

    const created = runTypescriptRuntimeCommand({
      args: [
        "runs",
        "--create",
        "runs-task",
        "--name",
        "qa-smoke",
        "--purpose",
        "qa",
        "--metadata-json",
        "{\"suite\":\"smoke\"}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(created.exitCode, 0);
    const createdPayload = JSON.parse(created.stdout ?? "{}") as {
      id: string;
      metadata: Record<string, unknown>;
      name: string;
      status: string;
    };
    assert.equal(createdPayload.name, "qa-smoke");
    assert.equal(createdPayload.status, "active");
    assert.deepEqual(createdPayload.metadata, { suite: "smoke" });

    const listed = runTypescriptRuntimeCommand({
      args: ["runs", "--list", "--task", "runs-task", "--status", "active", "--path", dbPath],
      env: {},
    });
    const listPayload = JSON.parse(listed.stdout ?? "[]") as Array<{ id: string }>;
    assert.deepEqual(listPayload.map((run) => run.id), [createdPayload.id]);

    const shown = runTypescriptRuntimeCommand({
      args: ["runs", "--show", "qa-smoke", "--path", dbPath],
      env: {},
    });
    assert.equal((JSON.parse(shown.stdout ?? "{}") as { id: string }).id, createdPayload.id);

    const policyRun = runTypescriptRuntimeCommand({
      args: [
        "runs",
        "--create",
        "runs-task",
        "--purpose",
        "ralph_loop",
        "--metadata-json",
        "{\"kind\":\"ralph_loop\",\"max_iterations\":2,\"current_iteration\":1,\"required_before_continue\":[\"ci_green\"],\"stop_conditions\":[\"max_iterations\"]}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(policyRun.exitCode, 0, policyRun.stderr);
    const policyPayload = JSON.parse(policyRun.stdout ?? "{}") as {
      metadata: Record<string, unknown>;
      name: string;
      purpose: string;
      status: string;
    };
    assert.equal(policyPayload.purpose, "ralph_loop");
    assert.equal(policyPayload.status, "finished");
    assert.match(policyPayload.name, /^runs-task-ralph-loop-/);
    assert.equal(policyPayload.metadata.cleanup_policy, null);
    assert.equal(policyPayload.metadata.current_iteration, 1);
    assert.deepEqual(policyPayload.metadata.required_before_continue, ["ci_green"]);

    const finished = runTypescriptRuntimeCommand({
      args: ["runs", "--finish", "qa-smoke", "--status", "failed", "--path", dbPath],
      env: {},
    });
    const finishedPayload = JSON.parse(finished.stdout ?? "{}") as { ended_at: string | null; status: string };
    assert.equal(finishedPayload.status, "failed");
    assert.ok(finishedPayload.ended_at);

    const after = openDatabaseSync(dbPath);
    try {
      const telemetry = after.prepare("select event_type, severity from telemetry_events where run_id = ?")
        .get(createdPayload.id) as { event_type: string; severity: string };
      assert.equal(telemetry.event_type, "run_finished");
      assert.equal(telemetry.severity, "error");
    } finally {
      after.close();
    }

    const badListStatus = runTypescriptRuntimeCommand({
      args: ["runs", "--list", "--status", "finihsed", "--path", dbPath],
      env: {},
    });
    assert.equal(badListStatus.exitCode, 2);
    assert.match(badListStatus.stderr ?? "", /invalid run status: finihsed/);

    const badMaxIterations = runTypescriptRuntimeCommand({
      args: [
        "runs",
        "--create",
        "runs-task",
        "--purpose",
        "ralph_loop",
        "--metadata-json",
        "{\"max_iterations\":0}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(badMaxIterations.exitCode, 2);
    assert.match(badMaxIterations.stderr ?? "", /max_iterations must be at least 1/);

    const badRequiredEvidence = runTypescriptRuntimeCommand({
      args: [
        "runs",
        "--create",
        "runs-task",
        "--purpose",
        "ralph_loop",
        "--metadata-json",
        "{\"max_iterations\":1,\"required_before_continue\":[123]}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(badRequiredEvidence.exitCode, 2);
    assert.match(badRequiredEvidence.stderr ?? "", /required_before_continue entries must be non-empty strings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles loop evidence add adversarial and visual diff by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-loop-evidence."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Record loop evidence.",
        name: "loop-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-loop-cli",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green", "adversarial_check", "visual_diff_report", "diff_below_threshold"],
        runId: "run-loop-cli",
        taskId: "task-loop-cli",
      });
      createTaskSync(database, {
        goal: "Host a colliding run name.",
        name: "loop-shadow-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-loop-shadow",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: [],
        runId: "run-loop-shadow",
        runName: "run-loop-cli",
        startedAt: "2026-05-23T10:01:45Z",
        taskId: "task-loop-shadow",
      });
    } finally {
      database.close();
    }

    const dryRunEvidence = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "add",
        "loop-task",
        "--loop-run",
        "run-loop-cli",
        "--iteration",
        "1",
        "--evidence-type",
        "dry_run_rejected",
        "--dry-run",
        "--path",
        dbPath,
      ],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(dryRunEvidence.exitCode, 2);
    assert.match(dryRunEvidence.stderr ?? "", /Unsupported TypeScript runtime option for loop-evidence/);
    const afterDryRun = openDatabaseSync(dbPath);
    try {
      const criteria = afterDryRun.prepare("select count(*) as count from acceptance_criteria where task_id = ?")
        .get("task-loop-cli") as { count: number };
      assert.equal(criteria.count, 0);
    } finally {
      afterDryRun.close();
    }

    const generic = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "add",
        "loop-task",
        "--loop-run",
        "task-loop-cli-ralph-loop",
        "--iteration",
        "1",
        "--evidence-type",
        "ci_green",
        "--metadata-json",
        "{\"suite\":\"unit\"}",
        "--proof",
        "CI is green.",
        "--artifact-path",
        "/tmp/ci.json",
        "--correlation-id",
        "corr-ci",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(generic.exitCode, 0);
    const genericPayload = JSON.parse(generic.stdout ?? "{}") as {
      criterion: { status: string };
      evidence: Record<string, unknown>;
    };
    assert.equal(genericPayload.criterion.status, "satisfied");
    assert.equal(genericPayload.evidence.artifact_path, "/tmp/ci.json");
    assert.equal(genericPayload.evidence.correlation_id, "corr-ci");

    const exactIdOverShadowName = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "add",
        "loop-task",
        "--loop-run",
        "run-loop-cli",
        "--iteration",
        "1",
        "--evidence-type",
        "exact_id_wins",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(exactIdOverShadowName.exitCode, 0);
    const exactIdPayload = JSON.parse(exactIdOverShadowName.stdout ?? "{}") as {
      run: { id: string; task_id: string };
    };
    assert.equal(exactIdPayload.run.id, "run-loop-cli");
    assert.equal(exactIdPayload.run.task_id, "task-loop-cli");

    const buildPassed = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "build-passed",
        "loop-task",
        "--loop-run",
        "run-loop-cli",
        "--iteration",
        "1",
        "--proof",
        "Focused build command passed.",
        "--artifact-path",
        "/tmp/build-passed.json",
        "--correlation-id",
        "corr-build",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(buildPassed.exitCode, 0);
    const buildPayload = JSON.parse(buildPassed.stdout ?? "{}") as {
      criterion: { status: string };
      evidence: Record<string, unknown>;
    };
    assert.equal(buildPayload.criterion.status, "satisfied");
    assert.equal(buildPayload.evidence.evidence_type, "build_passed");
    assert.equal(buildPayload.evidence.artifact_path, "/tmp/build-passed.json");
    assert.equal(buildPayload.evidence.correlation_id, "corr-build");

    const conflictingBuildPassed = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "build-passed",
        "loop-task",
        "--loop-run",
        "run-loop-cli",
        "--iteration",
        "1",
        "--evidence-type",
        "ci_green",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(conflictingBuildPassed.exitCode, 2);
    assert.match(conflictingBuildPassed.stderr ?? "", /records evidence_type=build_passed/);

    const weak = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "adversarial-check",
        "loop-task",
        "--loop-run",
        "run-loop-cli",
        "--iteration",
        "1",
        "--check",
        "No failure mode.",
        "--result",
        "Rejected.",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(weak.exitCode, 2);
    assert.match(weak.stderr ?? "", /--failure-mode must be non-empty/);

    const adversarial = runTypescriptRuntimeCommand({
      args: [
        "loop-evidence",
        "adversarial-check",
        "loop-task",
        "--loop-run",
        "run-loop-cli",
        "--iteration",
        "1",
        "--failure-mode",
        "Generic text could fake proof.",
        "--check",
        "Inspect structured receipt fields.",
        "--result",
        "Receipt has failure_mode, check, and result.",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(adversarial.exitCode, 0);

    withTemporaryHome((homeRoot) => {
      const reference = join(homeRoot, "reference.png");
      const candidate = join(homeRoot, "candidate.png");
      const diff = join(homeRoot, "diff.png");
      const report = join(homeRoot, "report.json");
      writePngRgba(reference, 2, 1, [[255, 0, 0, 255], [0, 255, 0, 255]]);
      writePngRgba(candidate, 2, 1, [[255, 0, 0, 255], [0, 0, 255, 255]]);
      const visual = runTypescriptRuntimeCommand({
        args: [
          "loop-evidence",
          "visual-diff",
          "loop-task",
          "--loop-run",
          "run-loop-cli",
          "--iteration",
          "1",
          "--reference",
          tildePath(reference),
          "--candidate",
          tildePath(candidate),
          "--threshold",
          "0.6",
          "--diff-output",
          tildePath(diff),
          "--report-output",
          tildePath(report),
          "--path",
          dbPath,
        ],
        env: {},
      });
      assert.equal(visual.exitCode, 0);
      const visualPayload = JSON.parse(visual.stdout ?? "{}") as {
        diff: { below_threshold: boolean; diff_score: number; reference: string; candidate: string };
        threshold_criterion: { status: string };
      };
      assert.equal(visualPayload.diff.reference, reference);
      assert.equal(visualPayload.diff.candidate, candidate);
      assert.equal(visualPayload.diff.diff_score, 0.5);
      assert.equal(visualPayload.diff.below_threshold, true);
      assert.equal(visualPayload.threshold_criterion.status, "satisfied");
      assert.equal(existsSync(diff), true);
      assert.equal(existsSync(report), true);

      const visualWithIgnoredStatus = runTypescriptRuntimeCommand({
        args: [
          "loop-evidence",
          "visual-diff",
          "loop-task",
          "--loop-run",
          "run-loop-cli",
          "--iteration",
          "1",
          "--reference",
          tildePath(reference),
          "--candidate",
          tildePath(candidate),
          "--threshold",
          "0.6",
          "--status",
          "fail",
          "--path",
          dbPath,
        ],
        env: {},
      });
      assert.equal(visualWithIgnoredStatus.exitCode, 2);
      assert.match(visualWithIgnoredStatus.stderr ?? "", /visual-diff does not support --status/);
    });

    const after = openDatabaseSync(dbPath);
    try {
      const criteria = after.prepare(`
        select status, evidence_json
        from acceptance_criteria
        where task_id = ?
        order by id
      `).all("task-loop-cli") as Array<{ evidence_json: string; status: string }>;
      assert.deepEqual(
        criteria.map((criterion) => JSON.parse(criterion.evidence_json).evidence_type),
        ["ci_green", "exact_id_wins", "build_passed", "adversarial_check", "visual_diff_report", "diff_below_threshold"],
      );
      assert.deepEqual(criteria.map((criterion) => criterion.status), ["satisfied", "satisfied", "satisfied", "satisfied", "satisfied", "satisfied"]);
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles loop templates presets and triggers by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-loop-templates."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run visual template loop.",
        name: "visual-template-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-visual-template",
      });
    } finally {
      database.close();
    }

    const listTemplates = runTypescriptRuntimeCommand({
      args: ["loop-templates", "--list", "--json"],
      env: {},
    });
    assert.equal(listTemplates.exitCode, 0, listTemplates.stderr);
    const templateList = JSON.parse(listTemplates.stdout ?? "{}") as { templates: Array<{
      cleanup_policy: string;
      name: string;
      required_before_continue: string[];
    }> };
    const appVisibleTemplate = templateList.templates.find((template) => template.name === "app_visible_build_loop");
    assert.ok(appVisibleTemplate);
    assert.equal(appVisibleTemplate.cleanup_policy, "off");
    assert.deepEqual(appVisibleTemplate.required_before_continue, ["build_passed", "adversarial_check"]);
    assert.ok(templateList.templates.some((template) => template.name === "visual_diff_loop"));
    const shipItTemplate = templateList.templates.find((template) => template.name === "ship_it_loop");
    assert.ok(shipItTemplate);
    assert.deepEqual(shipItTemplate.required_before_continue, [
      "branch_ready",
      "branch_pushed",
      "pr_url",
      "ci_green",
      "mergeability_clean",
      "manager_merge_decision",
      "merge",
      "post_merge_verification",
      "adversarial_check",
    ]);

    const badListArg = runTypescriptRuntimeCommand({
      args: ["loop-templates", "--list", "extra", "--json"],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(badListArg.exitCode, 2);
    assert.match(badListArg.stderr ?? "", /Unexpected argument: extra/);

    const showTemplate = runTypescriptRuntimeCommand({
      args: ["loop-templates", "--show", "visual_diff_loop", "--json"],
      env: {},
    });
    const template = JSON.parse(showTemplate.stdout ?? "{}") as {
      artifact_requirements: Record<string, { type: string }>;
      description: string;
      required_before_continue: string[];
    };
    assert.match(template.description, /visual-diff passes/);
    assert.equal(template.artifact_requirements.diff_score.type, "number");
    assert.deepEqual(template.required_before_continue, [
      "reference_artifact",
      "candidate_screenshot",
      "visual_diff_report",
      "diff_below_threshold",
      "adversarial_check",
    ]);

    const rejectCreateOnly = runTypescriptRuntimeCommand({
      args: ["loop-templates", "--show", "visual_diff_loop", "--current-iteration", "1", "--json"],
      env: {},
    });
    assert.equal(rejectCreateOnly.exitCode, 2);
    assert.match(rejectCreateOnly.stderr ?? "", /--current-iteration is only valid with --create-run/);

    const dryRunCreate = runTypescriptRuntimeCommand({
      args: [
        "loop-templates",
        "--create-run",
        "visual-template-task",
        "--template",
        "visual_diff_loop",
        "--dry-run",
        "--path",
        dbPath,
      ],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(dryRunCreate.exitCode, 2);
    assert.match(dryRunCreate.stderr ?? "", /Unsupported TypeScript runtime option for loop-templates/);
    const afterDryRun = openDatabaseSync(dbPath);
    try {
      const runs = afterDryRun.prepare("select count(*) as count from runs where task_id = ?")
        .get("task-visual-template") as { count: number };
      assert.equal(runs.count, 0);
    } finally {
      afterDryRun.close();
    }

    const malformedCreate = runTypescriptRuntimeCommand({
      args: [
        "loop-templates",
        "--create-run",
        "visual-template-task",
        "--template",
        "visual_diff_loop",
        "extra",
        "--json",
        "--path",
        dbPath,
      ],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(malformedCreate.exitCode, 2);
    assert.match(malformedCreate.stderr ?? "", /Unexpected argument: extra/);
    const afterMalformedCreate = openDatabaseSync(dbPath);
    try {
      const runs = afterMalformedCreate.prepare("select count(*) as count from runs where task_id = ?")
        .get("task-visual-template") as { count: number };
      assert.equal(runs.count, 0);
    } finally {
      afterMalformedCreate.close();
    }

    const createTemplateRun = runTypescriptRuntimeCommand({
      args: [
        "loop-templates",
        "--create-run",
        "visual-template-task",
        "--template",
        "visual_diff_loop",
        "--name",
        "visual-policy",
        "--max-iterations",
        "4",
        "--current-iteration",
        "1",
        "--seed-prompt-sha256",
        "visual123",
        "--json",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(createTemplateRun.exitCode, 0, createTemplateRun.stderr);
    const createdTemplate = JSON.parse(createTemplateRun.stdout ?? "{}") as {
      metadata: Record<string, unknown>;
      purpose: string;
      status: string;
    };
    assert.equal(createdTemplate.purpose, "ralph_loop");
    assert.equal(createdTemplate.status, "finished");
    assert.equal(createdTemplate.metadata.template, "visual_diff_loop");
    assert.equal(createdTemplate.metadata.preset, "visual_diff_loop");
    assert.equal(createdTemplate.metadata.current_iteration, 1);
    assert.equal(createdTemplate.metadata.seed_prompt_sha256, "visual123");

    const createPresetRun = runTypescriptRuntimeCommand({
      args: [
        "ralph-loop-presets",
        "--create-run",
        "visual-template-task",
        "--preset",
        "pr_ci_merge_loop",
        "--name",
        "preset-policy",
        "--max-iterations",
        "3",
        "--json",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(createPresetRun.exitCode, 0, createPresetRun.stderr);
    const createdPreset = JSON.parse(createPresetRun.stdout ?? "{}") as { metadata: Record<string, unknown> };
    assert.equal(createdPreset.metadata.preset, "pr_ci_merge_loop");
    assert.equal(createdPreset.metadata.current_iteration, 0);
    assert.deepEqual(createdPreset.metadata.required_before_continue, ["pr_url", "ci_green", "merge", "adversarial_check"]);

    const badPreset = runTypescriptRuntimeCommand({
      args: ["ralph-loop-presets", "--show", "nope", "--json"],
      env: {},
    });
    assert.equal(badPreset.exitCode, 2);
    assert.match(badPreset.stderr ?? "", /Unknown Ralph loop preset: nope/);

    const classify = runTypescriptRuntimeCommand({
      args: ["loop-triggers", "--classify", "Run this as an adversarial gated Ralph loop.", "--json"],
      env: {},
    });
    const classified = JSON.parse(classify.stdout ?? "{}") as {
      matched: boolean;
      matched_trigger: { name: string; operator_actions: string[]; required_before_continue: string[] };
    };
    assert.equal(classified.matched, true);
    assert.equal(classified.matched_trigger.name, "loop-gate-trigger");
    assert.deepEqual(classified.matched_trigger.required_before_continue, ["adversarial_check"]);
    assert.ok(classified.matched_trigger.operator_actions.some((action) => action.includes("loop-templates --create-run")));

    const negative = runTypescriptRuntimeCommand({
      args: ["loop-triggers", "--classify", "Please be careful, run tests, and summarize risks.", "--json"],
      env: {},
    });
    const negativePayload = JSON.parse(negative.stdout ?? "{}") as { guidance: string; matched: boolean };
    assert.equal(negativePayload.matched, false);
    assert.match(negativePayload.guidance, /No approved loop trigger matched/);

    const badTriggerArg = runTypescriptRuntimeCommand({
      args: ["loop-triggers", "--classify", "Run this as an adversarial gated Ralph loop.", "extra", "--json"],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(badTriggerArg.exitCode, 2);
    assert.match(badTriggerArg.stderr ?? "", /Unexpected argument: extra/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles qa-plan by default", () => {
  const selfManagement = runTypescriptRuntimeCommand({
    args: ["qa-plan", "self-management", "--json"],
    env: {},
  });
  assert.equal(selfManagement.exitCode, 0, selfManagement.stderr);
  assert.equal(selfManagement.handled, true);
  const selfPlan = JSON.parse(selfManagement.stdout ?? "{}") as {
    expected_observations: string[];
    scenario: string;
    steps: string[];
  };
  assert.equal(selfPlan.scenario, "self-management");
  assert.ok(selfPlan.steps.some((step) => step.includes("register-worker")));
  assert.ok(selfPlan.steps.some((step) => step.includes("conveyor cycle")));
  assert.ok(selfPlan.expected_observations.some((observation) => observation.includes("pane_signal")));

  const adversarial = runTypescriptRuntimeCommand({
    args: ["qa-plan", "adversarial-triggers", "--json"],
    env: {},
  });
  assert.equal(adversarial.exitCode, 0, adversarial.stderr);
  const adversarialPlan = JSON.parse(adversarial.stdout ?? "{}") as {
    correlation_markers: Array<{ correlation_id: string }>;
    trigger_tasks: Array<{ name: string }>;
  };
  assert.ok(adversarialPlan.trigger_tasks.some((trigger) => trigger.name === "loop-gate-trigger"));
  assert.ok(adversarialPlan.correlation_markers.some((marker) => marker.correlation_id === "nl-loop-gate-policy"));

  const goalbuddyText = runTypescriptRuntimeCommand({
    args: ["qa-plan", "goalbuddy-conveyor"],
    env: {},
  });
  assert.equal(goalbuddyText.exitCode, 0, goalbuddyText.stderr);
  assert.match(goalbuddyText.stdout ?? "", /Starter prompt:/);
  assert.match(goalbuddyText.stdout ?? "", /Authority boundaries:/);
  assert.match(goalbuddyText.stdout ?? "", /Correlation markers:/);

  const extraArg = runTypescriptRuntimeCommand({
    args: ["qa-plan", "self-management", "extra", "--json"],
    env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
  });
  assert.equal(extraArg.exitCode, 2);
  assert.match(extraArg.stderr ?? "", /Unexpected argument: extra/);
});

test("TypeScript runtime qa-run writes deterministic receipts and rejects dirty continue queues by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-qa-run."));
  try {
    const runScenario = (scenario: string) => {
      const scenarioRoot = join(root, scenario);
      mkdirSync(scenarioRoot, { recursive: true });
      const dbPath = join(scenarioRoot, "workerctl.db");
      const receiptPath = join(scenarioRoot, "receipt.json");
      const result = runTypescriptRuntimeCommand({
        args: [
          "qa-run",
          scenario,
          "--receipt-output",
          receiptPath,
          "--path",
          dbPath,
          "--dispatcher-id",
          `qa-${scenario}`,
          "--json",
        ],
        env: {},
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const summary = JSON.parse(result.stdout ?? "{}") as { checks: number; receipt_path: string; result: string; scenario: string };
      assert.equal(summary.scenario, scenario);
      assert.equal(summary.result, "passed");
      assert.equal(summary.receipt_path, receiptPath);
      assert.equal(existsSync(receiptPath), true);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        artifacts: Record<string, string>;
        checks: Array<Record<string, unknown>>;
        generated_tasks?: Array<{
          binding_id?: string | null;
          manager_id?: string | null;
          manager_name?: string | null;
          suffix: string;
          worker_id?: string | null;
          worker_name?: string | null;
        }>;
        negative_control?: { matched: boolean };
        result: string;
        scenario: string;
        template?: string;
        trigger_classifications?: Array<{ matched: boolean; name: string }>;
        visual_diff?: Record<string, unknown>;
      };
      assert.equal(receipt.result, "passed");
      assert.equal(receipt.scenario, scenario);
      assert.equal(receipt.checks.length, summary.checks);
      return { receipt, receiptPath };
    };
    const checkByName = (receipt: { checks: Array<Record<string, unknown>> }, name: string) => {
      const check = receipt.checks.find((candidate) => candidate.name === name);
      assert.ok(check, `missing qa-run check: ${name}`);
      return check;
    };

    const ralph = runScenario("ralph-loop-guardrails").receipt;
    const maxBlock = checkByName(ralph, "max_iteration_blocks_before_worker_delivery");
    assert.equal((maxBlock.dispatch as Record<string, unknown>).state, "blocked");
    assert.equal((maxBlock.dispatch as Record<string, unknown>).reason, "max_iterations_reached");
    assert.equal(maxBlock.worker_inbox_count, 0);
    const missingEvidence = checkByName(ralph, "missing_evidence_blocks_before_worker_delivery");
    assert.deepEqual((missingEvidence.dispatch as Record<string, unknown>).missing_evidence, ["ci_green", "adversarial_check"]);
    const allowedEvidence = checkByName(ralph, "fresh_retry_delivers_after_structured_evidence");
    assert.equal((allowedEvidence.dispatch as Record<string, unknown>).state, "pull_required");
    assert.equal(allowedEvidence.worker_inbox_count, 1);
    const presetBlock = checkByName(ralph, "preset_requires_pr_ci_merge_and_adversarial_evidence");
    assert.deepEqual((presetBlock.dispatch as Record<string, unknown>).missing_evidence, ["pr_url", "ci_green", "merge", "adversarial_check"]);

    const generic = runScenario("generic-loop-template").receipt;
    assert.equal(generic.template, "visual_diff_loop");
    assert.equal(existsSync(generic.artifacts.reference_artifact), true);
    assert.equal(existsSync(generic.artifacts.candidate_screenshot), true);
    assert.equal(existsSync(generic.artifacts.diff), true);
    assert.equal(generic.visual_diff?.below_threshold, true);
    const genericMissing = checkByName(generic, "visual_template_blocks_before_visual_evidence");
    assert.deepEqual((genericMissing.dispatch as Record<string, unknown>).missing_evidence, [
      "reference_artifact",
      "candidate_screenshot",
      "visual_diff_report",
      "diff_below_threshold",
      "adversarial_check",
    ]);
    const genericUnstructured = checkByName(generic, "unstructured_adversarial_check_still_blocks");
    assert.equal((genericUnstructured.dispatch as Record<string, unknown>).reason, "missing_adversarial_check_evidence");
    const genericAllowed = checkByName(generic, "structured_visual_evidence_retry_delivers");
    assert.equal(genericAllowed.worker_inbox_count, 1);

    const buildClear = runScenario("build-clear-loop").receipt;
    assert.equal(buildClear.template, "build_then_clear");
    assert.equal(existsSync(buildClear.artifacts.build_receipt), true);
    assert.equal(existsSync(buildClear.artifacts.cleanup_receipt), true);
    const buildOnly = checkByName(buildClear, "build_clear_still_blocks_before_cleanup_evidence");
    assert.equal((buildOnly.dispatch as Record<string, unknown>).reason, "missing_cleanup_evidence");
    assert.deepEqual((buildOnly.dispatch as Record<string, unknown>).missing_evidence, ["cleanup"]);
    const buildAllowed = checkByName(buildClear, "build_clear_retry_delivers_after_build_and_cleanup_evidence");
    assert.equal(buildAllowed.worker_inbox_count, 1);

    const shipIt = runScenario("ship-it-loop").receipt;
    assert.equal(shipIt.template, "ship_it_loop");
    assert.equal(existsSync(shipIt.artifacts.conflict_receipt), true);
    const pushDenied = checkByName(shipIt, "ship_it_push_branch_requires_repo_push_branch");
    assert.equal((pushDenied.dispatch as Record<string, unknown>).state, "failed");
    const pushAllowed = checkByName(shipIt, "ship_it_push_branch_delivers_after_permission");
    assert.equal(pushAllowed.worker_inbox_count, 1);
    const prDenied = checkByName(shipIt, "ship_it_open_pr_requires_repo_open_pr");
    assert.equal((prDenied.dispatch as Record<string, unknown>).state, "failed");
    const mergeDenied = checkByName(shipIt, "ship_it_merge_requires_repo_merge_green_pr");
    assert.equal((mergeDenied.dispatch as Record<string, unknown>).state, "failed");
    const lifecycleMissing = checkByName(shipIt, "ship_it_lifecycle_blocks_before_any_evidence");
    assert.deepEqual((lifecycleMissing.dispatch as Record<string, unknown>).missing_evidence, [
      "branch_ready",
      "branch_pushed",
      "pr_url",
      "ci_green",
      "mergeability_clean",
      "manager_merge_decision",
      "merge",
      "post_merge_verification",
      "adversarial_check",
    ]);
    const partialShipIt = checkByName(shipIt, "ship_it_lifecycle_blocks_before_mergeability_and_manager_decision");
    assert.deepEqual((partialShipIt.dispatch as Record<string, unknown>).missing_evidence, [
      "mergeability_clean",
      "manager_merge_decision",
      "merge",
      "post_merge_verification",
      "adversarial_check",
    ]);
    assert.equal(checkByName(shipIt, "ship_it_conflict_retry_blocks_after_limit").status, "passed");
    const shipItAllowed = checkByName(shipIt, "ship_it_lifecycle_retry_delivers_after_all_evidence");
    assert.equal(shipItAllowed.worker_inbox_count, 1);

    const adversarial = runScenario("adversarial-triggers").receipt;
    assert.equal(adversarial.negative_control?.matched, false);
    assert.ok(adversarial.trigger_classifications?.some((trigger) => trigger.name === "loop-gate-trigger" && trigger.matched));
    const finishTask = adversarial.generated_tasks?.find((task) => task.suffix === "adversarial-triggers-finish");
    assert.ok(finishTask);
    assert.equal(finishTask.binding_id, null);
    assert.equal(finishTask.worker_id, null);
    assert.equal(finishTask.worker_name, null);
    assert.equal(finishTask.manager_id, null);
    assert.equal(finishTask.manager_name, null);
    const adversarialMissing = checkByName(adversarial, "iteration_gate_blocks_before_adversarial_proof");
    assert.equal((adversarialMissing.dispatch as Record<string, unknown>).reason, "missing_adversarial_check_evidence");
    const adversarialAllowed = checkByName(adversarial, "iteration_gate_allows_fresh_retry_after_structured_proof");
    assert.equal(adversarialAllowed.worker_inbox_count, 1);
    assert.ok(adversarialAllowed.worker_inbox);
    assert.equal(checkByName(adversarial, "worker_directed_trigger_records_worker_proposed_proof").status, "passed");
    assert.equal(checkByName(adversarial, "acceptance_criteria_trigger_records_negative_manager_criteria").manager_inferred_criteria_count, 3);

    const dryRunDb = join(root, "qa-run-dry-run", "workerctl.db");
    const dryRunReceipt = join(root, "qa-run-dry-run", "receipt.json");
    const dryRun = runTypescriptRuntimeCommand({
      args: [
        "qa-run",
        "test-coverage-loop",
        "--receipt-output",
        dryRunReceipt,
        "--path",
        dryRunDb,
        "--dry-run",
        "--json",
      ],
      env: {},
    });
    assert.equal(dryRun.exitCode, 2);
    assert.match(dryRun.stderr ?? "", /Unsupported TypeScript runtime option for qa-run/);
    assert.equal(existsSync(dryRunReceipt), false);
    assert.equal(existsSync(dryRunDb), false);

    const dirtyRoot = join(root, "dirty-queue");
    mkdirSync(dirtyRoot, { recursive: true });
    const dirtyDb = join(dirtyRoot, "workerctl.db");
    const dirtyReceipt = join(dirtyRoot, "receipt.json");
    const database = openDatabaseSync(dirtyDb);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Dirty queue should block qa-run setup.",
        name: "dirty-queue-task",
        taskId: "task-dirty-queue",
      });
      createCommandSync(database, {
        commandId: "command-dirty-queue",
        commandType: "continue_iteration",
        correlationId: "dirty-queue",
        payload: { message: "leftover continue" },
        taskId: "task-dirty-queue",
      });
    } finally {
      database.close();
    }
    const dirty = runTypescriptRuntimeCommand({
      args: [
        "qa-run",
        "generic-loop-template",
        "--receipt-output",
        dirtyReceipt,
        "--path",
        dirtyDb,
        "--json",
      ],
      env: {},
    });
    assert.equal(dirty.exitCode, 2);
    assert.match(dirty.stderr ?? "", /continue_iteration dispatch queue is not clean/);
    assert.equal(existsSync(dirtyReceipt), false);
    const afterDirty = openDatabaseSync(dirtyDb);
    try {
      const row = afterDirty.prepare("select state from commands where id = ?").get("command-dirty-queue") as { state: string };
      assert.equal(row.state, "pending");
    } finally {
      afterDirty.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime loop-status scopes commands inbox telemetry and failures to the requested run", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-loop-status."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Inspect one loop run.",
        name: "loop-status-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-loop-status",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["adversarial_check"],
        runId: "run-loop-status-target",
        runName: "target-loop",
        taskId: "task-loop-status",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: [],
        runId: "run-loop-status-other",
        runName: "other-loop",
        taskId: "task-loop-status",
      });
      const targetCommand = createCommandSync(database, {
        commandId: "command-target-loop",
        commandType: "continue_iteration",
        correlationId: "target-command",
        payload: { loop_policy: { run_id: "run-loop-status-target" } },
        taskId: "task-loop-status",
      });
      database.prepare("update commands set state = 'succeeded', result_json = ? where id = ?")
        .run(JSON.stringify({ run_id: "run-loop-status-target" }), targetCommand);
      const otherCommand = createCommandSync(database, {
        commandId: "command-other-loop",
        commandType: "continue_iteration",
        correlationId: "other-command",
        payload: { loop_policy: { run_id: "run-loop-status-other" } },
        taskId: "task-loop-status",
      });
      database.prepare("update commands set state = 'failed', result_json = ?, error = 'other failed' where id = ?")
        .run(JSON.stringify({ run_id: "run-loop-status-other" }), otherCommand);

      database.prepare(`
        insert into sessions(id, name, role, identity_token, cwd, registered_at, state)
        values
          ('session-worker-loop-status', 'loop-status-worker', 'worker', 'token-worker-loop-status', '/repo', '2026-05-23T10:00:00Z', 'active'),
          ('session-manager-loop-status', 'loop-status-manager', 'manager', 'token-manager-loop-status', '/repo', '2026-05-23T10:00:00Z', 'active')
      `).run();
      database.prepare(`
        insert into bindings(id, task_id, worker_session_id, manager_session_id, state, created_at)
        values ('binding-loop-status', 'task-loop-status', 'session-worker-loop-status', 'session-manager-loop-status', 'active', '2026-05-23T10:00:00Z')
      `).run();
      for (let index = 0; index < 100; index += 1) {
        const minute = String(Math.floor(index / 60) + 1).padStart(2, "0");
        const second = String(index % 60).padStart(2, "0");
        database.prepare(`
          insert into routed_notifications(
            task_id, binding_id, correlation_id, source_session_id, target_session_id,
            signal_type, dedupe_key, created_at, state, payload_json, delivery_mode
          )
          values (?, ?, ?, ?, ?, 'continue_iteration', ?, ?, 'delivered', ?, 'pull_required')
        `).run(
          "task-loop-status",
          "binding-loop-status",
          `other-inbox-${index}`,
          "session-manager-loop-status",
          "session-worker-loop-status",
          `other-inbox-${index}`,
          `2026-05-23T10:${minute}:${second}Z`,
          JSON.stringify({ ralph_loop: { run_id: "run-loop-status-other" } }),
        );
      }
      database.prepare(`
        insert into routed_notifications(
          task_id, binding_id, correlation_id, source_session_id, target_session_id,
          signal_type, dedupe_key, created_at, state, payload_json, delivery_mode
        )
        values (?, ?, ?, ?, ?, 'continue_iteration', ?, ?, 'delivered', ?, 'pull_required')
      `).run(
        "task-loop-status",
        "binding-loop-status",
        "target-inbox",
        "session-manager-loop-status",
        "session-worker-loop-status",
        "target-inbox",
        "2026-05-23T10:03:00Z",
        JSON.stringify({ ralph_loop: { run_id: "run-loop-status-target" } }),
      );
      for (let index = 0; index < 1005; index += 1) {
        const minute = String(Math.floor(index / 60)).padStart(2, "0");
        const second = String(index % 60).padStart(2, "0");
        database.prepare(`
          insert into telemetry_events(
            id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json
          )
          values (?, 'run-loop-status-other', 'task-loop-status', ?, 'manager', 'manager_cycle_succeeded', 'info', ?, '{}', '{}')
        `).run(`telemetry-other-${index}`, `2026-05-23T09:${minute}:${second}Z`, `Other event ${index}.`);
      }
      database.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json
        )
        values ('telemetry-target-consumed', 'run-loop-status-target', 'task-loop-status', '2026-05-23T11:00:00Z', 'dispatch', 'dispatch_inbox_consumed', 'info', 'Target consumed.', '{}', '{}')
      `).run();
    } finally {
      database.close();
    }

    const before = runTypescriptRuntimeCommand({
      args: ["loop-status", "loop-status-task", "--run", "target-loop", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(before.exitCode, 0, before.stderr);
    const beforePayload = JSON.parse(before.stdout ?? "{}") as {
      commands: { states: Record<string, number> };
      failures: { failed_commands: number };
      inbox: { worker_unconsumed: number };
      recommendation: string;
      telemetry: { by_event_type: Record<string, number>; dispatch_inbox_consumed: number };
    };
    assert.deepEqual(beforePayload.commands.states, { succeeded: 1 });
    assert.equal(beforePayload.failures.failed_commands, 0);
    assert.equal(beforePayload.inbox.worker_unconsumed, 1);
    assert.equal(beforePayload.telemetry.dispatch_inbox_consumed, 1);
    assert.deepEqual(beforePayload.telemetry.by_event_type, { dispatch_inbox_consumed: 1 });
    assert.equal(beforePayload.recommendation, "worker_should_consume_inbox");

    const badStatusOption = runTypescriptRuntimeCommand({
      args: ["loop-status", "loop-status-task", "--run", "target-loop", "--name", "ignored", "--path", dbPath, "--json"],
      env: { AGENT_CONVEYOR_TS_RUNTIME: "1" },
    });
    assert.equal(badStatusOption.exitCode, 2);
    assert.match(badStatusOption.stderr ?? "", /Unsupported TypeScript runtime option for loop-status/);

    const afterConsumeDb = openDatabaseSync(dbPath);
    try {
      afterConsumeDb.prepare("update routed_notifications set consumed_at = '2026-05-23T11:01:00Z' where correlation_id = 'target-inbox'").run();
    } finally {
      afterConsumeDb.close();
    }
    const afterConsume = runTypescriptRuntimeCommand({
      args: ["loop-status", "loop-status-task", "--run", "run-loop-status-target", "--path", dbPath, "--json"],
      env: {},
    });
    const afterConsumePayload = JSON.parse(afterConsume.stdout ?? "{}") as {
      inbox: { worker_unconsumed: number };
      recommendation: string;
    };
    assert.equal(afterConsumePayload.inbox.worker_unconsumed, 0);
    assert.equal(afterConsumePayload.recommendation, "ready_for_manager_review");

    const openCriteriaDb = openDatabaseSync(dbPath);
    try {
      openCriteriaDb.prepare(`
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
        )
        values (
          'task-loop-status',
          'Target run accepted criterion still open.',
          'accepted',
          'user_requested',
          null,
          null,
          ?,
          '2026-05-23T11:01:10Z',
          '2026-05-23T11:01:10Z'
        )
      `).run(JSON.stringify({ evidence_type: "manual_review", ralph_loop_run_id: "run-loop-status-target" }));
      openCriteriaDb.prepare(`
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
        )
        values (
          'task-loop-status',
          'Other run accepted criterion still open.',
          'accepted',
          'user_requested',
          null,
          null,
          ?,
          '2026-05-23T11:01:11Z',
          '2026-05-23T11:01:11Z'
        )
      `).run(JSON.stringify({ evidence_type: "manual_review", ralph_loop_run_id: "run-loop-status-other" }));
      openCriteriaDb.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json
        )
        values (
          'telemetry-target-ingest-warning',
          'run-loop-status-target',
          'task-loop-status',
          '2026-05-23T11:01:12Z',
          'workerctl',
          'codex_ingest_failed',
          'warning',
          'Target ingest warning.',
          '{}',
          ?
        )
      `).run(JSON.stringify({ error: "bad rollout chunk" }));
      openCriteriaDb.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json
        )
        values (
          'telemetry-other-ingest-warning',
          'run-loop-status-other',
          'task-loop-status',
          '2026-05-23T11:01:13Z',
          'workerctl',
          'codex_ingest_failed',
          'warning',
          'Other ingest warning.',
          '{}',
          ?
        )
      `).run(JSON.stringify({ error: "other bad rollout chunk" }));
    } finally {
      openCriteriaDb.close();
    }
    const afterOpenCriteria = runTypescriptRuntimeCommand({
      args: ["loop-status", "loop-status-task", "--run", "run-loop-status-target", "--path", dbPath, "--json"],
      env: {},
    });
    const openCriteriaPayload = JSON.parse(afterOpenCriteria.stdout ?? "{}") as {
      failures: { alerts: number; ingest_errors: number; open_accepted_criteria: number };
      recommendation: string;
    };
    assert.equal(openCriteriaPayload.failures.ingest_errors, 1);
    assert.equal(openCriteriaPayload.failures.open_accepted_criteria, 1);
    assert.equal(openCriteriaPayload.failures.alerts, 2);
    assert.equal(openCriteriaPayload.recommendation, "inspect_failures");

    const failureDb = openDatabaseSync(dbPath);
    try {
      failureDb.prepare(`
        insert into manager_cycles(id, task_id, started_at, completed_at, state, status_json, health_json, error)
        values (101, 'task-loop-status', '2026-05-23T11:02:00Z', '2026-05-23T11:02:05Z', 'failed', ?, '{}', 'target capture failed')
      `).run(JSON.stringify({ kind: "session_cycle", pane_signal: { captured: false, reason: "target capture failed" } }));
      failureDb.prepare(`
        insert into manager_cycle_spans(
          manager_cycle_id, task_id, run_id, phase, started_at, completed_at,
          duration_ms, state, attributes_json, error_type
        )
        values (101, 'task-loop-status', 'run-loop-status-target', 'capture_pane_signal', '2026-05-23T11:02:00Z', '2026-05-23T11:02:05Z', 5000.0, 'succeeded', '{}', null)
      `).run();
    } finally {
      failureDb.close();
    }
    const afterFailure = runTypescriptRuntimeCommand({
      args: ["loop-status", "loop-status-task", "--run", "run-loop-status-target", "--path", dbPath, "--json"],
      env: {},
    });
    const failurePayload = JSON.parse(afterFailure.stdout ?? "{}") as {
      failures: { failed_cycles: number; pane_capture_failures: number };
      recommendation: string;
    };
    assert.equal(failurePayload.failures.failed_cycles, 1);
    assert.equal(failurePayload.failures.pane_capture_failures, 1);
    assert.equal(failurePayload.recommendation, "inspect_failures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles bind and unbind by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-bind."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Bind worker and manager.",
        name: "bind-task",
        now: "2026-05-23T11:00:00Z",
        taskId: "task-bind",
      });
      insertSession(database, { id: "session-worker-bind", name: "worker-bind", role: "worker" });
      insertSession(database, { id: "session-manager-bind", name: "manager-bind", role: "manager" });
    } finally {
      database.close();
    }

    const bound = runTypescriptRuntimeCommand({
      args: [
        "bind",
        "--task",
        "bind-task",
        "--worker",
        "worker-bind",
        "--manager",
        "manager-bind",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(bound.exitCode, 0);
    assert.equal(bound.handled, true);
    const boundPayload = JSON.parse(bound.stdout ?? "{}") as {
      binding_id: string;
      manager: string;
      task: string;
      worker: string;
    };
    assert.match(boundPayload.binding_id, /^binding-/);
    assert.equal(boundPayload.manager, "manager-bind");
    assert.equal(boundPayload.task, "bind-task");
    assert.equal(boundPayload.worker, "worker-bind");

    const afterBind = openDatabaseSync(dbPath);
    try {
      const binding = afterBind.prepare("select state, task_id, worker_session_id, manager_session_id from bindings where id = ?")
        .get(boundPayload.binding_id) as {
          manager_session_id: string | null;
          state: string;
          task_id: string;
          worker_session_id: string | null;
        };
      assert.equal(binding.state, "active");
      assert.equal(binding.task_id, "task-bind");
      assert.equal(binding.worker_session_id, "session-worker-bind");
      assert.equal(binding.manager_session_id, "session-manager-bind");
      const event = afterBind.prepare("select task_id, payload_json from events where type = 'binding_created'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, "task-bind");
      assert.deepEqual(JSON.parse(event.payload_json), {
        binding_id: boundPayload.binding_id,
        manager: "manager-bind",
        task: "bind-task",
        worker: "worker-bind",
      });
    } finally {
      afterBind.close();
    }

    const unboundByPath = runTypescriptRuntimeCommand({
      args: ["unbind", "--path", dbPath, "--task", "bind-task"],
      cwd: root,
      env: {},
    });
    assert.equal(unboundByPath.exitCode, 0);
    assert.equal(unboundByPath.stdout, "{\"task\": \"bind-task\", \"state\": \"ended\"}\n");

    const rebound = runTypescriptRuntimeCommand({
      args: ["bind", "--task", "bind-task", "--worker", "worker-bind", "--manager", "manager-bind"],
      cwd: root,
      env: {},
    });
    assert.equal(rebound.exitCode, 0);

    const unbound = runTypescriptRuntimeCommand({
      args: ["unbind", "--task", "bind-task"],
      cwd: root,
      env: {},
    });
    assert.equal(unbound.exitCode, 0);
    assert.equal(unbound.handled, true);
    assert.equal(unbound.stdout, "{\"task\": \"bind-task\", \"state\": \"ended\"}\n");
    assert.deepEqual(JSON.parse(unbound.stdout), { state: "ended", task: "bind-task" });

    const afterUnbind = openDatabaseSync(dbPath);
    try {
      const binding = afterUnbind.prepare("select state, ended_at from bindings where id = ?")
        .get(boundPayload.binding_id) as { ended_at: string | null; state: string };
      assert.equal(binding.state, "ended");
      assert.ok(binding.ended_at);
      const event = afterUnbind.prepare("select task_id, payload_json from events where type = 'binding_ended'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, "task-bind");
      assert.deepEqual(JSON.parse(event.payload_json), { task: "bind-task" });
    } finally {
      afterUnbind.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime loop-status exposes task-level app Dispatch when requested run is blind", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-loop-status-app-dispatch."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Inspect app-native task traffic.",
        name: "app-dispatch-status-task",
        now: "2026-05-24T10:00:00Z",
        taskId: "task-app-dispatch-status",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: [],
        runId: "run-app-dispatch-blind",
        runName: "blind-run",
        taskId: "task-app-dispatch-status",
      });
      createCommandSync(database, {
        commandId: "command-app-dispatch-task",
        commandType: "continue_iteration",
        correlationId: "app-dispatch-command",
        payload: { app_loop: { task: "app-dispatch-status-task" } },
        taskId: "task-app-dispatch-status",
      });
      database.prepare(`
        insert into sessions(id, name, role, identity_token, cwd, registered_at, state)
        values
          ('session-worker-app-dispatch-status', 'app-dispatch-worker', 'worker', 'token-worker-app-dispatch-status', '/repo', '2026-05-24T10:00:00Z', 'active'),
          ('session-manager-app-dispatch-status', 'app-dispatch-manager', 'manager', 'token-manager-app-dispatch-status', '/repo', '2026-05-24T10:00:00Z', 'active')
      `).run();
      database.prepare(`
        insert into bindings(id, task_id, worker_session_id, manager_session_id, state, created_at)
        values ('binding-app-dispatch-status', 'task-app-dispatch-status', 'session-worker-app-dispatch-status', 'session-manager-app-dispatch-status', 'active', '2026-05-24T10:00:00Z')
      `).run();
      database.prepare(`
        insert into routed_notifications(
          task_id, binding_id, correlation_id, source_session_id, target_session_id,
          signal_type, dedupe_key, created_at, state, payload_json, delivery_mode
        )
        values (?, ?, ?, ?, ?, 'worker_task', ?, ?, 'delivered', ?, 'pull_required')
      `).run(
        "task-app-dispatch-status",
        "binding-app-dispatch-status",
        "app-dispatch-notification",
        "session-manager-app-dispatch-status",
        "session-worker-app-dispatch-status",
        "app-dispatch-notification",
        "2026-05-24T10:01:00Z",
        JSON.stringify({ app_loop: { task: "app-dispatch-status-task" } }),
      );
      database.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json
        )
        values ('telemetry-app-dispatch-consumed', null, 'task-app-dispatch-status', '2026-05-24T10:02:00Z', 'dispatch', 'dispatch_inbox_consumed', 'info', 'Task-level app inbox item consumed.', '{}', '{}')
      `).run();
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["loop-status", "app-dispatch-status-task", "--run", "blind-run", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      app_task_dispatch: {
        commands: { total: number };
        note: string | null;
        notifications: { delivered_unconsumed: number; total: number };
        records_total: number;
        telemetry: { command_created: number; dispatch_inbox_consumed: number; total: number };
      };
      commands: { total: number };
      notifications: { total: number };
      telemetry: { total: number };
    };
    assert.equal(payload.commands.total, 0);
    assert.equal(payload.notifications.total, 0);
    assert.equal(payload.telemetry.total, 0);
    assert.equal(payload.app_task_dispatch.commands.total, 1);
    assert.equal(payload.app_task_dispatch.notifications.total, 1);
    assert.equal(payload.app_task_dispatch.notifications.delivered_unconsumed, 1);
    assert.equal(payload.app_task_dispatch.telemetry.command_created, 1);
    assert.equal(payload.app_task_dispatch.telemetry.dispatch_inbox_consumed, 1);
    assert.equal(payload.app_task_dispatch.records_total, 4);
    assert.match(payload.app_task_dispatch.note ?? "", /task-level app Dispatch records exist/);

    const textResult = runTypescriptRuntimeCommand({
      args: ["loop-status", "app-dispatch-status-task", "--run", "blind-run", "--path", dbPath],
      env: {},
    });
    assert.equal(textResult.exitCode, 0, textResult.stderr);
    assert.match(textResult.stdout ?? "", /app_task_dispatch: 4 records/);
    assert.match(textResult.stdout ?? "", /task-level app Dispatch records exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles no-tmux create-disposable-binding by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-disposable."));
  try {
    const dbPath = join(root, "workerctl.db");
    const sessionDir = join(root, "sessions");
    const created = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "real-slice",
        "--goal",
        "Run a real no-tmux Ralph loop.",
        "--worker",
        "real-worker",
        "--manager",
        "real-manager",
        "--worker-codex-app-thread-id",
        "worker-thread-123",
        "--worker-codex-app-thread-title",
        "Real Worker Thread",
        "--manager-codex-app-thread-id",
        "manager-thread-456",
        "--manager-codex-app-thread-title",
        "Real Manager Thread",
        "--run-name",
        "real-slice-run",
        "--required-before-continue",
        "adversarial_check",
        "--session-dir",
        sessionDir,
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(created.handled, true);
    const payload = JSON.parse(created.stdout ?? "{}") as {
      binding: { id: string };
      heartbeat_recommendations: {
        delivery_receipt_commands: { blocked: string; note: string; sent: string; skipped: string };
        interval_minutes: number;
        manager: { direct_inbox_command: string; poll_command: string; prompt: string };
        note: string;
        status_command: string;
        teardown_policy: {
          idle_poll: string;
          owner: string;
          terminal_closeout: string;
          terminal_closeout_command: string;
          worker_rule: string;
        };
        wakeup_dispatch_command: string;
        wakeup_plan_command: string;
        worker: { direct_inbox_command: string; poll_command: string; prompt: string };
      };
      manager: {
        communication: { delivery_mode: string; poll_command: string; receive_style: string; session_kind: string };
        codex_app_thread_id: string | null;
        codex_app_thread_title: string | null;
        name: string;
        rollout_path: string;
        tmux_session: string | null;
      };
      replay_commands: string[];
      run: {
        metadata: {
          current_iteration: number;
          max_iterations: number;
          policy_record: boolean;
          required_before_continue: string[];
        };
        name: string;
        purpose: string;
        status: string;
      };
      task: { created: boolean; id: string; name: string; state: string };
      worker: {
        communication: { delivery_mode: string; poll_command: string; receive_style: string; session_kind: string };
        codex_app_thread_id: string | null;
        codex_app_thread_title: string | null;
        name: string;
        rollout_path: string;
        tmux_session: string | null;
      };
      worker_handoff: string;
    };
    assert.equal(payload.task.name, "real-slice");
    assert.equal(payload.task.created, true);
    assert.equal(payload.task.state, "managed");
    assert.equal(payload.worker.name, "real-worker");
    assert.equal(payload.manager.name, "real-manager");
    assert.equal(payload.worker.codex_app_thread_id, "worker-thread-123");
    assert.equal(payload.worker.codex_app_thread_title, "Real Worker Thread");
    assert.equal(payload.manager.codex_app_thread_id, "manager-thread-456");
    assert.equal(payload.manager.codex_app_thread_title, "Real Manager Thread");
    assert.equal(payload.worker.tmux_session, null);
    assert.equal(payload.manager.tmux_session, null);
    assert.equal(payload.worker.communication.session_kind, "codex_app");
    assert.equal(payload.manager.communication.session_kind, "codex_app");
    assert.equal(payload.worker.communication.receive_style, "pull");
    assert.equal(payload.manager.communication.receive_style, "pull");
    assert.equal(payload.worker.communication.delivery_mode, "pull_required");
    assert.equal(payload.manager.communication.delivery_mode, "pull_required");
    const quotedDbPath = `'${dbPath.replace(/'/g, "'\"'\"'")}'`;
    const localConveyor = `PATH='${join(process.cwd(), "bin").replace(/'/g, "'\"'\"'")}':$PATH conveyor`;
    assert.equal(
      payload.worker.communication.poll_command,
      `${localConveyor} worker-inbox 'real-slice' --consume-next --wait --timeout 60 --path ${quotedDbPath} --json`,
    );
    assert.equal(
      payload.manager.communication.poll_command,
      `${localConveyor} manager-inbox 'real-slice' --consume-next --wait --timeout 60 --path ${quotedDbPath} --json`,
    );
    assert.equal(payload.heartbeat_recommendations.interval_minutes, 2);
    assert.ok(payload.heartbeat_recommendations.worker.poll_command.includes("app-heartbeat 'real-slice' --role worker"));
    assert.ok(payload.heartbeat_recommendations.manager.poll_command.includes("app-heartbeat 'real-slice' --role manager"));
    assert.equal(payload.heartbeat_recommendations.worker.direct_inbox_command, payload.worker.communication.poll_command);
    assert.equal(payload.heartbeat_recommendations.manager.direct_inbox_command, payload.manager.communication.poll_command);
    assert.ok(payload.heartbeat_recommendations.status_command.includes("app-loop-status 'real-slice'"));
    assert.ok(payload.heartbeat_recommendations.wakeup_plan_command.includes("app-wakeup-plan 'real-slice'"));
    assert.ok(payload.heartbeat_recommendations.wakeup_dispatch_command.includes("app-wakeup-dispatch 'real-slice'"));
    assert.ok(payload.heartbeat_recommendations.wakeup_dispatch_command.includes("--path"));
    assert.ok(payload.heartbeat_recommendations.delivery_receipt_commands.sent.includes("app-wakeup-record-delivery 'real-slice'"));
    assert.ok(payload.heartbeat_recommendations.delivery_receipt_commands.sent.includes("--delivery-status sent"));
    assert.ok(payload.heartbeat_recommendations.delivery_receipt_commands.sent.includes("--thread-id <action.thread.id>"));
    assert.ok(payload.heartbeat_recommendations.delivery_receipt_commands.skipped.includes("--delivery-status skipped"));
    assert.ok(payload.heartbeat_recommendations.delivery_receipt_commands.blocked.includes("--delivery-status blocked"));
    assert.ok(payload.heartbeat_recommendations.delivery_receipt_commands.note.includes("send_ready=true"));
    assert.ok(payload.heartbeat_recommendations.note.includes("heartbeat"));
    assert.equal(payload.heartbeat_recommendations.teardown_policy.owner, "manager_or_operator");
    assert.ok(payload.heartbeat_recommendations.teardown_policy.idle_poll.includes("Never delete"));
    assert.ok(payload.heartbeat_recommendations.teardown_policy.terminal_closeout.includes("terminal manager decision"));
    assert.ok(payload.heartbeat_recommendations.teardown_policy.terminal_closeout_command.includes("finish-task 'real-slice'"));
    assert.ok(payload.heartbeat_recommendations.teardown_policy.terminal_closeout_command.includes("--require-criteria-audit"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("Keep manager closeout/control-plane proof out of accepted worker criteria"));
    assert.ok(payload.heartbeat_recommendations.teardown_policy.worker_rule.includes("must not own loop teardown"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("stop after a one-line idle receipt"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("Run the worker app heartbeat"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("compact evidence for any completion claim"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("Visible session protocol, required for operator review"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("CONVEYOR POLL"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("CONVEYOR RECEIVED"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("CONVEYOR SEND"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("DISPATCH"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("enqueue-notify-manager 'real-slice'"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("dispatch --watch --watch-iterations 1 --interval 2 --dispatcher-id dispatch-local"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("direct app-thread final answer is not a manager receipt"));
    assert.ok(payload.heartbeat_recommendations.worker.prompt.includes("Do not delete, pause, or disable worker heartbeat automation after an idle poll"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("produce exactly one next worker task"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("Run the manager app heartbeat"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("Visible session protocol, required for operator review"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("CONVEYOR POLL"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("CONVEYOR RECEIVED"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("WORK"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("CONVEYOR SEND"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("app-wakeup-dispatch"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("send_ready=true"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("direct app-thread delivery is not task completion"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("app-wakeup-record-delivery"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("--delivery-status sent"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("--delivery-status skipped"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("--delivery-status blocked"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("Do not delete, pause, or disable manager or worker heartbeat automation after an idle poll"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("record the terminal manager decision"));
    assert.ok(payload.heartbeat_recommendations.manager.prompt.includes("task remains managed/active"));
    assert.equal(payload.run.name, "real-slice-run");
    assert.equal(payload.run.purpose, "ralph_loop");
    assert.equal(payload.run.status, "finished");
    assert.deepEqual(payload.run.metadata.required_before_continue, ["adversarial_check"]);
    assert.equal(payload.run.metadata.max_iterations, 2);
    assert.equal(payload.run.metadata.current_iteration, 1);
    assert.equal(payload.run.metadata.policy_record, true);
    assert.ok(payload.replay_commands.some((command) => command.includes("enqueue-continue-iteration")));
    assert.ok(payload.replay_commands.some((command) => command.includes("worker-inbox")));
    assert.ok(payload.replay_commands.some((command) => command.includes("loop-status")));
    assert.ok(payload.worker_handoff.includes("Keep polling your Conveyor worker inbox"));
    assert.ok(payload.worker_handoff.includes("Visible session protocol, required for operator review"));
    assert.ok(payload.worker_handoff.includes("CONVEYOR POLL"));
    assert.ok(payload.worker_handoff.includes("CONVEYOR RECEIVED"));
    assert.ok(payload.worker_handoff.includes("CONVEYOR SEND"));
    assert.ok(payload.worker_handoff.includes("DISPATCH"));
    assert.ok(payload.worker_handoff.includes("enqueue-notify-manager 'real-slice'"));
    assert.ok(payload.worker_handoff.includes("dispatch --watch --watch-iterations 1 --interval 2 --dispatcher-id dispatch-local"));
    assert.ok(payload.worker_handoff.includes("direct app-thread final answer is not a manager receipt"));
    assert.ok(payload.worker_handoff.includes("autonomous operation requires a heartbeat/wake layer"));
    assert.ok(payload.worker_handoff.includes("Do not delete, pause, or disable heartbeat automation just because an inbox poll is idle"));
    assert.ok(payload.worker_handoff.includes(payload.worker.communication.poll_command));

    for (const key of ["worker", "manager"] as const) {
      const rolloutLine = JSON.parse(readFileSync(payload[key].rollout_path, "utf8").split(/\r?\n/)[0] ?? "{}") as {
        payload: { cwd: string; id: string };
        type: string;
      };
      assert.equal(rolloutLine.type, "session_meta");
      assert.equal(rolloutLine.payload.cwd, root);
      assert.match(rolloutLine.payload.id, /^codex-real-/);
    }

    const database = openDatabaseSync(dbPath);
    try {
      const task = database.prepare("select id, name, goal, state from tasks where name = ?")
        .get("real-slice") as { goal: string; id: string; name: string; state: string };
      assert.equal(task.id, payload.task.id);
      assert.equal(task.goal, "Run a real no-tmux Ralph loop.");
      assert.equal(task.state, "managed");
      const sessions = database.prepare("select name, role, tmux_session, codex_app_thread_id, codex_app_thread_title, state from sessions order by role")
        .all() as Array<{
          codex_app_thread_id: string | null;
          codex_app_thread_title: string | null;
          name: string;
          role: string;
          state: string;
          tmux_session: string | null;
        }>;
      assert.deepEqual(sessions.map((session) => ({ ...session })), [
        {
          codex_app_thread_id: "manager-thread-456",
          codex_app_thread_title: "Real Manager Thread",
          name: "real-manager",
          role: "manager",
          state: "active",
          tmux_session: null,
        },
        {
          codex_app_thread_id: "worker-thread-123",
          codex_app_thread_title: "Real Worker Thread",
          name: "real-worker",
          role: "worker",
          state: "active",
          tmux_session: null,
        },
      ]);
      const binding = database.prepare("select id, task_id, state from bindings")
        .get() as { id: string; state: string; task_id: string };
      assert.equal(binding.id, payload.binding.id);
      assert.equal(binding.task_id, payload.task.id);
      assert.equal(binding.state, "active");
      const run = database.prepare("select name, purpose, status, metadata_json from runs")
        .get() as { metadata_json: string; name: string; purpose: string; status: string };
      assert.equal(run.name, "real-slice-run");
      assert.equal(run.purpose, "ralph_loop");
      assert.equal(run.status, "finished");
      const runMetadata = JSON.parse(run.metadata_json) as {
        policy_record: boolean;
        required_before_continue: string[];
      };
      assert.deepEqual(runMetadata.required_before_continue, ["adversarial_check"]);
      assert.equal(runMetadata.policy_record, true);
      const event = database.prepare("select task_id, payload_json from events where type = 'disposable_binding_created'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, payload.task.id);
      assert.deepEqual(JSON.parse(event.payload_json), {
        binding_id: payload.binding.id,
        manager: "real-manager",
        run: "real-slice-run",
        worker: "real-worker",
      });
    } finally {
      database.close();
    }

    const templated = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "templated-slice",
        "--worker",
        "templated-worker",
        "--manager",
        "templated-manager",
        "--template",
        "visual_diff_loop",
        "--max-iterations",
        "5",
        "--current-iteration",
        "2",
        "--seed-prompt-sha256",
        "seed-template",
        "--required-before-continue",
        "manual_review",
        "--run-name",
        "templated-run",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(templated.exitCode, 0, templated.stderr);
    assert.equal(templated.handled, true);
    const templatedPayload = JSON.parse(templated.stdout ?? "{}") as {
      replay_commands: string[];
      run: {
        metadata: {
          artifact_requirements: Record<string, unknown>;
          cleanup_policy: string;
          current_iteration: number;
          max_iterations: number;
          policy_record: boolean;
          recommended_tools: string[];
          required_before_continue: string[];
          seed_prompt_sha256: string;
          stop_conditions: string[];
          tags: string[];
          template: string;
        };
        name: string;
        status: string;
      };
    };
    assert.equal(templatedPayload.run.name, "templated-run");
    assert.equal(templatedPayload.run.status, "finished");
    assert.equal(templatedPayload.run.metadata.template, "visual_diff_loop");
    assert.equal(templatedPayload.run.metadata.max_iterations, 5);
    assert.equal(templatedPayload.run.metadata.current_iteration, 2);
    assert.equal(templatedPayload.run.metadata.cleanup_policy, "compact");
    assert.equal(templatedPayload.run.metadata.seed_prompt_sha256, "seed-template");
    assert.equal(templatedPayload.run.metadata.policy_record, true);
    assert.deepEqual(templatedPayload.run.metadata.stop_conditions, [
      "max_iterations",
      "required_evidence",
      "manager_accepts",
    ]);
    assert.deepEqual(templatedPayload.run.metadata.required_before_continue, [
      "reference_artifact",
      "candidate_screenshot",
      "visual_diff_report",
      "diff_below_threshold",
      "adversarial_check",
      "manual_review",
    ]);
    assert.deepEqual(templatedPayload.run.metadata.recommended_tools, ["browser", "playwright", "pixelmatch"]);
    assert.deepEqual(templatedPayload.run.metadata.tags, ["visual", "frontend", "qa"]);
    assert.ok("visual_diff_report" in templatedPayload.run.metadata.artifact_requirements);
    assert.ok(templatedPayload.replay_commands[0].includes("--template"));
    assert.ok(templatedPayload.replay_commands[0].includes("visual_diff_loop"));
    const appVisible = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "app-visible-slice",
        "--worker",
        "app-visible-worker",
        "--manager",
        "app-visible-manager",
        "--worker-codex-app-thread-id",
        "app-visible-worker-thread",
        "--manager-codex-app-thread-id",
        "app-visible-manager-thread",
        "--template",
        "app_visible_build_loop",
        "--run-name",
        "app-visible-run",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(appVisible.exitCode, 0, appVisible.stderr);
    const appVisiblePayload = JSON.parse(appVisible.stdout ?? "{}") as {
      run: {
        metadata: {
          cleanup_policy: string;
          recommended_tools: string[];
          required_before_continue: string[];
          tags: string[];
          template: string;
        };
      };
    };
    assert.equal(appVisiblePayload.run.metadata.template, "app_visible_build_loop");
    assert.equal(appVisiblePayload.run.metadata.cleanup_policy, "off");
    assert.deepEqual(appVisiblePayload.run.metadata.required_before_continue, ["build_passed", "adversarial_check"]);
    assert.deepEqual(appVisiblePayload.run.metadata.recommended_tools, ["verification.run_tests"]);
    assert.deepEqual(appVisiblePayload.run.metadata.tags, ["build", "codex_app", "visible_session"]);
    assert.equal(appVisiblePayload.run.metadata.required_before_continue.includes("cleanup"), false);
    const unknownTemplate = runTypescriptRuntimeCommand({
      args: ["create-disposable-binding", "unknown-template", "--template", "not_real", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(unknownTemplate.exitCode, 2);
    assert.match(unknownTemplate.stderr ?? "", /Unknown loop template: not_real/);
    const partialTask = openDatabaseSync(dbPath);
    try {
      const row = partialTask.prepare("select id from tasks where name = 'unknown-template'").get();
      assert.equal(row, undefined);
    } finally {
      partialTask.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles state-only finish-task and stop-task by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle."));
  try {
    const dbPath = join(root, "workerctl.db");
    const finishCreated = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "finish-slice",
        "--goal",
        "Finish a state-only lifecycle task.",
        "--worker",
        "finish-worker",
        "--manager",
        "finish-manager",
        "--run-name",
        "finish-run",
        "--required-before-continue",
        "ci_green",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(finishCreated.exitCode, 0, finishCreated.stderr);

    const finished = runTypescriptRuntimeCommand({
      args: [
        "finish-task",
        "finish-slice",
        "--reason",
        "QA complete.",
        "--path",
        dbPath,
      ],
      cwd: root,
      env: {},
    });
    assert.equal(finished.exitCode, 0, finished.stderr);
    assert.equal(finished.handled, true);
    const finishPayload = JSON.parse(finished.stdout ?? "{}") as {
      command_id: string;
      final_ack_audit: { missing: string[]; ok: boolean; require_acks: boolean };
      final_audit: { open_criteria: unknown[]; require_criteria_audit: boolean; total: number };
      final_decision_id: number;
      final_epilogue_audit: { ok: boolean; required_steps: string[] };
      finish: boolean;
      killed_manager: boolean;
      killed_worker: boolean;
      manager_decision: { decision_id: null; ok: boolean; warnings: string[] };
      manager_session: string;
      pre_stop_transcript_captures: unknown[];
      reason: string;
      stop_manager: boolean;
      stop_worker: boolean;
      task: string;
      worker: string;
      worker_session: string;
    };
    assert.equal(finishPayload.finish, true);
    assert.equal(finishPayload.task, "finish-slice");
    assert.equal(finishPayload.reason, "QA complete.");
    assert.equal(finishPayload.stop_manager, false);
    assert.equal(finishPayload.stop_worker, false);
    assert.equal(finishPayload.killed_manager, false);
    assert.equal(finishPayload.killed_worker, false);
    assert.deepEqual(finishPayload.pre_stop_transcript_captures, []);
    assert.equal(finishPayload.worker, "finish-worker");
    assert.equal(finishPayload.worker_session, "finish-worker");
    assert.equal(finishPayload.manager_session, "finish-manager");
    assert.deepEqual(finishPayload.manager_decision, {
      allowed_decisions: ["stop"],
      decision: null,
      decision_id: null,
      ok: false,
      warnings: ["missing_decision_id"],
    });
    assert.equal(finishPayload.final_audit.require_criteria_audit, false);
    assert.equal(finishPayload.final_audit.total, 0);
    assert.deepEqual(finishPayload.final_audit.open_criteria, []);
    assert.equal(finishPayload.final_ack_audit.require_acks, false);
    assert.equal(finishPayload.final_ack_audit.ok, false);
    assert.deepEqual(finishPayload.final_ack_audit.missing, ["worker", "manager"]);
    assert.equal(finishPayload.final_epilogue_audit.ok, true);
    assert.deepEqual(finishPayload.final_epilogue_audit.required_steps, []);

    const afterFinish = openDatabaseSync(dbPath);
    try {
      const task = afterFinish.prepare("select state from tasks where name = 'finish-slice'")
        .get() as { state: string };
      assert.equal(task.state, "done");
      const binding = afterFinish.prepare("select state, ended_at from bindings where task_id = (select id from tasks where name = 'finish-slice')")
        .get() as { ended_at: string | null; state: string };
      assert.equal(binding.state, "ended");
      assert.ok(binding.ended_at);
      const run = afterFinish.prepare("select status, ended_at from runs where name = 'finish-run'")
        .get() as { ended_at: string | null; status: string };
      assert.equal(run.status, "finished");
      assert.ok(run.ended_at);
      const command = afterFinish.prepare("select type, state, result_json from commands where id = ?")
        .get(finishPayload.command_id) as { result_json: string; state: string; type: string };
      assert.equal(command.type, "finish_task");
      assert.equal(command.state, "succeeded");
      assert.equal(JSON.parse(command.result_json).reason, "QA complete.");
      const decision = afterFinish.prepare("select decision, reason, payload_json from manager_decisions where id = ?")
        .get(finishPayload.final_decision_id) as { decision: string; payload_json: string; reason: string };
      assert.equal(decision.decision, "stop");
      assert.equal(decision.reason, "QA complete.");
      assert.equal(JSON.parse(decision.payload_json).source, "finish_task");
      const observation = afterFinish.prepare("select message from agent_observations where command_id = ?")
        .get(finishPayload.command_id) as { message: string };
      assert.equal(observation.message, "QA complete.");
      const eventTypes = afterFinish.prepare("select type from events where task_id = (select id from tasks where name = 'finish-slice') order by id")
        .all() as Array<{ type: string }>;
      assert.ok(eventTypes.some((event) => event.type === "finish_task_intent"));
      assert.ok(eventTypes.some((event) => event.type === "finish_task_criteria_audit"));
      assert.ok(eventTypes.some((event) => event.type === "finish_task_succeeded"));
      const telemetryTypes = afterFinish.prepare("select event_type from telemetry_events where task_id = (select id from tasks where name = 'finish-slice')")
        .all() as Array<{ event_type: string }>;
      assert.ok(telemetryTypes.some((event) => event.event_type === "command_attempted"));
      assert.ok(telemetryTypes.some((event) => event.event_type === "command_succeeded"));
      assert.ok(telemetryTypes.some((event) => event.event_type === "manager_decision_recorded"));
      assert.ok(telemetryTypes.some((event) => event.event_type === "task_finished"));
	    } finally {
	      afterFinish.close();
	    }

	    const finishMutationAudit = runTypescriptRuntimeCommand({
	      args: ["mutation-audit", "finish-slice", "--json", "--path", dbPath],
	      cwd: root,
	      env: {},
	    });
	    assert.equal(finishMutationAudit.exitCode, 0, finishMutationAudit.stderr);
	    const finishMutationPayload = JSON.parse(finishMutationAudit.stdout ?? "{}") as {
	      ok: boolean;
	      records: Array<{ linked_decision: { id: number } | null; ok: boolean; warnings: string[] }>;
	    };
	    assert.equal(finishMutationPayload.ok, true);
	    assert.equal(finishMutationPayload.records[0].ok, true);
	    assert.deepEqual(finishMutationPayload.records[0].warnings, []);
	    assert.equal(finishMutationPayload.records[0].linked_decision?.id, finishPayload.final_decision_id);

	    const stopCreated = runTypescriptRuntimeCommand({
	      args: [
        "create-disposable-binding",
        "stop-slice",
        "--worker",
        "stop-worker",
        "--manager",
        "stop-manager",
        "--run-name",
        "stop-run",
        "--required-before-continue",
        "manual_review",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(stopCreated.exitCode, 0, stopCreated.stderr);
    const stopped = runTypescriptRuntimeCommand({
      args: ["stop-task", "stop-slice", "--reason", "Operator stopped.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    const stopPayload = JSON.parse(stopped.stdout ?? "{}") as {
      command_id: string;
      final_decision_id: null;
      final_observation_id: null;
      finish: boolean;
      reason: string;
      stop_manager: boolean;
      stop_worker: boolean;
      task: string;
    };
    assert.equal(stopPayload.finish, false);
    assert.equal(stopPayload.final_decision_id, null);
    assert.equal(stopPayload.final_observation_id, null);
    assert.equal(stopPayload.reason, "Operator stopped.");
    assert.equal(stopPayload.stop_manager, true);
    assert.equal(stopPayload.stop_worker, false);
    assert.equal(stopPayload.task, "stop-slice");

    const afterStop = openDatabaseSync(dbPath);
    try {
      const task = afterStop.prepare("select state from tasks where name = 'stop-slice'")
        .get() as { state: string };
      assert.equal(task.state, "done");
      const run = afterStop.prepare("select status from runs where name = 'stop-run'")
        .get() as { status: string };
      assert.equal(run.status, "finished");
      const command = afterStop.prepare("select type, state from commands where id = ?")
        .get(stopPayload.command_id) as { state: string; type: string };
      assert.equal(command.type, "stop_task");
      assert.equal(command.state, "succeeded");
      const eventTypes = afterStop.prepare("select type from events where task_id = (select id from tasks where name = 'stop-slice')")
        .all() as Array<{ type: string }>;
      assert.ok(eventTypes.some((event) => event.type === "stop_task_intent"));
      assert.ok(eventTypes.some((event) => event.type === "stop_task_succeeded"));
      const telemetryTypes = afterStop.prepare("select event_type from telemetry_events where task_id = (select id from tasks where name = 'stop-slice')")
        .all() as Array<{ event_type: string }>;
      assert.ok(telemetryTypes.some((event) => event.event_type === "task_stopped"));
    } finally {
      afterStop.close();
    }

    const activeRunDb = openDatabaseSync(dbPath);
    try {
      const finishTaskId = createTaskSync(activeRunDb, {
        goal: "Close an active run on finish.",
        name: "active-run-finish",
      });
      const stopTaskId = createTaskSync(activeRunDb, {
        goal: "Close an active run on stop.",
        name: "active-run-stop",
      });
      const startedAt = new Date().toISOString();
      activeRunDb.prepare(`
        insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
        values (?, ?, ?, 'ralph_loop', 'active', ?, null, ?)
      `).run("run-active-finish", finishTaskId, "active-run-finish-run", startedAt, "{}");
      activeRunDb.prepare(`
        insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
        values (?, ?, ?, 'ralph_loop', 'active', ?, null, ?)
      `).run("run-active-stop", stopTaskId, "active-run-stop-run", startedAt, "{}");
    } finally {
      activeRunDb.close();
    }

    const activeFinish = runTypescriptRuntimeCommand({
      args: ["finish-task", "active-run-finish", "--reason", "Active run finished.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(activeFinish.exitCode, 0, activeFinish.stderr);
    const activeStop = runTypescriptRuntimeCommand({
      args: ["stop-task", "active-run-stop", "--reason", "Active run stopped.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(activeStop.exitCode, 0, activeStop.stderr);
    const activeRunCheck = openDatabaseSync(dbPath);
    try {
      const activeRuns = activeRunCheck.prepare("select name, status, ended_at from runs where name in ('active-run-finish-run', 'active-run-stop-run') order by name")
        .all() as Array<{ ended_at: string | null; name: string; status: string }>;
      assert.deepEqual(activeRuns.map((run) => ({ name: run.name, status: run.status })), [
        { name: "active-run-finish-run", status: "finished" },
        { name: "active-run-stop-run", status: "abandoned" },
      ]);
      assert.ok(activeRuns.every((run) => run.ended_at));
      const activeRunTelemetry = activeRunCheck.prepare(`
        select r.name, t.event_type
        from telemetry_events t
        join runs r on r.id = t.run_id
        where r.name in ('active-run-finish-run', 'active-run-stop-run')
        order by r.name, t.event_type
      `).all() as Array<{ event_type: string; name: string }>;
      assert.deepEqual(activeRunTelemetry.map((event) => ({ ...event })), [
        { name: "active-run-finish-run", event_type: "run_finished" },
        { name: "active-run-stop-run", event_type: "run_finished" },
      ]);
    } finally {
      activeRunCheck.close();
    }

    const jsonDb = openDatabaseSync(dbPath);
    try {
      createTaskSync(jsonDb, {
        goal: "Finish through explicit JSON flag.",
        name: "needs-json",
      });
    } finally {
      jsonDb.close();
    }
    const finishJson = runTypescriptRuntimeCommand({
      args: ["finish-task", "needs-json", "--reason", "JSON closeout.", "--json", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(finishJson.exitCode, 0, finishJson.stderr);
    const finishJsonPayload = JSON.parse(finishJson.stdout ?? "{}") as {
      finish: boolean;
      reason: string;
      task: string;
    };
    assert.equal(finishJsonPayload.finish, true);
    assert.equal(finishJsonPayload.reason, "JSON closeout.");
    assert.equal(finishJsonPayload.task, "needs-json");
    const explicitLive = runTypescriptRuntimeCommand({
      args: ["--ts-runtime", "finish-task", "needs-live", "--stop-worker", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(explicitLive.exitCode, 2);
    assert.match(explicitLive.stderr ?? "", /Unknown task: needs-live/);
    const needsCapture = runTypescriptRuntimeCommand({
      args: ["finish-task", "needs-capture", "--capture-transcript-before-stop", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(needsCapture.exitCode, 2);
    assert.match(needsCapture.stderr ?? "", /Unknown task: needs-capture/);
    const needsWorkerStop = runTypescriptRuntimeCommand({
      args: ["stop-task", "needs-worker-stop", "--stop-worker", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(needsWorkerStop.exitCode, 2);
    assert.match(needsWorkerStop.stderr ?? "", /Unknown task: needs-worker-stop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles finish-task final gates by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-finish-gates."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      const timestamp = new Date().toISOString();
      const criteriaTaskId = createTaskSync(database, {
        goal: "Finish only after criteria are audited.",
        name: "gate-criteria",
      });
      const ackTaskId = createTaskSync(database, {
        goal: "Finish only after acknowledgements exist.",
        name: "gate-acks",
      });
      const epilogueTaskId = createTaskSync(database, {
        goal: "Finish only after epilogue succeeds.",
        name: "gate-epilogue",
      });
      const proofTaskId = createTaskSync(database, {
        goal: "Finish only after adversarial proof exists.",
        name: "gate-proof",
      });
      const proofOkTaskId = createTaskSync(database, {
        goal: "Finish after structured adversarial proof exists.",
        name: "gate-proof-ok",
      });
      database.prepare("update tasks set state = 'managed', updated_at = ? where id in (?, ?, ?, ?, ?)")
        .run(timestamp, criteriaTaskId, ackTaskId, epilogueTaskId, proofTaskId, proofOkTaskId);
      database.prepare(`
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
        )
        values (?, ?, 'accepted', 'manager_inferred', null, null, '{}', ?, ?)
      `).run(criteriaTaskId, "Run final regression tests", timestamp, timestamp);
      for (const role of ["worker", "manager"]) {
        database.prepare(`
          insert into task_acknowledgements(
            task_id, binding_id, role, payload_json, revision, manager_config_revision, created_at, correlation_id
          )
          values (?, null, ?, '{}', 1, null, ?, null)
        `).run(ackTaskId, role, timestamp);
      }
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json, acceptance_criteria_json, reference_paths_json,
          permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks, revision, created_at, updated_at
        )
        values (?, 'guided', null, '[]', '[]', '[]', '{}', '[]', '["draft-pr"]', 'ask-operator', 0, 1, ?, ?)
      `).run(epilogueTaskId, timestamp, timestamp);
      database.prepare(`
        insert into epilogue_runs(
          task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
        )
        values (?, 'draft-pr', 'succeeded', ?, ?, '{"summary":"ready"}', null, 'corr-epilogue')
      `).run(epilogueTaskId, timestamp, timestamp);
      database.prepare(`
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
        )
        values (?, ?, 'satisfied', 'manager_inferred', ?, null, ?, ?, ?)
      `).run(
        proofOkTaskId,
        "Adversarial proof recorded",
        "Tried to disprove the change.",
        JSON.stringify({
          check: "negative test",
          evidence_type: "adversarial_check",
          failure_mode: "Happy-path only verification.",
          result: "negative test passed",
        }),
        timestamp,
        timestamp,
      );
    } finally {
      database.close();
    }

    const criteriaFailure = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-criteria", "--require-criteria-audit", "--reason", "Done too early.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(criteriaFailure.exitCode, 1);
    assert.match(criteriaFailure.stderr ?? "", /accepted acceptance criteria still open/);
    const proofFailure = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-proof", "--require-adversarial-proof", "--reason", "Done without proof.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(proofFailure.exitCode, 1);
    assert.match(proofFailure.stderr ?? "", /adversarial proof is required/);

    const ackSuccess = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-acks", "--require-acks", "--reason", "Acks present.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(ackSuccess.exitCode, 0, ackSuccess.stderr);
    const ackPayload = JSON.parse(ackSuccess.stdout ?? "{}") as {
      final_ack_audit: { missing: string[]; require_acks: boolean };
      finish: boolean;
    };
    assert.equal(ackPayload.finish, true);
    assert.equal(ackPayload.final_ack_audit.require_acks, true);
    assert.deepEqual(ackPayload.final_ack_audit.missing, []);

    const epilogueSuccess = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-epilogue", "--require-epilogue", "--reason", "Epilogue present.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(epilogueSuccess.exitCode, 0, epilogueSuccess.stderr);
    const epiloguePayload = JSON.parse(epilogueSuccess.stdout ?? "{}") as {
      final_epilogue_audit: { missing_or_incomplete: string[]; require_epilogue: boolean; required_steps: string[] };
    };
    assert.equal(epiloguePayload.final_epilogue_audit.require_epilogue, true);
    assert.deepEqual(epiloguePayload.final_epilogue_audit.required_steps, ["draft-pr"]);
    assert.deepEqual(epiloguePayload.final_epilogue_audit.missing_or_incomplete, []);

    const proofSuccess = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-proof-ok", "--require-adversarial-proof", "--reason", "Proof exists.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(proofSuccess.exitCode, 0, proofSuccess.stderr);
    const proofPayload = JSON.parse(proofSuccess.stdout ?? "{}") as { finish: boolean };
    assert.equal(proofPayload.finish, true);

    const afterGates = openDatabaseSync(dbPath);
    try {
      const criteriaTask = afterGates.prepare("select state from tasks where name = 'gate-criteria'")
        .get() as { state: string };
      assert.equal(criteriaTask.state, "managed");
      const failedCommand = afterGates.prepare("select state, result_json, error from commands where task_id = (select id from tasks where name = 'gate-criteria')")
        .get() as { error: string; result_json: string; state: string };
      assert.equal(failedCommand.state, "failed");
      assert.match(failedCommand.error, /accepted acceptance criteria still open/);
      const failedResult = JSON.parse(failedCommand.result_json) as {
        expected_failure: boolean;
        failure_stage: string;
        final_audit: { open_criteria: Array<{ criterion: string }> };
      };
      assert.equal(failedResult.expected_failure, true);
      assert.equal(failedResult.failure_stage, "final_criteria_audit");
      assert.deepEqual(failedResult.final_audit.open_criteria.map((criterion) => criterion.criterion), [
        "Run final regression tests",
      ]);
      const failedEvent = afterGates.prepare("select payload_json from events where type = 'finish_task_failed'")
        .get() as { payload_json: string };
      assert.equal(JSON.parse(failedEvent.payload_json).failure_stage, "final_criteria_audit");
      const proofCommands = afterGates.prepare("select count(*) as count from commands where task_id = (select id from tasks where name = 'gate-proof')")
        .get() as { count: number };
      assert.equal(proofCommands.count, 0);
      const doneTasks = afterGates.prepare("select name, state from tasks where name in ('gate-acks', 'gate-epilogue', 'gate-proof-ok') order by name")
        .all() as Array<{ name: string; state: string }>;
      assert.deepEqual(doneTasks.map((task) => ({ ...task })), [
        { name: "gate-acks", state: "done" },
        { name: "gate-epilogue", state: "done" },
        { name: "gate-proof-ok", state: "done" },
      ]);
    } finally {
      afterGates.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles deterministic session registry and discovery commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-sessions."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    const managerRollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cli_version: "1.2.3", cwd: "/worker-cwd", id: "codex-worker-a", originator: "codex" },
      type: "session_meta",
    })}\n`);
    writeFileSync(managerRollout, `${JSON.stringify({
      payload: { cli_version: "1.2.3", cwd: "/manager-cwd", id: "codex-manager-a", originator: "codex" },
      type: "session_meta",
    })}\n`);

    const pidOnlyFallback = runTypescriptRuntimeCommand({
      args: ["register-worker", "--name", "pid-only", "--pid", "555"],
      cwd: root,
      env: {},
    });
    assert.equal(pidOnlyFallback.exitCode, 2);
    assert.match(pidOnlyFallback.stderr ?? "", /does not yet discover --codex-session from --pid alone/);

    const worker = runTypescriptRuntimeCommand({
      args: [
        "register-worker",
        "--name",
        "worker-a",
        "--pid",
        "123",
        "--codex-session",
        workerRollout,
        "--tmux-session",
        "codex-worker-a",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(worker.exitCode, 0);
    assert.equal(worker.handled, true);
    const workerPayload = JSON.parse(worker.stdout ?? "{}") as {
      codex_session_id: string;
      communication: { can_receive_push: boolean; delivery_mode: string; session_kind: string };
      cwd: string;
      name: string;
      pid: number;
      role: string;
      session_id: string;
      tmux_session: string | null;
    };
    assert.equal(workerPayload.codex_session_id, "codex-worker-a");
    assert.equal(workerPayload.cwd, "/worker-cwd");
    assert.equal(workerPayload.name, "worker-a");
    assert.equal(workerPayload.pid, 123);
    assert.equal(workerPayload.role, "worker");
    assert.match(workerPayload.session_id, /^session-/);
    assert.equal(workerPayload.tmux_session, "codex-worker-a");
    const localConveyor = `PATH='${join(process.cwd(), "bin").replace(/'/g, "'\"'\"'")}':$PATH conveyor`;
    assert.deepEqual(workerPayload.communication, {
      can_receive_pull: true,
      can_receive_push: true,
      delivery_mode: "push",
      detection_source: "tmux_session",
      poll_command_template: `${localConveyor} worker-inbox <task> --consume-next --wait --timeout 60 --json`,
      receive_style: "push",
      requires_polling: false,
      session_kind: "tmux",
      tmux_session: "codex-worker-a",
    });

    const manager = runTypescriptRuntimeCommand({
      args: [
        "register-manager",
        "--name",
        "manager-a",
        "--pid",
        "456",
        "--codex-session",
        managerRollout,
        "--cwd",
        "/override-manager-cwd",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(manager.exitCode, 0);
    assert.equal(manager.handled, true);
    const managerPayload = JSON.parse(manager.stdout ?? "{}") as {
      communication: { can_receive_push: boolean; delivery_mode: string; session_kind: string };
      cwd: string;
      name: string;
      role: string;
      tmux_session: string | null;
    };
    assert.equal(managerPayload.cwd, "/override-manager-cwd");
    assert.equal(managerPayload.name, "manager-a");
    assert.equal(managerPayload.role, "manager");
    assert.equal(managerPayload.tmux_session, null);
    assert.equal(managerPayload.communication.can_receive_push, false);
    assert.equal(managerPayload.communication.delivery_mode, "pull_required");
    assert.equal(managerPayload.communication.session_kind, "codex_app");

    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      createTaskSync(database, {
        goal: "Exercise session discovery.",
        name: "session-task",
        now: "2026-06-04T10:00:00Z",
        taskId: "task-session",
      });
      const events = database.prepare("select type, payload_json from events where type = 'session_registered' order by id")
        .all() as Array<{ payload_json: string; type: string }>;
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((event) => JSON.parse(event.payload_json).name), ["worker-a", "manager-a"]);
    } finally {
      database.close();
    }

    const sessions = runTypescriptRuntimeCommand({
      args: ["sessions", "--role", "worker", "--redact-identity-token"],
      cwd: root,
      env: {},
    });
    assert.equal(sessions.exitCode, 0);
    assert.equal(sessions.handled, true);
    const sessionRows = JSON.parse(sessions.stdout ?? "[]") as Array<{
      identity_token: string;
      name: string;
      role: string;
    }>;
    assert.deepEqual(sessionRows.map((session) => session.name), ["worker-a"]);
    assert.equal(sessionRows[0].role, "worker");
    assert.equal(sessionRows[0].identity_token, "[REDACTED]");

    const sessionsPathFallback = runTypescriptRuntimeCommand({
      args: ["sessions", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(sessionsPathFallback.exitCode, 0);
    assert.equal(JSON.parse(sessionsPathFallback.stdout ?? "[]").length, 2);

    const discovered = runTypescriptRuntimeCommand({
      args: ["discover", "--limit", "5"],
      cwd: root,
      env: {},
    });
    assert.equal(discovered.exitCode, 0);
    const discoverPayload = JSON.parse(discovered.stdout ?? "{}") as {
      query: string;
      sessions: Array<{ name: string }>;
      suggestions: Array<{ command?: string; kind: string }>;
      tasks: Array<{ name: string }>;
    };
    assert.equal(discoverPayload.query, "");
    assert.deepEqual(discoverPayload.tasks.map((task) => task.name), ["session-task"]);
    assert.deepEqual(discoverPayload.sessions.map((session) => session.name), ["worker-a", "manager-a"]);
    assert.equal(discoverPayload.suggestions[0].kind, "bind");
    assert.equal(
      discoverPayload.suggestions[0].command,
      "conveyor bind --task 'session-task' --worker 'worker-a' --manager 'manager-a'",
    );

    const deregisterPathFallback = runTypescriptRuntimeCommand({
      args: ["deregister", "worker-a", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(deregisterPathFallback.exitCode, 0);
    assert.equal(deregisterPathFallback.stdout, "{\"name\": \"worker-a\", \"state\": \"gone\"}\n");

    const deregisteredManager = runTypescriptRuntimeCommand({
      args: ["deregister", "manager-a"],
      cwd: root,
      env: {},
    });
    assert.equal(deregisteredManager.exitCode, 0);
    assert.equal(deregisteredManager.handled, true);
    assert.equal(deregisteredManager.stdout, "{\"name\": \"manager-a\", \"state\": \"gone\"}\n");

    const afterDeregister = openDatabaseSync(dbPath);
    try {
      const workerState = afterDeregister.prepare("select state from sessions where name = 'worker-a'")
        .get() as { state: string };
      assert.equal(workerState.state, "gone");
      const command = afterDeregister.prepare("select type, state, result_json from commands where type = 'deregister_session'")
        .get() as { result_json: string; state: string; type: string };
      assert.equal(command.state, "succeeded");
      assert.deepEqual(JSON.parse(command.result_json), {
        command_id: JSON.parse(command.result_json).command_id,
        name: "worker-a",
        state: "gone",
      });
      const event = afterDeregister.prepare("select command_id, payload_json from events where type = 'session_deregistered'")
        .get() as { command_id: string; payload_json: string };
      assert.ok(event.command_id);
      assert.deepEqual(JSON.parse(event.payload_json), { name: "worker-a" });
    } finally {
      afterDeregister.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy start with bootstrap prompt and Codex passthrough args", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-start."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t qa-raw") {
      return { status: 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const stateRoot = join(root, "state");
    const env = { WORKERCTL_STATE_ROOT: stateRoot };

    const result = runTypescriptRuntimeCommand({
      args: [
        "start",
        "--dangerously-bypass-approvals-and-sandbox",
        "qa-raw",
        "--cwd",
        "~",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "never",
        "--",
        "--model",
        "gpt-5.4-mini",
      ],
      cwd: root,
      codexCommandResolver: () => "codex",
      env,
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      attach_command: string;
      cwd: string;
      register_worker_command_template: string;
      session: string;
      start_manager_command_template: string;
      start_prompt_path: string;
      start_prompt_sent: boolean;
    };
    assert.equal(payload.session, "qa-raw");
    assert.equal(payload.attach_command, "tmux attach -t qa-raw");
    assert.equal(payload.cwd, homedir());
    assert.equal(payload.start_prompt_sent, true);
    assert.equal(payload.start_prompt_path, join(stateRoot, "artifacts", "start-prompts", "qa-raw.md"));
    assert.match(payload.register_worker_command_template, /register-worker --name <worker-name>/);
    assert.match(payload.start_manager_command_template, /-- '--dangerously-bypass-approvals-and-sandbox' '--sandbox'/);
    assert.match(payload.start_manager_command_template, /'--sandbox' 'danger-full-access' '--ask-for-approval' 'never'/);
    assert.match(payload.start_manager_command_template, /'--ask-for-approval' 'never' '--model' 'gpt-5.4-mini'/);
    const prompt = readFileSync(payload.start_prompt_path, "utf8");
    assert.match(prompt, /Agent Conveyor tmux session qa-raw/);
    assert.match(prompt, /worker-ack <task-name>/);
    assert.match(prompt, /goal_restatement/);
    assert.match(prompt, /proposed_criteria/);
    assert.match(prompt, /must_have/);
    assert.match(prompt, /follow_up/);
    assert.match(prompt, /ready_to_start/);
    assert.match(prompt, /Required fields:\n- worker name\n- manager name\n- task name\n- goal/);
    assert.match(prompt, /-- '--dangerously-bypass-approvals-and-sandbox' '--sandbox'/);
    assert.match(prompt, /'--sandbox' 'danger-full-access' '--ask-for-approval' 'never'/);
    assert.match(prompt, /'--ask-for-approval' 'never' '--model' 'gpt-5.4-mini'/);
    assert.deepEqual(calls[0], ["tmux", "-V"]);
    assert.deepEqual(calls[1], ["tmux", "has-session", "-t", "qa-raw"]);
    assert.deepEqual(calls[2].slice(0, 5), ["tmux", "new-session", "-d", "-s", "qa-raw"]);
    assert.match(calls[2][5] ?? "", /codex --cd/);
    assert.match(calls[2][5] ?? "", /--no-alt-screen/);
    assert.match(calls[2][5] ?? "", /'--dangerously-bypass-approvals-and-sandbox' '--sandbox'/);
    assert.match(calls[2][5] ?? "", /'--sandbox' 'danger-full-access' '--ask-for-approval' 'never'/);
    assert.match(calls[2][5] ?? "", /'--model' 'gpt-5.4-mini'/);
    assert.match(calls[2][5] ?? "", /\$\(cat/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy start help without launching tmux", () => {
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };

  const commandHelp = runTypescriptRuntimeCommand({
    args: ["start", "--help"],
    codexCommandResolver: () => "codex",
    cwd: "/tmp",
    tmuxRunner: runner,
  });
  assert.equal(commandHelp.exitCode, 0);
  assert.match(commandHelp.stdout ?? "", /usage: conveyor start/);

  const sessionHelp = runTypescriptRuntimeCommand({
    args: ["start", "qa-help", "--help"],
    codexCommandResolver: () => "codex",
    cwd: "/tmp",
    tmuxRunner: runner,
  });
  assert.equal(sessionHelp.exitCode, 0);
  assert.match(sessionHelp.stdout ?? "", /usage: conveyor start/);
  assert.deepEqual(calls, []);
});

test("TypeScript runtime rejects non-create flags before legacy create/start-test launches", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-create-options."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const createResult = runTypescriptRuntimeCommand({
      args: ["create", "bad-create-option", "--cwd", repo, "--current-task", "oops"],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(createResult.exitCode, 2);
    assert.match(createResult.stderr ?? "", /Unsupported TypeScript runtime option for create/);

    const startTestResult = runTypescriptRuntimeCommand({
      args: ["start-test", "bad-start-test-option", "--cwd", repo, "--busy-wait-seconds", "7"],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startTestResult.exitCode, 2);
    assert.match(startTestResult.stderr ?? "", /Unsupported TypeScript runtime option for start-test/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(workerDir("bad-create-option", { cwd: root, env })), false);
    assert.equal(existsSync(workerDir("bad-start-test-option", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime reports invalid legacy cwd as runtime failure without state side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-bad-cwd."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    const missing = join(root, "missing");

    const startResult = runTypescriptRuntimeCommand({
      args: ["start", "bad-cwd-start", "--cwd", missing],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startResult.exitCode, 1);
    assert.match(startResult.stderr ?? "", /Session cwd does not exist or is not a directory/);

    const createResult = runTypescriptRuntimeCommand({
      args: ["create", "bad-cwd-create", "--cwd", missing],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(createResult.exitCode, 1);
    assert.match(createResult.stderr ?? "", /Worker cwd does not exist or is not a directory/);

    const startTestResult = runTypescriptRuntimeCommand({
      args: ["start-test", "bad-cwd-test", "--cwd", missing],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startTestResult.exitCode, 1);
    assert.match(startTestResult.stderr ?? "", /Worker cwd does not exist or is not a directory/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(workerDir("bad-cwd-create", { cwd: root, env })), false);
    assert.equal(existsSync(workerDir("bad-cwd-test", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime preflights Codex and tmux before legacy start and create launches", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-missing-codex."));
  const calls: string[][] = [];
  let tmuxMissing = false;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (tmuxMissing && args.join(" ") === "tmux -V") {
      return { status: 127, stderr: "tmux is not installed or is not available on PATH" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const startResult = runTypescriptRuntimeCommand({
      args: ["start", "missing-start", "--cwd", repo],
      codexCommandResolver: () => null,
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startResult.exitCode, 1);
    assert.match(startResult.stderr ?? "", /Required tool not found on PATH: codex/);

    const createResult = runTypescriptRuntimeCommand({
      args: ["create", "missing-create", "--cwd", repo],
      codexCommandResolver: () => null,
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(createResult.exitCode, 1);
    assert.match(createResult.stderr ?? "", /Required tool not found on PATH: codex/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(workerDir("missing-create", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);

    tmuxMissing = true;
    const missingTmuxResult = runTypescriptRuntimeCommand({
      args: ["create", "missing-tmux", "--cwd", repo],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(missingTmuxResult.exitCode, 1);
    assert.match(missingTmuxResult.stderr ?? "", /Required tool not found on PATH: tmux/);
    assert.deepEqual(calls, [["tmux", "-V"]]);
    assert.equal(existsSync(workerDir("missing-tmux", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy create dual-write and tmux launch", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-create."));
  const calls: string[][] = [];
  let spawned = false;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-db-create-dual-write") {
      return { status: spawned ? 0 : 1, stderr: spawned ? "" : "no session" };
    }
    if (args.join(" ") === "tmux list-panes -t codex-db-create-dual-write -F #{pane_id}") {
      return { status: 0, stdout: "%1\n" };
    }
    if (args.slice(0, 5).join(" ") === "tmux new-session -d -s codex-db-create-dual-write") {
      spawned = true;
      return { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const result = runTypescriptRuntimeCommand({
      args: ["create", "db-create-dual-write", "--cwd", repo, "--task", "Write initial status."],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      now: () => new Date("2026-06-05T01:02:03Z"),
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    assert.match(result.stdout ?? "", /created db-create-dual-write/);
    assert.match(result.stdout ?? "", /tmux session: codex-db-create-dual-write/);
    assert.match(result.stdout ?? "", /contract provided as initial Codex prompt/);

    const config = JSON.parse(readFileSync(configPath("db-create-dual-write", { cwd: root, env }), "utf8")) as {
      identity_token: string;
      tmux_pane_id: string;
      worker_id: string;
    };
    assert.match(config.identity_token, /^workerctl-/);
    assert.equal(config.tmux_pane_id, "%1");
    const contract = readFileSync(join(workerDir("db-create-dual-write", { cwd: root, env }), "contract.txt"), "utf8");
    assert.match(contract, new RegExp(config.identity_token));
    assert.match(contract, /Dispatcher inbox:/);
    assert.match(contract, /worker-inbox <task-name> --consume-next --wait --timeout 60 --json/);
    assert.match(contract, /dispatch_inbox_consumed/);
    assert.deepEqual(JSON.parse(readFileSync(statusPath("db-create-dual-write", { cwd: root, env }), "utf8")), {
      blocker: null,
      current_task: "Write initial status.",
      last_update: "2026-06-05T01:02:03Z",
      next_action: "Wait for manager instruction or begin assigned task.",
      state: "waiting",
    });
    assert.equal(readFileSync(transcriptPath("db-create-dual-write", { cwd: root, env }), "utf8"), "");
    const compatibilityEvents = readFileSync(eventsPath("db-create-dual-write", { cwd: root, env }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(compatibilityEvents.map((event) => event.type), ["create"]);
    const database = openDatabaseSync(defaultDbPath({ cwd: root, env }));
    try {
      const worker = database.prepare("select id, state, tmux_pane_id, identity_token from workers where name = ?")
        .get("db-create-dual-write") as { id: string; identity_token: string; state: string; tmux_pane_id: string };
      assert.equal(worker.id, config.worker_id);
      assert.equal(worker.state, "active");
      assert.equal(worker.tmux_pane_id, "%1");
      assert.equal(worker.identity_token, config.identity_token);
      const status = database.prepare("select state, current_task from statuses where worker_id = ?")
        .get(worker.id) as { current_task: string; state: string };
      assert.equal(status.state, "waiting");
      assert.equal(status.current_task, "Write initial status.");
      const dbEvents = database.prepare("select type from events where worker_id = ? order by id")
        .all(worker.id) as Array<{ type: string }>;
      assert.deepEqual(dbEvents.map((event) => event.type), ["worker_create_recorded", "worker_tmux_started"]);
    } finally {
      database.close();
    }
    const launch = calls.find((call) => call.slice(0, 5).join(" ") === "tmux new-session -d -s codex-db-create-dual-write");
    assert.ok(launch);
    assert.match(launch[5] ?? "", /codex --cd/);
    assert.match(launch[5] ?? "", /\$\(cat/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime leaves legacy create worker candidate when tmux launch fails", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-create-fail."));
  const runner: TmuxRunner = (args) => {
    if (args.join(" ") === "tmux has-session -t codex-db-create-fail") {
      return { status: 1, stderr: "no session" };
    }
    if (args.slice(0, 5).join(" ") === "tmux new-session -d -s codex-db-create-fail") {
      return { status: 1, stderr: "tmux refused launch" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const result = runTypescriptRuntimeCommand({
      args: ["create", "db-create-fail", "--cwd", repo, "--task", "Write initial status."],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      now: () => new Date("2026-06-05T01:02:03Z"),
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr ?? "", /tmux refused launch/);
    const database = openDatabaseSync(defaultDbPath({ cwd: root, env }));
    try {
      const worker = database.prepare("select state from workers where name = ?")
        .get("db-create-fail") as { state: string };
      assert.equal(worker.state, "candidate");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy start-test preset with wait-ready and verify", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-test."));
  const calls: string[][] = [];
  let spawned = false;
  const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-live-test") {
      return { status: spawned ? 0 : 1, stderr: spawned ? "" : "no session" };
    }
    if (args.join(" ") === "tmux list-panes -t codex-live-test -F #{pane_id}") {
      return { status: 0, stdout: "%2\n" };
    }
    if (args.slice(0, 5).join(" ") === "tmux new-session -d -s codex-live-test") {
      spawned = true;
      return { status: 0, stdout: "" };
    }
    if (args.join(" ") === "tmux capture-pane -p -S -80 -t codex-live-test") {
      writeFileSync(statusPath("live-test", { cwd: root, env }), `${JSON.stringify({
        blocker: null,
        current_task: "README checked",
        last_update: "2026-06-05T01:02:04Z",
        next_action: "report",
        state: "planning",
      }, null, 2)}\n`);
      return { status: 0, stdout: "OpenAI Codex\n› " };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    const result = runTypescriptRuntimeCommand({
      args: ["start-test", "--cwd", repo, "--wait-ready-timeout", "1", "--verify-timeout", "1"],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      now: () => new Date("2026-06-05T01:02:03Z"),
      sleepMilliseconds: () => {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    assert.match(result.stdout ?? "", /created live-test/);
    assert.match(result.stdout ?? "", /startup: ready \(Codex input prompt is visible\)/);
    assert.match(result.stdout ?? "", /verification: ok \(status update observed\)/);
    assert.match(result.stdout ?? "", /current task: README checked/);
    const contract = readFileSync(join(workerDir("live-test", { cwd: root, env }), "contract.txt"), "utf8");
    assert.match(contract, /Read README\.md and run conveyor update-status live-test/);
    const compatibilityEvents = readFileSync(eventsPath("live-test", { cwd: root, env }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(compatibilityEvents.map((event) => event.type), ["create", "wait_ready", "verify"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles start-worker spawn and register with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-worker."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-auto-foo") {
      return { status: 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-worker.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "cuid-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "start-worker",
        "--name",
        "auto-foo",
        "--cwd",
        "/repo",
        "--task",
        "Do work",
        "--codex-profile",
        "yolo",
        "--accept-trust",
        "--timeout-seconds",
        "7",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "/opt/test/bin/codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        assert.equal(options.acceptTrust, true);
        assert.equal(options.timeoutSeconds, 7);
        assert.equal(options.tmuxSessionName, "codex-auto-foo");
        assert.ok(options.minimumSessionTimestamp instanceof Date);
        return {
          codex_session_id: "cuid-worker",
          codex_session_path: rollout,
          cwd: "/repo",
          native_pid: 99999,
          originator: "codex-tui",
        };
      },
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      codex_session_id: string;
      codex_session_path: string;
      cwd: string;
      name: string;
      pid: number;
      role: string;
      session_id: string;
      tmux_session: string;
    };
    assert.equal(payload.name, "auto-foo");
    assert.equal(payload.role, "worker");
    assert.equal(payload.pid, 99999);
    assert.equal(payload.codex_session_id, "cuid-worker");
    assert.equal(payload.codex_session_path, rollout);
    assert.equal(payload.cwd, "/repo");
    assert.match(payload.session_id, /^session-/);
    assert.equal(payload.tmux_session, "codex-auto-foo");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ["tmux", "has-session", "-t", "codex-auto-foo"]);
    assert.deepEqual(calls[1].slice(0, 7), ["tmux", "new-session", "-d", "-s", "codex-auto-foo", "-c", "/repo"]);
    const codexShell = calls[1][7] ?? "";
    assert.match(codexShell, /unset "\$name"/);
    assert.match(codexShell, /PNPM_SCRIPT_SRC_DIR/);
    assert.match(codexShell, /exec \/opt\/test\/bin\/codex --sandbox danger-full-access --ask-for-approval never 'Do work'/);
    assert.deepEqual(calls[2], ["tmux", "send-keys", "-t", "codex-auto-foo", "Enter"]);

    const database = openDatabaseSync(dbPath);
    try {
      const session = database.prepare("select name, role, pid, codex_session_id, tmux_session from sessions where name = 'auto-foo'")
        .get() as { codex_session_id: string; name: string; pid: number; role: string; tmux_session: string };
      assert.equal(session.codex_session_id, "cuid-worker");
      assert.equal(session.name, "auto-foo");
      assert.equal(session.pid, 99999);
      assert.equal(session.role, "worker");
      assert.equal(session.tmux_session, "codex-auto-foo");
      const event = database.prepare("select payload_json from events where type = 'session_registered'")
        .get() as { payload_json: string };
      assert.deepEqual(JSON.parse(event.payload_json), {
        codex_session_id: "cuid-worker",
        name: "auto-foo",
        pid: 99999,
        role: "worker",
        session_id: payload.session_id,
        via: "start-worker",
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles start-manager bootstrap with seeded manager config", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-manager."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-auto-mgr") {
      return { status: 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "cuid-manager", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Ship the support queue reporter",
        name: "late-task",
        taskId: "task-late",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json, acceptance_criteria_json, reference_paths_json,
          permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks, revision, created_at, updated_at
        )
        values (?, 'strict', ?, '[]', ?, '[]', '{}', ?, '[]', 'ask-operator', 0, 1, ?, ?)
      `).run(
        "task-late",
        "Verify the reporter with pytest evidence.",
        JSON.stringify(["pytest passes"]),
        JSON.stringify(["pytest"]),
        "2026-06-04T14:00:00Z",
        "2026-06-04T14:00:00Z",
      );
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: [
        "start-manager",
        "--name",
        "auto-mgr",
        "--cwd",
        "/repo",
        "--task",
        "late-task",
        "--worker",
        "late-worker",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: () => ({
        codex_session_id: "cuid-manager",
        codex_session_path: rollout,
        cwd: "/repo",
        native_pid: 88888,
        originator: "codex-tui",
      }),
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as { name: string; role: string; tmux_session: string };
    assert.equal(payload.name, "auto-mgr");
    assert.equal(payload.role, "manager");
    assert.equal(payload.tmux_session, "codex-auto-mgr");
    assert.deepEqual(calls[0], ["tmux", "has-session", "-t", "codex-auto-mgr"]);
    const codexShell = calls[1][7] ?? "";
    assert.match(codexShell, /You are a Codex manager session/);
    assert.match(codexShell, /Task: late-task/);
    assert.match(codexShell, /Task goal: Ship the support queue reporter/);
    assert.match(codexShell, /Worker session: late-worker/);
    assert.match(codexShell, /Manager config has already been recorded/);
    assert.ok(codexShell.includes("cycle late-task --path"));
    assert.ok(codexShell.includes(dbPath));
    assert.match(codexShell, /Expected tools: pytest\./);
    assert.ok(codexShell.includes("manager-ack late-task --from-stdin --path"));
    assert.ok(codexShell.includes("worker-ack late-task --json --path"));
    assert.ok(codexShell.includes("criteria late-task --satisfy <id> --proof"));
    assert.ok(codexShell.includes("Keep manager closeout/control-plane proof out of accepted worker criteria"));
    assert.ok(codexShell.includes('finish-task late-task --reason "Accepted criteria satisfied" --require-criteria-audit --path'));

    const after = openDatabaseSync(dbPath);
    try {
      const session = after.prepare("select role, pid, tmux_session from sessions where name = 'auto-mgr'")
        .get() as { pid: number; role: string; tmux_session: string };
      assert.equal(session.pid, 88888);
      assert.equal(session.role, "manager");
      assert.equal(session.tmux_session, "codex-auto-mgr");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy open dry-run and prior open guard", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-open."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-worker-open") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: "unexpected tmux command" };
  };
  try {
    const name = "worker-open";
    const workerDir = join(root, ".codex-workers", name);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(configPath(name, { cwd: root, env: {} }), `${JSON.stringify({
      name,
      tmux_session: "codex-worker-open",
    })}\n`);

    const dryRun = runTypescriptRuntimeCommand({
      args: ["open", name, "--terminal", "ghostty", "--dry-run"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    assert.equal(dryRun.handled, true);
    assert.deepEqual(JSON.parse(dryRun.stdout ?? "{}"), {
      attach_command: "tmux attach -t codex-worker-open",
      command: ["open", "-na", "Ghostty.app", "--args", "-e", "tmux", "attach", "-t", "codex-worker-open"],
      dry_run: true,
      force: false,
      name,
      terminal: "ghostty",
      tmux_session: "codex-worker-open",
    });
    assert.deepEqual(calls, [["tmux", "has-session", "-t", "codex-worker-open"]]);
    assert.equal(existsSync(eventsPath(name, { cwd: root, env: {} })), false);

    writeFileSync(eventsPath(name, { cwd: root, env: {} }), `${JSON.stringify({
      terminal: "ghostty",
      time: "2026-06-04T01:00:00Z",
      type: "open_attempt",
    })}\n`);
    const guarded = runTypescriptRuntimeCommand({
      args: ["open", name, "--terminal", "ghostty", "--dry-run"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(guarded.exitCode, 1);
    assert.match(guarded.stderr ?? "", /terminal launch attempted/);
    assert.match(guarded.stderr ?? "", /--force/);

    const forced = runTypescriptRuntimeCommand({
      args: ["open", name, "--terminal", "ghostty", "--dry-run", "--force"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(forced.exitCode, 0, forced.stderr);
    const forcedPayload = JSON.parse(forced.stdout ?? "{}") as { force: boolean };
    assert.equal(forcedPayload.force, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles open-worker and open-manager dry-run from session binding", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-open-session."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (
      args.join(" ") === "tmux has-session -t codex-open-worker"
      || args.join(" ") === "tmux has-session -t codex-open-manager"
    ) {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: "unexpected tmux command" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Open the bound terminals.",
        name: "task-open",
        taskId: "task-open-id",
      });
      insertSession(database, {
        id: "session-worker-open",
        name: "open-worker-session",
        role: "worker",
        tmuxSession: "codex-open-worker",
      });
      insertSession(database, {
        id: "session-manager-open",
        name: "open-manager-session",
        role: "manager",
        tmuxSession: "codex-open-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-open",
        managerSessionName: "open-manager-session",
        taskName: "task-open",
        workerSessionName: "open-worker-session",
      });
    } finally {
      database.close();
    }

    const worker = runTypescriptRuntimeCommand({
      args: ["open-worker", "task-open", "--terminal", "terminal", "--dry-run", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(worker.exitCode, 0, worker.stderr);
    assert.deepEqual(JSON.parse(worker.stdout ?? "{}"), {
      attach_command: "tmux attach -t codex-open-worker",
      command: [
        "osascript",
        "-e",
        "tell application \"Terminal\" to activate",
        "-e",
        "tell application \"Terminal\" to do script \"tmux attach -t codex-open-worker\"",
      ],
      dry_run: true,
      task: "task-open",
      terminal: "terminal",
      tmux_session: "codex-open-worker",
      worker: "open-worker-session",
    });

    const manager = runTypescriptRuntimeCommand({
      args: ["open-manager", "task-open", "--terminal", "terminal", "--dry-run", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(manager.exitCode, 0, manager.stderr);
    assert.deepEqual(JSON.parse(manager.stdout ?? "{}"), {
      attach_command: "tmux attach -t codex-open-manager",
      command: [
        "osascript",
        "-e",
        "tell application \"Terminal\" to activate",
        "-e",
        "tell application \"Terminal\" to do script \"tmux attach -t codex-open-manager\"",
      ],
      dry_run: true,
      manager: "open-manager-session",
      task: "task-open",
      terminal: "terminal",
      tmux_session: "codex-open-manager",
    });
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "codex-open-worker"],
      ["tmux", "has-session", "-t", "codex-open-manager"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy stop with optional message and compatibility events", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-stop-legacy."));
  const calls: string[][] = [];
  const runningSessions = new Set(["codex-stop-legacy"]);
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === "tmux" && args[1] === "has-session") {
      const target = args.at(-1) ?? "";
      return { status: runningSessions.has(target) ? 0 : 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const name = "stop-legacy";
    mkdirSync(join(root, ".codex-workers", name), { recursive: true });
    writeFileSync(configPath(name, { cwd: root, env: {} }), `${JSON.stringify({
      name,
      tmux_session: "codex-stop-legacy",
    })}\n`);

    const stopped = runTypescriptRuntimeCommand({
      args: ["stop", name, "--message", "wrap it up"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    assert.equal(stopped.handled, true);
    assert.equal(stopped.stdout, "stopped stop-legacy\n");
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "codex-stop-legacy"],
      ["tmux", "has-session", "-t", "codex-stop-legacy"],
      ["tmux", "set-buffer", "-b", "workerctl-stop-legacy", "wrap it up"],
      ["tmux", "paste-buffer", "-b", "workerctl-stop-legacy", "-t", "codex-stop-legacy"],
      ["tmux", "send-keys", "-t", "codex-stop-legacy", "C-m"],
      ["tmux", "delete-buffer", "-b", "workerctl-stop-legacy"],
      ["tmux", "has-session", "-t", "codex-stop-legacy"],
      ["tmux", "kill-session", "-t", "codex-stop-legacy"],
    ]);
    const legacyEvents = readFileSync(eventsPath(name, { cwd: root, env: {} }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(legacyEvents.map((event) => event.type), ["stop_message", "stop"]);
    assert.equal(legacyEvents[0].message, "wrap it up");
    assert.equal(legacyEvents[1].killed_session, true);

    const idleName = "stop-idle";
    mkdirSync(join(root, ".codex-workers", idleName), { recursive: true });
    writeFileSync(configPath(idleName, { cwd: root, env: {} }), `${JSON.stringify({
      name: idleName,
      tmux_session: "codex-stop-idle",
    })}\n`);
    calls.length = 0;
    const idle = runTypescriptRuntimeCommand({
      args: ["stop", idleName],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(idle.exitCode, 0, idle.stderr);
    assert.equal(idle.stdout, "stop-idle was not running\n");
    assert.deepEqual(calls, [["tmux", "has-session", "-t", "codex-stop-idle"]]);
    const idleEvents = readFileSync(eventsPath(idleName, { cwd: root, env: {} }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(idleEvents, [{ killed_session: false, time: idleEvents[0].time, type: "stop" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles session-backed stop and marks the registered session gone", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-stop-session."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t manager-stop-tmux") {
      return { status: 0, stdout: "" };
    }
    if (args.join(" ") === "tmux kill-session -t manager-stop-tmux") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: "unexpected tmux command" };
  };
  try {
    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      insertSession(database, {
        id: "session-stop-manager",
        name: "session-stop-manager",
        role: "manager",
        tmuxPaneId: "%9",
        tmuxSession: "manager-stop-tmux",
      });
    } finally {
      database.close();
    }

    const stopped = runTypescriptRuntimeCommand({
      args: ["stop", "session-stop-manager"],
      cwd: root,
      env: {},
      now: () => new Date("2026-06-04T12:34:56.000Z"),
      tmuxRunner: runner,
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    assert.equal(stopped.handled, true);
    assert.equal(stopped.stdout, "stopped session-stop-manager\n");
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "manager-stop-tmux"],
      ["tmux", "kill-session", "-t", "manager-stop-tmux"],
    ]);

    const after = openDatabaseSync(dbPath);
    try {
      const session = after.prepare("select state, last_heartbeat_at from sessions where name = ?")
        .get("session-stop-manager") as { last_heartbeat_at: string; state: string };
      assert.equal(session.state, "gone");
      assert.equal(session.last_heartbeat_at, "2026-06-04T12:34:56Z");
      const event = after.prepare("select payload_json from events where type = 'session_stopped'")
        .get() as { payload_json: string };
      assert.deepEqual(JSON.parse(event.payload_json), {
        killed_session: true,
        role: "manager",
        session: "session-stop-manager",
        target: "manager-stop-tmux",
      });
    } finally {
      after.close();
    }
    const compatibilityEvents = readFileSync(eventsPath("session-stop-manager", { cwd: root, env: {} }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(compatibilityEvents, [{
      killed_session: true,
      lookup_source: "session",
      role: "manager",
      target: "manager-stop-tmux",
      time: compatibilityEvents[0].time,
      type: "stop",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime pair dry-run keeps Python default dispatch and accepts json", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-dry-run."));
  try {
    const dbPath = join(root, "workerctl.db");
    const binDir = join(root, "bin");
    const workerctlBin = join(binDir, "workerctl");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(workerctlBin, "#!/bin/sh\nexit 0\n");
    chmodSync(workerctlBin, 0o755);
    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--path",
        dbPath,
        "--dry-run",
        "--json",
      ],
      env: { PATH: `${binDir}:/bin:/usr/bin` },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      dispatch_command: string[];
      ensure_dispatch: boolean;
      manager: string;
      task: string;
      worker: string;
    };
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.manager, "pair-manager");
    assert.equal(payload.task, "pair-task");
    assert.equal(payload.worker, "pair-worker");
    assert.deepEqual(payload.dispatch_command.slice(0, 4), [
      workerctlBin,
      "dispatch",
      "--watch",
      "--dispatcher-id",
    ]);
    assert.ok(payload.dispatch_command.includes("dispatch-pair"));
    assert.ok(payload.dispatch_command.includes(dbPath));

    const withoutDispatch = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--path",
        dbPath,
        "--dry-run",
        "--no-dispatch",
      ],
      env: { PATH: `${binDir}:/bin:/usr/bin` },
    });
    assert.equal(withoutDispatch.exitCode, 0, withoutDispatch.stderr);
    const withoutDispatchPayload = JSON.parse(withoutDispatch.stdout ?? "{}") as {
      dispatch_command: string[] | null;
      ensure_dispatch: boolean;
    };
    assert.equal(withoutDispatchPayload.ensure_dispatch, false);
    assert.equal(withoutDispatchPayload.dispatch_command, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime pair preflights tmux before mutating task state", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-preflight."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux -V") {
      return { status: 0, stdout: "tmux 3.5a" };
    }
    if (args.join(" ") === "tmux start-server") {
      return { status: 1, stderr: "tmux access denied" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const binDir = join(root, "bin");
    const workerctlBin = join(binDir, "workerctl");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(workerctlBin, "#!/bin/sh\nexit 0\n");
    chmodSync(workerctlBin, 0o755);

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      env: { PATH: `${binDir}:/bin:/usr/bin` },
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /tmux access denied/);
    assert.deepEqual(calls, [
      ["tmux", "-V"],
      ["tmux", "start-server"],
    ]);
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles pair spawn bind run and dispatch with fake runners", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair."));
  const calls: string[][] = [];
  const dispatches: Array<{ command: string[]; cwd: string }> = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-pair-worker") {
      return { status: 1, stderr: "no worker session" };
    }
    if (args.join(" ") === "tmux has-session -t codex-pair-manager") {
      return { status: 1, stderr: "no manager session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const binDir = join(root, "bin");
    const workerctlBin = join(binDir, "workerctl");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(workerctlBin, "#!/bin/sh\nexit 0\n");
    chmodSync(workerctlBin, 0o755);
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    const managerRollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);
    writeFileSync(managerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-manager", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--task-prompt",
        "Do the worker part",
        "--manager-recipe",
        "goalbuddy",
        "--manager-permit",
        "verification.run_pytest",
        "--manager-tool",
        "verification.run_tests",
        "--manager-tool",
        "verification.run_tests",
        "--manager-epilogue",
        "draft-pr",
        "--manager-epilogue",
        "draft-pr",
        "--manager-nudge-on-completion",
        "auto-proceed",
        "--manager-require-acks",
        "--manager-allow-pr",
        "--manager-allow-merge-green",
        "--manager-allow-worker-compact-clear",
        "--manager-permissions-json",
        JSON.stringify({ context: ["fetch_prs"], "repo.push_branch": true }),
        "--dispatcher-id",
        "dispatch-pair-test",
        "--cwd",
        "/repo",
        "--path",
        dbPath,
        "--timeout-seconds",
        "9",
        "--accept-trust",
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        assert.equal(options.acceptTrust, true);
        assert.equal(options.timeoutSeconds, 9);
        if (options.tmuxSessionName === "codex-pair-worker") {
          return {
            codex_session_id: "codex-worker",
            codex_session_path: workerRollout,
            cwd: "/repo",
            native_pid: 11111,
            originator: "codex-tui",
          };
        }
        assert.equal(options.tmuxSessionName, "codex-pair-manager");
        return {
          codex_session_id: "codex-manager",
          codex_session_path: managerRollout,
          cwd: "/repo",
          native_pid: 22222,
          originator: "codex-tui",
        };
      },
      dispatchRunner: (command: string[], options: { cwd: string }) => {
        dispatches.push({ command, cwd: options.cwd });
        return { pid: 33333 };
      },
      env: { PATH: `${binDir}:/bin:/usr/bin` },
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      binding_id: string;
      dispatch: { command: string[]; ensure: boolean; pid: number; started: boolean };
      dispatch_command: string[];
      ensure_dispatch: boolean;
      manager: { name: string; pid: number; role: string; tmux_session: string };
      manager_config_seeded: boolean;
      manager_config_seeded_by_pair: boolean;
      run_id: string;
      task: { created: boolean; id: string; name: string };
      worker: { name: string; pid: number; role: string; tmux_session: string };
    };
    assert.equal(payload.task.name, "pair-task");
    assert.equal(payload.task.created, true);
    assert.match(payload.task.id, /^task-/);
    assert.equal(payload.worker.name, "pair-worker");
    assert.equal(payload.worker.role, "worker");
    assert.equal(payload.worker.pid, 11111);
    assert.equal(payload.worker.tmux_session, "codex-pair-worker");
    assert.equal(payload.manager.name, "pair-manager");
    assert.equal(payload.manager.role, "manager");
    assert.equal(payload.manager.pid, 22222);
    assert.equal(payload.manager.tmux_session, "codex-pair-manager");
    assert.match(payload.binding_id, /^binding-/);
    assert.match(payload.run_id, /^run-/);
    assert.equal(payload.manager_config_seeded, true);
    assert.equal(payload.manager_config_seeded_by_pair, true);
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.dispatch.ensure, true);
    assert.equal(payload.dispatch.started, true);
    assert.equal(payload.dispatch.pid, 33333);
    assert.deepEqual(payload.dispatch.command, payload.dispatch_command);
    assert.deepEqual(dispatches, [{
      command: payload.dispatch_command,
      cwd: process.cwd(),
    }]);
    assert.deepEqual(payload.dispatch_command.slice(0, 4), [
      workerctlBin,
      "dispatch",
      "--watch",
      "--dispatcher-id",
    ]);
    assert.ok(payload.dispatch_command.includes("dispatch-pair-test"));
    assert.ok(payload.dispatch_command.includes("--path"));
    assert.ok(payload.dispatch_command.includes(dbPath));

    assert.deepEqual(calls.filter((args) => args[0] === "tmux" && args[1] === "send-keys"), [
      ["tmux", "send-keys", "-t", "codex-pair-worker", "Enter"],
      ["tmux", "send-keys", "-t", "codex-pair-manager", "Enter"],
    ]);
    const workerShell = calls.find((args) => args[1] === "new-session" && args.includes("codex-pair-worker"))?.at(-1) ?? "";
    const managerShell = calls.find((args) => args[1] === "new-session" && args.includes("codex-pair-manager"))?.at(-1) ?? "";
    assert.match(workerShell, /Do the worker part/);
    assert.ok(workerShell.includes("worker-ack pair-task --from-stdin --path"));
    assert.ok(workerShell.includes("Do not call `conveyor finish-task`; the manager owns criteria satisfaction"));
    assert.ok(workerShell.includes(dbPath));
    assert.match(managerShell, /You are a Codex manager session/);
    assert.match(managerShell, /Task: pair-task/);
    assert.match(managerShell, /Task goal: Build a thing/);
    assert.match(managerShell, /Worker session: pair-worker/);
    assert.match(managerShell, /Manager config has already been recorded/);
    assert.ok(managerShell.includes("cycle pair-task --path"));
    assert.ok(managerShell.includes("manager-ack pair-task --from-stdin --path"));
    assert.ok(managerShell.includes("worker-ack pair-task --json --path"));
    assert.ok(managerShell.includes("criteria pair-task --satisfy <id> --proof"));
    assert.ok(managerShell.includes("Keep manager closeout/control-plane proof out of accepted worker criteria"));
    assert.ok(managerShell.includes('finish-task pair-task --reason "Accepted criteria satisfied" --require-criteria-audit --path'));
    assert.ok(managerShell.includes(dbPath));

    const database = openDatabaseSync(dbPath);
    try {
      const task = database.prepare("select id, name, goal from tasks where name = ?")
        .get("pair-task") as { goal: string; id: string; name: string };
      assert.equal(task.id, payload.task.id);
      assert.equal(task.goal, "Build a thing");
      const binding = database.prepare("select task_id, state from bindings where id = ?")
        .get(payload.binding_id) as { state: string; task_id: string };
      assert.equal(binding.task_id, payload.task.id);
      assert.equal(binding.state, "active");
      const run = database.prepare("select task_id, status, metadata_json from runs where id = ?")
        .get(payload.run_id) as { metadata_json: string; status: string; task_id: string };
      assert.equal(run.task_id, payload.task.id);
      assert.equal(run.status, "active");
      assert.deepEqual(JSON.parse(run.metadata_json), {
        binding_id: payload.binding_id,
        manager: "pair-manager",
        manager_config_seeded: true,
        manager_config_seeded_by_pair: true,
        source: "pair",
        worker: "pair-worker",
      });
      const managerConfig = database.prepare(`
        select recipe_name, permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks
        from manager_configs
        where task_id = ?
      `).get(payload.task.id) as {
        epilogues_json: string;
        nudge_on_completion: string;
        permissions_json: string;
        recipe_name: string;
        require_acks: number;
        tools_json: string;
      };
      assert.equal(managerConfig.recipe_name, "goalbuddy-conveyor");
      assert.deepEqual(JSON.parse(managerConfig.permissions_json), {
        communication: [],
        context: ["fetch_prs"],
        repo: ["merge_green_pr", "open_pr", "push_branch"],
        verification: ["run_pytest"],
        worker_session: ["clear", "compact"],
      });
      assert.deepEqual(JSON.parse(managerConfig.tools_json), ["verification.run_tests"]);
      assert.deepEqual(JSON.parse(managerConfig.epilogues_json), ["draft-pr"]);
      assert.equal(managerConfig.nudge_on_completion, "auto-proceed");
      assert.equal(managerConfig.require_acks, 1);
      const eventTypes = database.prepare("select event_type from telemetry_events where task_id = ? order by rowid")
        .all(payload.task.id)
        .map((row) => (row as { event_type: string }).event_type);
      assert.deepEqual(eventTypes, [
        "pair_started",
        "pair_task_resolved",
        "pair_manager_config_seeded",
        "pair_worker_spawned",
        "pair_manager_spawned",
        "pair_binding_created",
        "pair_run_created",
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime records pair failure telemetry after partial spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-failure."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-pair-worker") {
      return { status: 1, stderr: "no worker session" };
    }
    if (args.join(" ") === "tmux has-session -t codex-pair-manager") {
      return { status: 1, stderr: "no manager session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--cwd",
        "/repo",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        assert.equal(options.timeoutSeconds, 60);
        if (options.tmuxSessionName === "codex-pair-worker") {
          return {
            codex_session_id: "codex-worker",
            codex_session_path: workerRollout,
            cwd: "/repo",
            native_pid: 11111,
            originator: "codex-tui",
          };
        }
        throw new Error("manager rollout did not appear");
      },
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /manager rollout did not appear/);
    assert.equal(calls.filter((args) => args[1] === "new-session").length, 2);

    const database = openDatabaseSync(dbPath);
    try {
      const task = database.prepare("select id from tasks where name = ?").get("pair-task") as { id: string };
      const sessions = database.prepare("select name, role from sessions order by registered_at")
        .all() as Array<{ name: string; role: string }>;
      assert.deepEqual(sessions.map((session) => `${session.role}:${session.name}`), ["worker:pair-worker"]);
      const events = database.prepare(`
        select event_type, severity, attributes_json
        from telemetry_events
        where task_id = ?
        order by rowid
      `).all(task.id) as Array<{ attributes_json: string; event_type: string; severity: string }>;
      assert.deepEqual(events.map((event) => event.event_type), [
        "pair_started",
        "pair_task_resolved",
        "pair_manager_config_seeded",
        "pair_worker_spawned",
        "pair_failed",
      ]);
      const failure = events.at(-1);
      const failureAttributes = JSON.parse(failure?.attributes_json ?? "{}") as Record<string, unknown>;
      assert.equal(failure?.severity, "error");
      assert.deepEqual(failureAttributes, {
        binding_created: false,
        error: failureAttributes.error,
        error_type: "Error",
        manager_spawned: false,
        run_created: false,
        worker_spawned: true,
      });
      assert.match(String(failureAttributes.error), /manager rollout did not appear/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime pair reuses a recent matching dispatch heartbeat", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-heartbeat."));
  const calls: string[][] = [];
  const dispatches: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-pair-worker") {
      return { status: 1, stderr: "no worker session" };
    }
    if (args.join(" ") === "tmux has-session -t codex-pair-manager") {
      return { status: 1, stderr: "no manager session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    const managerRollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);
    writeFileSync(managerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-manager", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      database.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity,
          summary, correlation_json, attributes_json
        )
        values (?, null, null, ?, 'dispatch', 'dispatch_watch_heartbeat', 'info', ?, ?, ?)
      `).run(
        "heartbeat-pair",
        "2026-06-04T12:00:00.000Z",
        "Dispatch watch heartbeat.",
        JSON.stringify({ dispatcher_id: "dispatch-pair-test", iteration: 12 }),
        JSON.stringify({ dry_run: false, processed_count: 0 }),
      );
      database.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity,
          summary, correlation_json, attributes_json
        )
        values (?, null, null, ?, 'dispatch', 'dispatch_watch_heartbeat', 'info', ?, ?, ?)
      `).run(
        "heartbeat-other",
        "2026-06-04T12:00:04.000Z",
        "Dispatch watch heartbeat.",
        JSON.stringify({ dispatcher_id: "other-dispatcher", iteration: 99 }),
        JSON.stringify({ dry_run: false, processed_count: 0 }),
      );
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--dispatcher-id",
        "dispatch-pair-test",
        "--cwd",
        "/repo",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        if (options.tmuxSessionName === "codex-pair-worker") {
          return {
            codex_session_id: "codex-worker",
            codex_session_path: workerRollout,
            cwd: "/repo",
            native_pid: 11111,
            originator: "codex-tui",
          };
        }
        return {
          codex_session_id: "codex-manager",
          codex_session_path: managerRollout,
          cwd: "/repo",
          native_pid: 22222,
          originator: "codex-tui",
        };
      },
      dispatchRunner: (command) => {
        dispatches.push(command);
        return { pid: 33333 };
      },
      env: {},
      now: () => new Date("2026-06-04T12:00:05.000Z"),
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      dispatch: { ensure: boolean; pid: number | null; started: boolean };
      ensure_dispatch: boolean;
    };
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.dispatch.ensure, true);
    assert.equal(payload.dispatch.started, false);
    assert.equal(payload.dispatch.pid, null);
    assert.deepEqual(dispatches, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime default start-worker discovery polls process tree before register", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-discovery."));
  const calls: string[][] = [];
  let lsofAttempts = 0;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-poll-worker") {
      return { status: 1, stderr: "no session" };
    }
    if (args.join(" ") === "tmux list-panes -t codex-poll-worker -F #{pane_pid}") {
      return { status: 0, stdout: "101\n" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-polled.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: {
        cwd: "/repo",
        id: "cuid-polled",
        originator: "codex-tui",
        timestamp: "2026-06-04T14:00:05.000Z",
      },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "start-worker",
        "--name",
        "poll-worker",
        "--cwd",
        "/repo",
        "--task",
        "Poll work",
        "--timeout-seconds",
        "1",
        "--path",
        dbPath,
      ],
      childrenForPid: (pid) => (pid === 101 ? [202] : []),
      cwd: root,
      env: {},
      lsofForPid: (pid) => {
        if (pid !== 202) {
          throw new Error(`no rollout for ${pid}`);
        }
        lsofAttempts += 1;
        if (lsofAttempts === 1) {
          throw new Error("native process has not opened rollout yet");
        }
        return `codex ${pid} neon txt REG 1,2 3 4 ${rollout}\n`;
      },
      now: () => new Date("2026-06-04T14:00:00.000Z"),
      sleepMilliseconds: () => {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as { codex_session_id: string; name: string; pid: number };
    assert.equal(payload.name, "poll-worker");
    assert.equal(payload.pid, 202);
    assert.equal(payload.codex_session_id, "cuid-polled");
    assert.equal(lsofAttempts, 2);
    assert.deepEqual(calls[0], ["tmux", "has-session", "-t", "codex-poll-worker"]);
    assert.deepEqual(calls[1].slice(0, 7), ["tmux", "new-session", "-d", "-s", "codex-poll-worker", "-c", "/repo"]);
    assert.deepEqual(calls[2], ["tmux", "list-panes", "-t", "codex-poll-worker", "-F", "#{pane_pid}"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime refuses start-worker duplicate session before tmux spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-duplicate."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      insertSession(database, {
        id: "session-taken-id",
        name: "taken",
        role: "worker",
      });
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["start-worker", "--name", "taken", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /a session named "taken" is already registered/);
    assert.deepEqual(calls, []);
    const after = openDatabaseSync(dbPath);
    try {
      const eventCount = after.prepare("select count(*) as count from events where type = 'session_registered'")
        .get() as { count: number };
      assert.equal(eventCount.count, 0);
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles classify ingest and tail by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-ingest."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-tail.jsonl");
    writeFileSync(rollout, [
      JSON.stringify({
        payload: { cli_version: "1.2.3", cwd: root, id: "codex-tail", originator: "codex" },
        timestamp: "2026-06-04T12:00:00Z",
        type: "session_meta",
      }),
      "{not-json}",
      JSON.stringify({
        payload: {
          message: "hello\nthere",
          nested: { content: "" },
          output: "screen",
          type: "user_message",
        },
        timestamp: "2026-06-04T12:01:00Z",
        type: "event_msg",
      }),
      JSON.stringify({
        payload: { text: "model line\n", type: "assistant_message" },
        timestamp: "2026-06-04T12:02:00Z",
        type: "response_item",
      }),
      JSON.stringify({
        payload: { content: "complete", type: "task_complete" },
        timestamp: "2026-06-04T12:03:00Z",
        type: "event_msg",
      }),
    ].join("\n") + "\n");

    const classified = runTypescriptRuntimeCommand({
      args: ["classify", "--text", "OpenAI Codex\n›"],
      cwd: root,
      env: {},
    });
    assert.equal(classified.exitCode, 0);
    assert.equal(classified.handled, true);
    assert.deepEqual(JSON.parse(classified.stdout ?? "{}"), {
      busy_wait: null,
      busy_wait_seconds: 90,
      startup: "ready",
      startup_reason: "Codex input prompt is visible",
      status_age_seconds: 90,
    });

    const classifyInput = join(root, "capture.txt");
    writeFileSync(classifyInput, "Starting MCP servers\n");
    const classifiedFile = runTypescriptRuntimeCommand({
      args: ["classify", "--file", classifyInput, "--status-age-seconds", "120", "--busy-wait-seconds", "60"],
      cwd: root,
      env: {},
    });
    const classifiedFilePayload = JSON.parse(classifiedFile.stdout ?? "{}") as {
      busy_wait: { pattern: string; recommended_action: string } | null;
      startup: string;
    };
    assert.equal(classifiedFile.exitCode, 0);
    assert.equal(classifiedFilePayload.startup, "starting");
    assert.deepEqual(classifiedFilePayload.busy_wait, {
      pattern: "mcp_startup",
      reason: "terminal shows Codex waiting on MCP server startup",
      recommended_action: "inspect_or_interrupt",
    });

    const missingClassifyInput = runTypescriptRuntimeCommand({
      args: ["classify"],
      cwd: root,
      env: {},
    });
    assert.equal(missingClassifyInput.exitCode, 2);
    assert.match(missingClassifyInput.stderr ?? "", /classify requires --text or --file/);

    const registered = runTypescriptRuntimeCommand({
      args: [
        "register-worker",
        "--name",
        "worker-tail",
        "--pid",
        "789",
        "--codex-session",
        rollout,
      ],
      cwd: root,
      env: {},
    });
    assert.equal(registered.exitCode, 0);

    const ingested = runTypescriptRuntimeCommand({
      args: ["ingest", "worker-tail"],
      cwd: root,
      env: {},
    });
    assert.equal(ingested.exitCode, 0);
    assert.equal(ingested.handled, true);
    const ingestPayload = JSON.parse(ingested.stdout ?? "{}") as {
      new_events: number;
      new_offset: number;
      session: string;
      skipped_lines: number;
    };
    assert.equal(ingestPayload.session, "worker-tail");
    assert.equal(ingestPayload.new_events, 4);
    assert.equal(ingestPayload.skipped_lines, 1);
    assert.ok(ingestPayload.new_offset > 0);

    const redactedTail = runTypescriptRuntimeCommand({
      args: ["tail", "worker-tail", "--subtype", "user_message", "--limit", "10"],
      cwd: root,
      env: {},
    });
    assert.equal(redactedTail.exitCode, 0);
    assert.equal(redactedTail.handled, true);
    const redactedEvents = JSON.parse(redactedTail.stdout ?? "[]") as Array<{
      payload: Record<string, unknown>;
      subtype: string;
    }>;
    assert.equal(redactedEvents.length, 1);
    assert.equal(redactedEvents[0].subtype, "user_message");
    assert.deepEqual(redactedEvents[0].payload, {
      message_byte_count: 11,
      message_line_count: 2,
      message_redacted: true,
      nested: {
        content_byte_count: 0,
        content_line_count: 0,
        content_redacted: true,
      },
      output_byte_count: 6,
      output_line_count: 1,
      output_redacted: true,
      type: "user_message",
    });

    const rawTail = runTypescriptRuntimeCommand({
      args: ["tail", "worker-tail", "--limit", "2", "--include-content"],
      cwd: root,
      env: {},
    });
    assert.equal(rawTail.exitCode, 0);
    const rawEvents = JSON.parse(rawTail.stdout ?? "[]") as Array<{
      byte_offset: number;
      payload: Record<string, unknown>;
      subtype: string | null;
      type: string;
    }>;
    assert.deepEqual(rawEvents.map((event) => event.subtype), ["task_complete", null]);
    assert.deepEqual(rawEvents.map((event) => event.type), ["event_msg", "response_item"]);
    assert.equal(rawEvents[0].payload.content, "complete");
    assert.equal(rawEvents[1].payload.text, "model line\n");
    assert.ok(rawEvents[0].byte_offset > rawEvents[1].byte_offset);

    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      const telemetry = database.prepare(`
        select event_type, correlation_json, attributes_json
        from telemetry_events
        where event_type = 'codex_events_tail_read'
        order by timestamp desc, rowid desc
        limit 1
      `).get() as { attributes_json: string; correlation_json: string; event_type: string };
      assert.equal(telemetry.event_type, "codex_events_tail_read");
      assert.deepEqual(JSON.parse(telemetry.correlation_json), {
        session: "worker-tail",
        session_id: JSON.parse(registered.stdout ?? "{}").session_id,
      });
      assert.deepEqual(JSON.parse(telemetry.attributes_json), {
        limit: 2,
        returned_count: 2,
        subtype: null,
      });
    } finally {
      database.close();
    }

    const pathIngest = runTypescriptRuntimeCommand({
      args: ["ingest", "worker-tail", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(pathIngest.exitCode, 0);
    const pathTail = runTypescriptRuntimeCommand({
      args: ["tail", "worker-tail", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(pathTail.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles events update-status and transcript commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-events."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    mkdirSync(join(root, ".codex-workers", "worker-status"), { recursive: true });
    writeFileSync(configPath("worker-status", { cwd: root, env: {} }), `${JSON.stringify({
      cwd: "/repo",
      identity_token: "worker-token",
      tmux_pane_id: "%1",
      tmux_session: "codex-worker-status",
    }, null, 2)}\n`);

    const updated = runTypescriptRuntimeCommand({
      args: [
        "update-status",
        "worker-status",
        "--state",
        "editing",
        "--current-task",
        "Port deterministic commands.",
        "--next-action",
        "Run transcript tests.",
        "--blocker",
        "none",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.handled, true);
    const updatedPayload = JSON.parse(updated.stdout ?? "{}") as {
      blocker: string;
      current_task: string;
      last_update: string;
      next_action: string;
      state: string;
    };
    assert.deepEqual(
      {
        blocker: updatedPayload.blocker,
        current_task: updatedPayload.current_task,
        next_action: updatedPayload.next_action,
        state: updatedPayload.state,
      },
      {
        blocker: "none",
        current_task: "Port deterministic commands.",
        next_action: "Run transcript tests.",
        state: "editing",
      },
    );
    assert.match(updatedPayload.last_update, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(JSON.parse(readFileSync(statusPath("worker-status", { cwd: root, env: {} }), "utf8")), updatedPayload);

    writeFileSync(eventsPath("worker-status", { cwd: root, env: {} }), "{bad-json}\n", { flag: "a" });
    writeFileSync(
      eventsPath("worker-status", { cwd: root, env: {} }),
      `${JSON.stringify({ time: "2026-06-04T12:00:00Z", type: "note", value: 1 })}\n`,
      { flag: "a" },
    );
    const events = runTypescriptRuntimeCommand({
      args: ["events", "worker-status", "--type", "status_updated", "--limit", "1"],
      cwd: root,
      env: {},
    });
    assert.equal(events.exitCode, 0);
    assert.equal(events.handled, true);
    assert.equal(events.stderr, "workerctl: 1 malformed event line(s) skipped\n");
    const eventLines = (events.stdout ?? "").trim().split("\n");
    assert.equal(eventLines.length, 1);
    assert.deepEqual(JSON.parse(eventLines[0]), {
      blocker: "none",
      current_task: "Port deterministic commands.",
      next_action: "Run transcript tests.",
      state: "editing",
      time: updatedPayload.last_update,
      type: "status_updated",
    });

    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      const worker = database.prepare("select id, cwd, tmux_session, tmux_pane_id, identity_token, state from workers where name = ?")
        .get("worker-status") as {
          cwd: string;
          id: string;
          identity_token: string;
          state: string;
          tmux_pane_id: string;
          tmux_session: string;
        };
      assert.equal(worker.cwd, "/repo");
      assert.equal(worker.tmux_session, "codex-worker-status");
      assert.equal(worker.tmux_pane_id, "%1");
      assert.equal(worker.identity_token, "worker-token");
      assert.equal(worker.state, "active");
      const status = database.prepare("select state, current_task, next_action, blocker from statuses where worker_id = ?")
        .get(worker.id) as {
          blocker: string;
          current_task: string;
          next_action: string;
          state: string;
        };
      assert.deepEqual(Object.fromEntries(Object.entries(status)), {
        blocker: "none",
        current_task: "Port deterministic commands.",
        next_action: "Run transcript tests.",
        state: "editing",
      });

      createTaskSync(database, {
        goal: "Exercise transcript commands.",
        name: "transcript-task",
        now: "2026-06-04T12:00:00Z",
        taskId: "task-transcript",
      });
      const captureWorker1 = insertTerminalCapture(database, "task-transcript", "worker", "2026-06-04T12:01:00Z", "old\nworker");
      const captureWorker2 = insertTerminalCapture(database, "task-transcript", "worker", "2026-06-04T12:02:00Z", "new\nworker\n");
      const captureManager = insertTerminalCapture(database, "task-transcript", "manager", "2026-06-04T12:03:00Z", "manager");
      insertTranscriptSegment(database, {
        capturedAt: "2026-06-04T12:01:00Z",
        role: "worker",
        segmentId: captureWorker1,
        text: "old\nworker",
      });
      insertTranscriptSegment(database, {
        capturedAt: "2026-06-04T12:02:00Z",
        role: "worker",
        segmentId: captureWorker2,
        text: "new\nworker\n",
      });
      insertTranscriptSegment(database, {
        capturedAt: "2026-06-04T12:03:00Z",
        role: "manager",
        segmentId: captureManager,
        text: null,
      });
    } finally {
      database.close();
    }

    const transcriptJson = runTypescriptRuntimeCommand({
      args: ["transcript-show", "transcript-task", "--json"],
      cwd: root,
      env: {},
    });
    assert.equal(transcriptJson.exitCode, 0);
    const transcriptPayload = JSON.parse(transcriptJson.stdout ?? "{}") as {
      segments: Array<Record<string, unknown>>;
      task: { id: string; name: string; state: string };
    };
    assert.deepEqual(transcriptPayload.task, {
      id: "task-transcript",
      name: "transcript-task",
      state: "candidate",
    });
    assert.deepEqual(
      transcriptPayload.segments.map((segment) => ({
        byteCount: segment.segment_text_byte_count,
        hasText: Object.hasOwn(segment, "segment_text"),
        lineCount: segment.segment_text_line_count,
        redacted: segment.segment_text_redacted,
        role: segment.role,
      })),
      [
        { byteCount: 10, hasText: false, lineCount: 2, redacted: true, role: "worker" },
        { byteCount: 11, hasText: false, lineCount: 2, redacted: true, role: "worker" },
        { byteCount: undefined, hasText: false, lineCount: undefined, redacted: undefined, role: "manager" },
      ],
    );

    const transcriptText = runTypescriptRuntimeCommand({
      args: ["transcript-show", "transcript-task", "--role", "worker", "--limit", "1"],
      cwd: root,
      env: {},
    });
    assert.equal(transcriptText.exitCode, 0);
    assert.match(transcriptText.stdout ?? "", /worker transcript segment 2 12:02:00/);
    assert.match(transcriptText.stdout ?? "", /\[content redacted: 2 lines, 11 bytes\]/);

    const transcriptRaw = runTypescriptRuntimeCommand({
      args: ["transcript-show", "transcript-task", "--role", "worker", "--limit", "1", "--json", "--include-content"],
      cwd: root,
      env: {},
    });
    const rawPayload = JSON.parse(transcriptRaw.stdout ?? "{}") as { segments: Array<{ segment_text: string }> };
    assert.equal(rawPayload.segments[0].segment_text, "new\nworker\n");

    const dryPrune = runTypescriptRuntimeCommand({
      args: ["transcript-prune", "transcript-task", "--keep-latest", "1", "--dry-run"],
      cwd: root,
      env: {},
    });
    assert.deepEqual(JSON.parse(dryPrune.stdout ?? "{}"), {
      dry_run: true,
      keep_latest: 1,
      pruned_count: 0,
      would_prune_count: 1,
    });

    const pruned = runTypescriptRuntimeCommand({
      args: ["transcript-prune", "transcript-task", "--keep-latest", "1"],
      cwd: root,
      env: {},
    });
    assert.deepEqual(JSON.parse(pruned.stdout ?? "{}"), {
      dry_run: false,
      keep_latest: 1,
      pruned_count: 1,
      would_prune_count: 1,
    });
    const afterPrune = openDatabaseSync(dbPath);
    try {
      const prunedSegment = afterPrune.prepare("select segment_text, retention_class, segment_kind from transcript_segments where id = 1")
        .get() as { retention_class: string; segment_kind: string; segment_text: string | null };
      assert.deepEqual(Object.fromEntries(Object.entries(prunedSegment)), {
        retention_class: "cold",
        segment_kind: "metadata",
        segment_text: null,
      });
      const event = afterPrune.prepare("select task_id, payload_json from events where type = 'transcript_segments_pruned'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, "task-transcript");
      assert.deepEqual(JSON.parse(event.payload_json), { keep_latest: 1, segment_ids: [1] });
    } finally {
      afterPrune.close();
    }

    const pruneAll = runTypescriptRuntimeCommand({
      args: ["transcript-prune", "transcript-task", "--role", "all"],
      cwd: root,
      env: {},
    });
    assert.equal(pruneAll.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles live finish-task stop and strict decisions with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle-live."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t session-live-worker" || command === "tmux has-session -t session-live-manager") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux list-panes -t session-live-worker -F #{pane_id}") {
      return { status: 0, stdout: "%11\n" };
    }
    if (command === "tmux list-panes -t session-live-manager -F #{pane_id}") {
      return { status: 0, stdout: "%22\n" };
    }
    if (command === "tmux capture-pane -p -t session-live-worker -S -33") {
      return { status: 0, stdout: "worker before stop\nmore worker\n" };
    }
    if (command === "tmux capture-pane -p -t session-live-manager -S -33") {
      return { status: 0, stdout: "manager before stop\nmore manager\n" };
    }
    if (command === "tmux set-buffer -b workerctl-session-live-worker final note") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux paste-buffer -b workerctl-session-live-worker -t session-live-worker:%11") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux send-keys -t session-live-worker:%11 C-m") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux delete-buffer -b workerctl-session-live-worker") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux kill-session -t session-live-worker" || command === "tmux kill-session -t session-live-manager") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    let decisionId: number;
    try {
      initializeDatabaseSync(database);
      const taskId = createTaskSync(database, {
        goal: "Finish with live cleanup.",
        name: "live-finish",
        now: "2026-06-04T13:00:00Z",
        taskId: "task-live-finish",
      });
      insertSession(database, {
        id: "session-live-worker-id",
        name: "live-worker",
        role: "worker",
        tmuxPaneId: "%11",
        tmuxSession: "session-live-worker",
      });
      insertSession(database, {
        id: "session-live-manager-id",
        name: "live-manager",
        role: "manager",
        tmuxPaneId: "%22",
        tmuxSession: "session-live-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-live-finish",
        managerSessionName: "live-manager",
        taskName: "live-finish",
        workerSessionName: "live-worker",
      });
      const decision = database.prepare(`
        insert into manager_decisions(task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json)
        values (?, null, null, 'stop', 'Approved stop.', ?, '{}')
      `).run(taskId, new Date().toISOString());
      decisionId = Number(decision.lastInsertRowid);
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: [
        "finish-task",
        "live-finish",
        "--stop-manager",
        "--stop-worker",
        "--message",
        "final note",
        "--capture-transcript-before-stop",
        "--capture-transcript-lines",
        "33",
        "--require-transcript-segment",
        "--decision-id",
        String(decisionId),
        "--strict-decisions",
        "--reason",
        "Live cleanup complete.",
        "--path",
        dbPath,
      ],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      killed_manager: boolean;
      killed_worker: boolean;
      manager_decision: { ok: boolean; warnings: string[] };
      manager_session: string;
      pre_stop_transcript_captures: Array<{ role: string; transcript_segment: { line_count: number } | null }>;
      stop_manager: boolean;
      stop_worker: boolean;
      worker_session: string;
    };
    assert.equal(payload.stop_manager, true);
    assert.equal(payload.stop_worker, true);
    assert.equal(payload.killed_manager, true);
    assert.equal(payload.killed_worker, true);
    assert.equal(payload.worker_session, "live-worker");
    assert.equal(payload.manager_session, "live-manager");
    assert.equal(payload.manager_decision.ok, true);
    assert.deepEqual(payload.manager_decision.warnings, []);
    assert.deepEqual(
      payload.pre_stop_transcript_captures.map((capture) => ({
        line_count: capture.transcript_segment?.line_count,
        role: capture.role,
      })),
      [
        { line_count: 2, role: "worker" },
        { line_count: 2, role: "manager" },
      ],
    );
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "session-live-worker"],
      ["tmux", "list-panes", "-t", "session-live-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-live-worker", "-S", "-33"],
      ["tmux", "has-session", "-t", "session-live-manager"],
      ["tmux", "list-panes", "-t", "session-live-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-live-manager", "-S", "-33"],
      ["tmux", "has-session", "-t", "session-live-worker"],
      ["tmux", "set-buffer", "-b", "workerctl-session-live-worker", "final note"],
      ["tmux", "paste-buffer", "-b", "workerctl-session-live-worker", "-t", "session-live-worker:%11"],
      ["tmux", "send-keys", "-t", "session-live-worker:%11", "C-m"],
      ["tmux", "delete-buffer", "-b", "workerctl-session-live-worker"],
      ["tmux", "kill-session", "-t", "session-live-worker"],
      ["tmux", "kill-session", "-t", "session-live-manager"],
    ]);

    const after = openDatabaseSync(dbPath);
    try {
      const states = after.prepare("select name, state from sessions order by name")
        .all() as Array<{ name: string; state: string }>;
      assert.deepEqual(states.map((state) => ({ ...state })), [
        { name: "live-manager", state: "gone" },
        { name: "live-worker", state: "gone" },
      ]);
      const task = after.prepare("select state from tasks where name = 'live-finish'")
        .get() as { state: string };
      assert.equal(task.state, "done");
      const captureCount = after.prepare("select count(*) as count from terminal_captures where task_id = 'task-live-finish'")
        .get() as { count: number };
      assert.equal(captureCount.count, 2);
      const eventTypes = after.prepare("select type from events where task_id = 'task-live-finish' order by id")
        .all() as Array<{ type: string }>;
      assert.ok(eventTypes.some((event) => event.type === "finish_task_pre_stop_transcript_captured"));
      assert.ok(eventTypes.some((event) => event.type === "finish_task_succeeded"));
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime records failed live lifecycle side effects without completing task", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle-fail."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux kill-session -t session-fail-manager") {
      return { status: 1, stderr: "manager still busy" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Stay active if stop side effects fail.",
        name: "fail-stop",
        taskId: "task-fail-stop",
      });
      insertSession(database, {
        id: "session-fail-worker-id",
        name: "fail-worker",
        role: "worker",
      });
      insertSession(database, {
        id: "session-fail-manager-id",
        name: "fail-manager",
        role: "manager",
        tmuxSession: "session-fail-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-fail-stop",
        managerSessionName: "fail-manager",
        taskName: "fail-stop",
        workerSessionName: "fail-worker",
      });
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["stop-task", "fail-stop", "--reason", "Stop failed live manager.", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /tmux kill-session -t session-fail-manager failed: manager still busy/);
    assert.deepEqual(calls, [
      ["tmux", "kill-session", "-t", "session-fail-manager"],
    ]);

    const after = openDatabaseSync(dbPath);
    try {
      const task = after.prepare("select state from tasks where name = 'fail-stop'")
        .get() as { state: string };
      assert.equal(task.state, "candidate");
      const binding = after.prepare("select state from bindings where id = 'binding-fail-stop'")
        .get() as { state: string };
      assert.equal(binding.state, "active");
      const managerSession = after.prepare("select state from sessions where name = 'fail-manager'")
        .get() as { state: string };
      assert.equal(managerSession.state, "active");
      const command = after.prepare(`
        select state, result_json, error
        from commands
        where task_id = 'task-fail-stop'
      `).get() as { error: string; result_json: string; state: string };
      assert.equal(command.state, "failed");
      assert.match(command.error, /tmux kill-session -t session-fail-manager failed: manager still busy/);
      const commandResult = JSON.parse(command.result_json) as {
        expected_failure: boolean;
        failure_stage: string;
        stop_manager: boolean;
        stop_worker: boolean;
      };
      assert.equal(commandResult.expected_failure, true);
      assert.equal(commandResult.failure_stage, "live_lifecycle_side_effects");
      assert.equal(commandResult.stop_manager, true);
      assert.equal(commandResult.stop_worker, false);
      const failedEvent = after.prepare("select payload_json from events where type = 'stop_task_failed'")
        .get() as { payload_json: string };
      const failedPayload = JSON.parse(failedEvent.payload_json) as { failure_stage: string };
      assert.equal(failedPayload.failure_stage, "live_lifecycle_side_effects");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime rejects strict stop-task decision before mutating state", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle-strict."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Reject missing strict decision.",
        name: "strict-stop",
        taskId: "task-strict-stop",
      });
      insertSession(database, {
        id: "session-strict-worker-id",
        name: "strict-worker",
        role: "worker",
        tmuxSession: "session-strict-worker",
      });
      insertSession(database, {
        id: "session-strict-manager-id",
        name: "strict-manager",
        role: "manager",
        tmuxSession: "session-strict-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-strict-stop",
        managerSessionName: "strict-manager",
        taskName: "strict-stop",
        workerSessionName: "strict-worker",
      });
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["stop-task", "strict-stop", "--strict-decisions", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /strict manager decision validation failed/);
    assert.deepEqual(calls, []);
    const after = openDatabaseSync(dbPath);
    try {
      const task = after.prepare("select state from tasks where name = 'strict-stop'")
        .get() as { state: string };
      assert.equal(task.state, "candidate");
      const commandCount = after.prepare("select count(*) as count from commands")
        .get() as { count: number };
      assert.equal(commandCount.count, 0);
      const binding = after.prepare("select state from bindings where id = 'binding-strict-stop'")
        .get() as { state: string };
      assert.equal(binding.state, "active");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles live capture status and idle-check with a fake tmux runner", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-live."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t codex-worker-live") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux capture-pane -p -S -42 -t codex-worker-live") {
      return { status: 0, stdout: "OpenAI Codex\nPress enter to confirm\n" };
    }
    if (command === "tmux list-panes -t codex-worker-live -F #{pane_id}") {
      return { status: 0, stdout: "%1\n" };
    }
    if (command === "tmux has-session -t custom-session") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux capture-pane -p -S -5 -t custom-session") {
      return { status: 0, stdout: "session output\n" };
    }
    if (command === "tmux list-panes -t custom-session -F #{pane_id}") {
      return { status: 0, stdout: "%9\n" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  const now = () => new Date("2026-06-04T12:10:00Z");
  try {
    mkdirSync(join(root, ".codex-workers", "worker-live"), { recursive: true });
    writeFileSync(configPath("worker-live", { cwd: root, env: {} }), `${JSON.stringify({
      cwd: "/repo",
      identity_token: "worker-token",
      startup: "ready",
      startup_reason: "Codex input prompt is visible",
      startup_recommended_action: "none",
      tmux_session: "codex-worker-live",
    }, null, 2)}\n`);
    writeFileSync(statusPath("worker-live", { cwd: root, env: {} }), `${JSON.stringify({
      blocker: null,
      current_task: "Watch terminal.",
      last_update: "2026-06-04T12:00:00Z",
      next_action: "Respond if prompted.",
      state: "editing",
    }, null, 2)}\n`);

    const captured = runTypescriptRuntimeCommand({
      args: ["capture", "worker-live", "--lines", "42"],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(captured.exitCode, 0);
    assert.equal(captured.handled, true);
    const output = "OpenAI Codex\nPress enter to confirm";
    assert.deepEqual(JSON.parse(captured.stdout ?? "{}"), {
      byte_count: Buffer.byteLength(output),
      content_redacted: true,
      history_lines: 42,
      line_count: 2,
      name: "worker-live",
      sha256: createHash("sha256").update(output).digest("hex"),
      transcript_path: join(root, ".codex-workers", "worker-live", "transcript.txt"),
    });
    assert.equal(readFileSync(join(root, ".codex-workers", "worker-live", "transcript.txt"), "utf8"), `${output}\n`);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".codex-workers", "worker-live", "capture-meta.json"), "utf8")), {
      captured_at: "2026-06-04T12:10:00Z",
      changed_at: "2026-06-04T12:10:00Z",
      history_lines: 42,
      sha256: createHash("sha256").update(output).digest("hex"),
    });
    assert.deepEqual(calls.slice(0, 3), [
      ["tmux", "has-session", "-t", "codex-worker-live"],
      ["tmux", "capture-pane", "-p", "-S", "-42", "-t", "codex-worker-live"],
      ["tmux", "list-panes", "-t", "codex-worker-live", "-F", "#{pane_id}"],
    ]);

    const database = openDatabaseSync(defaultDbPath({ cwd: root, env: {} }));
    try {
      const capture = database.prepare(`
        select transcript_captures.content, transcript_captures.capture_kind,
               transcript_captures.history_lines, transcript_captures.line_count,
               workers.tmux_pane_id
        from transcript_captures
        join workers on workers.id = transcript_captures.worker_id
      `).get() as {
        capture_kind: string;
        content: string;
        history_lines: number;
        line_count: number;
        tmux_pane_id: string;
      };
      assert.deepEqual(Object.fromEntries(Object.entries(capture)), {
        capture_kind: "changed",
        content: output,
        history_lines: 42,
        line_count: 2,
        tmux_pane_id: "%1",
      });
    } finally {
      database.close();
    }

    const callCountBeforeStatus = calls.length;
    const status = runTypescriptRuntimeCommand({
      args: ["status", "worker-live", "--no-refresh"],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(status.exitCode, 0);
    const statusPayload = JSON.parse(status.stdout ?? "{}") as Record<string, unknown>;
    assert.deepEqual(statusPayload, {
      blocker: null,
      current_task: "Watch terminal.",
      name: "worker-live",
      next_action: "Respond if prompted.",
      running: true,
      startup: "ready",
      startup_reason: "Codex input prompt is visible",
      startup_recommended_action: "none",
      state: "editing",
      status_last_update: "2026-06-04T12:00:00Z",
      terminal_capture_error: null,
      terminal_captured_at: "2026-06-04T12:10:00Z",
      terminal_changed_at: "2026-06-04T12:10:00Z",
      tmux_session: "codex-worker-live",
    });
    assert.deepEqual(calls.slice(callCountBeforeStatus), [
      ["tmux", "has-session", "-t", "codex-worker-live"],
    ]);

    const idle = runTypescriptRuntimeCommand({
      args: [
        "idle-check",
        "worker-live",
        "--no-refresh",
        "--lines",
        "42",
        "--status-stale-seconds",
        "60",
        "--terminal-stale-seconds",
        "60",
        "--busy-wait-seconds",
        "60",
      ],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    const idlePayload = JSON.parse(idle.stdout ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      {
        busy_wait_pattern: idlePayload.busy_wait_pattern,
        health: idlePayload.health,
        reason: idlePayload.reason,
        recommended_action: idlePayload.recommended_action,
        running: idlePayload.running,
        status_age_seconds: idlePayload.status_age_seconds,
        terminal_age_seconds: idlePayload.terminal_age_seconds,
        terminal_fresh: idlePayload.terminal_fresh,
      },
      {
        busy_wait_pattern: "enter_to_confirm",
        health: "busy_wait",
        reason: "terminal is waiting for Enter confirmation",
        recommended_action: "inspect_or_confirm",
        running: true,
        status_age_seconds: 600,
        terminal_age_seconds: 0,
        terminal_fresh: true,
      },
    );

    const sessionDb = openDatabaseSync(defaultDbPath({ cwd: root, env: {} }));
    try {
      insertSession(sessionDb, {
        id: "session-live-id",
        name: "session-live",
        role: "worker",
        tmuxSession: "custom-session",
      });
    } finally {
      sessionDb.close();
    }
    const callCountBeforeSessionCapture = calls.length;
    const sessionCapture = runTypescriptRuntimeCommand({
      args: ["capture", "session-live", "--lines", "5", "--include-content"],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(sessionCapture.stdout, "session output\n");
    assert.deepEqual(calls.slice(callCountBeforeSessionCapture, callCountBeforeSessionCapture + 3), [
      ["tmux", "has-session", "-t", "custom-session"],
      ["tmux", "capture-pane", "-p", "-S", "-5", "-t", "custom-session"],
      ["tmux", "list-panes", "-t", "custom-session", "-F", "#{pane_id}"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime captures session-bound worker transcript segments with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-transcript-capture."));
  const dbPath = join(root, "workerctl.db");
  const calls: string[][] = [];
  const workerOutputs = [
    "line one\nline two",
    "line one\nline two",
    "line one\nline two\nline three",
    "line one\nline two\nline three",
    "line one\nline two\nline three\nline four",
  ];
  const managerOutputs = [
    "manager line one\nmanager line two",
    "manager line one\nmanager line two\nmanager line three",
  ];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t session-worker" || command === "tmux has-session -t session-manager") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux list-panes -t session-worker -F #{pane_id}") {
      return { status: 0, stdout: "%1\n" };
    }
    if (command === "tmux list-panes -t session-manager -F #{pane_id}") {
      return { status: 0, stdout: "%2\n" };
    }
    if (command === "tmux capture-pane -p -t session-worker -S -80") {
      return { status: 0, stdout: workerOutputs.shift() ?? "" };
    }
    if (command === "tmux capture-pane -p -t session-manager -S -80") {
      return { status: 0, stdout: managerOutputs.shift() ?? "" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  const now = () => new Date("2026-06-04T12:30:00Z");
  try {
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Capture transcript evidence.",
        name: "capture-task",
        now: "2026-06-04T12:00:00Z",
        taskId: "task-capture",
      });
      insertSession(database, {
        id: "session-worker-capture",
        name: "worker-capture",
        role: "worker",
        tmuxPaneId: "%1",
        tmuxSession: "session-worker",
      });
      insertSession(database, {
        id: "session-manager-capture",
        name: "manager-capture",
        role: "manager",
        tmuxPaneId: "%2",
        tmuxSession: "session-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-capture",
        managerSessionName: "manager-capture",
        now: "2026-06-04T12:00:30Z",
        taskName: "capture-task",
        workerSessionName: "worker-capture",
      });
    } finally {
      database.close();
    }

    const first = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "worker", "--json", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(first.exitCode, 0);
    assert.equal(first.handled, true);
    const firstPayload = JSON.parse(first.stdout ?? "{}") as {
      captures: Array<{
        capture: Record<string, unknown>;
        transcript_segment: Record<string, unknown>;
        worker: Record<string, unknown>;
      }>;
    };
    assert.equal(firstPayload.captures[0]?.capture.output, undefined);
    assert.equal(firstPayload.captures[0]?.capture.output_redacted, true);
    assert.equal(firstPayload.captures[0]?.capture.output_line_count, 2);
    assert.equal(firstPayload.captures[0]?.transcript_segment.segment_kind, "reset");
    assert.equal(firstPayload.captures[0]?.transcript_segment.line_count, 2);
    assert.equal(firstPayload.captures[0]?.worker.tmux_pane_id, "%1");

    const duplicate = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "worker", "--json", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(duplicate.exitCode, 0);
    assert.equal(JSON.parse(duplicate.stdout ?? "{}").captures[0].transcript_segment, null);

    const appended = runTypescriptRuntimeCommand({
      args: [
        "transcript-capture",
        "capture-task",
        "--role",
        "worker",
        "--json",
        "--include-content",
        "--path",
        dbPath,
        "--lines",
        "80",
      ],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(appended.exitCode, 0);
    const appendedPayload = JSON.parse(appended.stdout ?? "{}") as {
      captures: Array<{ capture: Record<string, unknown>; transcript_segment: Record<string, unknown> }>;
    };
    assert.equal(appendedPayload.captures[0]?.capture.output, "line one\nline two\nline three");
    assert.equal(appendedPayload.captures[0]?.transcript_segment.segment_kind, "segment");
    assert.equal(appendedPayload.captures[0]?.transcript_segment.line_count, 1);

    const required = runTypescriptRuntimeCommand({
      args: [
        "transcript-capture",
        "capture-task",
        "--role",
        "worker",
        "--json",
        "--require-segment",
        "--path",
        dbPath,
        "--lines",
        "80",
      ],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(required.exitCode, 2);
    assert.match(required.stderr ?? "", /no non-empty transcript segment captured for role\(s\): worker/);

    const managerCapture = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "manager", "--json", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(managerCapture.exitCode, 0);
    const managerPayload = JSON.parse(managerCapture.stdout ?? "{}") as {
      captures: Array<{ manager: Record<string, unknown>; transcript_segment: Record<string, unknown> }>;
    };
    assert.equal(managerPayload.captures[0]?.manager.tmux_pane_id, "%2");
    assert.equal(managerPayload.captures[0]?.transcript_segment.segment_kind, "reset");

    const allText = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "all", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(allText.exitCode, 0);
    assert.match(allText.stdout ?? "", /worker: capture \d+ segment \d+ \(segment, 1 lines\)/);
    assert.match(allText.stdout ?? "", /manager: capture \d+ segment \d+ \(segment, 1 lines\)/);

    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-manager"],
      ["tmux", "list-panes", "-t", "session-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-manager", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-manager"],
      ["tmux", "list-panes", "-t", "session-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-manager", "-S", "-80"],
    ]);

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const segmentRows = verifyDb.prepare(`
        select segment_kind, segment_text from transcript_segments order by id
      `).all() as Array<{ segment_kind: string; segment_text: string | null }>;
      assert.deepEqual(segmentRows.map((row) => Object.fromEntries(Object.entries(row))), [
        { segment_kind: "reset", segment_text: "line one\nline two" },
        { segment_kind: "segment", segment_text: "line three" },
        { segment_kind: "reset", segment_text: "manager line one\nmanager line two" },
        { segment_kind: "segment", segment_text: "line four" },
        { segment_kind: "segment", segment_text: "manager line three" },
      ]);
      const telemetryRows = verifyDb.prepare(`
        select event_type from telemetry_events order by id
      `).all() as Array<{ event_type: string }>;
      assert.equal(telemetryRows.filter((row) => row.event_type === "terminal_capture_recorded").length, 7);
      assert.equal(telemetryRows.filter((row) => row.event_type === "transcript_segment_recorded").length, 5);
      const observation = verifyDb.prepare(`
        select count(*) as count from agent_observations where observation_type = 'capture'
      `).get() as { count: number };
      assert.equal(observation.count, 7);
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime captures legacy worker and manager transcript paths with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-transcript-legacy."));
  const dbPath = join(root, "workerctl.db");
  const stateRoot = join(root, "state");
  const env = { WORKERCTL_STATE_ROOT: stateRoot };
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t codex-legacy-worker" || command === "tmux has-session -t codex-legacy-manager") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux list-panes -t codex-legacy-worker -F #{pane_id}") {
      return { status: 0, stdout: "%10\n" };
    }
    if (command === "tmux list-panes -t codex-legacy-manager -F #{pane_id}") {
      return { status: 0, stdout: "%20\n" };
    }
    if (command === "tmux capture-pane -p -S -80 -t codex-legacy-worker") {
      return { status: 0, stdout: "legacy worker line\nlegacy worker next\n" };
    }
    if (command === "tmux capture-pane -p -t codex-legacy-manager -S -80") {
      return { status: 0, stdout: "legacy manager line\nlegacy manager next" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  const now = () => new Date("2026-06-04T13:00:00Z");
  try {
    mkdirSync(join(stateRoot, "legacy-worker"), { recursive: true });
    writeFileSync(configPath("legacy-worker", { env }), `${JSON.stringify({
      cwd: root,
      identity_token: "token-legacy-worker",
      tmux_pane_id: "%10",
      tmux_session: "codex-legacy-worker",
    }, null, 2)}\n`);

    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Capture legacy transcript evidence.",
        name: "legacy-task",
        now: "2026-06-04T12:50:00Z",
        taskId: "task-legacy",
      });
      insertLegacyWorker(database, {
        identityToken: "token-legacy-worker",
        name: "legacy-worker",
        paneId: "%10",
        workerId: "worker-legacy-id",
      });
      insertLegacyManager(database, {
        managerId: "manager-legacy-id",
        name: "legacy-manager",
        paneId: "%20",
        taskId: "task-legacy",
      });
      database.prepare(`
        insert into bindings(id, task_id, worker_id, manager_id, state, created_at)
        values ('binding-legacy', 'task-legacy', 'worker-legacy-id', 'manager-legacy-id', 'active', '2026-06-04T12:51:00Z')
      `).run();
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "legacy-task", "--role", "all", "--json", "--include-content", "--path", dbPath, "--lines", "80"],
      env,
      now,
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      captures: Array<{
        binding_id: string | null;
        capture: Record<string, unknown>;
        manager?: Record<string, unknown>;
        role: "manager" | "worker";
        transcript_segment: Record<string, unknown>;
        worker?: Record<string, unknown>;
      }>;
    };
    const workerCapture = payload.captures.find((capture) => capture.role === "worker");
    const managerCapture = payload.captures.find((capture) => capture.role === "manager");
    assert.equal(workerCapture?.binding_id, "binding-legacy");
    assert.equal(workerCapture?.worker?.id, "worker-legacy-id");
    assert.equal(workerCapture?.worker?.tmux_pane_id, "%10");
    assert.equal(workerCapture?.capture.output, "legacy worker line\nlegacy worker next");
    assert.equal(workerCapture?.transcript_segment.segment_kind, "reset");
    assert.equal(managerCapture?.manager?.id, "manager-legacy-id");
    assert.equal(managerCapture?.manager?.tmux_pane_id, "%20");
    assert.equal(managerCapture?.capture.output, "legacy manager line\nlegacy manager next");
    assert.equal(managerCapture?.transcript_segment.segment_kind, "reset");

    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "codex-legacy-worker"],
      ["tmux", "list-panes", "-t", "codex-legacy-worker", "-F", "#{pane_id}"],
      ["tmux", "has-session", "-t", "codex-legacy-worker"],
      ["tmux", "capture-pane", "-p", "-S", "-80", "-t", "codex-legacy-worker"],
      ["tmux", "has-session", "-t", "codex-legacy-manager"],
      ["tmux", "list-panes", "-t", "codex-legacy-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "codex-legacy-manager", "-S", "-80"],
    ]);

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const captures = verifyDb.prepare(`
        select role, worker_id, manager_id, tmux_session, tmux_pane_id from terminal_captures order by id
      `).all() as Array<{
        manager_id: string | null;
        role: string;
        tmux_pane_id: string | null;
        tmux_session: string;
        worker_id: string | null;
      }>;
      assert.deepEqual(captures.map((row) => Object.fromEntries(Object.entries(row))), [
        {
          manager_id: null,
          role: "worker",
          tmux_pane_id: "%10",
          tmux_session: "codex-legacy-worker",
          worker_id: "worker-legacy-id",
        },
        {
          manager_id: "manager-legacy-id",
          role: "manager",
          tmux_pane_id: "%20",
          tmux_session: "codex-legacy-manager",
          worker_id: null,
        },
      ]);
      const eventRows = verifyDb.prepare(`
        select type, worker_id, manager_id from events where type like '%_terminal_captured' order by id
      `).all() as Array<{ manager_id: string | null; type: string; worker_id: string | null }>;
      assert.deepEqual(eventRows.map((row) => Object.fromEntries(Object.entries(row))), [
        { manager_id: null, type: "worker_terminal_captured", worker_id: "worker-legacy-id" },
        { manager_id: "manager-legacy-id", type: "manager_terminal_captured", worker_id: null },
      ]);
      const observations = verifyDb.prepare(`
        select role, worker_id, manager_id from agent_observations order by id
      `).all() as Array<{ manager_id: string | null; role: string; worker_id: string | null }>;
      assert.deepEqual(observations.map((row) => Object.fromEntries(Object.entries(row))), [
        { manager_id: null, role: "worker", worker_id: "worker-legacy-id" },
        { manager_id: "manager-legacy-id", role: "manager", worker_id: null },
      ]);
      const manager = verifyDb.prepare(`
        select last_capture_sha256, last_seen_at from managers where id = 'manager-legacy-id'
      `).get() as { last_capture_sha256: string | null; last_seen_at: string | null };
      assert.equal(manager.last_seen_at, "2026-06-04T13:00:00Z");
      assert.equal(manager.last_capture_sha256, createHash("sha256").update("legacy manager line\nlegacy manager next").digest("hex"));
      const legacyCapture = verifyDb.prepare(`
        select worker_id, content, line_count from transcript_captures
      `).get() as { content: string | null; line_count: number; worker_id: string };
      assert.equal(legacyCapture.worker_id, "worker-legacy-id");
      assert.equal(legacyCapture.content, "legacy worker line\nlegacy worker next");
      assert.equal(legacyCapture.line_count, 2);
    } finally {
      verifyDb.close();
    }
    assert.equal(readFileSync(join(stateRoot, "legacy-worker", "transcript.txt"), "utf8"), "legacy worker line\nlegacy worker next\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles migrated audit replay and full export commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-cli."));
  try {
    const dbPath = join(root, "workerctl.db");
    const outputDir = join(root, "export");
    const fullOutputDir = join(root, "export-full");
    const database = openDatabaseSync(dbPath);
    try {
      seedCliTask(database);
      insertLegacyWorker(database, {
        identityToken: "token-export-worker",
        name: "export-worker",
        paneId: "%30",
        workerId: "worker-export-id",
      });
      insertLegacyManager(database, {
        managerId: "manager-export-id",
        name: "export-manager",
        paneId: "%31",
        taskId: "task-cli",
      });
      database.prepare("update bindings set worker_id = ? where id = ?").run("worker-export-id", "binding-cli");
      database.prepare(`
        insert into statuses(worker_id, state, current_task, next_action, blocker, created_at)
        values (?, 'running_tests', ?, ?, null, ?)
      `).run(
        "worker-export-id",
        "cli-task",
        "Verify export parity.",
        "2026-05-23T10:02:45Z",
      );
      database.prepare(`
        insert into transcript_captures(
          worker_id, sha256, content, captured_at, changed_at, history_lines,
          byte_count, line_count, capture_kind, retention_class
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, 'changed', 'hot')
      `).run(
        "worker-export-id",
        "transcript-capture-sha",
        "raw transcript capture secret\n",
        "2026-05-23T10:02:30Z",
        "2026-05-23T10:02:30Z",
        200,
        Buffer.byteLength("raw transcript capture secret\n"),
        1,
      );
      database.prepare(`
        insert into transcript_captures(
          worker_id, sha256, content, captured_at, changed_at, history_lines,
          byte_count, line_count, capture_kind, retention_class
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, 'changed', 'hot')
      `).run(
        "worker-export-id",
        "transcript-capture-before-binding-sha",
        "old task capture secret\n",
        "2026-05-23T09:59:00Z",
        "2026-05-23T09:59:00Z",
        200,
        Buffer.byteLength("old task capture secret\n"),
        1,
      );
      const captureId = insertTerminalCapture(database, "task-cli", "worker", "2026-05-23T10:03:00Z", "worker export line\n");
      database.prepare(`
        insert into transcript_segments(
          task_id, role, source_capture_id, previous_capture_id, captured_at,
          content_sha256, segment_text, segment_start_line, segment_end_line,
          byte_count, line_count, retention_class, segment_kind, created_at
        )
        values (?, 'worker', ?, null, ?, ?, ?, 1, 1, ?, 1, 'hot', 'segment', ?)
      `).run(
        "task-cli",
        captureId,
        "2026-05-23T10:03:00Z",
        "worker-export-segment-sha",
        "worker export line",
        Buffer.byteLength("worker export line"),
        "2026-05-23T10:03:00Z",
      );
    } finally {
      database.close();
    }

    const audit = runTypescriptRuntimeCommand({
      args: ["audit", "cli-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(audit.exitCode, 0);
    assert.equal(audit.handled, true);
    const auditPayload = JSON.parse(audit.stdout ?? "{}") as {
      task: { name: string };
      terminal_captures: Array<Record<string, unknown>>;
      transcript_segments: Array<Record<string, unknown>>;
    };
    assert.equal(auditPayload.task.name, "cli-task");
    assert.equal(auditPayload.terminal_captures[0].content, undefined);
    assert.equal(auditPayload.terminal_captures[0].content_redacted, true);
    assert.equal(auditPayload.terminal_captures[0].content_byte_count, Buffer.byteLength("worker export line\n"));
    assert.equal(auditPayload.transcript_segments[0].segment_text, undefined);
    assert.equal(auditPayload.transcript_segments[0].segment_text_redacted, true);
    assert.equal(auditPayload.transcript_segments[0].segment_text_byte_count, Buffer.byteLength("worker export line"));

    const auditWithContent = runTypescriptRuntimeCommand({
      args: ["audit", "cli-task", "--json", "--include-content", "--path", dbPath],
      env: {},
    });
    assert.equal(auditWithContent.exitCode, 0);
    const auditWithContentPayload = JSON.parse(auditWithContent.stdout ?? "{}") as {
      terminal_captures: Array<Record<string, unknown>>;
      transcript_segments: Array<Record<string, unknown>>;
    };
    assert.equal(auditWithContentPayload.terminal_captures[0].content, "worker export line\n");
    assert.equal(auditWithContentPayload.transcript_segments[0].segment_text, "worker export line");

    const replay = runTypescriptRuntimeCommand({
      args: ["--ts-runtime", "replay", "cli-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(replay.exitCode, 0);
    const replayPayload = JSON.parse(replay.stdout ?? "{}") as {
      entries: Array<{ source: string }>;
      task: { name: string };
    };
    assert.equal(replayPayload.task.name, "cli-task");
    assert.deepEqual(replayPayload.entries.map((entry) => entry.source), [
      "events",
      "commands",
      "correlation_chains",
      "command_attempts",
      "routed_notifications",
    ]);

    const fullTranscriptReplay = runTypescriptRuntimeCommand({
      args: [
        "--ts-runtime",
        "replay",
        "cli-task",
        "--json",
        "--format",
        "full-transcript",
        "--include-content",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(fullTranscriptReplay.exitCode, 0);
    const fullTranscriptReplayPayload = JSON.parse(fullTranscriptReplay.stdout ?? "{}") as {
      entries: Array<{ content?: string; source: string }>;
    };
    assert.equal(fullTranscriptReplayPayload.entries.some((entry) => (
      entry.source === "transcript_segments" && entry.content === "worker export line"
    )), true);

    const fullTranscriptTextReplay = runTypescriptRuntimeCommand({
      args: [
        "--ts-runtime",
        "replay",
        "cli-task",
        "--format",
        "full-transcript",
        "--include-content",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(fullTranscriptTextReplay.exitCode, 0);
    assert.match(fullTranscriptTextReplay.stdout ?? "", /worker transcript segment \(1 lines\)/);
    assert.match(fullTranscriptTextReplay.stdout ?? "", /worker export line/);

    const exported = runTypescriptRuntimeCommand({
      args: ["export-task", "cli-task", "--output", outputDir, "--path", dbPath],
      env: {},
    });
    assert.equal(exported.exitCode, 0);
    assert.equal(JSON.parse(exported.stdout ?? "{}").export_dir, outputDir);
    assert.equal(existsSync(join(outputDir, "manifest.json")), true);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")) as {
      files: string[];
    };
    assert.deepEqual(manifest.files, [
      "task-status.json",
      "audit.json",
      "acceptance-criteria.json",
      "prompts.json",
      "transcript-captures.json",
      "terminal-captures.json",
      "agent-observations.json",
      "manager-cycles.json",
      "manager-cycle-spans.json",
      "manager-decisions.json",
      "mutation-audit.json",
      "replay.json",
      "telemetry-events.json",
      "telemetry-summary.json",
      "telemetry-report.md",
    ]);
    const exportedTaskStatus = JSON.parse(readFileSync(join(outputDir, "task-status.json"), "utf8")) as {
      integrity: { issues: string[]; ok: boolean };
      manager: { name: string; task_id: string } | null;
      manager_config: unknown;
      worker: { binding_id: string; name: string } | null;
      worker_handoff: unknown;
      worker_status: { current_task: string; next_action: string; state: string } | null;
    };
    assert.equal(exportedTaskStatus.worker?.binding_id, "binding-cli");
    assert.equal(exportedTaskStatus.worker?.name, "export-worker");
    assert.equal(exportedTaskStatus.worker_status?.state, "running_tests");
    assert.equal(exportedTaskStatus.worker_status?.current_task, "cli-task");
    assert.equal(exportedTaskStatus.worker_status?.next_action, "Verify export parity.");
    assert.equal(exportedTaskStatus.manager?.name, "export-manager");
    assert.equal(exportedTaskStatus.manager?.task_id, "task-cli");
    assert.equal(exportedTaskStatus.manager_config, null);
    assert.equal(exportedTaskStatus.worker_handoff, null);
    assert.deepEqual(exportedTaskStatus.integrity, { issues: [], ok: true });
    const exportedAudit = JSON.parse(readFileSync(join(outputDir, "audit.json"), "utf8")) as {
      terminal_captures: Array<Record<string, unknown>>;
      transcript_segments: Array<Record<string, unknown>>;
    };
    assert.equal(exportedAudit.terminal_captures[0].content, undefined);
    assert.equal(exportedAudit.terminal_captures[0].content_redacted, true);
    assert.equal(exportedAudit.transcript_segments[0].segment_text, undefined);
    assert.equal(exportedAudit.transcript_segments[0].segment_text_redacted, true);
    const exportedTerminalCaptures = JSON.parse(readFileSync(join(outputDir, "terminal-captures.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(exportedTerminalCaptures[0].content, undefined);
    assert.equal(exportedTerminalCaptures[0].content_redacted, true);
    const exportedTranscriptCaptures = JSON.parse(readFileSync(join(outputDir, "transcript-captures.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(exportedTranscriptCaptures.length, 1);
    assert.equal(exportedTranscriptCaptures[0].sha256, "transcript-capture-sha");
    assert.equal(exportedTranscriptCaptures[0].content, undefined);
    assert.equal(exportedTranscriptCaptures[0].content_redacted, true);
    assert.equal(exportedTranscriptCaptures[0].content_byte_count, Buffer.byteLength("raw transcript capture secret\n"));
    const exportedTelemetrySummary = JSON.parse(readFileSync(join(outputDir, "telemetry-summary.json"), "utf8")) as Record<string, unknown>;
    assert.equal(exportedTelemetrySummary.task_id, "task-cli");

    const fullExport = runTypescriptRuntimeCommand({
      args: [
        "export-task",
        "cli-task",
        "--include-full-transcripts",
        "--zip",
        "--output",
        fullOutputDir,
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(fullExport.exitCode, 0);
    const fullExportPayload = JSON.parse(fullExport.stdout ?? "{}") as { archive: string; export_dir: string };
    assert.equal(fullExportPayload.export_dir, fullOutputDir);
    assert.equal(fullExportPayload.archive, `${fullOutputDir}.zip`);
    assert.equal(existsSync(`${fullOutputDir}.zip`), true);
    const fullManifest = JSON.parse(readFileSync(join(fullOutputDir, "manifest.json"), "utf8")) as {
      files: string[];
    };
    assert.ok(fullManifest.files.includes("transcript-segments.json"));
    assert.ok(fullManifest.files.includes("replay-full-transcript.json"));
    assert.ok(fullManifest.files.includes("transcripts/worker.txt"));
    const replayFullTranscript = JSON.parse(readFileSync(join(fullOutputDir, "replay-full-transcript.json"), "utf8")) as {
      entries: Array<{ content?: string; source: string }>;
    };
    assert.equal(replayFullTranscript.entries.some((entry) => (
      entry.source === "transcript_segments" && entry.content === "worker export line"
    )), true);
    assert.match(readFileSync(join(fullOutputDir, "transcripts", "worker.txt"), "utf8"), /worker export line/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles diagnostics telemetry audit and prune commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-diagnostics."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Exercise diagnostics commands.",
        name: "diag-task",
        now: "2026-06-05T10:00:00Z",
        taskId: "task-diag",
      });
      insertSession(database, { id: "session-diag-worker", name: "diag-worker", role: "worker", tmuxSession: "diag-worker-tmux" });
      insertSession(database, { id: "session-diag-manager", name: "diag-manager", role: "manager", tmuxSession: "diag-manager-tmux" });
      bindSessionsSync(database, {
        bindingId: "binding-diag",
        managerSessionName: "diag-manager",
        now: "2026-06-05T10:00:05Z",
        taskName: "diag-task",
        workerSessionName: "diag-worker",
      });
      createTaskSync(database, {
        goal: "Exercise session-backed live diagnostics.",
        name: "diag-session-task",
        now: "2026-06-05T10:00:10Z",
        taskId: "task-diag-session",
      });
      insertSession(database, { id: "session-live-worker", name: "session-live-worker", role: "worker", tmuxSession: "missing-session-worker" });
      insertSession(database, { id: "session-live-manager", name: "session-live-manager", role: "manager", tmuxSession: "missing-session-manager" });
	      bindSessionsSync(database, {
	        bindingId: "binding-diag-session",
	        managerSessionName: "session-live-manager",
	        now: "2026-06-05T10:00:15Z",
	        taskName: "diag-session-task",
	        workerSessionName: "session-live-worker",
	      });
	      createTaskSync(database, {
	        goal: "Exercise no-tmux app-session diagnostics.",
	        name: "diag-app-session-task",
	        now: "2026-06-05T10:00:20Z",
	        taskId: "task-diag-app-session",
	      });
	      const freshHeartbeat = new Date().toISOString();
	      insertSession(database, { id: "session-app-worker", lastHeartbeatAt: freshHeartbeat, name: "session-app-worker", pid: process.pid, role: "worker" });
	      insertSession(database, { id: "session-app-manager", lastHeartbeatAt: freshHeartbeat, name: "session-app-manager", pid: process.pid, role: "manager" });
	      bindSessionsSync(database, {
	        bindingId: "binding-diag-app-session",
	        managerSessionName: "session-app-manager",
	        now: "2026-06-05T10:00:25Z",
	        taskName: "diag-app-session-task",
	        workerSessionName: "session-app-worker",
	      });
	      createTaskSync(database, {
	        goal: "Exercise legacy binding telemetry diagnostics.",
	        name: "diag-legacy-task",
	        now: "2026-06-05T10:00:30Z",
	        taskId: "task-diag-legacy",
	      });
	      database.prepare("update tasks set state = 'managed' where id = 'task-diag-legacy'").run();
	      insertLegacyWorker(database, {
	        identityToken: "diag-legacy-only-token",
	        name: "diag-legacy-only-worker",
	        paneId: "%7",
	        workerId: "worker-diag-legacy-only",
	      });
	      database.prepare(`
	        insert into managers(id, name, task_id, tmux_session, state, codex_args_json, started_at, last_seen_at)
	        values ('manager-diag-legacy-only', 'diag-legacy-only-manager', 'task-diag-legacy', 'diag-legacy-only-manager-tmux', 'ready', '[]', '2026-06-05T10:00:30Z', '2026-06-05T10:00:31Z')
	      `).run();
	      database.prepare(`
	        insert into bindings(id, task_id, worker_id, manager_id, worker_session_id, manager_session_id, state, created_at, ended_at)
	        values ('binding-diag-legacy-only', 'task-diag-legacy', 'worker-diag-legacy-only', 'manager-diag-legacy-only', null, null, 'active', '2026-06-05T10:00:32Z', null)
	      `).run();
      database.prepare(`
        insert into managers(id, name, task_id, tmux_session, state, codex_args_json, started_at, last_seen_at)
        values ('manager-diag-legacy', 'diag-legacy-manager', 'task-diag', 'diag-legacy-manager-tmux', 'ready', '[]', '2026-06-05T10:00:00Z', '2000-01-01T00:00:00Z')
      `).run();
      database.prepare("update bindings set manager_id = 'manager-diag-legacy' where id = 'binding-diag'").run();
      database.prepare(`
        insert into manager_cycles(id, task_id, manager_id, started_at, completed_at, state, status_json, health_json, decision, error)
        values (1, 'task-diag', null, '2026-06-05T10:01:00Z', '2026-06-05T10:01:05Z', 'succeeded', ?, '{}', 'wait', null)
      `).run(JSON.stringify({ notable_pane_pattern: "trust_prompt", pane_signal: { captured: true } }));
	      database.prepare(`
	        insert into telemetry_events(id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json)
	        values
	          ('telemetry-diag-1', null, 'task-diag', '2026-06-05T10:02:00Z', 'dispatch', 'dispatch_watch_heartbeat', 'info', 'Dispatch heartbeat.', '{}', '{"new_events":2}'),
	          ('telemetry-diag-2', null, 'task-diag', '2026-06-05T10:03:00Z', 'workerctl', 'command_failed', 'error', 'Command failed.', '{}', '{"skipped_lines":1}'),
	          ('telemetry-diag-3', null, 'task-diag', '2026-06-05T10:03:30Z', 'workerctl', 'codex_events_ingested', 'warning', 'Ingest warning.', '{}', '{"new_events":3,"skipped_lines":2,"reason":"partial parse"}'),
	          ('telemetry-diag-fts', null, 'task-diag', '2026-06-05T10:03:45Z', 'workerctl', 'operator_note', 'info', 'Trust signal observed.', '{}', '{"context":"manager prompt review"}'),
	          ('telemetry-z-same-second', null, 'task-diag', '2026-06-05T10:03:50Z', 'system', 'same_second_first', 'info', 'Same-second event inserted first.', '{}', '{}'),
	          ('telemetry-a-same-second', null, 'task-diag', '2026-06-05T10:03:50Z', 'system', 'same_second_second', 'info', 'Same-second event inserted second.', '{}', '{}')
	      `).run();
	      database.prepare(`
	        insert into telemetry_events_fts(event_id, task_id, run_id, actor, event_type, summary, attributes)
	        values
	          ('telemetry-diag-1', 'task-diag', null, 'dispatch', 'dispatch_watch_heartbeat', 'Dispatch heartbeat.', '{"new_events":2}'),
	          ('telemetry-diag-2', 'task-diag', null, 'workerctl', 'command_failed', 'Command failed.', '{"skipped_lines":1}'),
	          ('telemetry-diag-3', 'task-diag', null, 'workerctl', 'codex_events_ingested', 'Ingest warning.', '{"new_events":3,"skipped_lines":2,"reason":"partial parse"}'),
	          ('telemetry-diag-fts', 'task-diag', null, 'workerctl', 'operator_note', 'Trust signal observed.', '{"context":"manager prompt review"}')
	      `).run();
      const decision = database.prepare(`
        insert into manager_decisions(task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json)
        values ('task-diag', null, null, 'stop', 'Finish task.', '2026-06-05T10:04:00Z', '{}')
      `).run();
      const decisionId = Number(decision.lastInsertRowid);
	      createCommandSync(database, {
	        commandId: "command-diag-finish",
	        commandType: "finish_task",
	        correlationId: "diag-finish",
        now: "2026-06-05T10:05:00Z",
        payload: { manager_decision: { decision_id: decisionId } },
        taskId: "task-diag",
	      });
	      database.prepare("update commands set state = 'succeeded', result_json = ? where id = 'command-diag-finish'")
	        .run(JSON.stringify({ manager_decision: { decision: { decision: "stop", id: decisionId }, warnings: [] } }));
	      createCommandSync(database, {
	        commandId: "command-diag-pending",
	        commandType: "continue_iteration",
	        correlationId: "diag-pending",
	        now: "2026-06-05T10:05:30Z",
	        payload: {},
	        taskId: "task-diag",
	      });
	      insertLegacyWorker(database, {
	        identityToken: "diag-legacy-token",
	        name: "diag-legacy",
	        paneId: "%3",
	        workerId: "worker-diag-legacy",
	      });
	      database.prepare("update bindings set worker_id = 'worker-diag-legacy' where id = 'binding-diag'").run();
	      database.prepare(`
	        insert into bindings(id, task_id, worker_id, manager_id, worker_session_id, manager_session_id, state, created_at, ended_at)
	        values ('binding-diag-ended', 'task-diag', 'worker-diag-legacy', null, null, null, 'ended', '2026-06-05T09:00:00Z', '2026-06-05T09:30:00Z')
	      `).run();
	      database.prepare(`
	        insert into transcript_captures(worker_id, sha256, content, captured_at, changed_at, history_lines, byte_count, line_count, capture_kind, retention_class)
	        values
	          ('worker-diag-legacy', 'sha-old', 'old content', '2026-06-05T10:05:00Z', '2026-06-05T10:05:00Z', 20, 11, 1, 'changed', 'hot'),
	          ('worker-diag-legacy', 'sha-new', 'new content', '2026-06-05T10:06:00Z', '2026-06-05T10:06:00Z', 20, 11, 1, 'latest', 'hot')
	      `).run();
	      const captureId = insertTerminalCapture(database, "task-diag", "worker", "2026-06-05T10:06:30Z", "terminal capture bytes");
	      database.prepare(`
	        insert into transcript_segments(
	          task_id, role, source_capture_id, previous_capture_id, captured_at,
	          content_sha256, segment_text, segment_start_line, segment_end_line,
	          byte_count, line_count, retention_class, segment_kind, created_at
	        )
	        values ('task-diag', 'worker', ?, null, '2026-06-05T10:06:31Z', 'diag-segment-sha', 'segment bytes', 1, 1, 13, 1, 'hot', 'segment', '2026-06-05T10:06:31Z')
	      `).run(captureId);
	    } finally {
	      database.close();
	    }

    const telemetrySummary = runTypescriptRuntimeCommand({
      args: ["telemetry", "--task", "diag-task", "--summary", "--json", "--path", dbPath],
      env: {},
	    });
	    assert.equal(telemetrySummary.exitCode, 0);
	    assert.equal(telemetrySummary.handled, true);
	    const summaryPayload = JSON.parse(telemetrySummary.stdout ?? "{}") as { by_actor: Record<string, number>; by_severity: Record<string, number>; task_id: string | null; total: number };
	    assert.equal(summaryPayload.total, 8);
	    assert.equal(summaryPayload.task_id, "task-diag");
	    assert.equal(summaryPayload.by_actor.dispatch, 1);
	    assert.equal(summaryPayload.by_severity.error, 1);

	    const telemetryTimeline = runTypescriptRuntimeCommand({
	      args: ["telemetry", "--task", "diag-task", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(telemetryTimeline.exitCode, 0);
	    const timelinePayload = JSON.parse(telemetryTimeline.stdout ?? "[]") as Array<{ id: string }>;
	    assert.deepEqual(
	      timelinePayload.filter((event) => event.id.includes("same-second")).map((event) => event.id),
	      ["telemetry-z-same-second", "telemetry-a-same-second"],
	    );
	    const telemetryNewestTimeline = runTypescriptRuntimeCommand({
	      args: ["telemetry", "--task", "diag-task", "--newest", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(telemetryNewestTimeline.exitCode, 0);
	    const newestTimelinePayload = JSON.parse(telemetryNewestTimeline.stdout ?? "[]") as Array<{ id: string }>;
	    assert.deepEqual(
	      newestTimelinePayload.filter((event) => event.id.includes("same-second")).map((event) => event.id),
	      ["telemetry-a-same-second", "telemetry-z-same-second"],
	    );

	    const telemetrySearch = runTypescriptRuntimeCommand({
	      args: ["telemetry", "--task", "diag-task", "--search", "trust prompt", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(telemetrySearch.exitCode, 0);
	    const searchPayload = JSON.parse(telemetrySearch.stdout ?? "[]") as Array<{ id: string }>;
	    assert.deepEqual(searchPayload.map((event) => event.id), ["telemetry-diag-fts"]);

	    const telemetryTask = runTypescriptRuntimeCommand({
	      args: ["telemetry", "task", "diag-task", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(telemetryTask.exitCode, 0);
		    const taskPayload = JSON.parse(telemetryTask.stdout ?? "{}") as {
		      alerts: Array<{ type: string }>;
		      commands: { counts_by_state: Record<string, number>; failed_count: number; recent: Array<{ id: string }>; total: number };
		      criteria: { open: unknown[]; open_count: number; summary: Record<string, number>; total: number };
		      cycles: { failed: Array<{ id: number }>; failed_count: number; history: Array<{ id: number }>; last_successful: { id: number } | null; pane_capture_failures: Array<{ id: number }>; pane_capture_failure_count: number; total: number };
		      decisions: { recent: Array<{ decision: string; payload_keys: string[] }> };
		      ingest: { error_count: number; skipped_lines: number };
		      storage: { terminal_captures: { bytes: number; count: number }; total_retained: number; transcript_captures: { bytes: number; count: number }; transcript_segments: { bytes: number; count: number } };
		      task: { name: string };
		      telemetry: { summary: { by_severity: Record<string, number> } };
		    };
	    assert.equal(taskPayload.task.name, "diag-task");
	    assert.equal(taskPayload.telemetry.summary.by_severity.error, 1);
	    assert.ok(taskPayload.alerts.some((alert) => alert.type === "notable_pane_pattern"));
	    assert.equal(taskPayload.ingest.error_count, 1);
		    assert.equal(taskPayload.ingest.skipped_lines, 2);
		    assert.equal(taskPayload.storage.terminal_captures.count, 1);
		    assert.equal(taskPayload.storage.transcript_captures.count, 2);
		    assert.equal(taskPayload.storage.transcript_captures.bytes, 22);
		    assert.equal(taskPayload.storage.transcript_segments.count, 1);
		    assert.ok(taskPayload.storage.total_retained > 0);
		    assert.deepEqual(taskPayload.criteria, {
		      open: [],
		      open_count: 0,
		      summary: { accepted: 0, deferred: 0, proposed: 0, rejected: 0, satisfied: 0 },
		      total: 0,
		    });
		    assert.equal(taskPayload.cycles.total, 1);
		    assert.equal(taskPayload.cycles.failed_count, 0);
		    assert.deepEqual(taskPayload.cycles.failed, []);
		    assert.equal(taskPayload.cycles.last_successful?.id, 1);
		    assert.deepEqual(taskPayload.cycles.pane_capture_failures, []);
		    assert.equal(taskPayload.cycles.pane_capture_failure_count, 0);
		    assert.equal(taskPayload.decisions.recent[0].decision, "stop");
		    assert.deepEqual(taskPayload.decisions.recent[0].payload_keys, []);
		    assert.equal(taskPayload.commands.total, 2);
		    assert.equal(taskPayload.commands.failed_count, 0);

    const divergences = runTypescriptRuntimeCommand({
      args: ["divergences", "diag-task", "--limit", "5", "--path", dbPath],
      env: {},
    });
    assert.equal(divergences.exitCode, 0);
    assert.equal(JSON.parse(divergences.stdout ?? "[]")[0].notable_pane_pattern, "trust_prompt");

    const mutationAudit = runTypescriptRuntimeCommand({
      args: ["mutation-audit", "diag-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(mutationAudit.exitCode, 0);
    const mutationPayload = JSON.parse(mutationAudit.stdout ?? "{}") as { records: Array<{ ok: boolean }>; summary: { mutations: number } };
    assert.equal(mutationPayload.summary.mutations, 1);
    assert.equal(mutationPayload.records[0].ok, true);

    const dbDoctorTmuxRunner: TmuxRunner = (args) => {
      const target = args[args.length - 1];
      if (args[1] === "has-session") {
        return { status: target === "diag-legacy-manager-tmux" ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[1] === "list-panes" && target === "diag-legacy-manager-tmux") {
        return { status: 0, stdout: "%9\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
	    const dbDoctor = runTypescriptRuntimeCommand({
	      args: ["db-doctor", "--live", "--manager-stale-seconds", "1", "--path", dbPath],
	      env: {},
      tmuxRunner: dbDoctorTmuxRunner,
	    });
	    assert.equal(dbDoctor.handled, true);
	    const doctorPayload = JSON.parse(dbDoctor.stdout ?? "{}") as {
	      checks: Array<{ name: string; unfinished_command_count?: number }>;
	      live_reconcile: {
	        manager_liveness_warnings: Array<{ manager: string; reason: string }>;
	        ok: boolean;
	        results: Array<{
	          drift: string[];
	          manager: { live: boolean; name: string } | null;
	          task: { name: string };
	          unfinished_commands: unknown[];
	          worker: { live: boolean; name: string } | null;
	        }>;
	      };
	      ok: boolean;
	      path: string;
	    };
	    assert.equal(doctorPayload.path, dbPath);
	    assert.equal(dbDoctor.exitCode, doctorPayload.ok ? 0 : 1);
	    assert.equal(typeof doctorPayload.live_reconcile.ok, "boolean");
	    assert.equal(doctorPayload.live_reconcile.ok, false);
    const legacyDrift = doctorPayload.live_reconcile.results.find((row) => row.task.name === "diag-task");
	    assert.notEqual(legacyDrift, undefined);
    assert.equal(legacyDrift?.worker?.name, "diag-legacy");
    assert.equal(legacyDrift?.worker?.live, false);
    assert.ok(legacyDrift?.drift.includes("worker_missing"));
    assert.ok(legacyDrift?.drift.includes("unfinished_commands"));
    assert.equal(legacyDrift?.unfinished_commands.length, 1);
	    assert.equal(doctorPayload.checks.find((check) => check.name === "live_reconcile")?.unfinished_command_count, 1);
	    assert.equal(doctorPayload.live_reconcile.manager_liveness_warnings.length, 1);
    assert.equal(doctorPayload.live_reconcile.manager_liveness_warnings[0].reason, "manager_seen_stale");
    const sessionDrift = doctorPayload.live_reconcile.results.find((row) => row.task.name === "diag-session-task");
    assert.notEqual(sessionDrift, undefined);
    assert.equal(sessionDrift?.worker?.name, "session-live-worker");
    assert.equal(sessionDrift?.worker?.live, false);
	    assert.equal(sessionDrift?.manager?.name, "session-live-manager");
	    assert.equal(sessionDrift?.manager?.live, false);
	    assert.ok(sessionDrift?.drift.includes("worker_missing"));
	    assert.ok(sessionDrift?.drift.includes("manager_missing"));
	    const appSession = doctorPayload.live_reconcile.results.find((row) => row.task.name === "diag-app-session-task");
	    assert.notEqual(appSession, undefined);
	    assert.equal(appSession?.worker?.name, "session-app-worker");
	    assert.equal(appSession?.worker?.live, true);
	    assert.equal(appSession?.manager?.name, "session-app-manager");
	    assert.equal(appSession?.manager?.live, true);
	    assert.deepEqual(appSession?.drift, []);

    const storageCheck = runTypescriptRuntimeCommand({
      args: ["telemetry", "check", "--max-storage-bytes", "1", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(storageCheck.exitCode, 1);
	    const storagePayload = JSON.parse(storageCheck.stdout ?? "{}") as { alerts: Array<{ type: string }>; storage: { total_bytes: number } };
	    assert.ok(storagePayload.storage.total_bytes > 1);
	    assert.ok(storagePayload.alerts.some((alert) => alert.type === "storage_bytes"));

	    const scopedTaskCheck = runTypescriptRuntimeCommand({
	      args: ["telemetry", "check", "--task", "diag-app-session-task", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(scopedTaskCheck.exitCode, 0);
	    const scopedTaskPayload = JSON.parse(scopedTaskCheck.stdout ?? "{}") as {
	      alerts: Array<{ type: string }>;
	      checks: { ok: boolean };
	      task: { name: string };
	    };
	    assert.equal(scopedTaskPayload.task.name, "diag-app-session-task");
	    assert.equal(scopedTaskPayload.checks.ok, true);
	    assert.deepEqual(scopedTaskPayload.alerts, []);

	    let staleTaskDb = openDatabaseSync(dbPath);
	    try {
	      staleTaskDb.prepare("update sessions set last_heartbeat_at = '2000-01-01T00:00:00Z' where id in ('session-app-worker', 'session-app-manager')").run();
	    } finally {
	      staleTaskDb.close();
	    }
	    const scopedStaleTaskCheck = runTypescriptRuntimeCommand({
	      args: ["telemetry", "check", "--task", "diag-app-session-task", "--worker-staleness-seconds", "1", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(scopedStaleTaskCheck.exitCode, 1);
	    const scopedStaleTaskPayload = JSON.parse(scopedStaleTaskCheck.stdout ?? "{}") as {
	      alerts: Array<{ type: string }>;
	      checks: { ok: boolean };
	    };
	    assert.equal(scopedStaleTaskPayload.checks.ok, false);
	    assert.ok(scopedStaleTaskPayload.alerts.some((alert) => alert.type === "stale_sessions"));
	    staleTaskDb = openDatabaseSync(dbPath);
	    try {
	      const restoredHeartbeat = new Date().toISOString();
	      staleTaskDb.prepare("update sessions set last_heartbeat_at = ? where id in ('session-app-worker', 'session-app-manager')").run(restoredHeartbeat);
	    } finally {
	      staleTaskDb.close();
	    }

		    let metricsNowIso = "";
	    let proofDb = openDatabaseSync(dbPath);
	    try {
	      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	      metricsNowIso = nowIso;
      createTaskSync(proofDb, {
        goal: "Other completed task.",
        name: "diag-other-task",
        now: "2026-06-05T10:07:00Z",
        taskId: "task-diag-other",
      });
      proofDb.prepare("update tasks set state = 'done' where id = 'task-diag-other'").run();
      proofDb.prepare(`
        insert into runs(id, task_id, name, purpose, status, started_at, metadata_json)
        values
          ('run-diag', 'task-diag', 'diag-run', 'ralph_loop', 'active', ?, '{}'),
          ('run-other', 'task-diag-other', 'other-run', 'ralph_loop', 'finished', ?, '{}')
      `).run(nowIso, nowIso);
	      createTaskSync(proofDb, {
	        goal: "Extra active task.",
	        name: "diag-extra-active-task",
	        now: nowIso,
	        taskId: "task-diag-extra-active",
	      });
	      createTaskSync(proofDb, {
	        goal: "Managed task missing bindings.",
	        name: "diag-integrity-task",
	        now: nowIso,
	        taskId: "task-diag-integrity",
	      });
	      proofDb.prepare("update tasks set state = 'managed' where id = 'task-diag-integrity'").run();
	      proofDb.prepare(`
	        insert into runs(id, task_id, name, purpose, status, started_at, metadata_json)
	        values ('run-diag-shadow', 'task-diag-extra-active', 'diag-run', 'ralph_loop', 'active', ?, '{}')
      `).run(new Date(Date.now() + 1000).toISOString());
      proofDb.prepare(`
        insert into manager_cycles(id, task_id, started_at, completed_at, state, status_json, health_json, error)
        values
          (2, 'task-diag', ?, ?, 'failed', '{"notable_pane_pattern":"failure_pattern"}', '{}', 'current run failure'),
          (3, 'task-diag-other', ?, ?, 'failed', '{}', '{}', 'other run failure'),
          (4, 'task-diag', '2000-01-01T00:00:00Z', '2000-01-01T00:00:01Z', 'failed', '{}', '{}', 'old run failure'),
          (5, 'task-diag', ?, ?, 'succeeded', '{"pane_signal":{"captured":false},"error_type":"IngestWarning"}', '{}', 'Ingest pane capture failed')
      `).run(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);
      proofDb.prepare(`
        insert into manager_cycle_spans(manager_cycle_id, task_id, run_id, phase, started_at, completed_at, duration_ms, state, attributes_json)
        values
          (2, 'task-diag', 'run-diag', 'classify', ?, ?, 1, 'failed', '{}'),
          (3, 'task-diag-other', 'run-other', 'classify', ?, ?, 1, 'failed', '{}'),
          (4, 'task-diag', 'run-diag', 'classify', '2000-01-01T00:00:00Z', '2000-01-01T00:00:01Z', 1, 'failed', '{}'),
          (5, 'task-diag', 'run-diag', 'capture', ?, ?, 1, 'succeeded', '{}')
      `).run(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);
      proofDb.prepare(`
        insert into telemetry_events(id, run_id, task_id, timestamp, actor, event_type, severity, summary, correlation_json, attributes_json)
        values ('telemetry-diag-run-ingest', 'run-diag', 'task-diag', ?, 'workerctl', 'codex_events_ingested', 'warning', 'Run ingest skipped lines.', '{}', '{"new_events":5,"skipped_lines":4,"reason":"bad line"}')
      `).run(nowIso);
      proofDb.prepare(`
        insert into acceptance_criteria(task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at)
        values ('task-diag', 'Run criterion remains accepted.', 'accepted', 'manager_inferred', null, null, '{"ralph_loop_run_id":"run-diag"}', ?, ?)
      `).run(nowIso, nowIso);
      createCommandSync(proofDb, {
        commandId: "command-diag-loop",
        commandType: "continue_iteration",
        correlationId: "diag-loop",
        now: nowIso,
        payload: { ralph_loop_run_id: "run-diag" },
        taskId: "task-diag",
      });
      createCommandSync(proofDb, {
        commandId: "command-diag-old-loop",
        commandType: "continue_iteration",
        correlationId: "diag-old-loop",
        now: "2000-01-01T00:00:00Z",
        payload: { ralph_loop_run_id: "run-diag" },
        taskId: "task-diag",
      });
      createCommandSync(proofDb, {
        commandId: "command-other-loop",
        commandType: "continue_iteration",
        correlationId: "other-loop",
        now: nowIso,
        payload: { ralph_loop_run_id: "run-other" },
        taskId: "task-diag-other",
      });
	      proofDb.prepare("update commands set state = 'failed', error = 'completed task failed command' where id = 'command-other-loop'").run();
	    } finally {
	      proofDb.close();
	    }

	    const activeOnlyCheck = runTypescriptRuntimeCommand({
	      args: [
	        "telemetry",
	        "check",
	        "--active-only",
	        "--max-open-criteria",
	        "99",
	        "--max-unfinished-commands",
	        "99",
	        "--worker-staleness-seconds",
	        "999999999",
	        "--json",
	        "--path",
	        dbPath,
	      ],
	      env: {},
	    });
	    const activeOnlyPayload = JSON.parse(activeOnlyCheck.stdout ?? "{}") as {
	      alerts: Array<{ type: string }>;
	      commands: { failed_count: number };
	    };
	    assert.equal(activeOnlyPayload.commands.failed_count, 0);
	    assert.ok(!activeOnlyPayload.alerts.some((alert) => alert.type === "failed_commands"));

	    proofDb = openDatabaseSync(dbPath);
	    try {
	      proofDb.prepare("update commands set state = 'failed', error = 'failed command' where id in ('command-diag-loop', 'command-diag-old-loop')").run();
	      proofDb.prepare("update commands set updated_at = '2000-01-01T00:00:01Z' where id = 'command-diag-old-loop'").run();
	    } finally {
	      proofDb.close();
	    }

	    const failures = runTypescriptRuntimeCommand({
      args: ["telemetry", "failures", "--task", "diag-task", "--run", "diag-run", "--active-only", "--window", "1h", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(failures.exitCode, 0);
    const failuresPayload = JSON.parse(failures.stdout ?? "{}") as {
      alerts: Array<{ type: string }>;
      failed_commands: Array<{ id: string; task_name: string }>;
      failed_cycles: Array<{ id: number; notable_pane_pattern: string | null; status: Record<string, unknown>; task_name: string }>;
      filters: { active_only: boolean; run_id: string; task_id: string; window: { label: string } };
      ingest: { error_count: number; skipped_lines: number };
      open_criteria: { open_accepted_count: number };
      pane_capture_failures: Array<{ id: number; task_name: string }>;
    };
    assert.deepEqual(failuresPayload.failed_cycles.map((cycle) => cycle.id), [2]);
    assert.deepEqual(failuresPayload.failed_commands.map((command) => command.id), ["command-diag-loop"]);
    assert.deepEqual(failuresPayload.pane_capture_failures.map((cycle) => cycle.id), [5]);
    assert.equal(failuresPayload.failed_cycles[0].task_name, "diag-task");
    assert.equal(failuresPayload.failed_cycles[0].notable_pane_pattern, "failure_pattern");
    assert.equal(failuresPayload.failed_cycles[0].status.notable_pane_pattern, "failure_pattern");
    assert.equal(failuresPayload.failed_commands[0].task_name, "diag-task");
    assert.equal(failuresPayload.ingest.error_count, 1);
    assert.equal(failuresPayload.ingest.skipped_lines, 4);
    assert.equal(failuresPayload.open_criteria.open_accepted_count, 1);
    assert.ok(failuresPayload.alerts.some((alert) => alert.type === "ingest_errors"));
    assert.ok(failuresPayload.alerts.some((alert) => alert.type === "pane_capture_failures"));
    assert.ok(failuresPayload.alerts.some((alert) => alert.type === "open_accepted_criteria"));
    assert.equal(failuresPayload.filters.active_only, true);
    assert.equal(failuresPayload.filters.run_id, "run-diag");
    assert.equal(failuresPayload.filters.task_id, "task-diag");
    assert.equal(failuresPayload.filters.window.label, "1h");

    const limitedTask = runTypescriptRuntimeCommand({
      args: ["telemetry", "task", "diag-task", "--limit", "1", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(limitedTask.exitCode, 0);
	    const limitedTaskPayload = JSON.parse(limitedTask.stdout ?? "{}") as {
	      cycles: { counts_by_state: Record<string, number>; failed: Array<{ id: number }>; failed_count: number; history: Array<{ id: number }>; last_successful: { id: number } | null; pane_capture_failures: Array<{ id: number }>; pane_capture_failure_count: number; total: number };
	    };
	    assert.deepEqual(limitedTaskPayload.cycles.history.map((cycle) => cycle.id), [5]);
	    assert.equal(limitedTaskPayload.cycles.counts_by_state.failed, 2);
	    assert.equal(limitedTaskPayload.cycles.counts_by_state.succeeded, 2);
	    assert.deepEqual(limitedTaskPayload.cycles.failed.map((cycle) => cycle.id), [4]);
	    assert.equal(limitedTaskPayload.cycles.failed_count, 2);
	    assert.equal(limitedTaskPayload.cycles.last_successful?.id, 5);
	    assert.deepEqual(limitedTaskPayload.cycles.pane_capture_failures.map((cycle) => cycle.id), [5]);
	    assert.equal(limitedTaskPayload.cycles.pane_capture_failure_count, 1);
	    assert.equal(limitedTaskPayload.cycles.total, 4);

	    const metrics = runTypescriptRuntimeCommand({
	      args: ["telemetry", "metrics", "--task", "diag-task", "--window", "1h", "--json", "--path", dbPath],
	      env: {},
	      now: () => new Date(metricsNowIso.replace(/Z$/, ".789Z")),
	    });
	    assert.equal(metrics.exitCode, 0, metrics.stderr);
	    const metricsPayload = JSON.parse(metrics.stdout ?? "{}") as {
	      counters: {
	        cycles: { failed: number; succeeded: number; total: number };
	        pane_capture: { failed: number };
	        telemetry_events: {
	          by_actor_event_type_severity: Record<string, Record<string, Record<string, number>>>;
	          total: number;
	        };
	      };
	      gauges: { active_tasks: number };
	      rollups: { commands_by_type: Record<string, Record<string, number>>; cycle_success_rate: number };
	    };
    assert.equal(metricsPayload.counters.cycles.failed, 1);
    assert.equal(metricsPayload.counters.cycles.succeeded, 1);
    assert.equal(metricsPayload.counters.cycles.total, 2);
	    assert.equal(metricsPayload.counters.pane_capture.failed, 1);
	    assert.ok(metricsPayload.counters.telemetry_events.total >= 1);
	    assert.equal(metricsPayload.counters.telemetry_events.by_actor_event_type_severity.workerctl.codex_events_ingested.warning, 1);
	    assert.equal(metricsPayload.gauges.active_tasks, 1);
	    assert.equal(metricsPayload.rollups.commands_by_type.continue_iteration.failed, 1);
	    assert.equal(metricsPayload.rollups.cycle_success_rate, 0.5);

	    const runMetrics = runTypescriptRuntimeCommand({
	      args: ["telemetry", "metrics", "--run", "run-diag", "--window", "1h", "--json", "--path", dbPath],
	      env: {},
	      now: () => new Date(metricsNowIso.replace(/Z$/, ".789Z")),
	    });
	    assert.equal(runMetrics.exitCode, 0, runMetrics.stderr);
	    const runMetricsPayload = JSON.parse(runMetrics.stdout ?? "{}") as {
	      counters: { cycles: { failed: number; succeeded: number; total: number }; pane_capture: { failed: number } };
	      filters: { run_id: string; task_id: string | null };
	      rollups: { commands_by_type: Record<string, Record<string, number>>; cycle_success_rate: number };
	    };
	    assert.equal(runMetricsPayload.filters.run_id, "run-diag");
	    assert.equal(runMetricsPayload.filters.task_id, null);
	    assert.equal(runMetricsPayload.counters.cycles.failed, 1);
	    assert.equal(runMetricsPayload.counters.cycles.succeeded, 1);
	    assert.equal(runMetricsPayload.counters.cycles.total, 2);
	    assert.equal(runMetricsPayload.counters.pane_capture.failed, 1);
	    assert.equal(runMetricsPayload.rollups.commands_by_type.continue_iteration.failed, 1);
	    assert.equal(runMetricsPayload.rollups.cycle_success_rate, 0.5);

	    const scopedRunNameMetrics = runTypescriptRuntimeCommand({
	      args: ["telemetry", "metrics", "--task", "diag-task", "--run", "diag-run", "--window", "1h", "--json", "--path", dbPath],
	      env: {},
	      now: () => new Date(metricsNowIso.replace(/Z$/, ".789Z")),
	    });
	    assert.equal(scopedRunNameMetrics.exitCode, 0, scopedRunNameMetrics.stderr);
	    const scopedRunNameMetricsPayload = JSON.parse(scopedRunNameMetrics.stdout ?? "{}") as {
	      counters: { cycles: { failed: number; succeeded: number; total: number } };
	      filters: { run_id: string; task_id: string | null };
	    };
	    assert.equal(scopedRunNameMetricsPayload.filters.run_id, "run-diag");
	    assert.equal(scopedRunNameMetricsPayload.filters.task_id, "task-diag");
	    assert.equal(scopedRunNameMetricsPayload.counters.cycles.failed, 1);
	    assert.equal(scopedRunNameMetricsPayload.counters.cycles.succeeded, 1);
	    assert.equal(scopedRunNameMetricsPayload.counters.cycles.total, 2);

	    const scopedRunNameEvents = runTypescriptRuntimeCommand({
	      args: ["telemetry", "--task", "diag-task", "--run", "diag-run", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(scopedRunNameEvents.exitCode, 0, scopedRunNameEvents.stderr);
	    const scopedRunNameEventsPayload = JSON.parse(scopedRunNameEvents.stdout ?? "[]") as Array<{ id: string; run_id: string; task_id: string }>;
	    assert.deepEqual(scopedRunNameEventsPayload.map((event) => event.id), ["telemetry-diag-run-ingest"]);
	    assert.deepEqual(scopedRunNameEventsPayload.map((event) => [event.run_id, event.task_id]), [["run-diag", "task-diag"]]);

			    const telemetrySnapshot = runTypescriptRuntimeCommand({
			      args: ["telemetry", "snapshot", "--task", "diag-task", "--json", "--path", dbPath],
			      env: {},
			    });
		    assert.equal(telemetrySnapshot.exitCode, 0, telemetrySnapshot.stderr);
		    const telemetrySnapshotPayload = JSON.parse(telemetrySnapshot.stdout ?? "{}") as { telemetry: { summary: { run_id: string | null; task_id: string | null } } };
		    assert.equal(telemetrySnapshotPayload.telemetry.summary.task_id, "task-diag");
		    assert.equal(telemetrySnapshotPayload.telemetry.summary.run_id, "run-diag");

		    const legacySnapshot = runTypescriptRuntimeCommand({
		      args: ["telemetry", "snapshot", "--task", "diag-legacy-task", "--json", "--path", dbPath],
		      env: {},
		    });
		    assert.equal(legacySnapshot.exitCode, 0, legacySnapshot.stderr);
		    const legacySnapshotPayload = JSON.parse(legacySnapshot.stdout ?? "{}") as {
		      alerts: Array<{ type: string }>;
		      manager: { name: string; role: string } | null;
		      task: { integrity: { ok: boolean } };
		      worker: { name: string; role: string } | null;
		    };
		    assert.equal(legacySnapshotPayload.task.integrity.ok, true);
		    assert.equal(legacySnapshotPayload.worker?.name, "diag-legacy-only-worker");
		    assert.equal(legacySnapshotPayload.worker?.role, "worker");
		    assert.equal(legacySnapshotPayload.manager?.name, "diag-legacy-only-manager");
		    assert.equal(legacySnapshotPayload.manager?.role, "manager");
		    assert.ok(!legacySnapshotPayload.alerts.some((alert) => alert.type === "integrity_issue"));

			    const integritySnapshot = runTypescriptRuntimeCommand({
	      args: ["telemetry", "snapshot", "--task", "diag-integrity-task", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(integritySnapshot.exitCode, 0, integritySnapshot.stderr);
	    const integritySnapshotPayload = JSON.parse(integritySnapshot.stdout ?? "{}") as {
	      alerts: Array<{ message: string; type: string }>;
	      task: { integrity: { issues: string[]; ok: boolean } };
	    };
	    assert.deepEqual(integritySnapshotPayload.task.integrity, {
	      issues: ["managed_without_active_worker_binding", "managed_without_active_manager"],
	      ok: false,
	    });
	    assert.deepEqual(
	      integritySnapshotPayload.alerts.filter((alert) => alert.type === "integrity_issue").map((alert) => alert.message),
	      ["managed_without_active_worker_binding", "managed_without_active_manager"],
	    );

	    const integrityTask = runTypescriptRuntimeCommand({
	      args: ["telemetry", "task", "diag-integrity-task", "--json", "--path", dbPath],
	      env: {},
	    });
	    assert.equal(integrityTask.exitCode, 0, integrityTask.stderr);
	    const integrityTaskPayload = JSON.parse(integrityTask.stdout ?? "{}") as { alerts: Array<{ message: string; type: string }> };
	    assert.deepEqual(
	      integrityTaskPayload.alerts.filter((alert) => alert.type === "integrity_issue").map((alert) => alert.message),
	      ["managed_without_active_worker_binding", "managed_without_active_manager"],
	    );

	    const dryPrune = runTypescriptRuntimeCommand({
      args: ["prune", "--keep-latest", "1", "--dry-run", "--path", dbPath],
      env: {},
    });
    assert.deepEqual(JSON.parse(dryPrune.stdout ?? "{}"), {
      dry_run: true,
      keep_latest: 1,
      pruned_count: 0,
      would_prune_count: 1,
    });
    proofDb = openDatabaseSync(dbPath);
    try {
      const oldCapture = proofDb.prepare("select content, capture_kind, retention_class from transcript_captures where sha256 = 'sha-old'")
        .get() as { capture_kind: string; content: string | null; retention_class: string };
      assert.deepEqual(Object.fromEntries(Object.entries(oldCapture)), {
        capture_kind: "changed",
        content: "old content",
        retention_class: "hot",
      });
    } finally {
      proofDb.close();
    }

    const pruned = runTypescriptRuntimeCommand({
      args: ["prune", "--keep-latest", "1", "--path", dbPath],
      env: {},
    });
    assert.deepEqual(JSON.parse(pruned.stdout ?? "{}"), {
      dry_run: false,
      keep_latest: 1,
      pruned_count: 1,
      would_prune_count: 1,
    });
    proofDb = openDatabaseSync(dbPath);
    try {
      const oldCapture = proofDb.prepare("select content, capture_kind, retention_class from transcript_captures where sha256 = 'sha-old'")
        .get() as { capture_kind: string; content: string | null; retention_class: string };
      assert.deepEqual(Object.fromEntries(Object.entries(oldCapture)), {
        capture_kind: "metadata_only",
        content: null,
        retention_class: "warm",
      });
      const newestContent = (proofDb.prepare("select content from transcript_captures where sha256 = 'sha-new'").get() as { content: string }).content;
      assert.equal(newestContent, "new content");
      const event = proofDb.prepare("select payload_json from events where type = 'transcript_captures_pruned'")
        .get() as { payload_json: string };
      assert.deepEqual(JSON.parse(event.payload_json), { capture_ids: [1], keep_latest: 1 });
    } finally {
      proofDb.close();
    }
    const telemetryTaskAfterPrune = runTypescriptRuntimeCommand({
      args: ["telemetry", "task", "diag-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(telemetryTaskAfterPrune.exitCode, 0);
    const afterPrunePayload = JSON.parse(telemetryTaskAfterPrune.stdout ?? "{}") as {
      storage: { total_retained: number; transcript_captures: { bytes: number; count: number } };
    };
    assert.equal(afterPrunePayload.storage.transcript_captures.count, 1);
    assert.equal(afterPrunePayload.storage.transcript_captures.bytes, 11);
    assert.ok(afterPrunePayload.storage.total_retained < taskPayload.storage.total_retained);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime reconcile dry-run apply and doctor-self preserve mutation guardrails", () => {
  withTemporaryHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-reconcile."));
    try {
      const env = { HOME: home, USERPROFILE: home, WORKERCTL_STATE_ROOT: join(root, "state") };
      const dbPath = defaultDbPath({ env });
      const database = openDatabaseSync(dbPath);
      try {
        initializeDatabaseSync(database);
        createTaskSync(database, {
          goal: "Exercise reconcile.",
          name: "reconcile-task",
          now: "2026-06-05T11:00:00Z",
          taskId: "task-reconcile",
        });
        insertSession(database, { id: "session-reconcile-worker", name: "reconcile-worker", role: "worker" });
        insertSession(database, { id: "session-reconcile-manager", name: "reconcile-manager", role: "manager" });
        database.prepare("update sessions set pid = 999999999, last_heartbeat_at = '2026-06-05T11:00:00Z' where id = 'session-reconcile-worker'").run();
        database.prepare("update sessions set state = 'gone' where id = 'session-reconcile-manager'").run();
        bindSessionsSync(database, {
          bindingId: "binding-reconcile",
          managerSessionName: "reconcile-manager",
          now: "2026-06-05T11:00:05Z",
          taskName: "reconcile-task",
          workerSessionName: "reconcile-worker",
        });
        database.prepare(`
          insert into manager_cycles(id, task_id, started_at, completed_at, state, status_json, health_json, error)
          values (1, 'task-reconcile', '2026-06-05T10:00:00Z', '2026-06-05T10:00:05Z', 'succeeded', '{}', '{}', null)
        `).run();
      } finally {
        database.close();
      }

      const pathFallback = runTypescriptRuntimeCommand({
        args: ["reconcile", "--path", dbPath],
        env,
      });
      assert.equal(pathFallback.exitCode, 0);

      const dryRun = runTypescriptRuntimeCommand({
        args: ["reconcile", "--stale-cycles-seconds", "1"],
        env,
      });
      assert.equal(dryRun.exitCode, 0);
      const dryPayload = JSON.parse(dryRun.stdout ?? "{}") as { dangling_bindings: unknown[]; dead_pid_sessions: unknown[]; stuck_tasks: unknown[] };
      assert.equal(dryPayload.dead_pid_sessions.length, 1);
      assert.equal(dryPayload.dangling_bindings.length, 1);
      assert.equal(dryPayload.stuck_tasks.length, 1);
      let proofDb = openDatabaseSync(dbPath);
      try {
        assert.equal((proofDb.prepare("select state from sessions where name = 'reconcile-worker'").get() as { state: string }).state, "active");
        assert.equal((proofDb.prepare("select state from bindings where id = 'binding-reconcile'").get() as { state: string }).state, "active");
        assert.equal((proofDb.prepare("select count(*) as count from events where type like '%reconcile'").get() as { count: number }).count, 0);
      } finally {
        proofDb.close();
      }

      const applied = runTypescriptRuntimeCommand({
        args: ["reconcile", "--apply", "--stale-cycles-seconds", "1"],
        env,
      });
      assert.equal(applied.exitCode, 0);
      const applyPayload = JSON.parse(applied.stdout ?? "{}") as { applied: { bindings_marked_invalid: string[]; sessions_marked_gone: string[] } };
      assert.deepEqual(applyPayload.applied.sessions_marked_gone, ["reconcile-worker"]);
      assert.deepEqual(applyPayload.applied.bindings_marked_invalid, ["binding-reconcile"]);
      proofDb = openDatabaseSync(dbPath);
      try {
        assert.equal((proofDb.prepare("select state from sessions where name = 'reconcile-worker'").get() as { state: string }).state, "gone");
        assert.equal((proofDb.prepare("select state from bindings where id = 'binding-reconcile'").get() as { state: string }).state, "invalid");
        const eventTypes = proofDb.prepare("select type from events where type like '%reconcile' order by id").all() as Array<{ type: string }>;
        assert.deepEqual(eventTypes.map((event) => event.type), [
          "session_marked_gone_by_reconcile",
          "binding_marked_invalid_by_reconcile",
        ]);
      } finally {
        proofDb.close();
      }

      const binDir = join(root, "bin");
      mkdirSync(binDir, { recursive: true });
	      for (const name of ["codex", "tmux", "workerctl"]) {
	        const script = join(binDir, name);
	        writeFileSync(script, "#!/bin/sh\nexit 0\n");
	        chmodSync(script, 0o755);
	      }
	      const cwdFile = join(root, "not-a-directory.txt");
	      writeFileSync(cwdFile, "not a working directory\n");
	      const doctor = runTypescriptRuntimeCommand({
	        args: ["doctor", "--cwd", cwdFile, "--json"],
	        env: { ...env, PATH: `${binDir}:/bin:/usr/bin` },
	      });
	      assert.equal(doctor.exitCode, 1);
	      const doctorPayload = JSON.parse(doctor.stdout ?? "{}") as { checks: Array<{ name: string; ok: boolean; path?: string }>; ok: boolean };
	      assert.equal(doctorPayload.ok, false);
	      const cwdCheck = doctorPayload.checks.find((check) => check.name === "target_cwd_exists");
	      assert.deepEqual(cwdCheck, { name: "target_cwd_exists", ok: false, path: cwdFile });
	      const targetProject = join(root, "target-project");
	      const targetStateRoot = join(targetProject, ".codex-workers");
	      mkdirSync(targetStateRoot, { recursive: true });
		      const originalCwd = process.cwd();
		      const targetDoctor = runTypescriptRuntimeCommand({
		        args: ["doctor", "--cwd", targetProject, "--json"],
		        env: { HOME: home, USERPROFILE: home, PATH: `${binDir}:/bin:/usr/bin` },
		      });
		      assert.equal(targetDoctor.exitCode, 0, targetDoctor.stdout);
		      const targetDoctorPayload = JSON.parse(targetDoctor.stdout ?? "{}") as { checks: Array<{ name: string; ok: boolean; path?: string }>; ok: boolean; project_root: string; workers: unknown[] };
		      assert.equal(targetDoctorPayload.ok, true);
		      assert.equal(targetDoctorPayload.project_root, originalCwd);
		      assert.deepEqual(
		        targetDoctorPayload.checks.find((check) => check.name === "state_root_exists"),
		        { name: "state_root_exists", ok: true, path: targetStateRoot },
		      );
		      assert.deepEqual(targetDoctorPayload.workers, []);
		      mkdirSync(join(root, "outside-cwd"), { recursive: true });
		      let targetDoctorFromOutside: ReturnType<typeof runTypescriptRuntimeCommand>;
		      process.chdir(join(root, "outside-cwd"));
		      try {
		        targetDoctorFromOutside = runTypescriptRuntimeCommand({
		          args: ["doctor", "--cwd", targetProject, "--json"],
		          env: { HOME: home, USERPROFILE: home, PATH: `${binDir}:/bin:/usr/bin` },
		        });
		      } finally {
		        process.chdir(originalCwd);
		      }
		      assert.equal(targetDoctorFromOutside.exitCode, 0, targetDoctorFromOutside.stdout);
		      const outsideDoctorPayload = JSON.parse(targetDoctorFromOutside.stdout ?? "{}") as { project_root: string };
		      assert.equal(outsideDoctorPayload.project_root, originalCwd);
		      const tmuxRunner: TmuxRunner = (args) => {
        const command = args.join(" ");
        if (command === "tmux has-session -t live-session") {
          return { status: 0, stdout: "" };
        }
        return { status: 1, stderr: `unexpected tmux command: ${command}` };
      };
      const doctorSelf = runTypescriptRuntimeCommand({
        args: ["doctor-self", "--session", "live-session", "--json"],
        env: { ...env, PATH: `${binDir}:/bin:/usr/bin` },
        tmuxRunner,
      });
      assert.equal(doctorSelf.exitCode, 0);
      const selfPayload = JSON.parse(doctorSelf.stdout ?? "{}") as { current_session: string; supported: boolean };
      assert.equal(selfPayload.current_session, "live-session");
      assert.equal(selfPayload.supported, true);
      const codexHome = join(root, "codex-home");
      const reviewHelper = join(codexHome, "skills", "codex-review", "scripts", "codex-review");
      mkdirSync(join(codexHome, "skills", "manage-codex-workers"), { recursive: true });
      mkdirSync(join(codexHome, "skills", "codex-review", "scripts"), { recursive: true });
      writeFileSync(join(codexHome, "skills", "manage-codex-workers", "SKILL.md"), "manage skill\n");
	      writeFileSync(join(codexHome, "skills", "codex-review", "SKILL.md"), "review skill\n");
	      writeFileSync(reviewHelper, "#!/bin/sh\nexit 0\n");
	      chmodSync(reviewHelper, 0o644);
		      process.chdir(join(root, "outside-cwd"));
	      let doctorSelfNonExecutableReview;
	      try {
	        doctorSelfNonExecutableReview = runTypescriptRuntimeCommand({
	          args: ["doctor-self", "--session", "live-session", "--json"],
	          env: { ...env, CODEX_HOME: codexHome, PATH: "/bin:/usr/bin" },
	          tmuxRunner,
	        });
	      } finally {
	        process.chdir(originalCwd);
	      }
	      assert.equal(doctorSelfNonExecutableReview.exitCode, 1);
	      const nonExecutablePayload = JSON.parse(doctorSelfNonExecutableReview.stdout ?? "{}") as { checks: Array<{ name: string; ok: boolean; path?: string }>; workerctl_invocation: string | null };
	      assert.deepEqual(
	        nonExecutablePayload.checks.find((check) => check.name === "workerctl_script"),
	        { name: "workerctl_script", ok: true, path: join(process.cwd(), "scripts", "workerctl") },
	      );
	      assert.equal(nonExecutablePayload.workerctl_invocation, "scripts/workerctl");
	      assert.deepEqual(
	        nonExecutablePayload.checks.find((check) => check.name === "codex_review_helper_installed"),
	        { name: "codex_review_helper_installed", ok: false, path: reviewHelper },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("TypeScript runtime handles remaining dashboard and skill install CLI contracts by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-remaining-surface."));
  try {
    const dbPath = join(root, "workerctl.db");
    const dashboard = runTypescriptRuntimeCommand({
      args: [
        "dashboard",
        "--dry-run",
        "--json",
        "--task",
        "demo task",
        "--host",
        "127.0.0.2",
        "--port",
        "8899",
        "--workerctl-path",
        "scripts/workerctl",
        "--db-path",
        dbPath,
        "--campaign",
        "launch",
        "--ensure-dispatch",
        "--dispatcher-id",
        "dispatch-test",
      ],
      env: {},
    });
    assert.equal(dashboard.exitCode, 0, dashboard.stderr);
    assert.equal(dashboard.handled, true);
    const payload = JSON.parse(dashboard.stdout ?? "{}") as {
      command: string[];
      dispatch_command: string[];
      campaign: string;
      ensure_dispatch: boolean;
      task: string;
      url: string;
    };
    assert.deepEqual(payload.command, [
      "npm",
      "run",
      "dashboard",
      "--",
      "--host",
      "127.0.0.2",
      "--port",
      "8899",
      "--workerctl-path",
      "scripts/workerctl",
      "--task",
      "demo task",
      "--campaign",
      "launch",
      "--db-path",
      dbPath,
    ]);
    assert.deepEqual(payload.dispatch_command, [
      "scripts/workerctl",
      "dispatch",
      "--watch",
      "--dispatcher-id",
      "dispatch-test",
      "--path",
      dbPath,
    ]);
    assert.equal(payload.campaign, "launch");
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.task, "demo task");
    assert.equal(payload.url, "http://127.0.0.2:8899/?task=demo+task&campaign=launch");

    const defaultDashboard = runTypescriptRuntimeCommand({
      args: ["dashboard", "--dry-run", "--json", "--task", "demo task", "--db-path", dbPath, "--ensure-dispatch"],
      env: {},
    });
    assert.equal(defaultDashboard.exitCode, 0, defaultDashboard.stderr);
    const defaultPayload = JSON.parse(defaultDashboard.stdout ?? "{}") as {
      command: string[];
      dispatch_command: string[];
    };
    assert.deepEqual(defaultPayload.command.slice(0, 8), [
      "npm",
      "run",
      "dashboard",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "8797",
    ]);
    assert.deepEqual(defaultPayload.command.slice(8, 10), ["--workerctl-path", "conveyor"]);
    assert.deepEqual(defaultPayload.dispatch_command.slice(0, 4), [
      "conveyor",
      "dispatch",
      "--watch",
      "--dispatcher-id",
    ]);

    const codexHome = join(root, "codex-home");
    const install = runTypescriptRuntimeCommand({
      args: ["install-skills", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(install.exitCode, 0, install.stderr);
    const installPayload = JSON.parse(install.stdout ?? "{}") as {
      installed: string[];
      skills: Array<{ name: string; target: string }>;
    };
    assert.deepEqual(installPayload.installed.sort(), ["codex-review", "manage-codex-workers"]);
    assert.ok(existsSync(join(codexHome, "skills", "manage-codex-workers", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "codex-review", "scripts", "codex-review")));
    assert.deepEqual(
      installPayload.skills.map((skill) => skill.name).sort(),
      ["codex-review", "manage-codex-workers"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles Agent Conveyor plugin install status and path commands", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-plugin."));
  try {
    const codexHome = join(root, "codex-home");
    const pluginPath = runTypescriptRuntimeCommand({
      args: ["plugin-path", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(pluginPath.exitCode, 0, pluginPath.stderr);
    const pluginPathPayload = JSON.parse(pluginPath.stdout ?? "{}") as {
      codex_home: string;
      package_root: string;
      plugin_cache_root: string;
      plugin_install_root: string;
      plugin_source: string;
      skills_install_root: string;
    };
    assert.equal(pluginPathPayload.codex_home, codexHome);
    assert.ok(pluginPathPayload.plugin_source.endsWith(join("plugin", "agent-conveyor")));
    assert.ok(pluginPathPayload.plugin_install_root.endsWith(join("plugins", "cache", "agent-conveyor", "agent-conveyor", PACKAGE_VERSION)));
    assert.equal(pluginPathPayload.skills_install_root, join(codexHome, "skills"));

    const statusBefore = runTypescriptRuntimeCommand({
      args: ["plugin-status", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(statusBefore.exitCode, 0, statusBefore.stderr);
    const statusBeforePayload = JSON.parse(statusBefore.stdout ?? "{}") as {
      installed: boolean;
      package_version: string;
      plugin_version: string;
      skills: Array<{ installed: boolean; name: string }>;
      version_matches: boolean;
    };
    assert.equal(statusBeforePayload.installed, false);
    assert.equal(statusBeforePayload.package_version, PACKAGE_VERSION);
    assert.equal(statusBeforePayload.plugin_version, PACKAGE_VERSION);
    assert.equal(statusBeforePayload.version_matches, false);
    assert.deepEqual(
      statusBeforePayload.skills.map((skill) => ({ installed: skill.installed, name: skill.name })),
      [
        { installed: false, name: "conveyor-app-wake-relay" },
        { installed: false, name: "conveyor-smoke-app-connections" },
        { installed: false, name: "conveyor-create-pair" },
        { installed: false, name: "conveyor-create-worker-set" },
        { installed: false, name: "conveyor-check-status" },
        { installed: false, name: "conveyor-setup-bundle" },
        { installed: false, name: "conveyor-whats-next-nudger" },
      ],
    );

    const install = runTypescriptRuntimeCommand({
      args: ["install-plugin", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(install.exitCode, 0, install.stderr);
    const installPayload = JSON.parse(install.stdout ?? "{}") as {
      installed: boolean;
      installed_skills: string[];
      package_version: string;
      plugin_version: string;
    };
    assert.equal(installPayload.installed, true);
    assert.equal(installPayload.package_version, PACKAGE_VERSION);
    assert.equal(installPayload.plugin_version, PACKAGE_VERSION);
    assert.deepEqual(installPayload.installed_skills.sort(), [
      "conveyor-app-wake-relay",
      "conveyor-check-status",
      "conveyor-create-pair",
      "conveyor-create-worker-set",
      "conveyor-setup-bundle",
      "conveyor-smoke-app-connections",
      "conveyor-whats-next-nudger",
    ]);

    const installedManifestPath = join(codexHome, "plugins", "cache", "agent-conveyor", "agent-conveyor", PACKAGE_VERSION, "plugin.json");
    assert.ok(existsSync(installedManifestPath));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-app-wake-relay", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-smoke-app-connections", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-check-status", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-create-pair", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-create-worker-set", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-setup-bundle", "SKILL.md")));
    assert.ok(existsSync(join(codexHome, "skills", "conveyor-whats-next-nudger", "SKILL.md")));
    const absoluteLedgerPath = /(^|[^\w$])\/[^\s`"']*\.codex-workers\/workerctl\.db/;
    assert.match("/tmp/project/.codex-workers/workerctl.db", absoluteLedgerPath);
    assert.match("--path=/tmp/project/.codex-workers/workerctl.db", absoluteLedgerPath);
    assert.match("(/tmp/project/.codex-workers/workerctl.db)", absoluteLedgerPath);
    assert.doesNotMatch("$PWD/.codex-workers/workerctl.db", absoluteLedgerPath);
    assert.doesNotMatch("--path=$PWD/.codex-workers/workerctl.db", absoluteLedgerPath);
    assert.doesNotMatch(".codex-workers/workerctl.db", absoluteLedgerPath);
    for (const name of ["conveyor-app-wake-relay", "conveyor-smoke-app-connections", "conveyor-create-pair", "conveyor-create-worker-set", "conveyor-check-status", "conveyor-whats-next-nudger"]) {
      const text = readFileSync(join(codexHome, "skills", name, "SKILL.md"), "utf8");
      assert.match(text, /\.codex-workers\/workerctl\.db/);
      assert.doesNotMatch(text, absoluteLedgerPath);
      assert.match(text, /Operator-facing only|operator-facing/i);
      assert.match(text, /Codex app/i);
    }
    const createPairSkill = readFileSync(join(codexHome, "skills", "conveyor-create-pair", "SKILL.md"), "utf8");
    assert.match(createPairSkill, /Do not use tmux/);
    assert.match(createPairSkill, /app-autopilot start/);
    assert.match(createPairSkill, /manual-poll only/);
    const createWorkerSetSkill = readFileSync(join(codexHome, "skills", "conveyor-create-worker-set", "SKILL.md"), "utf8");
    assert.match(createWorkerSetSkill, /app-autopilot start/);
    assert.match(createWorkerSetSkill, /manual-poll only/);
    const wakeRelaySkill = readFileSync(join(codexHome, "skills", "conveyor-app-wake-relay", "SKILL.md"), "utf8");
    assert.match(wakeRelaySkill, /send_message_to_thread/);
    assert.match(wakeRelaySkill, /app-wakeup-record-delivery/);
    assert.match(wakeRelaySkill, /send_ready=true/);
    assert.match(wakeRelaySkill, /inbox-ack/);
    const smokeSkill = readFileSync(join(codexHome, "skills", "conveyor-smoke-app-connections", "SKILL.md"), "utf8");
    assert.match(smokeSkill, /app-smoke start/);
    assert.match(smokeSkill, /send_message_to_thread|native Codex app thread tools/);
    assert.match(smokeSkill, /real_work_allowed=false/);
    assert.match(smokeSkill, /app-autopilot start/);
    assert.match(smokeSkill, /manual-poll only/);
    assert.match(smokeSkill, /printf '%s\\n' '\{"summary"/);
    assert.match(smokeSkill, /--from-stdin expects a JSON object|explicit JSON stdin example/);
    const setupBundleSkill = readFileSync(join(codexHome, "skills", "conveyor-setup-bundle", "SKILL.md"), "utf8");
    assert.match(setupBundleSkill, /conveyor setup-bundle preview/);
    assert.match(setupBundleSkill, /conveyor setup-bundle apply/);
    assert.match(setupBundleSkill, /conveyor setup-bundle show/);
    assert.match(setupBundleSkill, /If a required backend is missing, stop\. Do not create sessions/);
    const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8")) as { name: string; version: string };
    assert.equal(installedManifest.name, "agent-conveyor");
    assert.equal(installedManifest.version, PACKAGE_VERSION);

    const statusAfter = runTypescriptRuntimeCommand({
      args: ["plugin-status", "--codex-home", codexHome, "--json"],
      env: {},
    });
    assert.equal(statusAfter.exitCode, 0, statusAfter.stderr);
    const statusAfterPayload = JSON.parse(statusAfter.stdout ?? "{}") as {
      installed: boolean;
      installed_version: string | null;
      version_matches: boolean;
    };
    assert.equal(statusAfterPayload.installed, true);
    assert.equal(statusAfterPayload.installed_version, PACKAGE_VERSION);
    assert.equal(statusAfterPayload.version_matches, true);

    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    for (const name of ["codex", "conveyor", "tmux", "workerctl"]) {
      const script = join(binDir, name);
      writeFileSync(script, "#!/bin/sh\nexit 0\n");
      chmodSync(script, 0o755);
    }
    const doctor = runTypescriptRuntimeCommand({
      args: ["doctor", "--codex-home", codexHome, "--cwd", root, "--json"],
      env: { PATH: `${binDir}:/bin:/usr/bin` },
    });
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout ?? "{}") as {
      codex_home: string;
      commands: Record<string, { ok: boolean; path: string | null }>;
      operator_ready: boolean;
      package: { version: string };
      plugin: {
        installed: boolean;
        version_matches: boolean;
        skills: Array<{ installed: boolean; name: string }>;
      };
    };
    assert.equal(doctorPayload.codex_home, codexHome);
    assert.equal(doctorPayload.package.version, PACKAGE_VERSION);
    assert.equal(doctorPayload.operator_ready, true);
    assert.equal(doctorPayload.commands.conveyor.ok, true);
    assert.equal(doctorPayload.commands.workerctl.ok, true);
    assert.equal(doctorPayload.plugin.installed, true);
    assert.equal(doctorPayload.plugin.version_matches, true);
    assert.equal(doctorPayload.plugin.skills.every((skill) => skill.installed), true);

    const corruptHome = join(root, "corrupt-codex-home");
    const corruptManifestDir = join(corruptHome, "plugins", "cache", "agent-conveyor", "agent-conveyor", PACKAGE_VERSION);
    mkdirSync(corruptManifestDir, { recursive: true });
    writeFileSync(join(corruptManifestDir, "plugin.json"), JSON.stringify({ name: "not-agent-conveyor", version: PACKAGE_VERSION }));
    const corruptStatus = runTypescriptRuntimeCommand({
      args: ["plugin-status", "--codex-home", corruptHome, "--json"],
      env: {},
    });
    assert.equal(corruptStatus.exitCode, 0, corruptStatus.stderr);
    const corruptStatusPayload = JSON.parse(corruptStatus.stdout ?? "{}") as {
      installed: boolean;
      installed_version: string | null;
      skills: Array<{ installed: boolean; name: string }>;
      version_matches: boolean;
    };
    assert.equal(corruptStatusPayload.installed, false);
    assert.equal(corruptStatusPayload.installed_version, null);
    assert.equal(corruptStatusPayload.version_matches, false);
    assert.deepEqual(
      corruptStatusPayload.skills.map((skill) => ({ installed: skill.installed, name: skill.name })),
      [
        { installed: false, name: "conveyor-app-wake-relay" },
        { installed: false, name: "conveyor-smoke-app-connections" },
        { installed: false, name: "conveyor-create-pair" },
        { installed: false, name: "conveyor-create-worker-set" },
        { installed: false, name: "conveyor-check-status" },
        { installed: false, name: "conveyor-setup-bundle" },
        { installed: false, name: "conveyor-whats-next-nudger" },
      ],
    );

    const installedDryRun = runTypescriptRuntimeCommand({
      args: ["install-plugin", "--codex-home", codexHome, "--dry-run", "--json"],
      env: {},
    });
    assert.equal(installedDryRun.exitCode, 0, installedDryRun.stderr);
    const installedDryRunPayload = JSON.parse(installedDryRun.stdout ?? "{}") as {
      dry_run: boolean;
      installed: boolean;
      installed_skills: string[];
      version_matches: boolean;
    };
    assert.equal(installedDryRunPayload.dry_run, true);
    assert.equal(installedDryRunPayload.installed, true);
    assert.deepEqual(installedDryRunPayload.installed_skills, []);
    assert.equal(installedDryRunPayload.version_matches, true);

    const dryRunHome = join(root, "dry-run-codex-home");
    const dryRunInstall = runTypescriptRuntimeCommand({
      args: ["install-plugin", "--codex-home", dryRunHome, "--dry-run", "--json"],
      env: {},
    });
    assert.equal(dryRunInstall.exitCode, 0, dryRunInstall.stderr);
    const dryRunInstallPayload = JSON.parse(dryRunInstall.stdout ?? "{}") as {
      installed: boolean;
      installed_skills: string[];
    };
    assert.equal(dryRunInstallPayload.installed, false);
    assert.deepEqual(dryRunInstallPayload.installed_skills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles ack inbox and session action CLI contracts by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-remaining-dispatch."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Exercise remaining CLI contracts.",
        name: "remaining-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-remaining",
      });
      createTaskSync(database, {
        goal: "Other task must not own remaining-task notifications.",
        name: "other-task",
        now: "2026-05-23T10:00:01Z",
        taskId: "task-other",
      });
      insertSession(database, { id: "session-worker-remaining", name: "worker-remaining", role: "worker", tmuxPaneId: "%7", tmuxSession: "tmux-worker-remaining" });
      insertSession(database, { id: "session-manager-remaining", name: "manager-remaining", role: "manager", tmuxPaneId: "%8", tmuxSession: "tmux-manager-remaining" });
      insertSession(database, { id: "session-worker-other", name: "worker-other", role: "worker", tmuxPaneId: "%9", tmuxSession: "tmux-worker-other" });
      insertSession(database, { id: "session-manager-other", name: "manager-other", role: "manager", tmuxPaneId: "%10", tmuxSession: "tmux-manager-other" });
      bindSessionsSync(database, {
        bindingId: "binding-remaining",
        managerSessionName: "manager-remaining",
        now: "2026-05-23T10:00:30Z",
        taskName: "remaining-task",
        workerSessionName: "worker-remaining",
      });
      bindSessionsSync(database, {
        bindingId: "binding-other",
        managerSessionName: "manager-other",
        now: "2026-05-23T10:00:31Z",
        taskName: "other-task",
        workerSessionName: "worker-other",
      });
      database.prepare(`
        insert into routed_notifications(
          task_id, binding_id, correlation_id, source_session_id, target_session_id,
          signal_type, source_event_id, source_event_timestamp, dedupe_key, command_id,
          created_at, delivered_at, delivery_mode, state, payload_json,
          side_effect_started, side_effect_completed
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-remaining",
        "binding-remaining",
        "corr-remaining",
        "session-manager-remaining",
        "session-worker-remaining",
        "nudge_worker",
        null,
        null,
        "dedupe-remaining",
        null,
        "2026-05-23T10:02:00Z",
        "2026-05-23T10:02:01Z",
        "pull_required",
        "delivered",
        JSON.stringify({ message: "keep going" }),
        0,
        0,
      );
    } finally {
      database.close();
    }

    const workerAck = runTypescriptRuntimeCommand({
      args: ["worker-ack", "remaining-task", "--from-stdin", "--correlation-id", "ack-worker", "--path", dbPath],
      env: {},
      stdin: "{\"ready_to_start\":true,\"goal_restatement\":\"finish\"}",
    });
    assert.equal(workerAck.exitCode, 0, workerAck.stderr);
    const workerAckPayload = JSON.parse(workerAck.stdout ?? "{}") as {
      binding_id: string;
      correlation_id: string;
      payload: Record<string, unknown>;
      revision: number;
      role: string;
    };
    assert.equal(workerAckPayload.binding_id, "binding-remaining");
    assert.equal(workerAckPayload.correlation_id, "ack-worker");
    assert.deepEqual(workerAckPayload.payload, { goal_restatement: "finish", ready_to_start: true });
    assert.equal(workerAckPayload.revision, 1);
    assert.equal(workerAckPayload.role, "worker");

    const managerAck = runTypescriptRuntimeCommand({
      args: ["manager-ack", "remaining-task", "--from-stdin", "--json", "--correlation-id", "ack-manager", "--path", dbPath],
      env: {},
      stdin: "{\"supervision\":\"accepted\"}",
    });
    assert.equal(managerAck.exitCode, 0, managerAck.stderr);
    const managerAckPayload = JSON.parse(managerAck.stdout ?? "{}") as { payload: Record<string, unknown>; role: string };
    assert.deepEqual(managerAckPayload.payload, { supervision: "accepted" });
    assert.equal(managerAckPayload.role, "manager");

    const managerRead = runTypescriptRuntimeCommand({
      args: ["manager-ack", "remaining-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.deepEqual(JSON.parse(managerRead.stdout ?? "{}").payload, { supervision: "accepted" });

    const receivedAck = runTypescriptRuntimeCommand({
      args: [
        "inbox-ack",
        "remaining-task",
        "--notification-id",
        "1",
        "--role",
        "worker",
        "--status",
        "received",
        "--from-stdin",
        "--correlation-id",
        "inbox-received",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-05-23T10:02:02Z"),
      stdin: "{\"summary\":\"Worker received manager instruction.\"}",
    });
    assert.equal(receivedAck.exitCode, 0, receivedAck.stderr);
    const receivedAckPayload = JSON.parse(receivedAck.stdout ?? "{}") as {
      acknowledgement: { notification_id: number; payload: Record<string, unknown>; role: string; status: string };
      receipt: { event_type: string };
    };
    assert.equal(receivedAckPayload.acknowledgement.notification_id, 1);
    assert.equal(receivedAckPayload.acknowledgement.role, "worker");
    assert.equal(receivedAckPayload.acknowledgement.status, "received");
    assert.deepEqual(receivedAckPayload.acknowledgement.payload, { summary: "Worker received manager instruction." });
    assert.equal(receivedAckPayload.receipt.event_type, "dispatch_inbox_ack_recorded");

    const wrongRoleAck = runTypescriptRuntimeCommand({
      args: [
        "inbox-ack",
        "remaining-task",
        "--notification-id",
        "1",
        "--role",
        "manager",
        "--status",
        "received",
        "--from-stdin",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      stdin: "{\"summary\":\"Wrong side.\"}",
    });
    assert.equal(wrongRoleAck.exitCode, 2);
    assert.match(wrongRoleAck.stderr ?? "", /target role is worker/);

    const crossTaskAck = runTypescriptRuntimeCommand({
      args: [
        "inbox-ack",
        "other-task",
        "--notification-id",
        "1",
        "--role",
        "worker",
        "--status",
        "received",
        "--from-stdin",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      stdin: "{\"summary\":\"Wrong task.\"}",
    });
    assert.equal(crossTaskAck.exitCode, 2);
    assert.match(crossTaskAck.stderr ?? "", /Unknown routed notification for task other-task: 1/);

    const prematureAcceptedAck = runTypescriptRuntimeCommand({
      args: [
        "inbox-ack",
        "remaining-task",
        "--notification-id",
        "1",
        "--role",
        "worker",
        "--status",
        "accepted",
        "--from-stdin",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      stdin: "{\"summary\":\"Accepted before consuming.\"}",
    });
    assert.equal(prematureAcceptedAck.exitCode, 2);
    assert.match(prematureAcceptedAck.stderr ?? "", /has not been consumed/);

    const inbox = runTypescriptRuntimeCommand({
      args: ["worker-inbox", "remaining-task", "--consume-next", "--wait", "--timeout", "0", "--interval", "1", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(inbox.exitCode, 0, inbox.stderr);
    const inboxPayload = JSON.parse(inbox.stdout ?? "{}") as {
      consumed: { correlation_id: string; consumed_at: string | null; target_session_name: string };
      items: unknown[];
      session: { name: string; role: string };
      task: { name: string };
    };
    assert.equal(inboxPayload.consumed.correlation_id, "corr-remaining");
    assert.ok(inboxPayload.consumed.consumed_at);
    assert.equal((inboxPayload.consumed as unknown as { acknowledgement: { status: string } }).acknowledgement.status, "received");
    assert.equal(inboxPayload.consumed.target_session_name, "worker-remaining");
    assert.deepEqual(inboxPayload.items, []);
    assert.equal(inboxPayload.session.name, "worker-remaining");
    assert.equal(inboxPayload.session.role, "worker");
    assert.equal(inboxPayload.task.name, "remaining-task");

    const acceptedAck = runTypescriptRuntimeCommand({
      args: [
        "inbox-ack",
        "remaining-task",
        "--notification-id",
        "1",
        "--role",
        "worker",
        "--status",
        "accepted",
        "--from-stdin",
        "--correlation-id",
        "inbox-accepted",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-05-23T10:03:00Z"),
      stdin: "{\"summary\":\"Worker accepted and acted on manager instruction.\"}",
    });
    assert.equal(acceptedAck.exitCode, 0, acceptedAck.stderr);
    const acceptedAckPayload = JSON.parse(acceptedAck.stdout ?? "{}") as {
      acknowledgement: { status: string };
    };
    assert.equal(acceptedAckPayload.acknowledgement.status, "accepted");

    const ackRead = runTypescriptRuntimeCommand({
      args: ["inbox-ack", "remaining-task", "--notification-id", "1", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(ackRead.exitCode, 0, ackRead.stderr);
    const ackReadPayload = JSON.parse(ackRead.stdout ?? "{}") as {
      acknowledgements: Array<{ status: string }>;
      latest: { status: string };
    };
    assert.deepEqual(ackReadPayload.acknowledgements.map((ack) => ack.status), ["received", "accepted"]);
    assert.equal(ackReadPayload.latest.status, "accepted");

    const audit = runTypescriptRuntimeCommand({
      args: ["audit", "remaining-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(audit.exitCode, 0, audit.stderr);
    const auditPayload = JSON.parse(audit.stdout ?? "{}") as {
      notification_acknowledgements: Array<{ notification_id: number; role: string; status: string }>;
    };
    assert.deepEqual(auditPayload.notification_acknowledgements.map((ack) => `${ack.notification_id}:${ack.role}:${ack.status}`), [
      "1:worker:received",
      "1:worker:accepted",
    ]);

    const replay = runTypescriptRuntimeCommand({
      args: ["replay", "remaining-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(replay.exitCode, 0, replay.stderr);
    const replayPayload = JSON.parse(replay.stdout ?? "{}") as {
      entries: Array<{ kind: string; source: string; summary: string }>;
    };
    assert.ok(replayPayload.entries.some((entry) => entry.source === "notification_acknowledgements" && /worker acknowledged notification 1: accepted/.test(entry.summary)));

    const dryNudge = runTypescriptRuntimeCommand({
      args: ["session-nudge", "worker-remaining", "status?", "--dry-run", "--path", dbPath],
      env: {},
    });
    assert.equal(dryNudge.exitCode, 0, dryNudge.stderr);
    const nudgePayload = JSON.parse(dryNudge.stdout ?? "{}") as {
      dry_run: boolean;
      session: string;
      side_effect_completed: boolean;
      side_effect_started: boolean;
      target: string;
      text: string;
      time: string;
    };
    assert.equal(nudgePayload.dry_run, true);
    assert.equal(nudgePayload.session, "worker-remaining");
    assert.equal(nudgePayload.side_effect_completed, false);
    assert.equal(nudgePayload.side_effect_started, false);
    assert.equal(nudgePayload.target, "tmux-worker-remaining:%7");
    assert.equal(nudgePayload.text, "status?");
    assert.match(nudgePayload.time, /^\d{4}-\d{2}-\d{2}T/);

    const dryInterrupt = runTypescriptRuntimeCommand({
      args: ["session-interrupt", "manager-remaining", "--dry-run", "--key", "C-g", "--followup", "pause", "--path", dbPath],
      env: {},
    });
    assert.equal(dryInterrupt.exitCode, 0, dryInterrupt.stderr);
    const interruptPayload = JSON.parse(dryInterrupt.stdout ?? "{}") as {
      dry_run: boolean;
      followup: string;
      key: string;
      session: string;
      target: string;
    };
    assert.equal(interruptPayload.dry_run, true);
    assert.equal(interruptPayload.followup, "pause");
    assert.equal(interruptPayload.key, "C-g");
    assert.equal(interruptPayload.session, "manager-remaining");
    assert.equal(interruptPayload.target, "tmux-manager-remaining:%8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy list nudge and interrupt contracts by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-misc."));
  try {
    const env = { WORKERCTL_STATE_ROOT: root };
    mkdirSync(workerDir("legacy-worker", { env }), { recursive: true });
    writeFileSync(configPath("legacy-worker", { env }), JSON.stringify({
      cwd: "/repo",
      name: "legacy-worker",
      tmux_session: "codex-legacy-worker",
    }));
    writeFileSync(statusPath("legacy-worker", { env }), JSON.stringify({
      current_task: "Port commands.",
      last_update: "2026-05-23T10:00:00Z",
      next_action: "test",
      state: "editing",
    }));
    const calls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args.join(" ") === "tmux has-session -t codex-legacy-worker") {
        return { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    };
    const listed = runTypescriptRuntimeCommand({
      args: ["list", "--json"],
      env,
      tmuxRunner: runner,
    });
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout ?? "[]"), [{
      current_task: "Port commands.",
      name: "legacy-worker",
      running: true,
      state: "editing",
      status: "running",
    }]);

    const nudged = runTypescriptRuntimeCommand({
      args: ["nudge", "legacy-worker", "please report"],
      env,
      tmuxRunner: runner,
    });
    assert.equal(nudged.exitCode, 0, nudged.stderr);
    assert.equal(nudged.stdout, "sent nudge to legacy-worker\n");
    assert.ok(calls.some((args) => args.join(" ") === "tmux set-buffer -b workerctl-legacy-worker please report"));
    assert.ok(calls.some((args) => args.join(" ") === "tmux paste-buffer -b workerctl-legacy-worker -t codex-legacy-worker"));

    const interrupted = runTypescriptRuntimeCommand({
      args: ["interrupt", "legacy-worker", "--dry-run", "--key", "C-g", "--followup", "pause now"],
      env,
      tmuxRunner: runner,
    });
    assert.equal(interrupted.exitCode, 0, interrupted.stderr);
    const interruptPayload = JSON.parse(interrupted.stdout ?? "{}") as {
      dry_run: boolean;
      followup: string;
      key: string;
      name: string;
    };
    assert.equal(interruptPayload.dry_run, true);
    assert.equal(interruptPayload.followup, "pause now");
    assert.equal(interruptPayload.key, "C-g");
    assert.equal(interruptPayload.name, "legacy-worker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles cycle observation and manager cycle persistence by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-cycle."));
  const rolloutPath = "/tmp/session-worker-cycle-ts.jsonl";
  try {
    writeFileSync(rolloutPath, `${JSON.stringify({
      payload: { type: "task_started" },
      timestamp: "2026-05-23T10:01:00Z",
      type: "event_msg",
    })}\n`);
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Observe a cycle.",
        name: "cycle-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-cycle",
      });
      insertSession(database, { id: "session-worker-cycle-ts", name: "worker-cycle", pid: process.pid, role: "worker", tmuxPaneId: "%7", tmuxSession: "tmux-worker-cycle" });
      insertSession(database, { id: "session-manager-cycle-ts", name: "manager-cycle", pid: process.pid, role: "manager", tmuxPaneId: "%8", tmuxSession: "tmux-manager-cycle" });
      bindSessionsSync(database, {
        bindingId: "binding-cycle",
        managerSessionName: "manager-cycle",
        now: "2026-05-23T10:00:30Z",
        taskName: "cycle-task",
        workerSessionName: "worker-cycle",
      });
      database.prepare(`
        insert into routed_notifications(
          task_id, binding_id, correlation_id, source_session_id, target_session_id,
          signal_type, source_event_id, source_event_timestamp, dedupe_key, command_id,
          created_at, delivered_at, delivery_mode, state, payload_json,
          side_effect_started, side_effect_completed
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-cycle",
        "binding-cycle",
        "corr-cycle",
        "session-worker-cycle-ts",
        "session-manager-cycle-ts",
        "worker_task_complete",
        null,
        null,
        "dedupe-cycle",
        null,
        "2026-05-23T10:02:00Z",
        "2026-05-23T10:02:01Z",
        "pull_required",
        "delivered",
        JSON.stringify({ message: "review completion" }),
        0,
        0,
      );
    } finally {
      database.close();
    }
    const tmuxCalls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      tmuxCalls.push(args);
      if (args.join(" ") === "tmux has-session -t tmux-worker-cycle") {
        return { status: 0, stdout: "" };
      }
      if (args[0] === "tmux" && args[1] === "capture-pane") {
        return { status: 0, stdout: "working on cycle\n" };
      }
      return { status: 0, stdout: "" };
    };
    const result = runTypescriptRuntimeCommand({
      args: ["cycle", "cycle-task", "--busy-wait-seconds", "45", "--path", dbPath],
      env: {},
      now: () => new Date("2026-05-23T10:05:00Z"),
      tmuxRunner: runner,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      binding_id: string;
      consumed_dispatch_notifications: number;
      cycle_id: number;
      ingest: { new_events: number };
      kind: string;
      manager_alive: boolean;
      manager_context: { acceptance_criteria: { summary: Record<string, number> } };
      pane_signal: { captured: boolean; degraded: boolean };
      state: string;
      worker_alive: boolean;
    };
    assert.equal(payload.kind, "session_cycle");
    assert.equal(payload.binding_id, "binding-cycle");
    assert.equal(payload.ingest.new_events, 1);
    assert.equal(payload.state, "busy");
    assert.equal(payload.pane_signal.captured, true);
    assert.equal(payload.pane_signal.degraded, false);
    assert.equal(payload.worker_alive, true);
    assert.equal(payload.manager_alive, true);
    assert.equal(payload.consumed_dispatch_notifications, 1);
    assert.equal(payload.manager_context.acceptance_criteria.summary.accepted, 0);
    assert.ok(tmuxCalls.some((args) => args.join(" ") === "tmux capture-pane -p -S -200 -t tmux-worker-cycle:%7"));

    const proofDb = openDatabaseSync(dbPath);
    try {
      const cycle = proofDb.prepare("select state, status_json from manager_cycles where id = ?")
        .get(payload.cycle_id) as { state: string; status_json: string };
      assert.equal(cycle.state, "succeeded");
      assert.equal(JSON.parse(cycle.status_json).kind, "session_cycle");
      const routed = proofDb.prepare("select consumed_manager_cycle_id from routed_notifications where dedupe_key = ?")
        .get("dedupe-cycle") as { consumed_manager_cycle_id: number };
      assert.equal(routed.consumed_manager_cycle_id, payload.cycle_id);
      const spans = proofDb.prepare("select phase, state from manager_cycle_spans where manager_cycle_id = ? order by id")
        .all(payload.cycle_id) as Array<{ phase: string; state: string }>;
      assert.deepEqual(spans.map((span) => span.phase), [
        "start_cycle",
        "ingest_rollout",
        "infer_worker_state",
        "capture_pane_signal",
        "load_manager_context",
        "persist_cycle_row",
      ]);
      assert.ok(spans.every((span) => span.state === "succeeded"));
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(rolloutPath, { force: true });
  }
});

test("TypeScript runtime handles enqueue commands list and dispatch pull-required queue by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-dispatch-cli."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Route dispatch queue.",
        name: "queue-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-queue-cli",
      });
      insertSession(database, { id: "session-worker", name: "worker-cli", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-cli", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-queue-cli",
        managerSessionName: "manager-cli",
        now: "2026-05-23T10:00:30Z",
        taskName: "queue-task",
        workerSessionName: "worker-cli",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: [],
        runId: "run-queue-cli",
        taskId: "task-queue-cli",
      });
    } finally {
      database.close();
    }

    const enqueuedNotify = runTypescriptRuntimeCommand({
      args: [
        "enqueue-notify-manager",
        "queue-task",
        "--message",
        "Please inspect the worker result.",
        "--correlation-id",
        "corr-notify-cli",
        "--idempotency-key",
        "idem-notify-cli",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(enqueuedNotify.exitCode, 0);
    assert.equal(enqueuedNotify.handled, true);
    const notifyPayload = JSON.parse(enqueuedNotify.stdout ?? "{}") as {
      command_id: string;
      command_type: string;
      correlation_id: string;
      task: string;
    };
    assert.equal(notifyPayload.command_type, "notify_manager");
    assert.equal(notifyPayload.correlation_id, "corr-notify-cli");
    assert.equal(notifyPayload.task, "queue-task");

    const enqueuedContinue = runTypescriptRuntimeCommand({
      args: [
        "enqueue-continue-iteration",
        "queue-task",
        "--message",
        "Run iteration 2.",
        "--loop-run",
        "run-queue-cli",
        "--requested-iteration",
        "2",
        "--manager-decision-id",
        "42",
        "--correlation-id",
        "corr-continue-cli",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(enqueuedContinue.exitCode, 0);
    const continuePayload = JSON.parse(enqueuedContinue.stdout ?? "{}") as {
      command_type: string;
      loop_policy: { current_iteration: number; max_iterations: number; run_id: string };
      manager_decision_id: number;
      requested_iteration: number;
    };
    assert.equal(continuePayload.command_type, "continue_iteration");
    assert.deepEqual(continuePayload.loop_policy, {
      artifact_requirements: {},
      cleanup_policy: "clear",
      current_iteration: 1,
      max_iterations: 3,
      preset: null,
      recommended_tools: [],
      required_before_continue: [],
      run_id: "run-queue-cli",
      seed_prompt_sha256: null,
      stop_conditions: ["max_iterations", "required_evidence"],
      tags: [],
      template: null,
    });
    assert.equal(continuePayload.manager_decision_id, 42);
    assert.equal(continuePayload.requested_iteration, 2);

    const listed = runTypescriptRuntimeCommand({
      args: ["commands", "--type", "notify_manager", "--attempts", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(listed.exitCode, 0);
    const commandList = JSON.parse(listed.stdout ?? "[]") as Array<{
      attempt_history: unknown[];
      idempotency_key: string;
      payload: { message: string };
      state: string;
      task_name: string;
      type: string;
    }>;
    assert.equal(commandList.length, 1);
    assert.equal(commandList[0].idempotency_key, "idem-notify-cli");
    assert.deepEqual(commandList[0].attempt_history, []);
    assert.equal(commandList[0].payload.message, "Please inspect the worker result.");
    assert.equal(commandList[0].state, "pending");
    assert.equal(commandList[0].task_name, "queue-task");
    assert.equal(commandList[0].type, "notify_manager");

    const dryRun = runTypescriptRuntimeCommand({
      args: [
        "dispatch",
        "--once",
        "--type",
        "notify_manager",
        "--dispatcher-id",
        "dispatch-cli-test",
        "--path",
        dbPath,
        "--dry-run",
        "--json",
      ],
      env: {},
    });
    assert.equal(dryRun.exitCode, 0);
    const dryRunPayload = JSON.parse(dryRun.stdout ?? "{}") as {
      processed: Array<{ command_id: string; state: string }>;
      processed_count: number;
    };
    assert.equal(dryRunPayload.processed_count, 1);
    assert.equal(dryRunPayload.processed[0]?.command_id, notifyPayload.command_id);
    assert.equal(dryRunPayload.processed[0]?.state, "planned");

    let verifyDb = openDatabaseSync(dbPath);
    try {
      const row = verifyDb.prepare("select state, attempts from commands where id = ?").get(notifyPayload.command_id) as {
        attempts: number;
        state: string;
      };
      const notifications = verifyDb.prepare("select count(*) as count from routed_notifications").get() as { count: number };
      assert.deepEqual({ attempts: row.attempts, state: row.state }, { attempts: 0, state: "pending" });
      assert.equal(notifications.count, 0);
    } finally {
      verifyDb.close();
    }

    const dispatched = runTypescriptRuntimeCommand({
      args: [
        "dispatch",
        "--once",
        "--type",
        "notify_manager",
        "--dispatcher-id",
        "dispatch-cli-test",
        "--lease-seconds",
        "45",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(dispatched.exitCode, 0);
    const dispatchPayload = JSON.parse(dispatched.stdout ?? "{}") as {
      processed: Array<{ delivery_mode: string; state: string; target_session: string }>;
      processed_count: number;
    };
    assert.equal(dispatchPayload.processed_count, 1);
    assert.deepEqual(dispatchPayload.processed[0], {
      attempt_id: 1,
      command_id: notifyPayload.command_id,
      command_type: "notify_manager",
      correlation_id: "corr-notify-cli",
      delivery_mode: "pull_required",
      dispatcher_id: "dispatch-cli-test",
      dry_run: false,
      notification_id: 1,
      permission_check: null,
      side_effect_completed: false,
      side_effect_started: false,
      state: "pull_required",
      target_session: "manager-cli",
    });

    verifyDb = openDatabaseSync(dbPath);
    try {
      const command = verifyDb.prepare("select state, attempts, result_json from commands where id = ?").get(notifyPayload.command_id) as {
        attempts: number;
        result_json: string;
        state: string;
      };
      const inbox = verifyDb.prepare(`
        select rn.delivery_mode, rn.side_effect_started, rn.side_effect_completed, rn.state,
               target.name as target_session_name
        from routed_notifications rn
        join sessions target on target.id = rn.target_session_id
      `).get() as {
        delivery_mode: string;
        side_effect_completed: number;
        side_effect_started: number;
        state: string;
        target_session_name: string;
      };
      assert.equal(command.state, "succeeded");
      assert.equal(command.attempts, 1);
      assert.equal(JSON.parse(command.result_json).notification_id, 1);
      assert.deepEqual({
        delivery_mode: inbox.delivery_mode,
        side_effect_completed: Boolean(inbox.side_effect_completed),
        side_effect_started: Boolean(inbox.side_effect_started),
        state: inbox.state,
        target_session_name: inbox.target_session_name,
      }, {
        delivery_mode: "pull_required",
        side_effect_completed: false,
        side_effect_started: false,
        state: "delivered",
        target_session_name: "manager-cli",
      });
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime default dispatch also routes worker completion signals", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-dispatch-completion-cli."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Wake manager on completion.",
        name: "completion-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-completion-cli",
      });
      insertSession(database, { id: "session-worker-complete", name: "worker-complete", role: "worker" });
      insertSession(database, { id: "session-manager-complete", name: "manager-complete", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-completion-cli",
        managerSessionName: "manager-complete",
        now: "2026-05-23T10:00:30Z",
        taskName: "completion-task",
        workerSessionName: "worker-complete",
      });
      database.prepare(`
        insert into codex_events(
          session_id, timestamp, type, subtype, payload_json, byte_offset, ingested_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "session-worker-complete",
        "2026-05-23T10:02:00Z",
        "event_msg",
        "task_complete",
        JSON.stringify({
          completed_at: "2026-05-23T10:02:00Z",
          duration_ms: 1200,
          last_agent_message: "done",
          turn_id: "turn-complete-cli",
        }),
        12,
        "2026-05-23T10:02:01Z",
      );
    } finally {
      database.close();
    }

    const dispatched = runTypescriptRuntimeCommand({
      args: [
        "dispatch",
        "--once",
        "--dispatcher-id",
        "dispatch-completion-cli",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-05-23T10:03:00Z"),
    });
    assert.equal(dispatched.exitCode, 0);
    assert.equal(dispatched.handled, true);
    const dispatchPayload = JSON.parse(dispatched.stdout ?? "{}") as {
      processed: Array<{
        delivery_mode: string;
        notification_id: number;
        signal_type: string;
        source_event_id: number;
        state: string;
        target_session: string;
      }>;
      processed_count: number;
    };
    assert.equal(dispatchPayload.processed_count, 1);
    assert.deepEqual(dispatchPayload.processed[0], {
      binding_id: "binding-completion-cli",
      correlation_id: dispatchPayload.processed[0]?.correlation_id,
      dedupe_key: "binding-completion-cli:worker_task_complete:session-worker-complete:1",
      delivery_mode: "pull_required",
      dry_run: false,
      notification_id: 1,
      signal_type: "worker_task_complete",
      source_event_id: 1,
      state: "pull_required",
      target_session: "manager-complete",
      task: "completion-task",
    });

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const notification = verifyDb.prepare(`
        select rn.state, rn.delivery_mode, rn.side_effect_started, rn.side_effect_completed,
               rn.source_event_id, rn.source_event_timestamp, rn.dedupe_key, rn.payload_json,
               target.name as target_session_name
        from routed_notifications rn
        join sessions target on target.id = rn.target_session_id
      `).get() as {
        dedupe_key: string;
        delivery_mode: string;
        payload_json: string;
        side_effect_completed: number;
        side_effect_started: number;
        source_event_id: number;
        source_event_timestamp: string;
        state: string;
        target_session_name: string;
      };
      const payload = JSON.parse(notification.payload_json) as {
        delivery_mode: string;
        signal: string;
        worker_receipt: { last_agent_message: string; turn_id: string };
      };
      assert.deepEqual({
        dedupe_key: notification.dedupe_key,
        delivery_mode: notification.delivery_mode,
        side_effect_completed: Boolean(notification.side_effect_completed),
        side_effect_started: Boolean(notification.side_effect_started),
        source_event_id: notification.source_event_id,
        source_event_timestamp: notification.source_event_timestamp,
        state: notification.state,
        target_session_name: notification.target_session_name,
      }, {
        dedupe_key: "binding-completion-cli:worker_task_complete:session-worker-complete:1",
        delivery_mode: "pull_required",
        side_effect_completed: false,
        side_effect_started: false,
        source_event_id: 1,
        source_event_timestamp: "2026-05-23T10:02:00Z",
        state: "delivered",
        target_session_name: "manager-complete",
      });
      assert.equal(payload.delivery_mode, "pull_required");
      assert.equal(payload.signal, "worker_task_complete");
      assert.deepEqual(payload.worker_receipt, {
        completed_at: "2026-05-23T10:02:00Z",
        duration_ms: 1200,
        last_agent_message: "done",
        source_event_id: 1,
        source_event_timestamp: "2026-05-23T10:02:00Z",
        source_session: "worker-complete",
        time_to_first_token_ms: null,
        turn_id: "turn-complete-cli",
      });
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime dispatch CLI records failed attempts for missing manager permission", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-dispatch-permission."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Route dispatch queue.",
        name: "permission-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-permission-cli",
      });
      insertSession(database, { id: "session-worker", name: "worker-permission", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-permission", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-permission-cli",
        managerSessionName: "manager-permission",
        now: "2026-05-23T10:00:30Z",
        taskName: "permission-task",
        workerSessionName: "worker-permission",
      });
    } finally {
      database.close();
    }

    const enqueued = runTypescriptRuntimeCommand({
      args: [
        "enqueue-nudge-worker",
        "permission-task",
        "--message",
        "Clear context.",
        "--required-permission",
        "worker_compact_clear",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(enqueued.exitCode, 0);
    const enqueuedPayload = JSON.parse(enqueued.stdout ?? "{}") as { command_id: string };

    const dispatched = runTypescriptRuntimeCommand({
      args: [
        "dispatch",
        "--once",
        "--type",
        "nudge_worker",
        "--dispatcher-id",
        "dispatch-permission-cli",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(dispatched.exitCode, 0);
    const dispatchPayload = JSON.parse(dispatched.stdout ?? "{}") as {
      processed: Array<{ error: string; state: string }>;
    };
    assert.equal(dispatchPayload.processed[0]?.state, "failed");
    assert.match(dispatchPayload.processed[0]?.error ?? "", /manager permission required/);

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const command = verifyDb.prepare("select state, error from commands where id = ?").get(enqueuedPayload.command_id) as {
        error: string;
        state: string;
      };
      const attempt = verifyDb.prepare("select state, error, side_effect_started from command_attempts where command_id = ?").get(enqueuedPayload.command_id) as {
        error: string;
        side_effect_started: number;
        state: string;
      };
      const events = verifyDb.prepare(`
        select event_type, severity
        from telemetry_events
        where event_type in ('dispatch_command_permission_checked', 'dispatch_command_failed')
        order by timestamp, event_type
      `).all() as Array<{ event_type: string; severity: string }>;
      assert.equal(command.state, "failed");
      assert.match(command.error, /manager permission required/);
      assert.equal(attempt.state, "failed");
      assert.match(attempt.error, /manager permission required/);
      assert.equal(Boolean(attempt.side_effect_started), false);
      assert.deepEqual(events.map((row) => ({ event_type: row.event_type, severity: row.severity })), [
        { event_type: "dispatch_command_failed", severity: "error" },
        { event_type: "dispatch_command_permission_checked", severity: "warning" },
      ]);
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup-bundle seeded manager permissions are used by dispatcher gates", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-cli-setup-bundle-dispatch-permission."));
  const codexHome = makeCodexHomeWithSkills([
    "goal-prep",
    "requesting-code-review",
    "receiving-code-review",
    "codex-review",
  ]);
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Dispatch must honor setup-seeded manager permissions.",
        name: "dispatch-ship-task",
        now: "2026-06-28T14:00:00Z",
        taskId: "task-dispatch-ship",
      });
      insertSession(database, { id: "session-worker-setup-dispatch", name: "worker-setup-dispatch", role: "worker" });
      insertSession(database, { id: "session-manager-setup-dispatch", name: "manager-setup-dispatch", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-setup-dispatch",
        managerSessionName: "manager-setup-dispatch",
        now: "2026-06-28T14:00:30Z",
        taskName: "dispatch-ship-task",
        workerSessionName: "worker-setup-dispatch",
      });
    } finally {
      database.close();
    }

    const applied = runTypescriptRuntimeCommand({
      args: [
        "setup-bundle",
        "apply",
        "dispatch-ship-task",
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
      now: () => new Date("2026-06-28T14:01:00Z"),
    });
    assert.equal(applied.exitCode, 0);
    assert.equal((JSON.parse(applied.stdout ?? "{}") as { blocked: boolean }).blocked, false);

    const enqueued = runTypescriptRuntimeCommand({
      args: [
        "enqueue-nudge-worker",
        "dispatch-ship-task",
        "--message",
        "Push the branch after setup-approved manager authority.",
        "--required-permission",
        "repo.push_branch",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
    });
    assert.equal(enqueued.exitCode, 0);

    const dispatched = runTypescriptRuntimeCommand({
      args: [
        "dispatch",
        "--once",
        "--type",
        "nudge_worker",
        "--dispatcher-id",
        "dispatch-local",
        "--path",
        dbPath,
        "--json",
      ],
      env: {},
      now: () => new Date("2026-06-28T14:02:00Z"),
    });
    assert.equal(dispatched.exitCode, 0);
    const dispatchPayload = JSON.parse(dispatched.stdout ?? "{}") as {
      processed: Array<{ permission_check: { allowed: boolean; required_permission: string }; state: string }>;
      processed_count: number;
    };
    assert.equal(dispatchPayload.processed_count, 1);
    assert.equal(dispatchPayload.processed[0]?.state, "pull_required");
    assert.deepEqual(dispatchPayload.processed[0]?.permission_check, {
      allowed: true,
      configured: true,
      required_permission: "repo.push_branch",
    });

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const event = verifyDb.prepare(`
        select attributes_json
        from telemetry_events
        where event_type = 'dispatch_command_permission_checked'
        order by timestamp desc, rowid desc
        limit 1
      `).get() as { attributes_json: string };
      assert.deepEqual(JSON.parse(event.attributes_json), {
        allowed: true,
        configured: true,
        required_permission: "repo.push_branch",
      });
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles manager-config and manager-permission by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-manager-policy."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Ship manager policy.",
        name: "policy-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-policy",
      });
    } finally {
      database.close();
    }

    const created = runTypescriptRuntimeCommand({
      args: [
        "manager-config",
        "policy-task",
        "--mode",
        "strict",
        "--recipe",
        "ux polish",
        "--objective",
        "Check the release contract.",
        "--guideline",
        "Nudge only on stale evidence.",
        "--acceptance",
        "CI is green.",
        "--reference",
        "docs/release.md",
        "--permit",
        "context.spawn_reviewer",
        "--allow-pr",
        "--allow-merge-green",
        "--allow-worker-compact-clear",
        "--tool",
        "npm test",
        "--epilogue",
        "draft-pr",
        "--nudge-on-completion",
        "auto-review",
        "--require-acks",
        "--permissions-json",
        "{\"communication.notify_operator\":true,\"unknown_key\":true}",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(created.exitCode, 0);
    assert.equal(created.handled, true);
    const config = JSON.parse(created.stdout ?? "{}") as {
      acceptance_criteria: string[];
      epilogues: string[];
      guidelines: string[];
      nudge_on_completion: string;
      objective: string;
      permissions: {
        communication: string[];
        context: string[];
        repo: string[];
        worker_session: string[];
      };
      recipe_name: string;
      reference_paths: string[];
      require_acks: boolean;
      revision: number;
      supervision_mode: string;
      tools: string[];
      warnings: string[];
    };
    assert.equal(config.supervision_mode, "strict");
    assert.equal(config.recipe_name, "ux-polish-loop");
    assert.equal(config.objective, "Check the release contract.");
    assert.deepEqual(config.guidelines, ["Nudge only on stale evidence."]);
    assert.deepEqual(config.acceptance_criteria, ["CI is green."]);
    assert.deepEqual(config.reference_paths, ["docs/release.md"]);
    assert.deepEqual(config.permissions.communication, ["notify_operator"]);
    assert.deepEqual(config.permissions.context, ["spawn_reviewer"]);
    assert.deepEqual(config.permissions.repo, ["merge_green_pr", "open_pr"]);
    assert.deepEqual(config.permissions.worker_session, ["clear", "compact"]);
    assert.deepEqual(config.epilogues, ["draft-pr"]);
    assert.deepEqual(config.tools, ["npm test"]);
    assert.equal(config.nudge_on_completion, "auto-review");
    assert.equal(config.require_acks, true);
    assert.equal(config.revision, 1);
    assert.deepEqual(config.warnings, ["unknown permission key \"unknown_key\""]);

    const listed = runTypescriptRuntimeCommand({
      args: ["manager-permission", "policy-task", "repo", "--list", "--path", dbPath],
      env: {},
    });
    assert.equal(listed.exitCode, 0);
    const listedPayload = JSON.parse(listed.stdout ?? "{}") as {
      allowed: boolean;
      listed_permissions: string[];
      reasons: string[];
    };
    assert.equal(listedPayload.allowed, true);
    assert.deepEqual(listedPayload.listed_permissions, ["merge_green_pr", "open_pr"]);
    assert.deepEqual(listedPayload.reasons, []);

    const denied = runTypescriptRuntimeCommand({
      args: ["manager-permission", "policy-task", "repo.push_branch", "--require", "--path", dbPath],
      env: {},
    });
    assert.equal(denied.exitCode, 1);
    const deniedPayload = JSON.parse(denied.stdout ?? "{}") as {
      allowed: boolean;
      reasons: string[];
    };
    assert.equal(deniedPayload.allowed, false);
    assert.deepEqual(deniedPayload.reasons, ["permission_not_enabled"]);

    const needsHandoff = runTypescriptRuntimeCommand({
      args: ["manager-permission", "policy-task", "worker_compact_clear", "--require-handoff", "--require", "--path", dbPath],
      env: {},
    });
    assert.equal(needsHandoff.exitCode, 1);
    assert.deepEqual((JSON.parse(needsHandoff.stdout ?? "{}") as { reasons: string[] }).reasons, ["missing_worker_handoff"]);

    const handoffDb = openDatabaseSync(dbPath);
    try {
      handoffDb.prepare(`
        insert into worker_handoffs(task_id, worker_session_id, summary, next_steps_json, payload_json, created_at)
        values ('task-policy', null, 'Ready for compact.', '[]', '{}', '2026-05-23T10:01:00Z')
      `).run();
    } finally {
      handoffDb.close();
    }

    const allowedWithHandoff = runTypescriptRuntimeCommand({
      args: ["manager-permission", "policy-task", "worker_compact_clear", "--require-handoff", "--require", "--path", dbPath],
      env: {},
    });
    assert.equal(allowedWithHandoff.exitCode, 0);
    const allowedPayload = JSON.parse(allowedWithHandoff.stdout ?? "{}") as {
      allowed: boolean;
      handoff_id: number;
      reasons: string[];
    };
    assert.equal(allowedPayload.allowed, true);
    assert.equal(allowedPayload.handoff_id, 1);
    assert.deepEqual(allowedPayload.reasons, []);

    const update = runTypescriptRuntimeCommand({
      args: ["manager-config", "policy-task", "--objective", "Check the merged PR.", "--path", dbPath],
      env: {},
    });
    assert.equal(update.exitCode, 0);
    const updated = JSON.parse(update.stdout ?? "{}") as { objective: string; recipe_name: string; revision: number };
    assert.equal(updated.objective, "Check the merged PR.");
    assert.equal(updated.recipe_name, "ux-polish-loop");
    assert.equal(updated.revision, 2);

    const eventDb = openDatabaseSync(dbPath);
    try {
      const events = eventDb.prepare(`
        select type
        from events
        where task_id = 'task-policy'
          and type in ('manager_config_recorded', 'manager_permission_checked')
        order by id
      `).all() as Array<{ type: string }>;
      assert.deepEqual(events.map((row) => row.type), [
        "manager_config_recorded",
        "manager_permission_checked",
        "manager_permission_checked",
        "manager_permission_checked",
        "manager_permission_checked",
        "manager_config_recorded",
      ]);
    } finally {
      eventDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles record-decision by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-record-decision."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Record a decision.",
        name: "decision-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-decision",
      });
      database.prepare(`
        insert into managers(id, name, task_id, tmux_session, state, codex_args_json, started_at)
        values ('manager-decision', 'decision-manager', 'task-decision', 'tmux-manager-decision', 'ready', '[]', '2026-05-23T10:00:15Z')
      `).run();
      database.prepare(`
        insert into manager_cycles(id, task_id, manager_id, started_at, state)
        values (7, 'task-decision', 'manager-decision', '2026-05-23T10:01:00Z', 'started')
      `).run();
    } finally {
      database.close();
    }

    const recorded = runTypescriptRuntimeCommand({
      args: [
        "record-decision",
        "decision-task",
        "stop",
        "--reason",
        "CI is green and the PR is merged.",
        "--cycle-id",
        "7",
        "--payload-json",
        "{\"ci\":\"green\"}",
        "--path",
        dbPath,
      ],
      env: {},
      now: () => new Date("2026-05-23T10:02:00Z"),
    });
    assert.equal(recorded.exitCode, 0);
    const payload = JSON.parse(recorded.stdout ?? "{}") as {
      created_at: string;
      decision: string;
      id: number;
      manager_cycle_id: number;
      manager_id: string;
      payload: Record<string, unknown>;
      reason: string;
      task: { id: string; name: string };
      task_id: string;
    };
    assert.equal(payload.created_at, "2026-05-23T10:02:00Z");
    assert.equal(payload.decision, "stop");
    assert.equal(payload.id, 1);
    assert.equal(payload.manager_cycle_id, 7);
    assert.equal(payload.manager_id, "manager-decision");
    assert.deepEqual(payload.payload, { ci: "green" });
    assert.equal(payload.reason, "CI is green and the PR is merged.");
    assert.deepEqual(payload.task, { id: "task-decision", name: "decision-task" });
    assert.equal(payload.task_id, "task-decision");

    const proofDb = openDatabaseSync(dbPath);
    try {
      const row = proofDb.prepare("select decision, manager_id, manager_cycle_id, payload_json from manager_decisions where id = 1")
        .get() as { decision: string; manager_cycle_id: number; manager_id: string; payload_json: string };
      assert.equal(row.decision, "stop");
      assert.equal(row.manager_id, "manager-decision");
      assert.equal(row.manager_cycle_id, 7);
      assert.deepEqual(JSON.parse(row.payload_json), { ci: "green" });
      const event = proofDb.prepare("select manager_id, payload_json, type from events where type = 'manager_decision_recorded'")
        .get() as { manager_id: string; payload_json: string; type: string };
      assert.equal(event.manager_id, "manager-decision");
      assert.equal(event.type, "manager_decision_recorded");
      assert.deepEqual(JSON.parse(event.payload_json), {
        decision: "stop",
        decision_id: 1,
        manager_cycle_id: 7,
        reason: "CI is green and the PR is merged.",
      });
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles continuation submit list and review by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-continuation."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Review continuation.",
        name: "continuation-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-continuation",
      });
    } finally {
      database.close();
    }

    const worker = runTypescriptRuntimeCommand({
      args: [
        "continuation",
        "continuation-task",
        "--submit",
        "worker",
        "--from-stdin",
        "--correlation-id",
        "corr-continuation",
        "--path",
        dbPath,
      ],
      env: {},
      stdin: "{\"next\":\"run tests\",\"private\":\"worker-note\"}",
    });
    assert.equal(worker.exitCode, 0);
    const workerPayload = JSON.parse(worker.stdout ?? "{}") as {
      correlation_id: string;
      id: number;
      payload: Record<string, unknown>;
      proposer: string;
      revision: number;
    };
    assert.equal(workerPayload.correlation_id, "corr-continuation");
    assert.equal(workerPayload.id, 1);
    assert.deepEqual(workerPayload.payload, { next: "run tests", private: "worker-note" });
    assert.equal(workerPayload.proposer, "worker");
    assert.equal(workerPayload.revision, 1);

    const blockedRead = runTypescriptRuntimeCommand({
      args: [
        "continuation",
        "continuation-task",
        "--list",
        "--as-role",
        "manager",
        "--include-payload",
        "--correlation-id",
        "corr-continuation",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(blockedRead.exitCode, 2);
    assert.match(blockedRead.stderr ?? "", /manager cannot read worker continuation payload/);

    const manager = runTypescriptRuntimeCommand({
      args: [
        "continuation",
        "continuation-task",
        "--submit",
        "manager",
        "--from-stdin",
        "--correlation-id",
        "corr-continuation",
        "--path",
        dbPath,
      ],
      env: {},
      stdin: "{\"decision\":\"continue\",\"manager_private\":\"reviewed\"}",
    });
    assert.equal(manager.exitCode, 0);
    const managerPayload = JSON.parse(manager.stdout ?? "{}") as {
      id: number;
      payload: Record<string, unknown>;
      proposer: string;
      revision: number;
    };
    assert.equal(managerPayload.id, 2);
    assert.deepEqual(managerPayload.payload, { decision: "continue", manager_private: "reviewed" });
    assert.equal(managerPayload.proposer, "manager");
    assert.equal(managerPayload.revision, 1);

    const list = runTypescriptRuntimeCommand({
      args: [
        "continuation",
        "continuation-task",
        "--list",
        "--as-role",
        "manager",
        "--include-payload",
        "--correlation-id",
        "corr-continuation",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(list.exitCode, 0);
    const listPayload = JSON.parse(list.stdout ?? "{}") as {
      continuations: Array<{ payload: Record<string, unknown>; payload_redacted?: boolean; proposer: string }>;
      reviews: unknown[];
    };
    assert.equal(listPayload.continuations.length, 2);
    assert.equal(listPayload.continuations[0].payload.private, "worker-note");
    assert.equal(listPayload.continuations[0].payload_redacted, undefined);
    assert.equal(listPayload.continuations[1].payload.manager_private, "reviewed");
    assert.deepEqual(listPayload.reviews, []);

    const deniedReview = runTypescriptRuntimeCommand({
      args: [
        "continuation",
        "continuation-task",
        "--review",
        "--from-stdin",
        "--correlation-id",
        "corr-continuation",
        "--path",
        dbPath,
      ],
      env: {},
      stdin: "{\"agreement\":\"match\",\"verdict\":\"proceed\",\"rationale\":\"Aligned.\",\"subagent_run\":{\"reviewer_session_id\":\"reviewer-1\",\"manager_session_id\":\"manager-1\",\"manager_rollout_access\":false}}",
    });
    assert.equal(deniedReview.exitCode, 2);
    assert.match(deniedReview.stderr ?? "", /manager permission context\.spawn_reviewer/);

    const permissionDb = openDatabaseSync(dbPath);
    try {
      permissionDb.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json,
          tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values ('task-continuation', 'guided', null, '[]', '[]', '[]', '{"context":["spawn_reviewer"]}', '[]', '[]', 'ask-operator', 0, 1, '2026-05-23T10:01:00Z', '2026-05-23T10:01:00Z')
      `).run();
    } finally {
      permissionDb.close();
    }

    const reviewed = runTypescriptRuntimeCommand({
      args: [
        "continuation",
        "continuation-task",
        "--review",
        "--from-stdin",
        "--correlation-id",
        "corr-continuation",
        "--path",
        dbPath,
      ],
      env: {},
      now: () => new Date("2026-05-23T10:02:00Z"),
      stdin: "{\"agreement\":\"divergent\",\"verdict\":\"amend\",\"rationale\":\"Manager missed the test step.\",\"addendum\":\"Add test proof.\",\"subagent_run\":{\"reviewer_session_id\":\"reviewer-1\",\"manager_session_id\":\"manager-1\",\"manager_rollout_access\":false,\"status\":\"succeeded\",\"allowed_context\":[\"task\",\"diff\"],\"duration_ms\":120,\"returncode\":0}}",
    });
    assert.equal(reviewed.exitCode, 0);
    const review = JSON.parse(reviewed.stdout ?? "{}") as {
      agreement: string;
      id: number;
      manager_continuation_id: number;
      operator_routing_required: boolean;
      subagent_run: Record<string, unknown>;
      verdict: string;
      worker_continuation_id: number;
    };
    assert.equal(review.id, 1);
    assert.equal(review.agreement, "divergent");
    assert.equal(review.verdict, "amend");
    assert.equal(review.operator_routing_required, true);
    assert.equal(review.worker_continuation_id, 1);
    assert.equal(review.manager_continuation_id, 2);
    assert.equal(review.subagent_run.operator_routing_required, true);

    const proofDb = openDatabaseSync(dbPath);
    try {
      const events = proofDb.prepare(`
        select actor, correlation_id, type
        from events
        where task_id = 'task-continuation'
          and type in ('task_continuation_recorded', 'continuation_review_recorded')
        order by id
      `).all() as Array<{ actor: string; correlation_id: string; type: string }>;
      assert.deepEqual(events.map((event) => [event.actor, event.correlation_id, event.type]), [
        ["worker", "corr-continuation", "task_continuation_recorded"],
        ["manager", "corr-continuation", "task_continuation_recorded"],
        ["workerctl", "corr-continuation", "continuation_review_recorded"],
      ]);
      const telemetry = proofDb.prepare("select severity, attributes_json from telemetry_events where event_type = 'continuation_review_recorded'")
        .get() as { attributes_json: string; severity: string };
      assert.equal(telemetry.severity, "warning");
      assert.equal(JSON.parse(telemetry.attributes_json).operator_routing_required, true);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles handoff and epilogue by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-handoff-epilogue."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Record handoff.",
        name: "handoff-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-handoff",
      });
      insertSession(database, { id: "session-handoff-worker", name: "handoff-worker", role: "worker" });
      insertSession(database, { id: "session-handoff-manager", name: "handoff-manager", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-handoff",
        managerSessionName: "handoff-manager",
        now: "2026-05-23T10:00:10Z",
        taskName: "handoff-task",
        workerSessionName: "handoff-worker",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json,
          tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values ('task-handoff', 'guided', null, '[]', '[]', '[]', '{}', '[]', '["record-handoff","draft-pr"]', 'ask-operator', 0, 1, '2026-05-23T10:00:20Z', '2026-05-23T10:00:20Z')
      `).run();
    } finally {
      database.close();
    }

    const handoff = runTypescriptRuntimeCommand({
      args: [
        "handoff",
        "handoff-task",
        "--summary",
        "Implemented the policy slice.",
        "--next-step",
        "Run full gates.",
        "--next-step",
        "Open PR.",
        "--payload-json",
        "{\"branch\":\"codex/ts-manager-policy-cli\"}",
        "--path",
        dbPath,
      ],
      env: {},
      now: () => new Date("2026-05-23T10:01:00Z"),
    });
    assert.equal(handoff.exitCode, 0);
    const handoffPayload = JSON.parse(handoff.stdout ?? "{}") as {
      id: number;
      next_steps: string[];
      payload: Record<string, unknown>;
      summary: string;
      worker_session_id: string;
    };
    assert.equal(handoffPayload.id, 1);
    assert.deepEqual(handoffPayload.next_steps, ["Run full gates.", "Open PR."]);
    assert.deepEqual(handoffPayload.payload, { branch: "codex/ts-manager-policy-cli" });
    assert.equal(handoffPayload.summary, "Implemented the policy slice.");
    assert.equal(handoffPayload.worker_session_id, "session-handoff-worker");

    const initialStatus = runTypescriptRuntimeCommand({
      args: ["epilogue", "handoff-task", "--status", "--path", dbPath],
      env: {},
    });
    assert.equal(initialStatus.exitCode, 0);
    assert.deepEqual((JSON.parse(initialStatus.stdout ?? "{}") as { status: { missing_or_incomplete: string[] } }).status.missing_or_incomplete, [
      "record-handoff",
      "draft-pr",
    ]);

    const recordHandoff = runTypescriptRuntimeCommand({
      args: ["epilogue", "handoff-task", "--step", "record-handoff", "--correlation-id", "epi-handoff", "--json", "--path", dbPath],
      env: {},
      now: () => new Date("2026-05-23T10:02:00Z"),
    });
    assert.equal(recordHandoff.exitCode, 0);
    const recordPayload = JSON.parse(recordHandoff.stdout ?? "{}") as {
      runs: Array<{ correlation_id: string; result: Record<string, unknown>; state: string; step_name: string }>;
      status: { missing_or_incomplete: string[] };
    };
    assert.equal(recordPayload.runs[0].correlation_id, "epi-handoff");
    assert.equal(recordPayload.runs[0].state, "succeeded");
    assert.equal(recordPayload.runs[0].step_name, "record-handoff");
    assert.deepEqual(recordPayload.runs[0].result, {
      handoff_id: 1,
      summary: "Implemented the policy slice.",
    });
    assert.deepEqual(recordPayload.status.missing_or_incomplete, ["draft-pr"]);

    const draftPr = runTypescriptRuntimeCommand({
      args: ["epilogue", "handoff-task", "--step", "draft-pr", "--correlation-id", "epi-draft", "--json", "--path", dbPath],
      env: {},
      now: () => new Date("2026-05-23T10:03:00Z"),
    });
    assert.equal(draftPr.exitCode, 0);
    const draftPayload = JSON.parse(draftPr.stdout ?? "{}") as {
      runs: Array<{ correlation_id: string; state: string; step_name: string }>;
      status: { ok: boolean };
    };
    assert.equal(draftPayload.status.ok, true);
    assert.deepEqual(draftPayload.runs.map((run) => [run.correlation_id, run.step_name, run.state]), [
      ["epi-handoff", "record-handoff", "succeeded"],
      ["epi-draft", "draft-pr", "succeeded"],
    ]);

    const proofDb = openDatabaseSync(dbPath);
    try {
      const events = proofDb.prepare(`
        select correlation_id, type
        from events
        where task_id = 'task-handoff'
          and type in ('worker_handoff_recorded', 'epilogue_step_recorded')
        order by id
      `).all() as Array<{ correlation_id: string | null; type: string }>;
      assert.deepEqual(events.map((event) => [event.correlation_id, event.type]), [
        [null, "worker_handoff_recorded"],
        ["epi-handoff", "epilogue_step_recorded"],
        ["epi-draft", "epilogue_step_recorded"],
      ]);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles request-worker-compact and compact-worker by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-worker-compact."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Compact worker context.",
        name: "compact-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-compact",
      });
      insertSession(database, {
        id: "session-compact-worker",
        name: "compact-worker",
        role: "worker",
        tmuxSession: "tmux-compact-worker",
      });
      insertSession(database, {
        id: "session-compact-manager",
        name: "compact-manager",
        role: "manager",
        tmuxSession: "tmux-compact-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-compact",
        managerSessionName: "compact-manager",
        now: "2026-05-23T10:00:10Z",
        taskName: "compact-task",
        workerSessionName: "compact-worker",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json,
          tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values ('task-compact', 'guided', null, '[]', '[]', '[]', '{"worker_session":["compact","clear"]}', '[]', '[]', 'ask-operator', 0, 1, '2026-05-23T10:00:20Z', '2026-05-23T10:00:20Z')
      `).run();
      database.prepare(`
        insert into worker_handoffs(task_id, worker_session_id, summary, next_steps_json, payload_json, created_at)
        values ('task-compact', 'session-compact-worker', 'Ready to compact.', '[]', '{}', '2026-05-23T10:00:30Z')
      `).run();
      database.prepare(`
        insert into manager_decisions(task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json)
        values ('task-compact', null, null, 'nudge', 'Request worker compaction.', '2026-05-23T10:00:40Z', '{}')
      `).run();
    } finally {
      database.close();
    }

    const requested = runTypescriptRuntimeCommand({
      args: [
        "request-worker-compact",
        "compact-task",
        "--decision-id",
        "1",
        "--strict-decisions",
        "--dry-run",
        "--path",
        dbPath,
      ],
      env: {},
      now: () => new Date("2026-05-23T10:01:00Z"),
    });
    assert.equal(requested.exitCode, 0);
    const requestPayload = JSON.parse(requested.stdout ?? "{}") as {
      permission_check: { allowed: boolean; handoff_id: number };
      send_result: { dry_run: boolean; session: string; text: string };
      send_text: string;
      slash_command: string;
    };
    assert.equal(requestPayload.permission_check.allowed, true);
    assert.equal(requestPayload.permission_check.handoff_id, 1);
    assert.equal(requestPayload.slash_command, "/compact");
    assert.equal(requestPayload.send_text, "/compact");
    assert.deepEqual(requestPayload.send_result, {
      dry_run: true,
      session: "compact-worker",
      side_effect_completed: false,
      side_effect_started: false,
      target: "tmux-compact-worker",
      text: "/compact",
      time: "2026-05-23T10:01:00Z",
    });

    const cleared = runTypescriptRuntimeCommand({
      args: [
        "compact-worker",
        "compact-task",
        "--reason",
        "Clear after saved handoff.",
        "--clear",
        "--dry-run",
        "--path",
        dbPath,
      ],
      env: {},
      now: () => new Date("2026-05-23T10:02:00Z"),
    });
    assert.equal(cleared.exitCode, 0);
    const clearPayload = JSON.parse(cleared.stdout ?? "{}") as {
      manager_decision: { decision_id: number; ok: boolean };
      send_result: { text: string };
      slash_command: string;
    };
    assert.equal(clearPayload.manager_decision.ok, true);
    assert.equal(clearPayload.manager_decision.decision_id, 2);
    assert.equal(clearPayload.slash_command, "/clear");
    assert.equal(clearPayload.send_result.text, "/clear");

    const proofDb = openDatabaseSync(dbPath);
    try {
      const commands = (proofDb.prepare("select state, type from commands where type = 'request_worker_compact' order by created_at")
        .all() as Array<Record<string, unknown>>)
        .map((row) => ({ state: row.state, type: row.type }));
      assert.deepEqual(commands, [
        { state: "succeeded", type: "request_worker_compact" },
        { state: "succeeded", type: "request_worker_compact" },
      ]);
      const events = proofDb.prepare(`
        select type
        from events
        where task_id = 'task-compact'
          and type in ('manager_decision_recorded', 'worker_compact_requested', 'worker_compact_request_succeeded')
        order by id
      `).all() as Array<{ type: string }>;
      assert.deepEqual(events.map((event) => event.type), [
        "worker_compact_requested",
        "worker_compact_request_succeeded",
        "manager_decision_recorded",
        "worker_compact_requested",
        "worker_compact_request_succeeded",
      ]);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles continuation-reviewer dry-run and fail-closed review by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-continuation-reviewer."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Review continuation independently.",
        name: "reviewer-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-reviewer",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json,
          tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values ('task-reviewer', 'guided', null, '[]', '[]', '[]', '{"context":["spawn_reviewer"]}', '[]', '[]', 'ask-operator', 0, 1, '2026-05-23T10:00:20Z', '2026-05-23T10:00:20Z')
      `).run();
    } finally {
      database.close();
    }

    for (const [submit, stdin] of [
      ["worker", "{\"next\":\"run focused tests\"}"],
      ["manager", "{\"decision\":\"continue after tests\"}"],
    ] as const) {
      const submitted = runTypescriptRuntimeCommand({
        args: [
          "continuation",
          "reviewer-task",
          "--submit",
          submit,
          "--from-stdin",
          "--correlation-id",
          "corr-reviewer",
          "--path",
          dbPath,
        ],
        env: {},
        stdin,
      });
      assert.equal(submitted.exitCode, 0);
    }

    const dryRun = runTypescriptRuntimeCommand({
      args: [
        "continuation-reviewer",
        "reviewer-task",
        "--correlation-id",
        "corr-reviewer",
        "--reviewer-session-id",
        "reviewer-session",
        "--manager-session-id",
        "manager-session",
        "--dry-run",
        "--path",
        dbPath,
      ],
      env: {},
    });
    assert.equal(dryRun.exitCode, 0);
    const dryRunPayload = JSON.parse(dryRun.stdout ?? "{}") as {
      context: { allowed_context: string[]; correlation_id: string };
      reviewer_command: string[];
    };
    assert.equal(dryRunPayload.context.correlation_id, "corr-reviewer");
    assert.ok(dryRunPayload.context.allowed_context.includes("worker_continuation"));
    assert.deepEqual(dryRunPayload.reviewer_command, []);

    const failedReview = runTypescriptRuntimeCommand({
      args: [
        "continuation-reviewer",
        "reviewer-task",
        "--correlation-id",
        "corr-reviewer",
        "--reviewer-session-id",
        "reviewer-session",
        "--manager-session-id",
        "manager-session",
        "--path",
        dbPath,
        "--reviewer-command",
        "--",
        "node",
        "-e",
        "process.stdout.write('not-json')",
      ],
      env: {},
      now: () => new Date("2026-05-23T10:02:00Z"),
    });
    assert.equal(failedReview.exitCode, 0);
    const reviewPayload = JSON.parse(failedReview.stdout ?? "{}") as {
      operator_routing_required: boolean;
      subagent_run: Record<string, unknown>;
      verdict: string;
    };
    assert.equal(reviewPayload.verdict, "stop");
    assert.equal(reviewPayload.operator_routing_required, true);
    assert.equal(reviewPayload.subagent_run.manager_rollout_access, false);
    assert.equal(reviewPayload.subagent_run.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles import-compat dry-run apply and idempotency by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-import-compat."));
  try {
    const compatRoot = join(root, "compat");
    const workerPath = join(compatRoot, "legacy-worker");
    mkdirSync(workerPath, { recursive: true });
    writeFileSync(join(workerPath, "config.json"), `${JSON.stringify({
      cwd: root,
      identity_token: "legacy-token",
      name: "legacy-worker",
      tmux_session: "legacy-tmux",
    })}\n`);
    writeFileSync(join(workerPath, "status.json"), `${JSON.stringify({
      current_task: "Migrate files.",
      last_update: "2026-05-23T10:00:00Z",
      next_action: "Run importer.",
      state: "planning",
    })}\n`);
    writeFileSync(join(workerPath, "events.jsonl"), `${JSON.stringify({ detail: "hello", time: "2026-05-23T10:00:01Z", type: "nudge" })}\n`);
    writeFileSync(join(workerPath, "transcript.txt"), "line one\nline two\n");
    writeFileSync(join(workerPath, "capture-meta.json"), `${JSON.stringify({
      captured_at: "2026-05-23T10:00:02Z",
      changed_at: "2026-05-23T10:00:02Z",
      history_lines: 2,
    })}\n`);

    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
    } finally {
      database.close();
    }

    const dryRun = runTypescriptRuntimeCommand({
      args: ["import-compat", "--root", compatRoot, "--path", dbPath],
      env: {},
    });
    assert.equal(dryRun.exitCode, 0);
    const dryRunPayload = JSON.parse(dryRun.stdout ?? "{}") as { apply: boolean; workers: Array<{ action_count: number }> };
    assert.equal(dryRunPayload.apply, false);
    assert.equal(dryRunPayload.workers[0].action_count, 4);

    const applied = runTypescriptRuntimeCommand({
      args: ["import-compat", "--root", compatRoot, "--apply", "--path", dbPath],
      env: {},
      now: () => new Date("2026-05-23T10:01:00Z"),
    });
    assert.equal(applied.exitCode, 0);
    const appliedPayload = JSON.parse(applied.stdout ?? "{}") as { apply: boolean; worker_count: number; workers: Array<{ action_count: number }> };
    assert.equal(appliedPayload.apply, true);
    assert.equal(appliedPayload.worker_count, 1);
    assert.equal(appliedPayload.workers[0].action_count, 4);

    const second = runTypescriptRuntimeCommand({
      args: ["import-compat", "--root", compatRoot, "--apply", "--path", dbPath],
      env: {},
    });
    assert.equal(second.exitCode, 0);
    assert.equal((JSON.parse(second.stdout ?? "{}") as { workers: Array<{ action_count: number }> }).workers[0].action_count, 0);

    const proofDb = openDatabaseSync(dbPath);
    try {
      const workerRows = (proofDb.prepare("select name, state, tmux_session from workers").all() as Array<Record<string, unknown>>)
        .map((row) => ({ name: row.name, state: row.state, tmux_session: row.tmux_session }));
      assert.deepEqual(workerRows, [
        { name: "legacy-worker", state: "candidate", tmux_session: "legacy-tmux" },
      ]);
      const statusRows = (proofDb.prepare("select state, current_task, next_action from statuses").all() as Array<Record<string, unknown>>)
        .map((row) => ({ current_task: row.current_task, next_action: row.next_action, state: row.state }));
      assert.deepEqual(statusRows, [
        { current_task: "Migrate files.", next_action: "Run importer.", state: "planning" },
      ]);
      assert.equal((proofDb.prepare("select count(*) as count from transcript_captures").get() as { count: number }).count, 1);
      const eventRows = (proofDb.prepare("select actor, type from events where actor = 'compat'").all() as Array<Record<string, unknown>>)
        .map((row) => ({ actor: row.actor, type: row.type }));
      assert.deepEqual(eventRows, [
        { actor: "compat", type: "compat_nudge" },
      ]);
      assert.equal((proofDb.prepare("select count(*) as count from data_migrations").get() as { count: number }).count, 4);
    } finally {
      proofDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedCliTask(database: DatabaseSync): void {
  initializeDatabaseSync(database);
  createTaskSync(database, {
    goal: "Exercise TypeScript CLI runtime.",
    name: "cli-task",
    now: "2026-05-23T10:00:00Z",
    taskId: "task-cli",
  });
  insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
  insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
  bindSessionsSync(database, {
    bindingId: "binding-cli",
    managerSessionName: "manager-a",
    now: "2026-05-23T10:00:30Z",
    taskName: "cli-task",
    workerSessionName: "worker-a",
  });
  insertRalphLoopRun(database, {
    currentIteration: 1,
    maxIterations: 3,
    requiredBeforeContinue: ["ci_green"],
    runId: "run-cli",
    taskId: "task-cli",
  });
  recordLoopEvidenceSync(database, {
    correlationId: "cli-ci",
    evidenceType: "ci_green",
    iteration: 1,
    loopRunId: "run-cli",
    now: "2026-05-23T10:01:00Z",
    proof: "CI is green.",
    status: "green",
    task: "cli-task",
  });
  createCommandSync(database, {
    commandId: "command-cli",
    commandType: "continue_iteration",
    correlationId: "corr-cli",
    now: "2026-05-23T10:02:00Z",
    payload: {
      message: "Run iteration 2.",
      ralph_loop: { requested_iteration: 2, run_id: "run-cli" },
    },
    taskId: "task-cli",
  });
  const claimed = claimNextDispatchCommandSync(database, {
    commandTypes: ["continue_iteration"],
    dispatcherId: "dispatch-cli",
    now: "2026-05-23T10:02:01Z",
  });
  assert.ok(claimed);
  executeDispatchCommandSync(database, {
    claimed,
    dispatcherId: "dispatch-cli",
    now: "2026-05-23T10:02:02Z",
  });
}

function insertSession(
  database: DatabaseSync,
	  options: {
	    id: string;
	    lastHeartbeatAt?: string;
	    name: string;
	    pid?: number | null;
	    role: "manager" | "worker";
	    tmuxPaneId?: string | null;
	    tmuxSession?: string | null;
	  },
): void {
	  database.prepare(`
	    insert into sessions(
	      id, name, role, identity_token, codex_session_path, codex_session_id,
	      cwd, registered_at, last_heartbeat_at, pid, state, tmux_session, tmux_pane_id
	    )
	    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	  `).run(
	    options.id,
	    options.name,
	    options.role,
    `${options.id}-token`,
    `/tmp/${options.id}.jsonl`,
	    `${options.id}-codex`,
	    "/repo",
	    "2026-05-23T10:00:00Z",
	    options.lastHeartbeatAt ?? "2026-05-23T10:00:00Z",
	    options.pid ?? null,
	    "active",
	    options.tmuxSession ?? null,
	    options.tmuxPaneId ?? null,
  );
}

function insertLegacyWorker(
  database: DatabaseSync,
  options: { identityToken: string; name: string; paneId: string; workerId: string },
): void {
  database.prepare(`
    insert into workers(
      id, name, tmux_session, tmux_pane_id, identity_token, cwd, state, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, '/repo', 'active', '2026-06-04T12:50:00Z', '2026-06-04T12:50:00Z')
  `).run(
    options.workerId,
    options.name,
    `codex-${options.name}`,
    options.paneId,
    options.identityToken,
  );
}

function insertLegacyManager(
  database: DatabaseSync,
  options: { managerId: string; name: string; paneId: string; taskId: string },
): void {
  database.prepare(`
    insert into managers(
      id, name, task_id, tmux_session, tmux_pane_id, state, codex_args_json, started_at
    )
    values (?, ?, ?, ?, ?, 'ready', '[]', '2026-06-04T12:50:30Z')
  `).run(
    options.managerId,
    options.name,
    options.taskId,
    `codex-${options.name}`,
    options.paneId,
  );
}

function insertTerminalCapture(
  database: DatabaseSync,
  taskId: string,
  role: "manager" | "worker",
  capturedAt: string,
  content: string,
): number {
  const result = database.prepare(`
    insert into terminal_captures(
      task_id, role, tmux_session, captured_at, history_lines, content_sha256,
      content, byte_count, line_count, classifier_json, source
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    role,
    `codex-${role}`,
    capturedAt,
    200,
    `${role}-sha`,
    content,
    Buffer.byteLength(content),
    pythonSplitlinesCountForTest(content),
    "{}",
    "test",
  );
  return Number(result.lastInsertRowid);
}

function insertTranscriptSegment(
  database: DatabaseSync,
  options: {
    capturedAt: string;
    role: "manager" | "worker";
    segmentId: number;
    text: string | null;
  },
): number {
  const result = database.prepare(`
    insert into transcript_segments(
      task_id, role, source_capture_id, previous_capture_id, captured_at,
      content_sha256, segment_text, segment_start_line, segment_end_line,
      byte_count, line_count, retention_class, segment_kind, created_at
    )
    values (?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, 'hot', ?, ?)
  `).run(
    "task-transcript",
    options.role,
    options.segmentId,
    options.capturedAt,
    `${options.role}-segment-sha-${options.segmentId}`,
    options.text,
    options.text === null ? null : 1,
    options.text === null ? null : pythonSplitlinesCountForTest(options.text),
    Buffer.byteLength(options.text ?? ""),
    pythonSplitlinesCountForTest(options.text ?? ""),
    options.text === null ? "metadata" : "segment",
    options.capturedAt,
  );
  return Number(result.lastInsertRowid);
}

function pythonSplitlinesCountForTest(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const lineBreaks = value.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/(?:\r\n|\r|\n)$/.test(value) ? 0 : 1);
}

function insertRalphLoopRun(
  database: DatabaseSync,
  options: {
    currentIteration: number;
    maxIterations: number;
    requiredBeforeContinue: string[];
    runId: string;
    runName?: string;
    startedAt?: string;
    taskId: string;
  },
): void {
  database.prepare(`
    insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
    values (?, ?, ?, 'ralph_loop', 'finished', ?, ?, ?)
  `).run(
    options.runId,
    options.taskId,
    options.runName ?? `${options.taskId}-ralph-loop`,
    options.startedAt ?? "2026-05-23T10:00:45Z",
    options.startedAt ?? "2026-05-23T10:00:45Z",
    JSON.stringify({
      cleanup_policy: "clear",
      current_iteration: options.currentIteration,
      kind: "ralph_loop",
      max_iterations: options.maxIterations,
      policy_record: true,
      preset: null,
      required_before_continue: options.requiredBeforeContinue,
      seed_prompt_sha256: null,
      stop_conditions: ["max_iterations", "required_evidence"],
    }),
  );
}
