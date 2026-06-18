# GoalBuddy Conveyor QA

Use this when a manager should drive a broad body of work through sequential
GoalBuddy child boards instead of a single flat task list.

## Trigger

The canonical natural-language trigger is:

```text
Create an autonomous GoalBuddy conveyor for this project.
```

The manager should translate that into one parent conveyor board and
vertical-slice child boards. Only one child may be active at a time.

## Required Proof

- Parent board records the child queue, the active child, and the final oracle.
- Each child records completion proof, verification commands, and adversarial
  review before PR creation or completion.
- Each implemented child records PR URL, CI result, merge SHA, and parent
  handoff after merge.
- A child already satisfied on main is recorded as `satisfied_on_main` only
  after code evidence and focused tests prove it.
- Failed CI is handled by log inspection, fixes, push, and re-monitoring.
- Parent and child GoalBuddy state checkers pass after each receipt mutation.

## Reusable Plan

Run:

```bash
conveyor qa-plan goalbuddy-conveyor
```

For machine-readable output:

```bash
conveyor qa-plan goalbuddy-conveyor --json
```

The plan includes the starter prompt, authority boundaries, acceptance
criteria, correlation markers, expected observations, and negative QA checks.

## Creative Ops Campaign Child Boards

Use this extension when a GoalBuddy conveyor is building or dogfooding
multi-worker Creative Ops Campaign support.

Required additional proof:

- Campaign setup uses `campaign create` plus one `campaign add-slot` receipt
  per worker slot. Slot keys, channel names, role labels, session ids, and
  Codex app thread ids/titles must be visible in receipts or dashboard output.
- Each channel-specific worker starts from a structured `campaign brief` and a
  slot-scoped `campaign assign` command. The manager must not rely on private
  chat text as the only assignment record.
- Worker output is recorded with `campaign asset` receipts that contain
  sanitized prompt summaries, asset type, review status, and artifact path only
  when the artifact is safe to commit or reference.
- `campaign dashboard --name <campaign> --json` or
  `dashboard --campaign <campaign>` is used as manager status proof. The proof
  must show slot lifecycle, blockers, approval counts, and next manager action.
- `campaign rotate-slot` and `campaign archive-slot` require exact
  `--expected-thread-id` matches. The manager must never rotate or archive a
  thread that is not the owned active worker slot for that campaign.
- Public publishing, scheduling, posting, or external account side effects
  require explicit human approval. Asset status alone is not permission to post.
- Dogfood is a separate proof gate. Recipe/skill docs can be complete before
  dogfood, but the parent campaign goal cannot be final-complete until a
  campaign dogfood receipt or explicit blocker exists.

Negative QA checks:

- No raw screenshots, private phone content, keys, JWTs, audio, unsanitized
  transcripts, archives, IPAs, or platform credentials are committed as campaign
  evidence.
- No manager prompt claims "fully autonomous campaign success" without
  dashboard proof, asset receipts, and final dogfood evidence.
- No worker slot cleanup bypasses `campaign rotate-slot`, `campaign
  archive-slot`, or app-worker rotation planning for Codex app sessions.
