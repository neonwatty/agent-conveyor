# Agent Evidence Playbook Design

## Purpose

Harden agent documentation so completion claims in Codex Terminal Manager are
backed by concrete evidence, not only by test coverage or worker optimism. The
new guidance should translate the burden-of-proof idea into repo-native agent
practice: pick a realistic failure mode, try to disprove the work, record the
evidence, and name any remaining risk.

This is documentation and process hardening for agents. It does not add new CLI
gates in this slice.

## Scope

- Add a concise `docs/agent-evidence-playbook.md` as the main agent-facing
  guide.
- Link the playbook from `AGENTS.md`, `README.md`, `docs/qa/README.md`, and the
  `manage-codex-workers` skill.
- Update `docs/qa/evidence-template.md` with explicit disproof-attempt fields.
- Clarify `docs/qa/adversarial-proof.md` so ordinary burden-of-proof closeout is
  distinct from gated adversarial proof.
- Treat `AGENTS.md` as the source of truth for local agent instructions.
  `CLAUDE.md` is not needed for this process and should not be updated.

Out of scope:

- New `workerctl` enforcement flags.
- New deterministic QA harnesses.
- Large rewrites of existing scenario docs.
- Requiring full release-candidate checks for every small documentation edit.

## Playbook Shape

The playbook should be short enough for agents to actually use. It should define:

1. A closeout rule:
   - name the strongest realistic failure mode;
   - run or inspect evidence that would expose it;
   - report the result and residual risk.
2. An evidence ladder by change type:
   - docs/static guidance: diff inspection plus targeted grep or rendered check
     when relevant;
   - Python or CLI behavior: focused command/unit verification, with
     `scripts/rc-check` for broad changes;
   - dashboard/frontend behavior: `npm run build` plus browser or screenshot
     inspection when the UI is affected;
   - worker/manager/Dispatch behavior: `workerctl qa-plan`, `qa-run`, `audit`,
     `replay`, criteria state, and Dispatch receipts;
   - PR or ship loops: PR URL, CI green, merge/main receipt, and guarded
     `codex-review` when requested or appropriate.
3. A final handoff shape:
   - claim;
   - disproof attempt;
   - evidence;
   - residual risk or follow-up.

## Integration Points

`AGENTS.md` should stay compact and point agents to the playbook for operational
details.

`README.md` should keep the existing Burden Of Proof section, then mention the
playbook as the repo-specific evidence guide.

`docs/qa/README.md` should link the playbook near the common pass bar so QA
runners understand how to pick proof beyond screenshots or pane text.

`skills/manage-codex-workers/SKILL.md` should reference the playbook in its
burden-of-proof and finish/export sections so manager agents use the same
receipt vocabulary.

`docs/qa/evidence-template.md` should gain a compact disproof section with:

- strongest realistic failure mode;
- check used;
- result;
- unresolved risk or follow-up.

`docs/qa/adversarial-proof.md` should clarify that every agent closeout needs a
burden-of-proof attempt, while `adversarial_check` receipts and
`finish-task --require-adversarial-proof` are the stricter gated form used when
the manager/operator asks for adversarial proof.

## Verification

Because this slice is documentation-only, verification should try to disprove the
most likely documentation failure: the new guidance exists but is not discoverable
from the places agents actually read.

Minimum verification:

- inspect the final diff;
- run targeted `rg` checks proving the playbook is linked from `AGENTS.md`,
  `README.md`, `docs/qa/README.md`, and `skills/manage-codex-workers/SKILL.md`;
- inspect the playbook for placeholder language and make sure it names concrete
  CTM commands rather than generic test-coverage advice.

`npm test` or `scripts/rc-check` are not required unless the implementation
touches executable code.
