import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPythonEntrypoint,
  packageRootFromModuleUrl,
  programNameFromArgv,
} from "./python-bridge.js";

test("program name honors explicit conveyor override", () => {
  assert.equal(
    programNameFromArgv(["node", "/tmp/workerctl"], { CONVEYOR_CLI_PROG: "conveyor" }),
    "conveyor",
  );
});

test("program name falls back to workerctl bin name", () => {
  assert.equal(programNameFromArgv(["node", "/usr/local/bin/workerctl"], {}), "workerctl");
});

test("program name defaults to conveyor for unknown Node launchers", () => {
  assert.equal(programNameFromArgv(["node", "/repo/dist/cli/main.js"], {}), "conveyor");
});

test("package root resolves from compiled dist cli module url", () => {
  assert.equal(
    packageRootFromModuleUrl("file:///repo/dist/cli/main.js"),
    "/repo",
  );
});

test("python entrypoint bridges conveyor through the compatibility env var", () => {
  const entrypoint = buildPythonEntrypoint({
    args: ["tasks", "--json"],
    env: { PATH: "/usr/bin" },
    packageRoot: "/repo",
    program: "conveyor",
  });

  assert.deepEqual(entrypoint, {
    args: ["tasks", "--json"],
    command: "/repo/scripts/workerctl",
    env: {
      CONVEYOR_CLI_PROG: "conveyor",
      PATH: "/usr/bin",
    },
  });
});

test("python entrypoint leaves workerctl environment behavior unchanged", () => {
  const entrypoint = buildPythonEntrypoint({
    args: ["--help"],
    env: { CONVEYOR_CLI_PROG: "conveyor", PATH: "/usr/bin" },
    packageRoot: "/repo",
    program: "workerctl",
  });

  assert.deepEqual(entrypoint, {
    args: ["--help"],
    command: "/repo/scripts/workerctl",
    env: {
      CONVEYOR_CLI_PROG: "conveyor",
      PATH: "/usr/bin",
    },
  });
});
