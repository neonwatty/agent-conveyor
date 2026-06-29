# Setup Bundle Dogfood

This guide keeps setup-bundle dogfooding on rails. There are two dogfood tiers:

1. Local CI-safe dogfood
2. Live GitHub sandbox dogfood

## Local CI-safe dogfood

Use this before live autonomous ship-it work:

```bash
conveyor qa-plan setup-bundle-dogfood
conveyor qa-run setup-bundle-dogfood \
  --receipt-output /tmp/setup-bundle-dogfood-receipt.json \
  --json
```

This flow uses temp ledgers, temp Codex homes, and a disposable local fixture
repo. It does not run `gh`, push branches, create PRs, merge, or launch manager
or worker sessions.

The receipt must prove:

- setup-bundle preview is read-only for every supported setup preset
- missing required Superpowers review backend blocks before launch
- approved setup bundles persist to `setup_bundles`
- `setup-bundle show` is ledger truth for approved hash and policy
- worker-set intent is only a launch handoff, not silently persisted worker count
- no sessions are created during the CI-safe dogfood

## Live GitHub sandbox dogfood

Use a dedicated sandbox repository such as:

```text
neonwatty/agent-conveyor-dogfood-sandbox
```

Required rails:

- The repo must be explicitly allowlisted by the operator.
- Branches must use the `dogfood/` prefix.
- The run must set max iterations, max PRs, and max runtime.
- The operator must explicitly approve GitHub side effects with an
  `--allow-github-side-effects` equivalent in the launch prompt or future CLI.
- The setup bundle must be applied and verified with `setup-bundle show` before
  manager or worker launch.
- The manager must stop before merge unless CI is green, PR review proof exists,
  mergeability is clean, and manager merge decision is recorded.
- The manager must record post-merge verification and adversarial proof before
  declaring the dogfood complete.

Run the executable live-sandbox preflight before launching manager or worker
sessions:

```bash
conveyor qa-run setup-bundle-live-sandbox \
  --allow-github-side-effects \
  --github-repo neonwatty/agent-conveyor-dogfood-sandbox \
  --branch-prefix dogfood/ \
  --max-prs 1 \
  --max-iterations 2 \
  --max-runtime-minutes 30 \
  --receipt-output /tmp/setup-bundle-live-sandbox-receipt.json \
  --json
```

This preflight is intentionally `preflight_only`: it verifies the operator has
made GitHub side effects explicit and bounded, then writes a receipt and replay
commands. It does not run `gh`, push a branch, open a PR, merge, or launch
manager/worker sessions.

Recommended live flow:

```bash
TASK="setup-dogfood-live"
LEDGER="$PWD/.codex-workers/workerctl.db"

conveyor tasks --create "$TASK" \
  --goal "Run live setup-bundle dogfood in the sandbox repo." \
  --path "$LEDGER" \
  --json

conveyor setup-bundle preview "$TASK" \
  --preset autonomous_ship_it \
  --pr-review-backend composite \
  --pr-review-required \
  --whats-next execute_bounded \
  --whats-next-max-iterations 1 \
  --path "$LEDGER" \
  --json

conveyor setup-bundle apply "$TASK" \
  --preset autonomous_ship_it \
  --pr-review-backend composite \
  --pr-review-required \
  --whats-next execute_bounded \
  --whats-next-max-iterations 1 \
  --approve \
  --path "$LEDGER" \
  --json

conveyor setup-bundle show "$TASK" --path "$LEDGER" --json
```

Only after `show` confirms `state: "applied"`, launch the manager/worker setup
with the `conveyor-setup-bundle` handoff rules.

Final live receipt must include:

- sandbox repo URL
- setup preview hash
- applied setup bundle id and approved hash
- branch name with `dogfood/` prefix
- PR URL
- CI result
- PR review result
- mergeability result
- manager merge decision
- merge SHA
- post-merge verification command/result
- what's-next iterations used
- adversarial proof with `failure_mode`, `check`, and `result`
