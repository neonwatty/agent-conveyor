# QA Evidence Template

Copy this structure into the final QA report for each Codex + Chrome run.

## Run

- Scenario:
- Date:
- Product repo commit:
- Lab repo commit:
- Run id:
- Task:
- Worker:
- Manager:
- Dashboard URL:

## Browser Evidence

- Chrome opened dashboard URL: yes/no
- Dispatch banner state:
- Dispatcher id:
- Heartbeat age:
- Dispatch conversation lane showed `worker_task_complete`: yes/no
- Source event id:
- Routed notification id:
- Manager cycle id that consumed the notification:
- `finish_task` visible after consumption: yes/no
- Task state visible as `done`: yes/no

## CLI Evidence

```bash
./lab status
./lab cycle
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl audit <task> --json
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Record key values:

- `consumed_dispatch_notifications`:
- `source_event_id`:
- `signal_type`:
- `consumed_manager_cycle_id`:
- `finish_task` command id:
- criteria summary:
- task state:

## Worker Evidence

- Initial pytest result:
- Final pytest result:
- Files changed by worker:
- Focused diff checked: yes/no
- Worker final receipt summarized commands and evidence: yes/no

## Criteria

- Criterion 1:
- Criterion 2:
- Criterion 3:
- Criterion 4, if present:

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

- Cleanup succeeded: yes/no
- Remaining active lab sessions:
- Final lab status:

## Result

- Pass/fail:
- Blocker, if failed:
- Product follow-up needed:
- Lab follow-up needed:
