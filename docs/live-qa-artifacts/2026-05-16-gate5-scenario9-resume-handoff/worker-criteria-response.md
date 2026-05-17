Must-have current-task criteria:

- A durable worker handoff records current status, next steps, and known risks.
  Verification: `workerctl handoff` output and replay/export include the handoff.
- The current task has accepted criteria for resume safety and a deferred
  follow-up for optional compact/clear coverage. Verification: `workerctl
  criteria --list` shows accepted and deferred criteria.
- A resumed manager records a decision based on durable replay/export/handoff
  state, not live chat memory. Verification: `workerctl record-decision` payload
  names replay, export, handoff, and criteria as evidence.

Follow-up criteria:

- Run the same resume drill with actual compact/clear only after handoff and
  manager permission are configured.
