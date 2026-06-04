const RECENT_EVENT_QUIET_THRESHOLD = 10;
const CURRENT_PROMPT_REGION_LINES = 12;

const APPROVAL_TRANSCRIPT_TOKENS = [
  "approval_prompt",
  "inspect_or_approve",
  "notable_pane_pattern",
];
const APPROVAL_WORDS = ["approval", "approve"];
const APPROVAL_ACTIVE_MARKERS = [
  "allow",
  "deny",
  "permission",
  "requires approval",
  "needs approval",
  "approve command",
];

const BUSY_WAIT_PATTERNS: Array<[
  pattern: string,
  needle: string,
  reason: string,
  recommendedAction: string,
]> = [
  [
    "mcp_startup",
    "Starting MCP servers",
    "terminal shows Codex waiting on MCP server startup",
    "inspect_or_interrupt",
  ],
  [
    "rate_limit_prompt",
    "Approaching rate limits",
    "terminal shows a rate-limit model switch prompt",
    "inspect_or_interrupt",
  ],
  [
    "enter_to_confirm",
    "Press enter to confirm",
    "terminal is waiting for Enter confirmation",
    "inspect_or_confirm",
  ],
  [
    "trust_prompt",
    "Do you trust the contents of this directory",
    "terminal is waiting for workspace trust confirmation",
    "inspect_or_accept_trust",
  ],
  [
    "plan_prompt",
    "Create a plan?",
    "terminal is waiting at Codex plan-mode suggestion",
    "inspect_or_confirm",
  ],
  [
    "approval_prompt",
    "approval",
    "terminal appears to mention an approval prompt",
    "inspect_or_approve",
  ],
];

export interface BusyWaitClassification {
  pattern: string;
  reason: string;
  recommended_action: string;
}

export type StartupState = "error" | "needs_trust" | "ready" | "starting" | "working";

export function classifyStartupOutput(output: string): [StartupState, string] {
  const normalized = output.toLowerCase();
  if (normalized.includes("do you trust the contents of this directory")) {
    return ["needs_trust", "Codex is waiting for workspace trust confirmation"];
  }
  if (normalized.includes("openai codex") && output.includes("›")) {
    return ["ready", "Codex input prompt is visible"];
  }
  if (normalized.includes("working") && normalized.includes("esc to interrupt")) {
    return ["working", "Codex is already working"];
  }
  if (normalized.includes("error") || normalized.includes("failed")) {
    return ["error", "terminal output contains an error-like message"];
  }
  if (!output.trim()) {
    return ["starting", "terminal output is empty"];
  }
  return ["starting", "Codex has not reached a recognized startup state"];
}

export function classifyBusyWait(
  output: string,
  statusAge: number | null,
  busyWaitSeconds: number,
  recentEventCount = 0,
): BusyWaitClassification | null {
  if (statusAge !== null && statusAge < busyWaitSeconds) {
    return null;
  }
  const normalized = output.toLowerCase();
  for (const [pattern, needle, reason, recommendedAction] of BUSY_WAIT_PATTERNS) {
    if (pattern === "approval_prompt") {
      if (!looksLikeActiveApprovalPrompt(output)) {
        continue;
      }
    } else if (!normalized.includes(needle.toLowerCase())) {
      continue;
    }
    return {
      pattern,
      reason,
      recommended_action: recommendedAction,
    };
  }
  if (
    normalized.includes("esc to interrupt")
    && statusAge !== null
    && statusAge >= busyWaitSeconds
  ) {
    if (recentEventCount >= RECENT_EVENT_QUIET_THRESHOLD) {
      return null;
    }
    return {
      pattern: "long_running_interruptible",
      reason: "terminal shows an interruptible Codex operation while status.json is stale",
      recommended_action: "inspect_or_interrupt",
    };
  }
  return null;
}

function currentPromptRegion(output: string, lineCount = CURRENT_PROMPT_REGION_LINES): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lineCount)
    .join("\n");
}

function looksLikeActiveApprovalPrompt(output: string): boolean {
  const region = currentPromptRegion(output).toLowerCase();
  if (!region) {
    return false;
  }
  const filtered = region
    .split(/\r?\n/)
    .filter((line) => !APPROVAL_TRANSCRIPT_TOKENS.some((token) => line.includes(token)))
    .join("\n");
  return (
    APPROVAL_WORDS.some((word) => filtered.includes(word))
    && APPROVAL_ACTIVE_MARKERS.some((marker) => filtered.includes(marker))
  );
}
