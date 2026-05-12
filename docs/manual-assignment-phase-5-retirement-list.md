# Phase 5 Retirement List

Generated at start of Phase 5. Lists every CLI subcommand, command function,
helper candidate, and test class anchor relevant to Tasks 2-7. Branch:
`manual-assignment-phase-5`.

## Current module sizes (Phase 4 baseline)

```
       2 workerctl/__init__.py
       6 workerctl/__main__.py
      76 workerctl/audit.py
      78 workerctl/classify.py
     942 workerctl/cli.py
     123 workerctl/codex_session.py
    2979 workerctl/commands.py
      25 workerctl/constants.py
      56 workerctl/core.py
    2427 workerctl/db.py
     131 workerctl/export.py
      97 workerctl/identity.py
     249 workerctl/importer.py
     258 workerctl/ingest.py
    1692 workerctl/lifecycle.py
     300 workerctl/replay.py
     146 workerctl/shadow_state.py
     206 workerctl/state.py
     176 workerctl/supervise_cycle.py
     263 workerctl/supervise.py
     304 workerctl/tmux.py
   10536 total

tests/test_workerctl.py: 8856 lines
```

## Retired CLI subcommands

### Promotion / management (Task 2)

- `name-session` → workerctl/cli.py:183
- `explain-managed-flow` → workerctl/cli.py:241
- `bind-task` → workerctl/cli.py:402
- `become-managed` → workerctl/cli.py:408
- `manage` → workerctl/cli.py:440
- `promote` → workerctl/cli.py:464
- `self-promote` → workerctl/cli.py:484
- `pause-manager` → workerctl/cli.py:505
- `close-manager` → workerctl/cli.py:512
- `unmanage` → workerctl/cli.py:518
- `my-status` → workerctl/cli.py:526
- `remanage` → workerctl/cli.py:533
- `resume-manager` → workerctl/cli.py:547

### Legacy supervision + task-scoped (Task 3)

- `supervise` → workerctl/cli.py:814
- `watch` → workerctl/cli.py:833
- `manager-observe` → workerctl/cli.py:640
- `manager-decision` → workerctl/cli.py:659
- `task-nudge` → workerctl/cli.py:682
- `task-interrupt` → workerctl/cli.py:701
- `task-idle-check` → workerctl/cli.py:672
- `task-capture` → workerctl/cli.py:631
- `task-events` → workerctl/cli.py:715
- `task-status` → workerctl/cli.py:611
- `task-health` → workerctl/cli.py:617
- `extend-nudge-budget` → workerctl/cli.py:691

### Reconcile family (Task 4 — collapse)

- `reconcile` (legacy) → workerctl/cli.py:587 — rewrite in place
- `recover` → workerctl/cli.py:592 — delete
- `close-stale` → workerctl/cli.py:602 — delete

## Retired command functions

### Lifecycle commands (Task 2 + Task 4)
- `command_name_session` → workerctl/commands.py:518
- `command_explain_managed_flow` → workerctl/commands.py:1106
- `command_bind_task` → workerctl/commands.py:1385
- `command_task_status` → workerctl/commands.py:1400
- `command_task_health` → workerctl/commands.py:1414
- `command_promote` → workerctl/lifecycle.py:211
- `command_self_promote` → workerctl/lifecycle.py:402
- `command_manage` → workerctl/lifecycle.py:430
- `command_become_managed` → workerctl/lifecycle.py:472
- `command_pause_manager` → workerctl/lifecycle.py:709
- `command_close_manager` → workerctl/lifecycle.py:719
- `command_unmanage` → workerctl/lifecycle.py:832
- `command_my_status` → workerctl/lifecycle.py:859
- `command_resume_manager` → workerctl/lifecycle.py:1045
- `command_remanage` → workerctl/lifecycle.py:1062
- `command_reconcile` → workerctl/lifecycle.py:1512
- `command_recover` → workerctl/lifecycle.py:1519
- `command_close_stale` → workerctl/lifecycle.py:1617

### Task-scoped commands (Task 3)
- `command_task_events` → workerctl/commands.py:1287
- `command_extend_nudge_budget` → workerctl/commands.py:1598
- `command_task_capture` → workerctl/commands.py:1890
- `command_task_idle_check` → workerctl/commands.py:2108
- `command_manager_observe` → workerctl/commands.py:2128
- `command_manager_decision` → workerctl/commands.py:2250
- `command_task_nudge` → workerctl/commands.py:2300
- `command_task_interrupt` → workerctl/commands.py:2429

### Supervision commands (Task 3)
- `command_supervise` → workerctl/supervise.py:131
- `command_watch` → workerctl/supervise.py:235

## Test class anchors (no decisions yet)

Classes in tests/test_workerctl.py that will be evaluated for method-level deletions in Tasks 2/3:

- `DatabaseTests` → line 42
- `ContractTests` → line 594
- `ClassifierTests` → line 605
- `CliTests` → line 661
- `TmuxTests` → line 5432
- `CodexSessionDiscoveryTests` → line 5548
- `SessionsSchemaTests` → line 5672
- `RegisterCommandsTests` → line 6052
- `BindCommandTests` → line 6331
- `CodexEventsSchemaTests` → line 6619
- `IngestModuleTests` → line 6829
- `IngestCliTests` → line 7200
- `StalenessTests` → line 7300
- `SessionTmuxTests` → line 7399
- `SessionActionCliTests` → line 7653
- `SuperviseCycleTests` → line 7792
- `CycleCliTests` → line 8282
- `ShadowStateTests` → line 8359
- `DivergencesTests` → line 8635
- `DivergencesCliTests` → line 8756

## Tmux helper candidates for Task 5

Evaluate after Tasks 2/3/4 land—keep if any kept command still calls:

- `tmux_target` → workerctl/tmux.py:31
- `session_exists` → workerctl/tmux.py:35
- `current_pane_id` → workerctl/tmux.py:40
- `capture_output` → workerctl/tmux.py:64
- `send_text` → workerctl/tmux.py:152
- `interrupt_worker` → workerctl/tmux.py:166

## Expected diff scale

- `workerctl/lifecycle.py`: 1692 → ~400 lines (Task 2 deletes promotion/management bodies; Task 4 rewrites/deletes reconcile; Task 6 sweeps orphans)
- `workerctl/commands.py`: 2979 → ~2400 lines (Task 3 deletes manager_observe/decision/task_* bodies; Task 4 adds new reconcile rewrite)
- `workerctl/supervise.py`: 263 → DELETED (Task 3 — file no longer needed)
- `workerctl/cli.py`: 942 → ~600 lines (subparser block removals across all tasks)
- `tests/test_workerctl.py`: 8856 → smaller (Tasks 2/3 delete legacy-command test methods)
- `workerctl/tmux.py`: 304 → possibly unchanged (Task 5 may be no-op if callers remain)

## Summary

- **29 CLI subcommands** inventoried: 13 promotion/management, 12 supervision/task-scoped, 3 reconcile
- **26 command_* functions** across lifecycle.py, commands.py, supervise.py
- **20 test classes** identified for method-level review
- **6 tmux helpers** flagged for orphan evaluation
