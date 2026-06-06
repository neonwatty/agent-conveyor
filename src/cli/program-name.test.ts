import { strict as assert } from "node:assert";
import test from "node:test";
import { programNameFromArgv } from "./program-name.js";

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
