export type ManagerPermissionCategory = "communication" | "context" | "repo" | "verification" | "worker_session";

export type ManagerPermissions = Record<ManagerPermissionCategory, string[]>;

const MANAGER_PERMISSION_TAXONOMY: Record<ManagerPermissionCategory, Set<string>> = {
  communication: new Set(["comment_on_pr", "notify_operator"]),
  context: new Set(["spawn_reviewer", "fetch_prs", "fetch_issues"]),
  repo: new Set(["merge_green_pr", "monitor_ci", "open_pr", "push_branch", "resolve_conflicts"]),
  verification: new Set(["run_playwright", "run_xcodebuild", "run_pytest", "run_cargo"]),
  worker_session: new Set(["compact", "clear", "interrupt", "stop"]),
};

const MANAGER_PERMISSION_ALIASES = new Map<string, string | string[]>([
  ["allow_pr", "repo.open_pr"],
  ["create_pr", "repo.open_pr"],
  ["allow_merge_green", "repo.merge_green_pr"],
  ["merge_green_pr", "repo.merge_green_pr"],
  ["allow_worker_compact_clear", ["worker_session.compact", "worker_session.clear"]],
  ["worker_compact_clear", ["worker_session.compact", "worker_session.clear"]],
]);

const MANAGER_PERMISSION_ACTIONS = new Set(
  Object.entries(MANAGER_PERMISSION_TAXONOMY).flatMap(([category, actions]) => (
    Array.from(actions).map((action) => `${category}.${action}`)
  )),
);

function emptyManagerPermissions(): ManagerPermissions {
  return {
    communication: [],
    context: [],
    repo: [],
    verification: [],
    worker_session: [],
  };
}

export function canonicalManagerPermissionNames(name: string): string[] {
  const alias = MANAGER_PERMISSION_ALIASES.get(name) ?? name;
  return Array.isArray(alias) ? alias : [alias];
}

export function normalizeManagerPermissions(permissions: Record<string, unknown> | null | undefined): ManagerPermissions {
  const normalized = emptyManagerPermissions();
  for (const [key, value] of Object.entries(permissions ?? {})) {
    if (isManagerPermissionCategory(key) && Array.isArray(value)) {
      for (const action of value) {
        if (typeof action === "string" && MANAGER_PERMISSION_TAXONOMY[key].has(action)) {
          grantManagerPermission(normalized, `${key}.${action}`);
        }
      }
      continue;
    }
    if (value) {
      grantManagerPermission(normalized, key);
    }
  }
  return normalized;
}

export function flattenManagerPermissions(permissions: Record<string, unknown> | null | undefined): string[] {
  const normalized = normalizeManagerPermissions(permissions);
  return Object.entries(normalized).flatMap(([category, actions]) => actions.map((action) => `${category}.${action}`));
}

export function managerPermissionAllowed(permissions: Record<string, unknown> | null | undefined, action: string): boolean {
  const flattened = new Set(flattenManagerPermissions(permissions));
  return canonicalManagerPermissionNames(action).every((permission) => flattened.has(permission));
}

export function validateRequiredPermission(requiredPermission: string | null): string | null {
  if (requiredPermission === null) {
    return null;
  }
  const permission = requiredPermission.trim();
  if (!permission) {
    throw new Error("required_permission must be non-empty when provided");
  }
  const unknown = canonicalManagerPermissionNames(permission).filter((item) => !MANAGER_PERMISSION_ACTIONS.has(item));
  if (unknown.length > 0) {
    throw new Error(`unknown required_permission: ${requiredPermission}`);
  }
  return permission;
}

function isManagerPermissionCategory(value: string): value is ManagerPermissionCategory {
  return Object.prototype.hasOwnProperty.call(MANAGER_PERMISSION_TAXONOMY, value);
}

function grantManagerPermission(normalized: ManagerPermissions, name: string): void {
  for (const canonical of canonicalManagerPermissionNames(name)) {
    const [category, action] = canonical.split(".", 2);
    if (!isManagerPermissionCategory(category) || !action || !MANAGER_PERMISSION_TAXONOMY[category].has(action)) {
      continue;
    }
    const bucket = normalized[category];
    if (!bucket.includes(action)) {
      bucket.push(action);
      bucket.sort();
    }
  }
}
