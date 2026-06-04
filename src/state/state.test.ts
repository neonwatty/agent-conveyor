import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

test("state paths mirror the Python compatibility layout", () => {
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

test("worker name validation matches the Python allowed character set", () => {
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

test("latest status reads Python-created sqlite before stale status.json", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-status-sqlite."));
  try {
    writeJsonSync(statusPath("worker-a", { env: { WORKERCTL_STATE_ROOT: root } }), {
      blocker: null,
      current_task: "json task",
      last_update: "2026-05-08T09:00:00Z",
      next_action: "json next",
      state: "waiting",
    });
    const script = `
from workerctl import db
with db.connect() as conn:
    db.initialize_database(conn)
    worker_id = db.upsert_worker(
        conn,
        name="worker-a",
        cwd="/repo",
        tmux_session="codex-worker-a",
        state="active",
        identity_token="worker-token-a",
    )
    db.insert_status(
        conn,
        worker_id=worker_id,
        status={
            "blocker": "db blocker",
            "current_task": "db task",
            "next_action": "db next",
            "state": "blocked",
        },
        timestamp="2026-05-08T10:00:00Z",
    )
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      env: { ...process.env, WORKERCTL_STATE_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

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

test("sqlite schema contract constants match Python db contract constants", () => {
  const script = `
import json
from workerctl import db
print(json.dumps({
    "schema_version": db.SCHEMA_VERSION,
    "required_tables": sorted(db.REQUIRED_TABLES),
    "required_indexes": sorted(db.REQUIRED_INDEXES),
    "required_triggers": sorted(db.REQUIRED_TRIGGERS),
}, sort_keys=True))
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const pythonContract = JSON.parse(result.stdout) as {
    required_indexes: string[];
    required_tables: string[];
    required_triggers: string[];
    schema_version: number;
  };

  assert.equal(SCHEMA_VERSION, pythonContract.schema_version);
  assert.deepEqual([...REQUIRED_TABLES].sort(), pythonContract.required_tables);
  assert.deepEqual([...REQUIRED_INDEXES].sort(), pythonContract.required_indexes);
  assert.deepEqual([...REQUIRED_TRIGGERS].sort(), pythonContract.required_triggers);
});

test("TypeScript database initialization is healthy under Python database_health", () => {
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

    const script = `
import json
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    db.initialize_database(conn)
    print(json.dumps(db.database_health(conn), sort_keys=True))
finally:
    conn.close()
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const pythonHealth = JSON.parse(result.stdout) as { ok: boolean; schema_version: number; user_version: number };
    assert.equal(pythonHealth.ok, true);
    assert.equal(pythonHealth.schema_version, SCHEMA_VERSION);
    assert.equal(pythonHealth.user_version, SCHEMA_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript-created and Python-created empty schema dumps match", () => {
  const tsRoot = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-schema."));
  const pyRoot = mkdtempSync(join(tmpdir(), "agent-conveyor-py-schema."));
  try {
    const tsDbPath = join(tsRoot, "workerctl.db");
    const tsDb = openDatabaseSync(tsDbPath);
    try {
      initializeDatabaseSync(tsDb);
    } finally {
      tsDb.close();
    }

    const script = `
from pathlib import Path
from workerctl import db
with db.connect(Path(${JSON.stringify(join(pyRoot, "workerctl.db"))})) as conn:
    db.initialize_database(conn)
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    assert.deepEqual(schemaDump(tsDbPath), schemaDump(join(pyRoot, "workerctl.db")));
  } finally {
    rmSync(tsRoot, { recursive: true, force: true });
    rmSync(pyRoot, { recursive: true, force: true });
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

test("TypeScript initialization delegates legacy schema repair to Python migrator", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-legacy-db."));
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
        pragma user_version = 21;
      `);
    } finally {
      legacyDatabase.close();
    }

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
    } finally {
      database.close();
    }

    const script = `
import json
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    db.initialize_database(conn)
    print(json.dumps(db.database_health(conn), sort_keys=True))
finally:
    conn.close()
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
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
