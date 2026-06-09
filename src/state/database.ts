import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultDbPath } from "./files.js";
import {
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  REQUIRED_TRIGGERS,
  SCHEMA_VERSION,
} from "./sqlite-contract.js";
import { SCHEMA_V23_SQL } from "./schema-v23.js";

export interface DatabaseCheck {
  name: string;
  ok: boolean;
  value?: number | string | null;
  missing?: string[];
  violations?: unknown[];
}

export interface DatabaseHealth {
  checks: DatabaseCheck[];
  ok: boolean;
  schema_version: number | null;
  user_version: number;
}

export class WorkerctlDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerctlDatabaseError";
  }
}

export function openDatabaseSync(path = defaultDbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  configureConnectionSync(database);
  return database;
}

export function configureConnectionSync(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  const foreignKeys = pragmaNumber(database, "foreign_keys");
  if (foreignKeys !== 1) {
    throw new WorkerctlDatabaseError("SQLite foreign key enforcement is not enabled");
  }
}

export function initializeDatabaseSync(database: DatabaseSync): void {
  const userVersion = pragmaNumber(database, "user_version");
  if (userVersion > SCHEMA_VERSION) {
    throw new WorkerctlDatabaseError(
      `Database schema version ${userVersion} is newer than workerctl supports (${SCHEMA_VERSION})`,
    );
  }
  if (userVersion === SCHEMA_VERSION) {
    return;
  }
  if (userVersion !== 0 || hasUserTables(database)) {
    migrateLegacySchemaSync(database, userVersion);
    return;
  }

  database.exec(SCHEMA_V23_SQL);
  const now = new Date().toISOString();
  database.prepare(
    "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
  ).run(SCHEMA_VERSION, now);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function migrateLegacySchemaSync(database: DatabaseSync, userVersion: number): void {
  if (!databasePath(database)) {
    throw new WorkerctlDatabaseError(
      `Migrating existing schema version ${userVersion} requires a file-backed database`,
    );
  }

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    migrateCommandsBlockedStateSync(database);
    migrateCommandAttemptsBlockedStateSync(database);
    database.exec(idempotentSchemaSql());
    addColumnIfMissing(database, "manager_configs", "recipe_name", "text");
    addColumnIfMissing(database, "sessions", "codex_app_thread_id", "text");
    addColumnIfMissing(database, "sessions", "codex_app_thread_title", "text");
    database.prepare(
      "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
    ).run(SCHEMA_VERSION, new Date().toISOString());
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }

  if (pragmaNumber(database, "foreign_keys") !== 1) {
    throw new WorkerctlDatabaseError("SQLite foreign key enforcement is not enabled after legacy migration");
  }
}

function migrateCommandsBlockedStateSync(database: DatabaseSync): void {
  if (!hasTable(database, "commands") || tableSql(database, "commands").includes("'blocked'")) {
    return;
  }
  const columns = tableColumns(database, "commands");
  database.exec(`
    create table commands_v22(
      id text primary key,
      idempotency_key text unique not null,
      created_at text not null,
      updated_at text not null,
      task_id text references tasks(id),
      worker_id text references workers(id),
      manager_id text references managers(id),
      correlation_id text,
      type text not null,
      state text not null check (state in ('pending','attempted','succeeded','failed','blocked')),
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

    insert into commands_v22(
      id, idempotency_key, created_at, updated_at, task_id, worker_id,
      manager_id, correlation_id, type, state, available_at, claimed_by,
      claimed_at, claim_expires_at, attempts, max_attempts,
      required_permission, payload_json, result_json, error
    )
    select
      ${selectColumnOrDefault(columns, "id", "lower(hex(randomblob(16)))")},
      ${selectColumnOrDefault(columns, "idempotency_key", "lower(hex(randomblob(16)))")},
      ${selectColumnOrDefault(columns, "created_at", "datetime('now')")},
      ${selectColumnOrDefault(columns, "updated_at", "datetime('now')")},
      ${selectColumnOrDefault(columns, "task_id", "null")},
      ${selectColumnOrDefault(columns, "worker_id", "null")},
      ${selectColumnOrDefault(columns, "manager_id", "null")},
      ${selectColumnOrDefault(columns, "correlation_id", "null")},
      ${selectColumnOrDefault(columns, "type", "'notify_manager'")},
      ${selectColumnOrDefault(columns, "state", "'pending'")},
      ${selectColumnOrDefault(columns, "available_at", "null")},
      ${selectColumnOrDefault(columns, "claimed_by", "null")},
      ${selectColumnOrDefault(columns, "claimed_at", "null")},
      ${selectColumnOrDefault(columns, "claim_expires_at", "null")},
      ${selectColumnOrDefault(columns, "attempts", "0")},
      ${selectColumnOrDefault(columns, "max_attempts", "1")},
      ${selectColumnOrDefault(columns, "required_permission", "null")},
      ${selectColumnOrDefault(columns, "payload_json", "'{}'")},
      ${selectColumnOrDefault(columns, "result_json", "null")},
      ${selectColumnOrDefault(columns, "error", "null")}
    from commands;

    drop table commands;
    alter table commands_v22 rename to commands;
  `);
}

function migrateCommandAttemptsBlockedStateSync(database: DatabaseSync): void {
  if (!hasTable(database, "command_attempts") || tableSql(database, "command_attempts").includes("'blocked'")) {
    return;
  }
  const columns = tableColumns(database, "command_attempts");
  database.exec(`
    create table command_attempts_v22(
      id integer primary key autoincrement,
      command_id text not null references commands(id),
      correlation_id text not null,
      dispatcher_id text not null,
      started_at text not null,
      finished_at text,
      state text not null check (state in ('running','succeeded','failed','abandoned','blocked')),
      result_json text check (result_json is null or json_valid(result_json)),
      error text,
      side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
      side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1))
    );

    insert into command_attempts_v22(
      id, command_id, correlation_id, dispatcher_id, started_at,
      finished_at, state, result_json, error, side_effect_started,
      side_effect_completed
    )
    select
      ${selectColumnOrDefault(columns, "id", "null")},
      ${selectColumnOrDefault(columns, "command_id", "''")},
      ${selectColumnOrDefault(columns, "correlation_id", "lower(hex(randomblob(16)))")},
      ${selectColumnOrDefault(columns, "dispatcher_id", "'legacy-migration'")},
      ${selectColumnOrDefault(columns, "started_at", "datetime('now')")},
      ${selectColumnOrDefault(columns, "finished_at", "null")},
      ${selectColumnOrDefault(columns, "state", "'running'")},
      ${selectColumnOrDefault(columns, "result_json", "null")},
      ${selectColumnOrDefault(columns, "error", "null")},
      ${selectColumnOrDefault(columns, "side_effect_started", "0")},
      ${selectColumnOrDefault(columns, "side_effect_completed", "0")}
    from command_attempts;

    drop table command_attempts;
    alter table command_attempts_v22 rename to command_attempts;
  `);
}

export function databaseHealthSync(database: DatabaseSync): DatabaseHealth {
  const foreignKeys = pragmaNumber(database, "foreign_keys");
  const journalMode = pragmaValue(database, "journal_mode");
  const busyTimeout = pragmaNumber(database, "busy_timeout");
  const userVersion = pragmaNumber(database, "user_version");
  const schemaVersion = database
    .prepare("select max(version) as version from schema_migrations")
    .get() as { version: number | null };

  const tables = schemaNames(database, "table");
  const indexes = schemaNames(database, "index");
  const triggers = schemaNames(database, "trigger");
  const violations = database.prepare(`
    select "table", rowid, parent, fkid
    from pragma_foreign_key_check
  `).all();

  const checks: DatabaseCheck[] = [
    { name: "foreign_keys", ok: foreignKeys === 1, value: foreignKeys },
    { name: "journal_mode_wal", ok: String(journalMode).toLowerCase() === "wal", value: journalMode },
    { name: "busy_timeout", ok: busyTimeout >= 5000, value: busyTimeout },
    { name: "schema_version", ok: schemaVersion.version === SCHEMA_VERSION, value: schemaVersion.version },
    { name: "user_version", ok: userVersion === SCHEMA_VERSION, value: userVersion },
    { name: "required_tables", ok: isSubset(REQUIRED_TABLES, tables), missing: missing(REQUIRED_TABLES, tables) },
    { name: "required_indexes", ok: isSubset(REQUIRED_INDEXES, indexes), missing: missing(REQUIRED_INDEXES, indexes) },
    { name: "required_triggers", ok: isSubset(REQUIRED_TRIGGERS, triggers), missing: missing(REQUIRED_TRIGGERS, triggers) },
    { name: "foreign_key_check", ok: violations.length === 0, violations },
  ];

  return {
    checks,
    ok: checks.every((check) => check.ok),
    schema_version: schemaVersion.version,
    user_version: userVersion,
  };
}

function hasUserTables(database: DatabaseSync): boolean {
  const row = database.prepare(`
    select count(*) as count
    from sqlite_master
    where type = 'table'
      and name not like 'sqlite_%'
  `).get() as { count: number };
  return row.count > 0;
}

function idempotentSchemaSql(): string {
  return SCHEMA_V23_SQL
    .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
    .replaceAll("CREATE VIRTUAL TABLE ", "CREATE VIRTUAL TABLE IF NOT EXISTS ")
    .replaceAll("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replaceAll("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")
    .replaceAll("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ");
}

function hasTable(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(`
    select count(*) as count
    from sqlite_master
    where type = 'table'
      and name = ?
  `).get(table) as { count: number };
  return row.count > 0;
}

function tableSql(database: DatabaseSync, table: string): string {
  const row = database.prepare(`
    select sql
    from sqlite_master
    where type = 'table'
      and name = ?
  `).get(table) as { sql?: string } | undefined;
  return row?.sql ?? "";
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasTable(database, table) || tableColumns(database, table).has(column)) {
    return;
  }
  database.exec(`alter table ${table} add column ${column} ${definition}`);
}

function selectColumnOrDefault(columns: Set<string>, column: string, fallbackSql: string): string {
  return columns.has(column) ? column : fallbackSql;
}

function schemaNames(database: DatabaseSync, type: "index" | "table" | "trigger"): Set<string> {
  const rows = database.prepare(`
    select name
    from sqlite_master
    where type = ?
      and name not like 'sqlite_%'
  `).all(type) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function databasePath(database: DatabaseSync): string | null {
  const row = database.prepare("PRAGMA database_list").get() as { file?: string };
  return row.file || null;
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const value = pragmaValue(database, name);
  return Number(value);
}

function pragmaValue(database: DatabaseSync, name: string): number | string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, number | string>;
  return Object.values(row)[0];
}

function missing(required: Set<string>, actual: Set<string>): string[] {
  return [...required].filter((value) => !actual.has(value)).sort();
}

function isSubset(required: Set<string>, actual: Set<string>): boolean {
  return missing(required, actual).length === 0;
}
