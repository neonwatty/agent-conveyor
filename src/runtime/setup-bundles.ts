import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
    optional_skills: string[];
    required: boolean;
    required_skills: string[];
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
  checked_skills: string[];
  missing_optional: string[];
  missing_required: string[];
  ok: boolean;
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

const LOOP_PRESET_REQUIRED_EVIDENCE = new Map<string, string[]>([
  ["ship_it_loop", ["branch_ready", "branch_pushed", "pr_url", "ci_green", "mergeability_clean", "manager_merge_decision", "merge", "post_merge_verification", "adversarial_check"]],
  ["test_coverage_loop", ["test_coverage", "adversarial_check"]],
  ["visual_diff_loop", ["reference_artifact", "candidate_screenshot", "visual_diff_report", "diff_below_threshold", "adversarial_check"]],
  ["pr_ci_merge_loop", ["pr_url", "ci_green", "merge", "adversarial_check"]],
]);

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
  const loopPreset = options.loopBackend === "none"
    ? null
    : (options.loopPreset
      ?? (shipIt ? "ship_it_loop" : testCoverage ? "test_coverage_loop" : uxPolish ? "visual_diff_loop" : prCiMerge ? "pr_ci_merge_loop" : null));
  const requiredEvidence = requiredEvidenceForLoopPreset(loopPreset);
  const planningRequired = options.planningRequired ?? shipIt;
  const planningBackend = options.planningBackend ?? (shipIt ? "goalbuddy" : "codex_goal");
  const prReviewBackend = options.prReviewBackend ?? ((options.prReviewRequired ?? shipIt) ? (shipIt ? "composite" : "codex_review") : "off");
  const prReviewRequired = prReviewBackend === "off" ? false : options.prReviewRequired ?? shipIt;
  const defaultReviewSkills = prReviewRequired ? prReviewBackendRequiredSkills(prReviewBackend) : [];
  const reviewGateEnabled = prReviewRequired && prReviewBackend !== "off";
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
        backend: reviewGateEnabled ? "inherit" : "off",
        gate: reviewGateEnabled ? "block_merge_until_review_receipts" : "none",
        role: reviewGateEnabled ? "gatekeeper" : "none",
      },
      tools: shipIt || prCiMerge
        ? ["gh", "git", "verification.run_pytest", "context.fetch_prs"]
        : testCoverage
          ? ["verification.run_pytest"]
          : uxPolish ? ["verification.run_playwright"] : [],
    },
    planning: {
      backend: planningBackend,
      required: planningRequired,
      required_skills: planningRequired ? planningBackendRequiredSkills(planningBackend) : [],
    },
    pr_review: {
      backend: prReviewBackend,
      optional_skills: uniqueStrings(options.optionalSkills ?? ["security-diff-scan"]),
      required: prReviewRequired,
      required_skills: uniqueStringsPreservingOrder([...defaultReviewSkills, ...(options.requiredSkills ?? [])]),
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
          backend: reviewGateEnabled ? "inherit" : "off",
          required_before_handoff: reviewGateEnabled,
        },
        role: "implementer",
        sandbox: "workspace-write",
      }],
    },
  };
}

function requiredEvidenceForLoopPreset(loopPreset: string | null): string[] {
  if (loopPreset === null) {
    return [];
  }
  const requiredEvidence = LOOP_PRESET_REQUIRED_EVIDENCE.get(loopPreset);
  if (requiredEvidence === undefined) {
    throw new Error(`Unknown loop preset: ${loopPreset}`);
  }
  return [...requiredEvidence];
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
  const name = options.name ?? `${options.taskId}-${options.policy.preset}-${id.slice("setup-".length, "setup-".length + 8)}`;
  const draftHash = setupBundleHash(options.policy);
  const blocked = !options.approve || !preflight.ok;
  const state: SetupBundleState = blocked ? "blocked" : "applied";
  const approvedHash = blocked ? null : draftHash;
  const blockedReason = !options.approve
    ? "missing approval"
    : !preflight.ok ? `missing required backend: ${preflight.missing_required.join(", ")}` : null;
  const approvalJson = { approved: options.approve, source: "setup-bundle apply" };
  database.exec("begin immediate");
  try {
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
    database.exec("commit");
    return { blocked, missing_required: preflight.missing_required, record };
  } catch (error) {
    database.exec("rollback");
    throw error;
  }
}

export function setupBundleForTaskSync(database: DatabaseSync, taskId: string): SetupBundleRecord | null {
  const row = database.prepare(`
    select id, task_id, name, preset, state, draft_hash, approved_hash,
           policy_json, preflight_json, approval_json, applied_json,
           blocked_reason, created_at, updated_at, approved_at, applied_at
    from setup_bundles
    where task_id = ?
    order by updated_at desc, rowid desc
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

function applyBundleDerivedRecords(database: DatabaseSync, options: {
  now: string;
  policy: SetupBundlePolicy;
  setupBundleId: string;
  taskId: string;
}): Record<string, unknown> {
  const permissions = normalizeManagerPermissions(Object.fromEntries(options.policy.manager.permissions.map((permission) => [permission, true])));
  const acceptanceCriteriaSeeded = seedSetupBundleAcceptanceCriteria(database, {
    criteria: options.policy.evidence.acceptance_criteria,
    now: options.now,
    preset: options.policy.preset,
    setupBundleId: options.setupBundleId,
    taskId: options.taskId,
  });
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
    acceptance_criteria_seeded: acceptanceCriteriaSeeded,
    manager_config: true,
    setup_bundle_id: options.setupBundleId,
  };
}

function seedSetupBundleAcceptanceCriteria(database: DatabaseSync, options: {
  criteria: string[];
  now: string;
  preset: string;
  setupBundleId: string;
  taskId: string;
}): number {
  const insert = database.prepare(`
    insert into acceptance_criteria(
      task_id, criterion, status, source, proof, rationale,
      evidence_json, created_at, updated_at
    )
    values (?, ?, 'accepted', 'manager_inferred', null, ?, ?, ?, ?)
  `);
  const seen = new Set<string>();
  let seeded = 0;
  for (const raw of options.criteria) {
    const criterion = raw.trim();
    if (criterion.length === 0 || seen.has(criterion)) {
      continue;
    }
    seen.add(criterion);
    const existing = database.prepare(`
      select id
      from acceptance_criteria
      where task_id = ? and criterion = ?
      limit 1
    `).get(options.taskId, criterion) as { id: number } | undefined;
    if (existing) {
      continue;
    }
    const result = insert.run(
      options.taskId,
      criterion,
      "Seeded from setup bundle evidence policy.",
      stableJson({
        preset: options.preset,
        setup_bundle_id: options.setupBundleId,
        source: "setup_bundle",
      }),
      options.now,
      options.now,
    );
    seeded += Number(result.changes ?? 0);
  }
  return seeded;
}

function skillAvailable(skill: string, codexHome: string | null): boolean {
  if (codexHome === null) {
    return false;
  }
  return skillLookupNames(skill).some((candidate) => {
    const skillsDir = resolve(codexHome, "skills");
    if (skillFileExistsUnder(skillsDir, candidate)) {
      return true;
    }
    return pluginSkillAvailable(candidate, codexHome);
  });
}

function pluginSkillAvailable(skill: string, codexHome: string): boolean {
  const cacheDir = resolve(codexHome, "plugins", "cache");
  if (!existsSync(cacheDir)) {
    return false;
  }
  const pending: Array<{ depth: number; path: string }> = [{ depth: 0, path: cacheDir }];
  const maxDepth = 5;
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      break;
    }
    if (skillFileExistsUnder(resolve(current.path, "skills"), skill)) {
      return true;
    }
    if (current.depth >= maxDepth) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push({ depth: current.depth + 1, path: resolve(current.path, entry.name) });
      }
    }
  }
  return false;
}

function skillFileExistsUnder(skillsDir: string, skill: string): boolean {
  const skillFile = resolve(skillsDir, skill, "SKILL.md");
  const skillRelativePath = relative(skillsDir, skillFile);
  if (!skillRelativePath.startsWith("..")
    && !isAbsolute(skillRelativePath)
    && existsSync(skillFile)) {
    return true;
  }
  return declaredSkillFileExistsUnder(skillsDir, skill);
}

function declaredSkillFileExistsUnder(skillsDir: string, skill: string): boolean {
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillFile = resolve(skillsDir, entry.name, "SKILL.md");
    const skillRelativePath = relative(skillsDir, skillFile);
    if (skillRelativePath.startsWith("..") || isAbsolute(skillRelativePath) || !existsSync(skillFile)) {
      continue;
    }
    if (skillManifestName(skillFile) === skill) {
      return true;
    }
  }
  return false;
}

function skillManifestName(skillFile: string): string | null {
  let contents;
  try {
    contents = readFileSync(skillFile, "utf8");
  } catch {
    return null;
  }
  const frontmatter = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/.exec(contents)?.groups?.body
    ?? contents.split(/\r?\n/).slice(0, 20).join("\n");
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^\s*name\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
    if (name !== null) {
      return name.trim();
    }
  }
  return null;
}

function skillLookupNames(skill: string): string[] {
  const normalized = skill.trim();
  if (validBareSkillName(normalized)) {
    return [normalized];
  }
  const parts = normalized.split(":");
  if (parts.length !== 2 || !validBareSkillName(parts[0]) || !validBareSkillName(parts[1])) {
    return [];
  }
  return [parts[1]];
}

function validBareSkillName(skill: string): boolean {
  return skill.length > 0
    && skill !== "."
    && skill !== ".."
    && !skill.includes(":")
    && !skill.includes("/")
    && !skill.includes("\\");
}

function planningBackendRequiredSkills(backend: PlanningBackend): string[] {
  switch (backend) {
    case "goalbuddy":
      return ["goal-prep"];
    case "codex_goal":
      return ["codex-goal-drafter"];
    case "custom":
    case "direct_prompt":
      return [];
  }
}

function prReviewBackendRequiredSkills(backend: PrReviewBackend): string[] {
  switch (backend) {
    case "codex_review":
      return ["codex-review"];
    case "composite":
      return ["requesting-code-review", "receiving-code-review", "codex-review"];
    case "github":
      return ["gh-address-comments", "gh-fix-ci"];
    case "security":
      return ["security-diff-scan"];
    case "superpowers":
      return ["requesting-code-review", "receiving-code-review"];
    case "custom":
    case "off":
      return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort();
}

function uniqueStringsPreservingOrder(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
