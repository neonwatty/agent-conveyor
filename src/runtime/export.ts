import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { taskAuditSync } from "./audit.js";
import type { TaskAuditResult } from "./audit.js";

export interface TaskExportManifest {
  created_at: string;
  files: string[];
  task: {
    id: string;
    name: string;
  };
}

export interface TaskExportResult {
  export_dir: string;
  manifest: TaskExportManifest;
  task: string;
}

export class TaskExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExportError";
  }
}

export function exportTaskAuditSubsetSync(
  database: DatabaseSync,
  options: {
    now?: string;
    outputDir: string;
    task: string;
  },
): TaskExportResult {
  const audit = taskAuditSync(database, options.task);
  const exportDir = resolve(options.outputDir);
  mkdirSync(exportDir, { recursive: true });
  const files = [
    "task-status.json",
    "audit.json",
    "acceptance-criteria.json",
    "commands.json",
    "command-attempts.json",
    "routed-notifications.json",
    "manager-decisions.json",
    "correlation-chains.json",
  ];
  const payloads: Record<string, unknown> = {
    "acceptance-criteria.json": audit.acceptance_criteria,
    "audit.json": audit,
    "command-attempts.json": audit.command_attempts,
    "commands.json": audit.commands,
    "correlation-chains.json": audit.correlation_chains,
    "manager-decisions.json": audit.manager_decisions,
    "routed-notifications.json": audit.routed_notifications,
    "task-status.json": taskStatusPayload(audit),
  };
  for (const file of files) {
    writeJson(`${exportDir}/${file}`, payloads[file]);
  }
  const manifest = {
    created_at: options.now ?? new Date().toISOString(),
    files,
    task: {
      id: audit.task.id,
      name: audit.task.name,
    },
  };
  writeJson(`${exportDir}/manifest.json`, manifest);
  return {
    export_dir: exportDir,
    manifest,
    task: audit.task.name,
  };
}

function taskStatusPayload(audit: TaskAuditResult): Record<string, unknown> {
  return {
    created_at: audit.task.created_at,
    goal: audit.task.goal,
    id: audit.task.id,
    name: audit.task.name,
    state: audit.task.state,
    summary: audit.task.summary,
    updated_at: audit.task.updated_at,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(sortJson(value), null, 2)}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
