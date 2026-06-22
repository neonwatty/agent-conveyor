#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const DEFAULT_MAX_LINES = 1600;
const SKIPPED_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".lock",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".svg",
  ".webp",
  ".zip",
]);

const SKIPPED_PREFIXES = [
  ".codex-workers/",
  ".git/",
  "dashboard/dist/",
  "dist/",
  "node_modules/",
];

function usage() {
  console.error(
    [
      "Usage: node scripts/check-max-lines.mjs [--max N] [--base REF --head REF] [--all]",
      "",
      "Checks changed text files by default. Use --all to scan tracked files.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    all: false,
    base: undefined,
    head: "HEAD",
    max: DEFAULT_MAX_LINES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--base") {
      options.base = argv[index + 1];
      index += 1;
    } else if (arg === "--head") {
      options.head = argv[index + 1];
      index += 1;
    } else if (arg === "--max") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --max value: ${argv[index + 1] ?? ""}`);
      }
      options.max = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.all && !options.base) {
    throw new Error("Provide --base REF --head REF, or use --all.");
  }

  return options;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changedFiles(base, head) {
  const output = git(["diff", "--name-only", "--diff-filter=ACMRT", `${base}...${head}`]);
  return output.length === 0 ? [] : output.split("\n");
}

function trackedFiles() {
  const output = git(["ls-files"]);
  return output.length === 0 ? [] : output.split("\n");
}

function shouldSkip(file) {
  if (SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return true;
  }
  if (file.includes("/fixtures/") || file.includes("/__snapshots__/")) {
    return true;
  }
  return SKIPPED_EXTENSIONS.has(extname(file).toLowerCase());
}

function lineCount(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = (options.all ? trackedFiles() : changedFiles(options.base, options.head))
    .filter((file) => file.length > 0)
    .filter((file) => !shouldSkip(file));

  const offenders = [];
  for (const file of files) {
    const lines = lineCount(file);
    if (lines > options.max) {
      offenders.push({ file, lines });
    }
  }

  if (offenders.length > 0) {
    console.error(`Files over ${options.max} lines:`);
    for (const offender of offenders) {
      console.error(`- ${offender.file}: ${offender.lines}`);
    }
    process.exit(1);
  }

  console.log(`Max-lines check passed for ${files.length} file(s) at <= ${options.max} lines.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(2);
}
