# Continuation Reviewer Broader Containment

## Original request

Make a detailed plan with `$goalbuddy:goal-prep` for issue #133.

## Issue

GitHub issue #133: `Evaluate broader continuation reviewer containment for .codex-workers artifacts`

Follow-up from continuation-reviewer gap hardening after #130/#132.

The current hard-isolation guarantee is targeted: reviewer execution denies reads of the bound worker/manager rollout files and active workerctl DB/sidecars, runs from a temporary cwd, and uses a stripped environment. That satisfied the original #130 scope.

Issue #133 asks whether reviewer containment should also deny broader `.codex-workers` runtime artifacts such as transcripts, capture metadata, task state, exports, and other session-adjacent files.

## Outcome

Decide and, if approved, implement broader continuation-reviewer containment for `.codex-workers` artifacts while preserving allowed reviewer context, replay/audit workflows, normal CLI behavior, and redacted failure output.

## Acceptance criteria

- Decide the intended containment boundary for broader `.codex-workers` artifacts.
- If broader denial is desired, design it without breaking allowed reviewer context, replay/audit, or normal CLI operation.
- Add direct tests proving the approved artifact classes are inaccessible from the reviewer command.
- Keep failure output and telemetry redacted; no raw transcript, prompt, DB, rollout, stdout, stderr, or secret content should leak.
- Update README to distinguish targeted rollout/database denial from any broader containment guarantee.

## Non-goals

- Do not replace the current macOS `sandbox-exec` targeted-denial implementation unless the design decision requires it.
- Do not implement a broad deny-all filesystem policy without mapping which artifacts are protected and which reviewer inputs remain intentionally available.
- Do not reopen #130 or change its already-merged completion criteria.
- Do not hide actionable failures behind vague errors; preserve debuggability while keeping sensitive content redacted.

## Likely misfire

Treating broader containment as an obvious implementation task and denying all `.codex-workers` reads without first proving how that interacts with reviewer context, replay/audit paths, export behavior, and current CLI workflows. The opposite misfire is closing the issue as "no change" without an explicit source-backed boundary decision.

## Completion proof

Issue #133 is complete when a final Judge receipt confirms:

- The containment boundary decision is explicit.
- If broader denial is desired, the implementation matches the approved artifact classes and keeps allowed reviewer context working.
- Direct tests cover each approved inaccessible artifact class.
- Redaction behavior is tested or otherwise verified for failure output and telemetry.
- README documents the distinction between targeted rollout/database denial and any broader `.codex-workers` guarantee.
- Verification is green with the agreed commands, including:
  - `python3 -m unittest tests.test_workerctl.PairCommandTests -v`
  - `python3 -m unittest tests.test_workerctl -v`
  - `python3 -m py_compile workerctl/*.py`
  - `git diff --check`
  - `./scripts/rc-check`

## Execution strategy

Use a narrow Scout -> Judge -> Worker -> Judge flow.

1. Scout maps the current artifact classes, current continuation-reviewer containment points, and allowed reviewer context dependencies.
2. Judge decides the containment boundary before any implementation starts.
3. Worker implements the Judge-approved decision only, with tests and README updates.
4. PM handles issue/PR hygiene once implementation or no-code decision evidence exists.
5. Final Judge audits #133 acceptance criteria against repo evidence before merge/close.
