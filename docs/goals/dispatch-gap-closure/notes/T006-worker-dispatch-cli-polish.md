# T006 Worker Receipt

Result: done

Objective: implement local dispatch CLI and command-observability polish with low coupling.

Changed files:

- `workerctl/cli.py`
- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`

Summary:

- Exposed public `dispatch --watch-iterations N`, wiring the already-existing bounded watch support into the CLI for scripts and verification.
- Added `commands --attempts` to include per-dispatcher `command_attempts` history in JSON output and concise text output.
- Documented both surfaces in README.
- Left command lease tuning unchanged because Judge flagged it as requiring review before changing claim/retry semantics.
- Did not change `command_enqueue_notify_manager` for the duplicate result-key concern because the current output path did not reproduce the duplicate; this remains a no-op verification note rather than code churn.

Verification:

- `python3 -m unittest tests.test_workerctl.DispatchTests.test_dispatch_cli_help_exposes_watch_iterations tests.test_workerctl.DispatchTests.test_dispatch_watch_runs_bounded_passes_with_limit_and_interval tests.test_workerctl.CliTests.test_commands_cli_can_include_attempt_history tests.test_workerctl.CliTests.test_commands_cli_lists_durable_commands -v`: pass
- `python3 -m py_compile workerctl/*.py`: pass
- `python3 -m unittest tests.test_workerctl -v`: pass, 434 tests
- `git diff --check`: pass

Notes:

- `--watch-iterations` is intentionally bounded only for `--watch`; `--once` remains the single-pass mode.
- Attempt history includes side-effect started/completed flags so operators can distinguish retry-safe and retry-risky failures.
