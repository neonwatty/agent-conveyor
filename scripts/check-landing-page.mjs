#!/usr/bin/env node

import { spawn } from "node:child_process";

const checks = [
  ["node", ["--check", "scripts/serve-landing-page.mjs"]],
  ["node", ["--check", "scripts/capture-static-html-screenshot.mjs"]],
  [
    "node",
    [
      "scripts/capture-static-html-screenshot.mjs",
      "--html",
      "docs/landing-page.html",
      "--output",
      "/tmp/agent-conveyor-landing-check.png",
      "--width",
      "1440",
      "--height",
      "1200",
    ],
  ],
  [
    "node",
    [
      "scripts/capture-static-html-screenshot.mjs",
      "--html",
      "docs/landing-page.html",
      "--output",
      "/tmp/agent-conveyor-landing-mobile-check.png",
      "--width",
      "390",
      "--height",
      "1200",
    ],
  ],
];

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

for (const [command, args] of checks) {
  await run(command, args);
}
