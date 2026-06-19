import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CampaignStatus = "active" | "archived" | "blocked" | "done" | "paused";
export type CampaignWorkerSlotState = "active" | "archived" | "blocked" | "idle" | "planned";
export type CampaignAssignmentStatus = "active" | "blocked" | "cancelled" | "done" | "queued";
export type CampaignAssetStatus = "approved" | "draft" | "needs_review" | "published" | "rejected";
export type CampaignAssetType = "audio" | "copy" | "hyperframes" | "image" | "other" | "video";

export interface CampaignRecord {
  created_at: string;
  id: string;
  metadata: Record<string, unknown>;
  name: string;
  objective: string;
  status: CampaignStatus;
  updated_at: string;
}

export interface CampaignWorkerSlotRecord {
  campaign_id: string;
  channel: string | null;
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  created_at: string;
  id: string;
  metadata: Record<string, unknown>;
  role_label: string;
  session_id: string | null;
  slot_key: string;
  state: CampaignWorkerSlotState;
  updated_at: string;
}

export interface CampaignAssignmentRecord {
  campaign_id: string;
  completed_at: string | null;
  created_at: string;
  id: string;
  instructions: string;
  metadata: Record<string, unknown>;
  slot_id: string;
  status: CampaignAssignmentStatus;
  title: string;
  updated_at: string;
}

export interface CampaignChannelBriefRecord {
  brief: Record<string, unknown>;
  campaign_id: string;
  channel: string;
  created_at: string;
  id: string;
  updated_at: string;
}

export interface CampaignAssetReceiptRecord {
  artifact_path: string | null;
  asset_type: CampaignAssetType;
  assignment_id: string | null;
  campaign_id: string;
  channel: string | null;
  created_at: string;
  id: string;
  metadata: Record<string, unknown>;
  prompt_summary: string | null;
  review_notes: string | null;
  slot_id: string;
  status: CampaignAssetStatus;
  title: string;
}

export interface CampaignStatusRecord {
  asset_counts: Record<CampaignAssetStatus, number>;
  assignment_counts: Record<CampaignAssignmentStatus, number>;
  campaign: CampaignRecord;
  channel_briefs: CampaignChannelBriefRecord[];
  slots: Array<CampaignWorkerSlotRecord & {
    active_assignments: number;
    asset_receipts: number;
  }>;
}

export interface CampaignLedgerReadbackProof {
  campaign_id: string;
  campaign_name: string;
  checked_at: string;
  checks: Array<{
    entity: "assignment" | "brief" | "campaign" | "slot";
    id: string;
    key?: string;
    ok: true;
  }>;
  ok: true;
}

export type CampaignNextManagerAction =
  | "add_worker_slots"
  | "assign_work"
  | "close_campaign"
  | "monitor_workers"
  | "review_assets"
  | "resolve_assignment_blockers"
  | "resolve_worker_blockers"
  | "wake_or_rotate_workers";

export type CampaignSlotLifecycleState =
  | "active"
  | "archived"
  | "blocked"
  | "idle"
  | "needs_session"
  | "needs_thread"
  | "planned"
  | "stale";

export interface CampaignDashboardSlotRecord extends CampaignWorkerSlotRecord {
  active_assignments: number;
  asset_receipts: number;
  assignments: CampaignAssignmentRecord[];
  assets: CampaignAssetReceiptRecord[];
  blockers: string[];
  lifecycle: {
    operator_message: string;
    stale: boolean;
    stale_seconds: number | null;
    state: CampaignSlotLifecycleState;
  };
  session: {
    codex_app_thread_id: string | null;
    codex_app_thread_title: string | null;
    id: string;
    last_heartbeat_at: string | null;
    name: string;
    role: string;
    state: string;
  } | null;
}

export interface CampaignDashboardRecord {
  approvals: {
    approved: number;
    needs_review: number;
    published: number;
    rejected: number;
  };
  asset_counts: Record<CampaignAssetStatus, number>;
  assignment_counts: Record<CampaignAssignmentStatus, number>;
  blockers: string[];
  campaign: CampaignRecord;
  channel_briefs: CampaignChannelBriefRecord[];
  next_manager_action: {
    action: CampaignNextManagerAction;
    reason: string;
  };
  slots: CampaignDashboardSlotRecord[];
  summary: {
    active_slots: number;
    archived_slots: number;
    assignment_total: number;
    asset_total: number;
    blocked_assignments: number;
    blocked_slots: number;
    channel_briefs: number;
    stale_slots: number;
  };
}

export class CampaignStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignStateError";
  }
}

export function createCampaignSync(
  database: DatabaseSync,
  options: {
    campaignId?: string;
    metadata?: Record<string, unknown>;
    name: string;
    now?: string;
    objective: string;
    status?: CampaignStatus;
  },
): string {
  const timestamp = options.now ?? new Date().toISOString();
  const campaignId = options.campaignId ?? `campaign-${randomUUID()}`;
  database.prepare(`
    insert into campaigns(id, name, objective, status, metadata_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    campaignId,
    options.name,
    options.objective,
    options.status ?? "active",
    json(options.metadata),
    timestamp,
    timestamp,
  );
  return campaignId;
}

export function addCampaignWorkerSlotSync(
  database: DatabaseSync,
  options: {
    campaign: string;
    channel?: string | null;
    codexAppThreadId?: string | null;
    codexAppThreadTitle?: string | null;
    metadata?: Record<string, unknown>;
    now?: string;
    roleLabel: string;
    sessionId?: string | null;
    slotId?: string;
    slotKey: string;
    state?: CampaignWorkerSlotState;
  },
): string {
  const campaign = campaignRow(database, options.campaign);
  if (options.sessionId) {
    requireWorkerSession(database, options.sessionId);
  }
  const timestamp = options.now ?? new Date().toISOString();
  const slotId = options.slotId ?? `campaign-slot-${randomUUID()}`;
  database.prepare(`
    insert into campaign_worker_slots(
      id, campaign_id, slot_key, role_label, channel, session_id,
      codex_app_thread_id, codex_app_thread_title, state, metadata_json,
      created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slotId,
    campaign.id,
    options.slotKey,
    options.roleLabel,
    options.channel ?? null,
    options.sessionId ?? null,
    options.codexAppThreadId ?? null,
    options.codexAppThreadTitle ?? null,
    options.state ?? "planned",
    json(options.metadata),
    timestamp,
    timestamp,
  );
  return slotId;
}

export function updateCampaignWorkerSlotLifecycleSync(
  database: DatabaseSync,
  options: {
    campaign: string;
    codexAppThreadId?: string | null;
    codexAppThreadTitle?: string | null;
    expectedThreadId?: string | null;
    metadata?: Record<string, unknown>;
    now?: string;
    sessionId?: string | null;
    slot: string;
    state?: CampaignWorkerSlotState;
  },
): CampaignWorkerSlotRecord {
  const campaign = campaignRow(database, options.campaign);
  const slot = slotRow(database, options.slot);
  requireSameCampaign(campaign.id, slot.campaign_id, "slot");
  if (options.expectedThreadId !== undefined && slot.codex_app_thread_id !== options.expectedThreadId) {
    throw new CampaignStateError("campaign worker slot thread guard does not match");
  }
  if (options.sessionId) {
    requireWorkerSession(database, options.sessionId);
  }
  const timestamp = options.now ?? new Date().toISOString();
  const nextSessionId = options.sessionId !== undefined ? options.sessionId : slot.session_id;
  const nextThreadId = options.codexAppThreadId !== undefined ? options.codexAppThreadId : slot.codex_app_thread_id;
  const nextThreadTitle = options.codexAppThreadTitle !== undefined ? options.codexAppThreadTitle : slot.codex_app_thread_title;
  const nextState = options.state ?? slot.state;
  const nextMetadata = options.metadata ?? parseJson(slot.metadata_json);
  database.prepare(`
    update campaign_worker_slots
    set session_id = ?,
      codex_app_thread_id = ?,
      codex_app_thread_title = ?,
      state = ?,
      metadata_json = ?,
      updated_at = ?
    where id = ?
  `).run(
    nextSessionId,
    nextThreadId,
    nextThreadTitle,
    nextState,
    json(nextMetadata),
    timestamp,
    slot.id,
  );
  return slotRecord(slotRow(database, slot.id));
}

export function upsertCampaignChannelBriefSync(
  database: DatabaseSync,
  options: {
    brief: Record<string, unknown>;
    campaign: string;
    channel: string;
    now?: string;
  },
): string {
  const campaign = campaignRow(database, options.campaign);
  const timestamp = options.now ?? new Date().toISOString();
  const existing = database.prepare(`
    select id
    from campaign_channel_briefs
    where campaign_id = ? and channel = ?
  `).get(campaign.id, options.channel) as { id: string } | undefined;
  const briefId = existing?.id ?? `campaign-brief-${randomUUID()}`;
  database.prepare(`
    insert into campaign_channel_briefs(id, campaign_id, channel, brief_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)
    on conflict(campaign_id, channel) do update set
      brief_json = excluded.brief_json,
      updated_at = excluded.updated_at
  `).run(briefId, campaign.id, options.channel, json(options.brief), timestamp, timestamp);
  return briefId;
}

export function createCampaignAssignmentSync(
  database: DatabaseSync,
  options: {
    campaign: string;
    assignmentId?: string;
    instructions: string;
    metadata?: Record<string, unknown>;
    now?: string;
    slot: string;
    status?: CampaignAssignmentStatus;
    title: string;
  },
): string {
  const campaign = campaignRow(database, options.campaign);
  const slot = slotRow(database, options.slot);
  requireSameCampaign(campaign.id, slot.campaign_id, "slot");
  const timestamp = options.now ?? new Date().toISOString();
  const assignmentId = options.assignmentId ?? `campaign-assignment-${randomUUID()}`;
  database.prepare(`
    insert into campaign_assignments(
      id, campaign_id, slot_id, title, instructions, status, metadata_json,
      created_at, updated_at, completed_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assignmentId,
    campaign.id,
    slot.id,
    options.title,
    options.instructions,
    options.status ?? "queued",
    json(options.metadata),
    timestamp,
    timestamp,
    options.status === "done" ? timestamp : null,
  );
  return assignmentId;
}

export function recordCampaignAssetReceiptSync(
  database: DatabaseSync,
  options: {
    allowAdditionalReceipt?: boolean;
    artifactPath?: string | null;
    assetReceiptId?: string;
    assetType: CampaignAssetType;
    assignment?: string | null;
    campaign: string;
    channel?: string | null;
    metadata?: Record<string, unknown>;
    now?: string;
    promptSummary?: string | null;
    reviewNotes?: string | null;
    slot: string;
    status?: CampaignAssetStatus;
    title: string;
  },
): string {
  const campaign = campaignRow(database, options.campaign);
  const slot = slotRow(database, options.slot);
  requireSameCampaign(campaign.id, slot.campaign_id, "slot");
  if (options.assignment) {
    const assignment = assignmentRow(database, options.assignment);
    requireSameCampaign(campaign.id, assignment.campaign_id, "assignment");
    if (assignment.slot_id !== slot.id) {
      throw new CampaignStateError("assignment does not belong to the provided campaign worker slot");
    }
    if (!options.allowAdditionalReceipt) {
      const existing = existingAssetReceiptForAssignment(database, assignment.id, slot.id);
      if (existing) {
        throw new CampaignStateError(
          `campaign assignment already has asset receipt ${existing.id}; use --allow-additional-receipt only for intentional variants or revisions`,
        );
      }
    }
  }
  const timestamp = options.now ?? new Date().toISOString();
  const receiptId = options.assetReceiptId ?? `campaign-asset-${randomUUID()}`;
  database.prepare(`
    insert into campaign_asset_receipts(
      id, campaign_id, slot_id, assignment_id, asset_type, channel, status,
      title, prompt_summary, artifact_path, metadata_json, review_notes, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receiptId,
    campaign.id,
    slot.id,
    options.assignment ?? null,
    options.assetType,
    options.channel ?? slot.channel,
    options.status ?? "draft",
    options.title,
    options.promptSummary ?? null,
    options.artifactPath ?? null,
    json(options.metadata),
    options.reviewNotes ?? null,
    timestamp,
  );
  return receiptId;
}

export function campaignSetupReadbackProofSync(
  database: DatabaseSync,
  options: {
    assignment?: string;
    campaign: string;
    channel?: string;
    checkedAt?: string;
    slot?: string;
  },
): CampaignLedgerReadbackProof {
  const campaign = campaignRecord(campaignRow(database, options.campaign));
  const checks: CampaignLedgerReadbackProof["checks"] = [
    {
      entity: "campaign",
      id: campaign.id,
      key: campaign.name,
      ok: true,
    },
  ];
  if (options.slot) {
    const slot = slotRecord(slotRow(database, options.slot));
    requireSameCampaign(campaign.id, slot.campaign_id, "slot");
    checks.push({
      entity: "slot",
      id: slot.id,
      key: slot.slot_key,
      ok: true,
    });
  }
  if (options.channel) {
    const brief = channelBriefRow(database, campaign.id, options.channel);
    checks.push({
      entity: "brief",
      id: brief.id,
      key: brief.channel,
      ok: true,
    });
  }
  if (options.assignment) {
    const assignment = assignmentRecord(assignmentRow(database, options.assignment));
    requireSameCampaign(campaign.id, assignment.campaign_id, "assignment");
    if (options.slot && assignment.slot_id !== options.slot) {
      throw new CampaignStateError("assignment does not belong to the provided campaign worker slot");
    }
    checks.push({
      entity: "assignment",
      id: assignment.id,
      key: assignment.title,
      ok: true,
    });
  }
  return {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    checked_at: options.checkedAt ?? new Date().toISOString(),
    checks,
    ok: true,
  };
}

function existingAssetReceiptForAssignment(
  database: DatabaseSync,
  assignmentId: string,
  slotId: string,
): { id: string } | null {
  const row = database.prepare(`
    select id
    from campaign_asset_receipts
    where assignment_id = ? and slot_id = ?
    order by created_at, id
    limit 1
  `).get(assignmentId, slotId) as { id: string } | undefined;
  return row ?? null;
}

export function campaignStatusSync(database: DatabaseSync, campaignNameOrId: string): CampaignStatusRecord {
  const campaign = campaignRecord(campaignRow(database, campaignNameOrId));
  const slots = (database.prepare(`
    select *
    from campaign_worker_slots
    where campaign_id = ?
    order by created_at, slot_key
  `).all(campaign.id) as unknown as CampaignWorkerSlotRow[]).map((row) => ({
    ...slotRecord(row),
    active_assignments: Number((database.prepare(`
      select count(*) as count
      from campaign_assignments
      where slot_id = ? and status in ('queued','active','blocked')
    `).get(row.id) as { count: number }).count),
    asset_receipts: Number((database.prepare(`
      select count(*) as count
      from campaign_asset_receipts
      where slot_id = ?
    `).get(row.id) as { count: number }).count),
  }));
  const channelBriefs = (database.prepare(`
    select *
    from campaign_channel_briefs
    where campaign_id = ?
    order by channel
  `).all(campaign.id) as unknown as CampaignChannelBriefRow[]).map(channelBriefRecord);
  return {
    asset_counts: countByStatus<CampaignAssetStatus>(
      database,
      "campaign_asset_receipts",
      campaign.id,
      ["approved", "draft", "needs_review", "published", "rejected"],
    ),
    assignment_counts: countByStatus<CampaignAssignmentStatus>(
      database,
      "campaign_assignments",
      campaign.id,
      ["active", "blocked", "cancelled", "done", "queued"],
    ),
    campaign,
    channel_briefs: channelBriefs,
    slots,
  };
}

export function campaignDashboardSync(
  database: DatabaseSync,
  campaignNameOrId: string,
  options: { now?: string; staleAfterSeconds?: number } = {},
): CampaignDashboardRecord {
  const status = campaignStatusSync(database, campaignNameOrId);
  const now = Date.parse(options.now ?? new Date().toISOString());
  const staleAfterSeconds = options.staleAfterSeconds ?? 300;
  const slots = status.slots.map((slot) => campaignDashboardSlot(database, slot, { now, staleAfterSeconds }));
  const blockers = slots.flatMap((slot) => slot.blockers);
  const blockedAssignments = status.assignment_counts.blocked;
  const blockedSlots = slots.filter((slot) => slot.state === "blocked").length;
  const staleSlots = slots.filter((slot) => slot.lifecycle.stale).length;
  return {
    approvals: {
      approved: status.asset_counts.approved,
      needs_review: status.asset_counts.needs_review,
      published: status.asset_counts.published,
      rejected: status.asset_counts.rejected,
    },
    asset_counts: status.asset_counts,
    assignment_counts: status.assignment_counts,
    blockers,
    campaign: status.campaign,
    channel_briefs: status.channel_briefs,
    next_manager_action: campaignNextManagerAction({
      assetCounts: status.asset_counts,
      assignmentCounts: status.assignment_counts,
      blockedAssignments,
      blockedSlots,
      slots,
      staleSlots,
    }),
    slots,
    summary: {
      active_slots: slots.filter((slot) => slot.state === "active").length,
      archived_slots: slots.filter((slot) => slot.state === "archived").length,
      assignment_total: Object.values(status.assignment_counts).reduce((sum, count) => sum + count, 0),
      asset_total: Object.values(status.asset_counts).reduce((sum, count) => sum + count, 0),
      blocked_assignments: blockedAssignments,
      blocked_slots: blockedSlots,
      channel_briefs: status.channel_briefs.length,
      stale_slots: staleSlots,
    },
  };
}

function requireWorkerSession(database: DatabaseSync, sessionId: string): void {
  const row = database.prepare("select role from sessions where id = ?").get(sessionId) as { role: string } | undefined;
  if (!row) {
    throw new CampaignStateError(`unknown session: ${sessionId}`);
  }
  if (row.role !== "worker") {
    throw new CampaignStateError(`campaign worker slot requires a worker session, got ${row.role}`);
  }
}

function campaignDashboardSlot(
  database: DatabaseSync,
  slot: CampaignStatusRecord["slots"][number],
  options: { now: number; staleAfterSeconds: number },
): CampaignDashboardSlotRecord {
  const assignments = (database.prepare(`
    select *
    from campaign_assignments
    where slot_id = ?
    order by created_at, title
  `).all(slot.id) as unknown as CampaignAssignmentRow[]).map(assignmentRecord);
  const assets = (database.prepare(`
    select *
    from campaign_asset_receipts
    where slot_id = ?
    order by created_at, title
  `).all(slot.id) as unknown as CampaignAssetReceiptRow[]).map(assetReceiptRecord);
  const session = slot.session_id ? sessionRecord(database, slot.session_id) : null;
  const lifecycle = campaignSlotLifecycle(slot, session, options);
  const blockers = [
    slot.state === "blocked" ? `worker slot ${slot.slot_key} is blocked` : null,
    lifecycle.state === "needs_session" ? `worker slot ${slot.slot_key} has no registered worker session` : null,
    lifecycle.state === "needs_thread" ? `worker slot ${slot.slot_key} has no Codex app thread id` : null,
    lifecycle.state === "stale" ? `worker slot ${slot.slot_key} heartbeat is stale` : null,
    ...assignments.filter((assignment) => assignment.status === "blocked").map((assignment) => `assignment ${assignment.title} is blocked`),
    ...assets.filter((asset) => asset.status === "rejected").map((asset) => `asset ${asset.title} is rejected`),
  ].filter((item): item is string => item !== null);
  return {
    ...slot,
    assignments,
    assets,
    blockers,
    lifecycle,
    session,
  };
}

function campaignSlotLifecycle(
  slot: CampaignStatusRecord["slots"][number],
  session: CampaignDashboardSlotRecord["session"],
  options: { now: number; staleAfterSeconds: number },
): CampaignDashboardSlotRecord["lifecycle"] {
  if (slot.state === "archived") {
    return { operator_message: "Worker slot is archived.", stale: false, stale_seconds: null, state: "archived" };
  }
  if (slot.state === "blocked") {
    return { operator_message: "Worker slot is marked blocked.", stale: false, stale_seconds: null, state: "blocked" };
  }
  if (!slot.codex_app_thread_id) {
    return { operator_message: "Record the Codex app worker thread id for this slot.", stale: false, stale_seconds: null, state: "needs_thread" };
  }
  if (!slot.session_id || !session) {
    if (slot.state === "idle") {
      return { operator_message: "Codex app worker slot is idle and ready for assignment.", stale: false, stale_seconds: null, state: "idle" };
    }
    if (slot.state === "planned") {
      return { operator_message: "Codex app worker slot is planned and needs activation.", stale: false, stale_seconds: null, state: "planned" };
    }
    return { operator_message: "Codex app worker slot is active.", stale: false, stale_seconds: null, state: "active" };
  }
  const staleSeconds = heartbeatAgeSeconds(session.last_heartbeat_at, options.now);
  const stale = staleSeconds === null || staleSeconds > options.staleAfterSeconds;
  if (stale) {
    return { operator_message: "Wake or rotate this worker before assigning more work.", stale: true, stale_seconds: staleSeconds, state: "stale" };
  }
  if (slot.state === "idle") {
    return { operator_message: "Worker slot is idle and ready for assignment.", stale: false, stale_seconds: staleSeconds, state: "idle" };
  }
  if (slot.state === "planned") {
    return { operator_message: "Worker slot is planned and needs activation.", stale: false, stale_seconds: staleSeconds, state: "planned" };
  }
  return { operator_message: "Worker slot is active.", stale: false, stale_seconds: staleSeconds, state: "active" };
}

function heartbeatAgeSeconds(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !Number.isFinite(now)) {
    return null;
  }
  return Math.max(0, Math.round((now - parsed) / 1000));
}

function campaignNextManagerAction(options: {
  assetCounts: Record<CampaignAssetStatus, number>;
  assignmentCounts: Record<CampaignAssignmentStatus, number>;
  blockedAssignments: number;
  blockedSlots: number;
  slots: CampaignDashboardSlotRecord[];
  staleSlots: number;
}): CampaignDashboardRecord["next_manager_action"] {
  if (options.slots.length === 0) {
    return { action: "add_worker_slots", reason: "Campaign has no worker slots." };
  }
  if (options.blockedSlots > 0) {
    return { action: "resolve_worker_blockers", reason: "One or more worker slots are blocked." };
  }
  if (options.staleSlots > 0 || options.slots.some((slot) => slot.lifecycle.state === "needs_session" || slot.lifecycle.state === "needs_thread")) {
    return { action: "wake_or_rotate_workers", reason: "One or more worker slots are stale or missing session/thread metadata." };
  }
  if (options.blockedAssignments > 0) {
    return { action: "resolve_assignment_blockers", reason: "One or more assignments are blocked." };
  }
  if (options.assetCounts.needs_review > 0 || options.assetCounts.rejected > 0) {
    return { action: "review_assets", reason: "Assets need review or rejection follow-up." };
  }
  if (options.assignmentCounts.queued > 0 || options.assignmentCounts.active > 0) {
    return { action: "monitor_workers", reason: "Assignments are queued or active." };
  }
  if (options.assetCounts.approved > 0 || options.assetCounts.published > 0) {
    return { action: "close_campaign", reason: "No active work remains and approved/published assets exist." };
  }
  return { action: "assign_work", reason: "Worker slots exist but no assignments or reviewable assets are present." };
}

function campaignRow(database: DatabaseSync, nameOrId: string): CampaignRow {
  const row = database.prepare(`
    select *
    from campaigns
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(nameOrId, nameOrId) as CampaignRow | undefined;
  if (!row) {
    throw new CampaignStateError(`unknown campaign: ${nameOrId}`);
  }
  return row;
}

function slotRow(database: DatabaseSync, id: string): CampaignWorkerSlotRow {
  const row = database.prepare("select * from campaign_worker_slots where id = ?").get(id) as CampaignWorkerSlotRow | undefined;
  if (!row) {
    throw new CampaignStateError(`unknown campaign worker slot: ${id}`);
  }
  return row;
}

function assignmentRow(database: DatabaseSync, id: string): CampaignAssignmentRow {
  const row = database.prepare("select * from campaign_assignments where id = ?").get(id) as CampaignAssignmentRow | undefined;
  if (!row) {
    throw new CampaignStateError(`unknown campaign assignment: ${id}`);
  }
  return row;
}

function channelBriefRow(database: DatabaseSync, campaignId: string, channel: string): CampaignChannelBriefRow {
  const row = database.prepare(`
    select *
    from campaign_channel_briefs
    where campaign_id = ? and channel = ?
  `).get(campaignId, channel) as CampaignChannelBriefRow | undefined;
  if (!row) {
    throw new CampaignStateError(`unknown campaign channel brief: ${channel}`);
  }
  return row;
}

function requireSameCampaign(expectedCampaignId: string, actualCampaignId: string, subject: string): void {
  if (expectedCampaignId !== actualCampaignId) {
    throw new CampaignStateError(`${subject} does not belong to campaign ${expectedCampaignId}`);
  }
}

function countByStatus<T extends string>(
  database: DatabaseSync,
  table: "campaign_asset_receipts" | "campaign_assignments",
  campaignId: string,
  statuses: T[],
): Record<T, number> {
  const result = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  const rows = database.prepare(`
    select status, count(*) as count
    from ${table}
    where campaign_id = ?
    group by status
  `).all(campaignId) as Array<{ count: number; status: T }>;
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}

function campaignRecord(row: CampaignRow): CampaignRecord {
  return {
    created_at: row.created_at,
    id: row.id,
    metadata: parseJson(row.metadata_json),
    name: row.name,
    objective: row.objective,
    status: row.status,
    updated_at: row.updated_at,
  };
}

function slotRecord(row: CampaignWorkerSlotRow): CampaignWorkerSlotRecord {
  return {
    campaign_id: row.campaign_id,
    channel: row.channel,
    codex_app_thread_id: row.codex_app_thread_id,
    codex_app_thread_title: row.codex_app_thread_title,
    created_at: row.created_at,
    id: row.id,
    metadata: parseJson(row.metadata_json),
    role_label: row.role_label,
    session_id: row.session_id,
    slot_key: row.slot_key,
    state: row.state,
    updated_at: row.updated_at,
  };
}

function channelBriefRecord(row: CampaignChannelBriefRow): CampaignChannelBriefRecord {
  return {
    brief: parseJson(row.brief_json),
    campaign_id: row.campaign_id,
    channel: row.channel,
    created_at: row.created_at,
    id: row.id,
    updated_at: row.updated_at,
  };
}

function assignmentRecord(row: CampaignAssignmentRow): CampaignAssignmentRecord {
  return {
    campaign_id: row.campaign_id,
    completed_at: row.completed_at,
    created_at: row.created_at,
    id: row.id,
    instructions: row.instructions,
    metadata: parseJson(row.metadata_json),
    slot_id: row.slot_id,
    status: row.status,
    title: row.title,
    updated_at: row.updated_at,
  };
}

function assetReceiptRecord(row: CampaignAssetReceiptRow): CampaignAssetReceiptRecord {
  return {
    artifact_path: row.artifact_path,
    asset_type: row.asset_type,
    assignment_id: row.assignment_id,
    campaign_id: row.campaign_id,
    channel: row.channel,
    created_at: row.created_at,
    id: row.id,
    metadata: parseJson(row.metadata_json),
    prompt_summary: row.prompt_summary,
    review_notes: row.review_notes,
    slot_id: row.slot_id,
    status: row.status,
    title: row.title,
  };
}

function sessionRecord(database: DatabaseSync, sessionId: string): CampaignDashboardSlotRecord["session"] {
  const row = database.prepare(`
    select id, name, role, state, last_heartbeat_at, codex_app_thread_id, codex_app_thread_title
    from sessions
    where id = ?
  `).get(sessionId) as CampaignSessionRow | undefined;
  if (!row) {
    return null;
  }
  return {
    codex_app_thread_id: row.codex_app_thread_id,
    codex_app_thread_title: row.codex_app_thread_title,
    id: row.id,
    last_heartbeat_at: row.last_heartbeat_at,
    name: row.name,
    role: row.role,
    state: row.state,
  };
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function json(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

interface CampaignRow {
  created_at: string;
  id: string;
  metadata_json: string;
  name: string;
  objective: string;
  status: CampaignStatus;
  updated_at: string;
}

interface CampaignWorkerSlotRow {
  campaign_id: string;
  channel: string | null;
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  created_at: string;
  id: string;
  metadata_json: string;
  role_label: string;
  session_id: string | null;
  slot_key: string;
  state: CampaignWorkerSlotState;
  updated_at: string;
}

interface CampaignAssignmentRow {
  campaign_id: string;
  completed_at: string | null;
  created_at: string;
  id: string;
  instructions: string;
  metadata_json: string;
  slot_id: string;
  status: CampaignAssignmentStatus;
  title: string;
  updated_at: string;
}

interface CampaignChannelBriefRow {
  brief_json: string;
  campaign_id: string;
  channel: string;
  created_at: string;
  id: string;
  updated_at: string;
}

interface CampaignAssetReceiptRow {
  artifact_path: string | null;
  asset_type: CampaignAssetType;
  assignment_id: string | null;
  campaign_id: string;
  channel: string | null;
  created_at: string;
  id: string;
  metadata_json: string;
  prompt_summary: string | null;
  review_notes: string | null;
  slot_id: string;
  status: CampaignAssetStatus;
  title: string;
}

interface CampaignSessionRow {
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  id: string;
  last_heartbeat_at: string | null;
  name: string;
  role: string;
  state: string;
}
