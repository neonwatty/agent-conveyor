import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  addCampaignWorkerSlotSync,
  campaignDashboardSync,
  campaignStatusSync,
  createCampaignAssignmentSync,
  createCampaignSync,
  recordCampaignAssetReceiptSync,
  updateCampaignWorkerSlotLifecycleSync,
  upsertCampaignChannelBriefSync,
} from "./campaigns.js";
import { initializeDatabaseSync, openDatabaseSync } from "../state/database.js";

test("campaign runtime records slots assignments briefs assets and status", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaigns."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      seedWorkerSession(database);
      const now = "2026-06-16T12:00:00Z";
      createCampaignSync(database, {
        campaignId: "campaign-1",
        metadata: { brand: "foil" },
        name: "creative-launch",
        now,
        objective: "Launch creative assets across channels.",
      });
      const slotId = addCampaignWorkerSlotSync(database, {
        campaign: "creative-launch",
        channel: "tiktok",
        codexAppThreadId: "thread-tiktok",
        codexAppThreadTitle: "TikTok Worker",
        metadata: { lane: "short-form" },
        now,
        roleLabel: "TikTok worker",
        sessionId: "session-worker",
        slotId: "slot-tiktok",
        slotKey: "tiktok",
        state: "active",
      });
      assert.equal(slotId, "slot-tiktok");
      const briefId = upsertCampaignChannelBriefSync(database, {
        brief: { aspect_ratio: "9:16", voice: "direct" },
        campaign: "campaign-1",
        channel: "tiktok",
        now,
      });
      assert.match(briefId, /^campaign-brief-/);
      const assignmentId = createCampaignAssignmentSync(database, {
        assignmentId: "assignment-hook",
        campaign: "campaign-1",
        instructions: "Draft three short hooks.",
        metadata: { priority: 1 },
        now,
        slot: "slot-tiktok",
        status: "active",
        title: "TikTok hook variants",
      });
      assert.equal(assignmentId, "assignment-hook");
      const receiptId = recordCampaignAssetReceiptSync(database, {
        artifactPath: "assets/tiktok/hook.md",
        assetReceiptId: "asset-hook",
        assetType: "copy",
        assignment: "assignment-hook",
        campaign: "creative-launch",
        metadata: { variants: 3 },
        now,
        promptSummary: "Sterile short-form hook request summary.",
        reviewNotes: "Needs human approval before publishing.",
        slot: "slot-tiktok",
        status: "needs_review",
        title: "TikTok hook copy",
      });
      assert.equal(receiptId, "asset-hook");

      const status = campaignStatusSync(database, "creative-launch");
      assert.equal(status.campaign.id, "campaign-1");
      assert.deepEqual(status.campaign.metadata, { brand: "foil" });
      assert.equal(status.slots.length, 1);
      assert.equal(status.slots[0]?.slot_key, "tiktok");
      assert.equal(status.slots[0]?.active_assignments, 1);
      assert.equal(status.slots[0]?.asset_receipts, 1);
      assert.deepEqual(status.channel_briefs[0]?.brief, { aspect_ratio: "9:16", voice: "direct" });
      assert.equal(status.assignment_counts.active, 1);
      assert.equal(status.asset_counts.needs_review, 1);
      assert.equal(status.asset_counts.approved, 0);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign worker slots require worker sessions and unique slot keys", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-slots."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      seedWorkerSession(database);
      seedManagerSession(database);
      createCampaignSync(database, {
        campaignId: "campaign-1",
        name: "creative-launch",
        objective: "Launch creative assets.",
      });
      addCampaignWorkerSlotSync(database, {
        campaign: "campaign-1",
        roleLabel: "Image worker",
        sessionId: "session-worker",
        slotId: "slot-image",
        slotKey: "image",
      });
      assert.throws(
        () => addCampaignWorkerSlotSync(database, {
          campaign: "campaign-1",
          roleLabel: "Duplicate image worker",
          slotKey: "image",
        }),
        /UNIQUE constraint failed/,
      );
      assert.throws(
        () => addCampaignWorkerSlotSync(database, {
          campaign: "campaign-1",
          roleLabel: "Manager as worker",
          sessionId: "session-manager",
          slotKey: "manager",
        }),
        /requires a worker session/,
      );
      assert.throws(
        () => addCampaignWorkerSlotSync(database, {
          campaign: "campaign-1",
          roleLabel: "Missing worker",
          sessionId: "missing",
          slotKey: "missing",
        }),
        /unknown session/,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign asset receipts reject cross-campaign assignment and slot mismatches", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-ownership."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createCampaignSync(database, { campaignId: "campaign-a", name: "campaign-a", objective: "A" });
      createCampaignSync(database, { campaignId: "campaign-b", name: "campaign-b", objective: "B" });
      const slotA = addCampaignWorkerSlotSync(database, {
        campaign: "campaign-a",
        roleLabel: "A worker",
        slotId: "slot-a",
        slotKey: "a",
      });
      const slotB = addCampaignWorkerSlotSync(database, {
        campaign: "campaign-b",
        roleLabel: "B worker",
        slotId: "slot-b",
        slotKey: "b",
      });
      const assignmentA = createCampaignAssignmentSync(database, {
        assignmentId: "assignment-a",
        campaign: "campaign-a",
        instructions: "Do A.",
        slot: slotA,
        title: "A",
      });

      assert.throws(
        () => recordCampaignAssetReceiptSync(database, {
          assetType: "image",
          assignment: assignmentA,
          campaign: "campaign-b",
          slot: slotB,
          title: "Wrong campaign",
        }),
        /assignment does not belong to campaign/,
      );
      assert.throws(
        () => recordCampaignAssetReceiptSync(database, {
          assetType: "image",
          assignment: assignmentA,
          campaign: "campaign-a",
          slot: slotB,
          title: "Wrong slot",
        }),
        /slot does not belong to campaign/,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign asset receipts are one per assignment unless explicitly allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-asset-idempotency."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createCampaignSync(database, { campaignId: "campaign-a", name: "campaign-a", objective: "A" });
      const slot = addCampaignWorkerSlotSync(database, {
        campaign: "campaign-a",
        roleLabel: "A worker",
        slotId: "slot-a",
        slotKey: "a",
      });
      const assignment = createCampaignAssignmentSync(database, {
        assignmentId: "assignment-a",
        campaign: "campaign-a",
        instructions: "Do A.",
        slot,
        title: "A",
      });

      const firstReceipt = recordCampaignAssetReceiptSync(database, {
        assetReceiptId: "asset-a-1",
        assetType: "copy",
        assignment,
        campaign: "campaign-a",
        slot,
        status: "needs_review",
        title: "First receipt",
      });
      assert.equal(firstReceipt, "asset-a-1");

      assert.throws(
        () => recordCampaignAssetReceiptSync(database, {
          assetReceiptId: "asset-a-2",
          assetType: "copy",
          assignment,
          campaign: "campaign-a",
          slot,
          status: "needs_review",
          title: "Second receipt with different title",
        }),
        /assignment already has asset receipt asset-a-1/,
      );

      const intentionalVariant = recordCampaignAssetReceiptSync(database, {
        allowAdditionalReceipt: true,
        assetReceiptId: "asset-a-variant",
        assetType: "copy",
        assignment,
        campaign: "campaign-a",
        slot,
        status: "needs_review",
        title: "Intentional variant",
      });
      assert.equal(intentionalVariant, "asset-a-variant");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign worker slot lifecycle updates are campaign owned and worker scoped", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-lifecycle."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      seedWorkerSession(database);
      seedManagerSession(database);
      createCampaignSync(database, { campaignId: "campaign-a", name: "campaign-a", objective: "A" });
      createCampaignSync(database, { campaignId: "campaign-b", name: "campaign-b", objective: "B" });
      const slotA = addCampaignWorkerSlotSync(database, {
        campaign: "campaign-a",
        roleLabel: "A worker",
        slotId: "slot-a",
        slotKey: "a",
      });

      assert.throws(
        () => updateCampaignWorkerSlotLifecycleSync(database, {
          campaign: "campaign-a",
          sessionId: "session-manager",
          slot: slotA,
          state: "active",
        }),
        /requires a worker session/,
      );

      const attached = updateCampaignWorkerSlotLifecycleSync(database, {
        campaign: "campaign-a",
        codexAppThreadId: "thread-worker",
        codexAppThreadTitle: "Worker",
        sessionId: "session-worker",
        slot: slotA,
        state: "active",
      });
      assert.equal(attached.session_id, "session-worker");
      assert.equal(attached.codex_app_thread_id, "thread-worker");
      assert.equal(attached.state, "active");

      assert.throws(
        () => updateCampaignWorkerSlotLifecycleSync(database, {
          campaign: "campaign-a",
          codexAppThreadId: "thread-worker-2",
          expectedThreadId: "wrong-thread",
          slot: slotA,
          state: "active",
        }),
        /thread guard does not match/,
      );

      assert.throws(
        () => updateCampaignWorkerSlotLifecycleSync(database, {
          campaign: "campaign-b",
          expectedThreadId: "thread-worker",
          slot: slotA,
          state: "archived",
        }),
        /slot does not belong to campaign/,
      );

      const rotated = updateCampaignWorkerSlotLifecycleSync(database, {
        campaign: "campaign-a",
        codexAppThreadId: "thread-worker-2",
        codexAppThreadTitle: "Worker 2",
        expectedThreadId: "thread-worker",
        slot: slotA,
        state: "active",
      });
      assert.equal(rotated.codex_app_thread_id, "thread-worker-2");
      assert.equal(rotated.codex_app_thread_title, "Worker 2");

      const archived = updateCampaignWorkerSlotLifecycleSync(database, {
        campaign: "campaign-a",
        expectedThreadId: "thread-worker-2",
        slot: slotA,
        state: "archived",
      });
      assert.equal(archived.state, "archived");
      assert.equal(archived.codex_app_thread_id, "thread-worker-2");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign dashboard summarizes ready review work for manager action", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-dashboard-review."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      seedWorkerSession(database);
      database.prepare("update sessions set last_heartbeat_at = ? where id = ?").run("2026-06-16T12:09:30Z", "session-worker");
      createCampaignSync(database, {
        campaignId: "campaign-1",
        name: "creative-launch",
        now: "2026-06-16T12:00:00Z",
        objective: "Launch creative assets.",
      });
      addCampaignWorkerSlotSync(database, {
        campaign: "campaign-1",
        channel: "tiktok",
        codexAppThreadId: "thread-worker",
        codexAppThreadTitle: "Worker",
        now: "2026-06-16T12:00:00Z",
        roleLabel: "TikTok worker",
        sessionId: "session-worker",
        slotId: "slot-tiktok",
        slotKey: "tiktok",
        state: "active",
      });
      createCampaignAssignmentSync(database, {
        assignmentId: "assignment-hooks",
        campaign: "campaign-1",
        instructions: "Draft hooks.",
        now: "2026-06-16T12:01:00Z",
        slot: "slot-tiktok",
        status: "done",
        title: "Hook drafts",
      });
      recordCampaignAssetReceiptSync(database, {
        assetReceiptId: "asset-hooks",
        assetType: "copy",
        assignment: "assignment-hooks",
        campaign: "campaign-1",
        now: "2026-06-16T12:02:00Z",
        slot: "slot-tiktok",
        status: "needs_review",
        title: "Hook copy",
      });

      const dashboard = campaignDashboardSync(database, "creative-launch", {
        now: "2026-06-16T12:10:00Z",
        staleAfterSeconds: 300,
      });

      assert.equal(dashboard.next_manager_action.action, "review_assets");
      assert.equal(dashboard.approvals.needs_review, 1);
      assert.equal(dashboard.summary.asset_total, 1);
      assert.equal(dashboard.summary.active_slots, 1);
      assert.equal(dashboard.summary.stale_slots, 0);
      assert.equal(dashboard.slots[0]?.lifecycle.state, "active");
      assert.equal(dashboard.slots[0]?.lifecycle.stale_seconds, 30);
      assert.equal(dashboard.slots[0]?.session?.codex_app_thread_id, "thread-worker");
      assert.equal(dashboard.slots[0]?.assignments[0]?.title, "Hook drafts");
      assert.equal(dashboard.slots[0]?.assets[0]?.status, "needs_review");
      assert.deepEqual(dashboard.blockers, []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign dashboard exposes stale workers missing sessions and blocked work", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-dashboard-blockers."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      seedWorkerSession(database);
      database.prepare("update sessions set last_heartbeat_at = ? where id = ?").run("2026-06-16T12:00:00Z", "session-worker");
      createCampaignSync(database, {
        campaignId: "campaign-1",
        name: "creative-launch",
        now: "2026-06-16T12:00:00Z",
        objective: "Launch creative assets.",
      });
      addCampaignWorkerSlotSync(database, {
        campaign: "campaign-1",
        codexAppThreadId: "thread-worker",
        now: "2026-06-16T12:00:00Z",
        roleLabel: "Stale worker",
        sessionId: "session-worker",
        slotId: "slot-stale",
        slotKey: "stale",
        state: "active",
      });
      addCampaignWorkerSlotSync(database, {
        campaign: "campaign-1",
        now: "2026-06-16T12:00:00Z",
        roleLabel: "Unattached worker",
        slotId: "slot-unattached",
        slotKey: "unattached",
        state: "planned",
      });
      createCampaignAssignmentSync(database, {
        assignmentId: "assignment-blocked",
        campaign: "campaign-1",
        instructions: "Blocked work.",
        now: "2026-06-16T12:01:00Z",
        slot: "slot-stale",
        status: "blocked",
        title: "Blocked edit",
      });
      recordCampaignAssetReceiptSync(database, {
        assetReceiptId: "asset-rejected",
        assetType: "image",
        campaign: "campaign-1",
        now: "2026-06-16T12:02:00Z",
        slot: "slot-stale",
        status: "rejected",
        title: "Rejected frame",
      });

      const dashboard = campaignDashboardSync(database, "creative-launch", {
        now: "2026-06-16T12:10:00Z",
        staleAfterSeconds: 300,
      });

      assert.equal(dashboard.next_manager_action.action, "wake_or_rotate_workers");
      assert.equal(dashboard.summary.stale_slots, 1);
      assert.equal(dashboard.summary.blocked_assignments, 1);
      assert.equal(dashboard.approvals.rejected, 1);
      assert.equal(dashboard.slots.find((slot) => slot.slot_key === "stale")?.lifecycle.state, "stale");
      assert.equal(dashboard.slots.find((slot) => slot.slot_key === "unattached")?.lifecycle.state, "needs_thread");
      assert.match(dashboard.blockers.join("\n"), /worker slot stale heartbeat is stale/);
      assert.match(dashboard.blockers.join("\n"), /worker slot unattached has no Codex app thread id/);
      assert.match(dashboard.blockers.join("\n"), /assignment Blocked edit is blocked/);
      assert.match(dashboard.blockers.join("\n"), /asset Rejected frame is rejected/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("campaign dashboard treats native Codex app thread slots as active without registered sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-campaign-dashboard-app-slots."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createCampaignSync(database, {
        campaignId: "campaign-1",
        name: "creative-launch",
        now: "2026-06-18T12:00:00Z",
        objective: "Launch native app creative assets.",
      });
      addCampaignWorkerSlotSync(database, {
        campaign: "campaign-1",
        codexAppThreadId: "thread-app-worker",
        codexAppThreadTitle: "Native App Worker",
        now: "2026-06-18T12:00:00Z",
        roleLabel: "Native app worker",
        slotId: "slot-app",
        slotKey: "app",
        state: "active",
      });
      createCampaignAssignmentSync(database, {
        assignmentId: "assignment-app",
        campaign: "campaign-1",
        instructions: "Create sanitized app receipt.",
        now: "2026-06-18T12:01:00Z",
        slot: "slot-app",
        status: "active",
        title: "App receipt",
      });

      const dashboard = campaignDashboardSync(database, "creative-launch", {
        now: "2026-06-18T12:10:00Z",
        staleAfterSeconds: 300,
      });

      assert.equal(dashboard.next_manager_action.action, "monitor_workers");
      assert.equal(dashboard.summary.active_slots, 1);
      assert.equal(dashboard.summary.stale_slots, 0);
      assert.equal(dashboard.slots[0]?.lifecycle.state, "active");
      assert.equal(dashboard.slots[0]?.lifecycle.stale_seconds, null);
      assert.equal(dashboard.slots[0]?.session, null);
      assert.deepEqual(dashboard.blockers, []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedWorkerSession(database: ReturnType<typeof openDatabaseSync>): void {
  database.prepare(`
    insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
      codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "session-worker",
    "worker",
    "worker",
    "worker-token",
    "codex-worker",
    "/tmp/worker.jsonl",
    "thread-worker",
    "Worker",
    "/repo",
    "2026-06-16T12:00:00Z",
    null,
    "active",
  );
}

function seedManagerSession(database: ReturnType<typeof openDatabaseSync>): void {
  database.prepare(`
    insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
      codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "session-manager",
    "manager",
    "manager",
    "manager-token",
    "codex-manager",
    "/tmp/manager.jsonl",
    "thread-manager",
    "Manager",
    "/repo",
    "2026-06-16T12:00:00Z",
    null,
    "active",
  );
}
