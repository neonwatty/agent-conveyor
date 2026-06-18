import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  databaseHealthSync,
  initializeDatabaseSync,
  openDatabaseSync,
} from "./database.js";
import {
  captureMetaPath,
  configPath,
  defaultDbPath,
  eventsPath,
  loadJsonSync,
  stateRoot,
  statusPath,
  transcriptPath,
  validateWorkerName,
  workerDir,
  writeJsonSync,
} from "./files.js";
import { latestStatusSync } from "./status.js";
import {
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  REQUIRED_TRIGGERS,
  SCHEMA_VERSION,
} from "./sqlite-contract.js";

test("state paths mirror the legacy compatibility layout", () => {
  const env = { WORKERCTL_STATE_ROOT: "/tmp/custom-workers" };

  assert.equal(stateRoot({ cwd: "/repo", env }), "/tmp/custom-workers");
  assert.equal(stateRoot({ cwd: "/repo", env: {} }), "/repo/.codex-workers");
  assert.equal(workerDir("worker-a", { cwd: "/repo", env: {} }), "/repo/.codex-workers/worker-a");
  assert.equal(configPath("worker-a", { cwd: "/repo", env: {} }), "/repo/.codex-workers/worker-a/config.json");
  assert.equal(statusPath("worker-a", { cwd: "/repo", env: {} }), "/repo/.codex-workers/worker-a/status.json");
  assert.equal(eventsPath("worker-a", { cwd: "/repo", env: {} }), "/repo/.codex-workers/worker-a/events.jsonl");
  assert.equal(transcriptPath("worker-a", { cwd: "/repo", env: {} }), "/repo/.codex-workers/worker-a/transcript.txt");
  assert.equal(captureMetaPath("worker-a", { cwd: "/repo", env: {} }), "/repo/.codex-workers/worker-a/capture-meta.json");
  assert.equal(defaultDbPath({ cwd: "/repo", env: {} }), "/repo/.codex-workers/workerctl.db");
});

test("worker name validation matches the legacy allowed character set", () => {
  assert.doesNotThrow(() => validateWorkerName("worker-A_12"));
  assert.throws(() => validateWorkerName("worker.a"), /letters, numbers, hyphens, and underscores/);
  assert.throws(() => validateWorkerName(""), /letters, numbers, hyphens, and underscores/);
});

test("JSON compatibility helpers sort keys and keep the trailing newline", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-state-json."));
  try {
    const path = join(root, "nested", "status.json");
    writeJsonSync(path, { state: "waiting", blocker: null, current_task: "task" });

    assert.equal(
      readFileSync(path, "utf8"),
      `{\n  "blocker": null,\n  "current_task": "task",\n  "state": "waiting"\n}\n`,
    );
    assert.deepEqual(loadJsonSync(path, {}), {
      blocker: null,
      current_task: "task",
      state: "waiting",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("latest status falls back to status.json when sqlite is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-status-json."));
  try {
    writeJsonSync(statusPath("worker-a", { env: { WORKERCTL_STATE_ROOT: root } }), {
      blocker: null,
      current_task: "json task",
      last_update: "2026-05-08T09:00:00Z",
      next_action: "json next",
      state: "waiting",
    });

    assert.deepEqual(latestStatusSync("worker-a", { env: { WORKERCTL_STATE_ROOT: root } }), {
      blocker: null,
      current_task: "json task",
      last_update: "2026-05-08T09:00:00Z",
      next_action: "json next",
      state: "waiting",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("latest status reads sqlite before stale status.json", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-status-sqlite."));
  try {
    writeJsonSync(statusPath("worker-a", { env: { WORKERCTL_STATE_ROOT: root } }), {
      blocker: null,
      current_task: "json task",
      last_update: "2026-05-08T09:00:00Z",
      next_action: "json next",
      state: "waiting",
    });
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      database.prepare(`
        insert into workers(
          id, name, tmux_session, identity_token, cwd, state, created_at, updated_at
        )
        values (
          'worker-id-a', 'worker-a', 'codex-worker-a', 'worker-token-a',
          '/repo', 'active', '2026-05-08T10:00:00Z', '2026-05-08T10:00:00Z'
        )
      `).run();
      database.prepare(`
        insert into statuses(worker_id, state, current_task, next_action, blocker, created_at)
        values (
          'worker-id-a', 'blocked', 'db task', 'db next', 'db blocker',
          '2026-05-08T10:00:00Z'
        )
      `).run();
    } finally {
      database.close();
    }

    assert.deepEqual(latestStatusSync("worker-a", { env: { WORKERCTL_STATE_ROOT: root } }), {
      blocker: "db blocker",
      current_task: "db task",
      last_update: "2026-05-08T10:00:00Z",
      next_action: "db next",
      state: "blocked",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite schema contract constants cover the expected v25 inventory", () => {
  assert.equal(SCHEMA_VERSION, 25);
  assert.deepEqual([...REQUIRED_TABLES].sort(), [
    "acceptance_criteria",
    "agent_observations",
    "bindings",
    "budgets",
    "campaign_asset_receipts",
    "campaign_assignments",
    "campaign_channel_briefs",
    "campaign_worker_slots",
    "campaigns",
    "codex_events",
    "command_attempts",
    "commands",
    "continuation_reviews",
    "data_migrations",
    "epilogue_runs",
    "events",
    "manager_configs",
    "manager_cycle_spans",
    "manager_cycles",
    "manager_decisions",
    "managers",
    "prompts",
    "routed_notifications",
    "runs",
    "schema_migrations",
    "sessions",
    "statuses",
    "task_acknowledgements",
    "task_continuations",
    "tasks",
    "telemetry_events",
    "telemetry_events_fts",
    "terminal_captures",
    "transcript_captures",
    "transcript_segments",
    "worker_handoffs",
    "workers",
  ]);
  assert.equal(REQUIRED_INDEXES.has("campaign_worker_slots_campaign_slot"), true);
  assert.equal(REQUIRED_INDEXES.has("campaign_asset_receipts_campaign_status"), true);
  assert.equal(REQUIRED_INDEXES.has("commands_claimable"), true);
  assert.equal(REQUIRED_INDEXES.has("routed_notifications_target_inbox"), true);
  assert.deepEqual([...REQUIRED_TRIGGERS].sort(), ["events_no_delete", "events_no_update"]);
});

test("TypeScript database initialization reports healthy schema", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-db."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      const health = databaseHealthSync(database);
      assert.equal(health.ok, true);
      assert.equal(health.schema_version, SCHEMA_VERSION);
      assert.equal(health.user_version, SCHEMA_VERSION);
    } finally {
      database.close();
    }

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript-created empty schema contains the required tables indexes and triggers", () => {
  const tsRoot = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-schema."));
  try {
    const tsDbPath = join(tsRoot, "workerctl.db");
    const tsDb = openDatabaseSync(tsDbPath);
    try {
      initializeDatabaseSync(tsDb);
    } finally {
      tsDb.close();
    }

    const dumped = schemaDump(tsDbPath).join("\n");
    for (const table of REQUIRED_TABLES) {
      assert.match(dumped, new RegExp(`CREATE (VIRTUAL )?TABLE ${table}\\b`));
    }
    for (const index of REQUIRED_INDEXES) {
      assert.match(dumped, new RegExp(`CREATE (UNIQUE )?INDEX ${index}\\b`));
    }
    for (const trigger of REQUIRED_TRIGGERS) {
      assert.match(dumped, new RegExp(`CREATE TRIGGER ${trigger}\\b`));
    }
  } finally {
    rmSync(tsRoot, { recursive: true, force: true });
  }
});

test("TypeScript initialization refuses newer user_version", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-newer-db."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      assert.throws(
        () => initializeDatabaseSync(database),
        /newer than workerctl supports/,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript initialization migrates legacy schema without Python", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-legacy-no-python."));
  const originalPath = process.env.PATH;
  try {
    const dbPath = join(root, "workerctl.db");
    const legacyDatabase = new DatabaseSync(dbPath);
    try {
      legacyDatabase.exec(`
        create table commands(
          id text primary key,
          idempotency_key text unique not null,
          created_at text not null,
          updated_at text not null,
          task_id text,
          worker_id text,
          manager_id text,
          correlation_id text,
          type text not null,
          state text not null check (state in ('pending','attempted','succeeded','failed')),
          available_at text,
          claimed_by text,
          claimed_at text,
          claim_expires_at text,
          attempts integer not null default 0 check (attempts >= 0),
          max_attempts integer not null default 1 check (max_attempts > 0),
          required_permission text,
          payload_json text not null check (json_valid(payload_json)),
          result_json text check (result_json is null or json_valid(result_json)),
          error text
        );
        create table command_attempts(
          id integer primary key autoincrement,
          command_id text not null references commands(id),
          correlation_id text not null,
          dispatcher_id text not null,
          started_at text not null,
          finished_at text,
          state text not null check (state in ('running','succeeded','failed','abandoned')),
          result_json text check (result_json is null or json_valid(result_json)),
          error text,
          side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
          side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1))
        );
        create table manager_configs(
          task_id text primary key,
          supervision_mode text not null check (supervision_mode in ('light','guided','strict')),
          objective text,
          guidelines_json text not null check (json_valid(guidelines_json)),
          acceptance_criteria_json text not null check (json_valid(acceptance_criteria_json)),
          reference_paths_json text not null check (json_valid(reference_paths_json)),
          permissions_json text not null check (json_valid(permissions_json)),
          tools_json text not null default '[]' check (json_valid(tools_json)),
          epilogues_json text not null default '[]' check (json_valid(epilogues_json)),
          nudge_on_completion text not null default 'ask-operator' check (nudge_on_completion in ('off','ask-operator','auto-review','auto-proceed')),
          require_acks integer not null default 0 check (require_acks in (0, 1)),
          revision integer not null default 1 check (revision > 0),
          created_at text not null,
          updated_at text not null
        );
        create table sessions(
          id text primary key,
          name text unique not null,
          role text not null check (role in ('worker','manager','operator','dispatch')),
          pid integer,
          cwd text,
          tmux_session text,
          tmux_pane_id text,
          state text not null check (state in ('active','gone','unknown')),
          created_at text not null,
          updated_at text not null,
          last_seen_at text,
          gone_at text,
          exit_reason text,
          metadata_json text not null default '{}' check (json_valid(metadata_json)),
          last_ingest_offset integer
        );
        pragma user_version = 21;
      `);
    } finally {
      legacyDatabase.close();
    }

    process.env.PATH = "/tmp/agent-conveyor-no-python";
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      assert.equal(databaseHealthSync(database).ok, true);

      database.prepare(`
        insert into commands(
          id, idempotency_key, created_at, updated_at, type, state, payload_json
        )
        values ('cmd-blocked', 'cmd-blocked', '2026-05-08T10:00:00Z',
                '2026-05-08T10:00:00Z', 'notify_manager', 'blocked', '{}')
      `).run();

      database.prepare(`
        insert into command_attempts(
          command_id, correlation_id, dispatcher_id, started_at, state
        )
        values ('cmd-blocked', 'corr-blocked', 'dispatch-a',
                '2026-05-08T10:00:00Z', 'blocked')
      `).run();

      const managerConfigColumns = tableColumns(database, "manager_configs");
      const sessionColumns = tableColumns(database, "sessions");
      assert.equal(managerConfigColumns.has("recipe_name"), true);
      assert.equal(sessionColumns.has("codex_app_thread_id"), true);
      assert.equal(sessionColumns.has("codex_app_thread_title"), true);
    } finally {
      database.close();
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

function schemaDump(dbPath: string): string[] {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = database.prepare(`
      select type, name, sql
      from sqlite_master
      where sql is not null
        and name not like 'sqlite_%'
        and name not like 'telemetry_events_fts_%'
      order by case type when 'table' then 0 when 'index' then 1 when 'trigger' then 2 else 3 end, name
    `).all() as Array<{ sql: string }>;
    return rows.map((row) => row.sql.trim().replaceAll(/\\s+/g, " "));
  } finally {
    database.close();
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
