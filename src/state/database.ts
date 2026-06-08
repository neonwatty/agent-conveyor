import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    delegateLegacyMigrationToPython(database, userVersion);
    return;
  }

  database.exec(SCHEMA_V23_SQL);
  const now = new Date().toISOString();
  database.prepare(
    "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
  ).run(SCHEMA_VERSION, now);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function delegateLegacyMigrationToPython(database: DatabaseSync, userVersion: number): void {
  const path = databasePath(database);
  if (!path) {
    throw new WorkerctlDatabaseError(
      `Migrating existing schema version ${userVersion} requires a file-backed database`,
    );
  }

  const script = `
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(path)}))
try:
    db.initialize_database(conn)
finally:
    conn.close()
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown migration error").trim();
    throw new WorkerctlDatabaseError(`Python legacy migration failed: ${detail}`);
  }

  const migratedVersion = pragmaNumber(database, "user_version");
  if (migratedVersion !== SCHEMA_VERSION) {
    throw new WorkerctlDatabaseError(
      `Python legacy migration left schema version ${migratedVersion}; expected ${SCHEMA_VERSION}`,
    );
  }
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
