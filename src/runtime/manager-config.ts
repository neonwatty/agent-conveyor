import { DatabaseSync } from "node:sqlite";

import { managerPermissionAllowed, normalizeManagerPermissions } from "./manager-permissions.js";
import type { ManagerPermissions } from "./manager-permissions.js";

export interface ManagerConfigRecord {
  acceptance_criteria: string[];
  created_at: string;
  epilogues: string[];
  guidelines: string[];
  nudge_on_completion: string;
  objective: string | null;
  permissions: ManagerPermissions;
  reference_paths: string[];
  require_acks: boolean;
  revision: number;
  supervision_mode: string;
  task_id: string;
  tools: string[];
  updated_at: string;
}

export function managerConfigSync(database: DatabaseSync, taskId: string): ManagerConfigRecord | null {
  const row = database.prepare(`
    select task_id, supervision_mode, objective, guidelines_json,
           acceptance_criteria_json, reference_paths_json, permissions_json,
           tools_json, epilogues_json, nudge_on_completion, require_acks,
           revision, created_at, updated_at
    from manager_configs
    where task_id = ?
  `).get(taskId) as ManagerConfigRow | undefined;
  if (!row) {
    return null;
  }
  return {
    acceptance_criteria: JSON.parse(row.acceptance_criteria_json),
    created_at: row.created_at,
    epilogues: JSON.parse(row.epilogues_json),
    guidelines: JSON.parse(row.guidelines_json),
    nudge_on_completion: row.nudge_on_completion,
    objective: row.objective,
    permissions: normalizeManagerPermissions(JSON.parse(row.permissions_json)),
    reference_paths: JSON.parse(row.reference_paths_json),
    require_acks: Boolean(row.require_acks),
    revision: row.revision,
    supervision_mode: row.supervision_mode,
    task_id: row.task_id,
    tools: JSON.parse(row.tools_json),
    updated_at: row.updated_at,
  };
}

export function managerConfigPermissionAllowed(config: ManagerConfigRecord | null, action: string): boolean {
  return config !== null && managerPermissionAllowed(config.permissions, action);
}

interface ManagerConfigRow {
  acceptance_criteria_json: string;
  created_at: string;
  epilogues_json: string;
  guidelines_json: string;
  nudge_on_completion: string;
  objective: string | null;
  permissions_json: string;
  reference_paths_json: string;
  require_acks: number;
  revision: number;
  supervision_mode: string;
  task_id: string;
  tools_json: string;
  updated_at: string;
}
