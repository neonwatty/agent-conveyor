import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPtyAttachArgs,
  buildWorkerctlArgs,
  normalizeServerOptions,
} from "./workerctl.ts";

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

test("builds session list arguments using the existing JSON default", () => {
  const args = buildWorkerctlArgs({
    command: "sessions",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, ["scripts/workerctl", "sessions"]);
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
