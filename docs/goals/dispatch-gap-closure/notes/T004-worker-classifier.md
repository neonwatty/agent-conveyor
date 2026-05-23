# T004 Worker Receipt

Result: done

Objective: implement #128 by making pane classification avoid historical-transcript false positives while preserving active approval prompt detection.

Changed files:

- `workerctl/classify.py`
- `tests/test_workerctl.py`

Summary:

- Added a bottom-region approval prompt detector for `approval_prompt`.
- Historical/audit tokens such as `approval_prompt`, `inspect_or_approve`, and `notable_pane_pattern` are ignored when deciding whether an active approval prompt is present.
- Other busy-wait patterns keep their existing full-output behavior.
- Added regression tests for historical approval-prompt transcript text and a positive active approval prompt.

Verification:

- `python3 -m unittest tests.test_workerctl.ClassifierTests tests.test_workerctl.ShadowStateTests -v`: pass, 20 tests
- `python3 -m py_compile workerctl/*.py`: pass
- `python3 -m unittest tests.test_workerctl -v`: pass, 431 tests
- `git diff --check`: pass

Notes:

- This does not add any new stored classifier fields, preserving the persisted `pane_signal.classifier` shape.
- The detector is intentionally conservative for approval prompts because false `inspect_or_approve` guidance is operator-hostile.
