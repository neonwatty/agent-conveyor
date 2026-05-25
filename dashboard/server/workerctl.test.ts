import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPtyAttachArgs,
  buildWorkerctlArgs,
  normalizeServerOptions,
} from "./workerctl.ts";
import {
  dispatchHealth,
  dispatchChainEntries,
  dispatchHeartbeatTelemetryOptions,
  dashboardTaskName,
  isDashboardSession,
} from "./index.ts";
import {
  encodeTerminalResizeMessage,
  parseTerminalControlMessage,
} from "./terminal.ts";

test("normalizes loopback dashboard server defaults", () => {
  const options = normalizeServerOptions({});

  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 8797);
  assert.equal(options.workerctlPath, "scripts/workerctl");
});

test("builds task snapshot workerctl arguments without shell interpolation", () => {
  const args = buildWorkerctlArgs({
    command: "snapshot",
    task: "snapshot-task",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "telemetry",
    "snapshot",
    "--task",
    "snapshot-task",
    "--json",
  ]);
});

test("builds task audit workerctl arguments", () => {
  const args = buildWorkerctlArgs({
    command: "audit",
    dbPath: "/tmp/workerctl.db",
    task: "snapshot-task",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "audit",
    "snapshot-task",
    "--json",
    "--path",
    "/tmp/workerctl.db",
  ]);
});

test("builds filtered telemetry workerctl arguments", () => {
  const args = buildWorkerctlArgs({
    command: "telemetry",
    limit: 1000,
    task: "dispatch-task",
    telemetryActor: "dispatch",
    telemetryEventType: "dispatch_signal_suppressed",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "telemetry",
    "--task",
    "dispatch-task",
    "--actor",
    "dispatch",
    "--event-type",
    "dispatch_signal_suppressed",
    "--limit",
    "1000",
    "--json",
  ]);
});

test("explicit dashboard task overrides dashboard-bound task", () => {
  assert.equal(
    dashboardTaskName({ task: "requested-task" }, { task_name: "bound-task" }),
    "requested-task",
  );
  assert.equal(dashboardTaskName({}, { task_name: "bound-task" }), "bound-task");
});

test("ignores gone registrations for dashboard terminals", () => {
  assert.equal(isDashboardSession({
    name: "old-worker",
    state: "gone",
    tmux_session: "workerctl-dashboard-a",
  }), false);
  assert.equal(isDashboardSession({
    name: "active-worker",
    state: "active",
    tmux_session: "workerctl-dashboard-a",
  }), true);
});

test("groups dispatch correlation chains with command attempts for dashboard display", () => {
  const chains = dispatchChainEntries({
    command_attempts: [
      {
        command_id: "cmd-1",
        dispatcher_id: "dispatcher-a",
        error: "tmux failed after paste",
        id: 7,
        side_effect_completed: false,
        side_effect_started: true,
        state: "failed",
      },
      {
        command_id: "cmd-2",
        dispatcher_id: "dispatcher-b",
        id: 8,
        side_effect_completed: true,
        side_effect_started: true,
        state: "succeeded",
      },
    ],
    commands: [
      {
        correlation_id: "corr-1",
        created_at: "2026-05-23T10:00:00Z",
        id: "cmd-1",
        state: "failed",
        type: "notify_manager",
      },
      {
        correlation_id: "corr-2",
        created_at: "2026-05-23T10:01:00Z",
        id: "cmd-2",
        state: "succeeded",
        type: "nudge_worker",
      },
    ],
    correlation_chains: [
      {
        attempt_ids: [7],
        command_id: "cmd-1",
        command_state: "failed",
        command_type: "notify_manager",
        correlation_id: "corr-1",
        created_at: "2026-05-23T10:00:00Z",
        manager_cycle_id: 11,
        manager_decision_id: 12,
        routed_notification_ids: [21, 22],
      },
      {
        attempt_ids: [8],
        command_id: "cmd-2",
        command_state: "succeeded",
        command_type: "nudge_worker",
        correlation_id: "corr-2",
        created_at: "2026-05-23T10:01:00Z",
        manager_cycle_id: null,
        manager_decision_id: null,
        routed_notification_ids: [],
      },
    ],
    routed_notifications: [],
  });

  assert.equal(chains.length, 2);
  assert.equal(chains[0].command_id, "cmd-2");
  assert.equal(chains[0].summary, "nudge_worker cmd-2");
  assert.equal(chains[0].side_effect_risk, false);
  assert.equal(chains[1].command_id, "cmd-1");
  assert.equal(chains[1].correlation_id, "corr-1");
  assert.equal(chains[1].manager_cycle_id, 11);
  assert.equal(chains[1].manager_decision_id, 12);
  assert.equal(chains[1].notification_count, 2);
  assert.equal(chains[1].side_effect_risk, true);
  assert.equal(chains[1].error, "tmux failed after paste");
  assert.deepEqual(chains[1].attempts, [
    {
      dispatcher_id: "dispatcher-a",
      error: "tmux failed after paste",
      id: 7,
      side_effect_completed: false,
      side_effect_started: true,
      state: "failed",
    },
  ]);
});

test("groups completion-only dispatch notifications for dashboard display", () => {
  const chains = dispatchChainEntries({
    command_attempts: [],
    commands: [],
    correlation_chains: [
      {
        command_id: null,
        command_state: "delivered",
        command_type: "worker_task_complete",
        correlation_id: "dispatch-completion",
        created_at: "2026-05-23T10:02:00Z",
        manager_cycle_id: null,
        manager_decision_id: null,
        routed_notification_ids: [31],
        signal_type: "worker_task_complete",
        source_event_id: 17,
      },
    ],
    routed_notifications: [
      {
        correlation_id: "dispatch-completion",
        created_at: "2026-05-23T10:02:00Z",
        id: 31,
        signal_type: "worker_task_complete",
        state: "delivered",
      },
    ],
  });

  assert.equal(chains.length, 1);
  assert.equal(chains[0].command_id, null);
  assert.equal(chains[0].command_type, "worker_task_complete");
  assert.equal(chains[0].command_state, "delivered");
  assert.equal(chains[0].correlation_id, "dispatch-completion");
  assert.equal(chains[0].notification_count, 1);
  assert.equal(chains[0].summary, "worker_task_complete notification #31");
  assert.equal(chains[0].time, "2026-05-23T10:02:00Z");
});

test("dispatch chains summarize worker manager conversation", () => {
  const chains = dispatchChainEntries({
    command_attempts: [
      {
        command_id: "cmd-1",
        dispatcher_id: "dispatch-local",
        id: 1,
        side_effect_completed: true,
        side_effect_started: true,
        state: "succeeded",
      },
    ],
    commands: [
      {
        correlation_id: "corr-1",
        created_at: "2026-05-25T10:00:00Z",
        id: "cmd-1",
        state: "succeeded",
        type: "nudge_worker",
      },
    ],
    correlation_chains: [
      {
        attempt_ids: [1],
        command_id: "cmd-1",
        command_state: "succeeded",
        command_type: "nudge_worker",
        correlation_id: "corr-1",
        created_at: "2026-05-25T10:00:00Z",
        manager_cycle_id: 44,
        manager_decision_id: 12,
        routed_notification_ids: [99],
      },
    ],
    routed_notifications: [
      {
        id: 99,
        state: "delivered",
        signal_type: "nudge_worker",
      },
    ],
  });

  assert.deepEqual(chains[0].conversation, [
    { kind: "manager_decision", label: "Manager decision #12" },
    { kind: "dispatch_attempt", label: "Dispatch succeeded via dispatch-local" },
    { kind: "routed_notification", label: "Routed notification #99 delivered" },
    { kind: "manager_cycle", label: "Manager cycle #44 consumed the routed fact" },
  ]);
});

test("dispatch conversation uses the latest retry attempt", () => {
  const chains = dispatchChainEntries({
    command_attempts: [
      {
        command_id: "cmd-1",
        dispatcher_id: "dispatch-old",
        id: 1,
        side_effect_completed: false,
        side_effect_started: true,
        started_at: "2026-05-25T10:00:00Z",
        state: "failed",
      },
      {
        command_id: "cmd-1",
        dispatcher_id: "dispatch-new",
        id: 2,
        side_effect_completed: true,
        side_effect_started: true,
        started_at: "2026-05-25T10:01:00Z",
        state: "succeeded",
      },
    ],
    commands: [
      {
        correlation_id: "corr-1",
        created_at: "2026-05-25T10:00:00Z",
        id: "cmd-1",
        state: "succeeded",
        type: "nudge_worker",
      },
    ],
    correlation_chains: [
      {
        attempt_ids: [1, 2],
        command_id: "cmd-1",
        command_state: "succeeded",
        command_type: "nudge_worker",
        correlation_id: "corr-1",
        created_at: "2026-05-25T10:00:00Z",
        manager_cycle_id: null,
        manager_decision_id: 12,
        routed_notification_ids: [],
      },
    ],
    routed_notifications: [],
  });

  assert.deepEqual(chains[0].attempts.map((attempt) => attempt.id), [1, 2]);
  assert.equal(
    chains[0].conversation.find((item) => item.kind === "dispatch_attempt")?.label,
    "Dispatch succeeded via dispatch-new",
  );
});

test("orders mixed dispatch chains by timestamp before dashboard display", () => {
  const chains = dispatchChainEntries({
    command_attempts: [],
    commands: [
      {
        correlation_id: "corr-new",
        created_at: "2026-05-23T10:03:00Z",
        id: "cmd-new",
        state: "succeeded",
        type: "notify_manager",
      },
    ],
    correlation_chains: [
      {
        command_id: "cmd-new",
        command_state: "succeeded",
        command_type: "notify_manager",
        correlation_id: "corr-new",
        created_at: "2026-05-23T10:03:00Z",
        manager_cycle_id: null,
        manager_decision_id: null,
        routed_notification_ids: [],
      },
      {
        command_id: null,
        command_state: "delivered",
        command_type: "worker_task_complete",
        correlation_id: "dispatch-old",
        created_at: "2026-05-23T10:01:00Z",
        manager_cycle_id: null,
        manager_decision_id: null,
        routed_notification_ids: [31],
        signal_type: "worker_task_complete",
        source_event_id: 17,
      },
    ],
    routed_notifications: [
      {
        correlation_id: "dispatch-old",
        created_at: "2026-05-23T10:01:00Z",
        id: 31,
        signal_type: "worker_task_complete",
        state: "delivered",
      },
    ],
  });

  assert.equal(chains[0].command_id, "cmd-new");
  assert.equal(chains[1].summary, "worker_task_complete notification #31");
});

test("counts suppressed dispatch signals in health", () => {
  const health = dispatchHealth({
    telemetry: {
      recent: [
        { actor: "dispatch", event_type: "dispatch_signal_suppressed" },
        { actor: "dispatch", event_type: "dispatch_signal_routed" },
        { actor: "workerctl", event_type: "dispatch_signal_suppressed" },
      ],
    },
  }, null);

  assert.equal(health.suppressed_signal_count, 1);
});

test("marks missing dispatch heartbeat as not observed", () => {
  const health = dispatchHealth({ telemetry: { recent: [] } }, null);

  assert.equal(health.core_status, "not_observed");
  assert.equal(health.operator_message, "Dispatch has not been observed; worker completions will not wake managers.");
  assert.equal(health.heartbeat.state, "not_observed");
  assert.equal(health.heartbeat.stale, true);
  assert.equal(health.heartbeat.timestamp, "");
});

test("ignores non-dispatch heartbeat telemetry for core status", () => {
  const health = dispatchHealth({
    telemetry: {
      recent: [
        {
          actor: "workerctl",
          event_type: "dispatch_watch_heartbeat",
          timestamp: new Date().toISOString(),
          correlation: { dispatcher_id: "not-dispatch", iteration: 9 },
          attributes: { dry_run: false, processed_count: 12 },
        },
      ],
    },
  }, null, [], [
    {
      actor: "manager",
      event_type: "dispatch_watch_heartbeat",
      timestamp: new Date().toISOString(),
      correlation: { dispatcher_id: "also-not-dispatch", iteration: 10 },
      attributes: { dry_run: false, processed_count: 20 },
    },
  ]);

  assert.equal(health.core_status, "not_observed");
  assert.equal(health.heartbeat.state, "not_observed");
  assert.equal(health.heartbeat.dispatcher_id, undefined);
});

test("marks stale dispatch heartbeat explicitly", () => {
  const health = dispatchHealth({
    telemetry: {
      recent: [
        {
          actor: "dispatch",
          event_type: "dispatch_watch_heartbeat",
          timestamp: "2000-01-01T00:00:00Z",
          correlation: { dispatcher_id: "dispatch-old", iteration: 3 },
          attributes: { dry_run: false, processed_count: 0 },
        },
      ],
    },
  }, null);

  assert.equal(health.core_status, "stale");
  assert.equal(health.operator_message, "Dispatch heartbeat is stale; worker completions may not wake managers.");
  assert.equal(health.heartbeat.state, "stale");
  assert.equal(health.heartbeat.dispatcher_id, "dispatch-old");
});

test("uses durable dispatch heartbeat when snapshot recent events omit it", () => {
  const health = dispatchHealth({ telemetry: { recent: [] } }, null, [], [
    {
      actor: "dispatch",
      event_type: "dispatch_watch_heartbeat",
      timestamp: new Date().toISOString(),
      correlation: { dispatcher_id: "dispatch-live", iteration: 4 },
      attributes: { dry_run: true, processed_count: 2 },
    },
  ]);

  assert.equal(health.core_status, "active");
  assert.equal(health.operator_message, "Dispatch is routing worker/manager events.");
  assert.equal(health.heartbeat.state, "active");
  assert.equal(health.heartbeat.dispatcher_id, "dispatch-live");
  assert.equal(health.heartbeat.iteration, 4);
  assert.equal(health.heartbeat.processed_count, 2);
  assert.equal(health.heartbeat.dry_run, true);
});

test("counts durable suppressed dispatch telemetry outside snapshot recent events", () => {
  const health = dispatchHealth({
    telemetry: {
      recent: [],
    },
  }, null, [
    { actor: "dispatch", event_type: "dispatch_signal_suppressed" },
    { actor: "dispatch", event_type: "dispatch_signal_suppressed" },
  ]);

  assert.equal(health.suppressed_signal_count, 2);
});

test("builds global dispatch heartbeat telemetry options", () => {
  const options = dispatchHeartbeatTelemetryOptions({
    dbPath: "/tmp/workerctl.db",
    workerctlPath: "scripts/workerctl",
  });

  assert.equal(options.task, undefined);
  assert.deepEqual(buildWorkerctlArgs(options), [
    "scripts/workerctl",
    "telemetry",
    "--actor",
    "dispatch",
    "--event-type",
    "dispatch_watch_heartbeat",
    "--limit",
    "1",
    "--newest",
    "--json",
    "--path",
    "/tmp/workerctl.db",
  ]);
});

test("builds session list arguments using the existing JSON default", () => {
  const args = buildWorkerctlArgs({
    dbPath: "/tmp/workerctl.db",
    command: "sessions",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, ["scripts/workerctl", "sessions"]);
});

test("builds discovery arguments for dashboard search", () => {
  const args = buildWorkerctlArgs({
    command: "discover",
    includeAll: true,
    limit: 5,
    task: "dashboard-debug",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "discover",
    "dashboard-debug",
    "--all",
    "--limit",
    "5",
  ]);
});

test("builds tmux attach arguments for a registered session", () => {
  const args = buildPtyAttachArgs({ session: "codex-worker-a" });

  assert.deepEqual(args, ["tmux", "attach", "-t", "codex-worker-a"]);
});

test("rejects unsafe terminal session names before spawning a PTY", () => {
  assert.throws(
    () => buildPtyAttachArgs({ session: "bad; rm -rf /" }),
    /Unsafe tmux session name/,
  );
});

test("parses dashboard terminal resize control messages", () => {
  assert.deepEqual(parseTerminalControlMessage(encodeTerminalResizeMessage(83, 31)), {
    cols: 83,
    rows: 31,
    type: "resize",
  });
});

test("leaves ordinary terminal input untouched by control parsing", () => {
  assert.equal(parseTerminalControlMessage("ls -la\r"), null);
  assert.equal(parseTerminalControlMessage(JSON.stringify({ type: "resize", cols: 83, rows: 31 })), null);
  assert.equal(parseTerminalControlMessage(encodeTerminalResizeMessage(1, 31)), null);
});

test("builds bind action arguments", () => {
  const args = buildWorkerctlArgs({
    command: "bind",
    manager: "manager-a",
    task: "task-a",
    worker: "worker-a",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "bind",
    "--task",
    "task-a",
    "--worker",
    "worker-a",
    "--manager",
    "manager-a",
  ]);
});

test("builds task creation arguments", () => {
  const args = buildWorkerctlArgs({
    command: "create-task",
    task: "dashboard-task",
    taskGoal: "Supervise from dashboard.",
    taskSummary: "Dashboard QA",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "tasks",
    "--create",
    "dashboard-task",
    "--goal",
    "Supervise from dashboard.",
    "--summary",
    "Dashboard QA",
  ]);
});

test("builds start-worker and start-manager arguments", () => {
  assert.deepEqual(
    buildWorkerctlArgs({
      askForApproval: "never",
      command: "start-worker",
      cwd: "/repo",
      sandbox: "danger-full-access",
      taskPrompt: "Implement the slice.",
      timeoutSeconds: 20,
      workerName: "dash-worker",
      workerctlPath: "scripts/workerctl",
    }),
    [
      "scripts/workerctl",
      "start-worker",
      "--name",
      "dash-worker",
      "--cwd",
      "/repo",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--timeout-seconds",
      "20",
      "--task",
      "Implement the slice.",
    ],
  );

  assert.deepEqual(
    buildWorkerctlArgs({
      command: "start-manager",
      dbPath: "/tmp/workerctl.db",
      managerName: "dash-manager",
      workerctlPath: "scripts/workerctl",
    }),
    ["scripts/workerctl", "start-manager", "--name", "dash-manager"],
  );
});

test("builds pair bootstrap arguments", () => {
  const args = buildWorkerctlArgs({
    command: "pair",
    cwd: "/repo",
    managerAcceptance: ["Both terminals attach"],
    managerGuideline: ["Keep receipts visible"],
    managerMode: "guided",
    managerName: "dash-manager",
    managerObjective: "Supervise dashboard bootstrap",
    managerReference: ["README.md"],
    task: "dashboard-task",
    taskGoal: "Exercise the browser bootstrap flow.",
    taskPrompt: "Start work from dashboard.",
    workerName: "dash-worker",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "pair",
    "--task",
    "dashboard-task",
    "--worker-name",
    "dash-worker",
    "--manager-name",
    "dash-manager",
    "--cwd",
    "/repo",
    "--task-prompt",
    "Start work from dashboard.",
    "--task-goal",
    "Exercise the browser bootstrap flow.",
    "--manager-mode",
    "guided",
    "--manager-objective",
    "Supervise dashboard bootstrap",
    "--manager-guideline",
    "Keep receipts visible",
    "--manager-acceptance",
    "Both terminals attach",
    "--manager-reference",
    "README.md",
  ]);
});

test("builds session nudge dry-run arguments", () => {
  const args = buildWorkerctlArgs({
    command: "nudge",
    dryRun: true,
    session: "worker-a",
    text: "please report status",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "session-nudge",
    "worker-a",
    "please report status",
    "--dry-run",
  ]);
});

test("builds interrupt arguments with followup", () => {
  const args = buildWorkerctlArgs({
    command: "interrupt",
    followup: "stop and summarize",
    key: "C-c",
    session: "worker-a",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "session-interrupt",
    "worker-a",
    "--key",
    "C-c",
    "--followup",
    "stop and summarize",
  ]);
});

test("builds finish and export task arguments", () => {
  assert.deepEqual(
    buildWorkerctlArgs({
      command: "finish",
      requireCriteriaAudit: true,
      task: "task-a",
      workerctlPath: "scripts/workerctl",
    }),
    ["scripts/workerctl", "finish-task", "task-a", "--require-criteria-audit"],
  );
  assert.deepEqual(
    buildWorkerctlArgs({
      command: "export",
      task: "task-a",
      workerctlPath: "scripts/workerctl",
      zip: true,
    }),
    ["scripts/workerctl", "export-task", "task-a", "--zip"],
  );
});
