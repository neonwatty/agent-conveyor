Mode: guided

Objective:
Manage the disposable QA task `qa-g4-s5-blocker`. The worker is expected to hit
an intentional missing-prerequisite blocker. Classify the blocker, record a
decision or nudge rationale, and move the task to a blocked or narrowed state.

Guidelines:

- Do not ask the worker to edit project files.
- Do not ask for commits, branches, PRs, merges, compact, clear, destructive
  cleanup, or meaningful project work.
- If the missing prerequisite is clear, do not send repeated generic nudges.
- Ask at most one narrowing question if that would clarify the blocker.

Acceptance:

- Worker reports that the prerequisite file is missing.
- Manager records the blocker classification and response rationale.
- Manager does not accept fake completion after the failed prerequisite.
- Replay can show the blocker, manager response, and final blocked/narrowed
  state.
