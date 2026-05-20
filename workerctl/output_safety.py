from __future__ import annotations

import copy
from typing import Any


CONTENT_KEYS = {
    "content",
    "message",
    "output",
    "segment_text",
    "text",
}


def redact_payload(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_payload(item) for item in value]
    if not isinstance(value, dict):
        return value

    redacted: dict[str, Any] = {}
    for key, item in value.items():
        if key in CONTENT_KEYS and isinstance(item, str):
            redacted[f"{key}_redacted"] = True
            redacted[f"{key}_byte_count"] = len(item.encode())
            redacted[f"{key}_line_count"] = len(item.splitlines())
            continue
        redacted[key] = redact_payload(item)
    return redacted


def redact_capture_result(result: dict[str, Any]) -> dict[str, Any]:
    safe = copy.deepcopy(result)
    for capture in safe.get("captures", []):
        if not isinstance(capture, dict):
            continue
        capture_payload = capture.get("capture")
        if isinstance(capture_payload, dict) and isinstance(capture_payload.get("output"), str):
            output = capture_payload.pop("output")
            capture_payload["output_redacted"] = True
            capture_payload["output_byte_count"] = len(output.encode())
            capture_payload["output_line_count"] = len(output.splitlines())
    return safe


def redact_transcript_segments(result: dict[str, Any]) -> dict[str, Any]:
    safe = copy.deepcopy(result)
    for segment in safe.get("segments", []):
        if not isinstance(segment, dict):
            continue
        text = segment.pop("segment_text", None)
        if isinstance(text, str):
            segment["segment_text_redacted"] = True
            segment["segment_text_byte_count"] = len(text.encode())
            segment["segment_text_line_count"] = len(text.splitlines())
    return safe


def redact_audit(audit: dict[str, Any]) -> dict[str, Any]:
    safe = copy.deepcopy(audit)
    for capture in safe.get("terminal_captures", []):
        if not isinstance(capture, dict):
            continue
        content = capture.pop("content", None)
        if isinstance(content, str):
            capture["content_redacted"] = True
            capture["content_byte_count"] = len(content.encode())
            capture["content_line_count"] = len(content.splitlines())
    for segment in safe.get("transcript_segments", []):
        if not isinstance(segment, dict):
            continue
        text = segment.pop("segment_text", None)
        if isinstance(text, str):
            segment["segment_text_redacted"] = True
            segment["segment_text_byte_count"] = len(text.encode())
            segment["segment_text_line_count"] = len(text.splitlines())
    return safe
