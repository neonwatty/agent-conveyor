import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { defaultDbPath, loadJsonSync, statusPath } from "./files.js";

export interface WorkerStatus {
  blocker?: string | null;
  current_task?: string;
  last_update?: string;
  next_action?: string;
  state?: string;
}

interface StatusRow {
  blocker: string | null;
  created_at: string;
  current_task: string | null;
  next_action: string | null;
  state: string;
}

export function latestStatusSync(
  name: string,
  options: { cwd?: string; dbPath?: string; env?: NodeJS.ProcessEnv } = {},
): WorkerStatus {
  const fallback = loadJsonSync<WorkerStatus>(statusPath(name, options), {});
  const dbPath = options.dbPath ?? defaultDbPath(options);
  if (!existsSync(dbPath)) {
    return fallback;
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const row = database.prepare(`
      select statuses.state, statuses.current_task, statuses.next_action,
             statuses.blocker, statuses.created_at
      from statuses
      join workers on workers.id = statuses.worker_id
      where workers.name = ?
      order by statuses.id desc
      limit 1
    `).get(name) as StatusRow | undefined;

    if (!row) {
      return fallback;
    }
    return {
      blocker: row.blocker,
      current_task: row.current_task ?? undefined,
      last_update: row.created_at,
      next_action: row.next_action ?? undefined,
      state: row.state,
    };
  } catch {
    return fallback;
  } finally {
    database?.close();
  }
}
