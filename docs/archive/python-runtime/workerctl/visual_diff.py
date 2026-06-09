from __future__ import annotations

import json
import math
import struct
import zlib
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _read_png_rgba(path: Path) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise WorkerError(f"unable to read visual diff PNG {path}: {exc}") from exc
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise WorkerError(f"unsupported image format for visual diff: {path} is not a PNG")
    offset = 8
    width = height = bit_depth = color_type = None
    compressed = bytearray()
    while offset < len(data):
        if offset + 8 > len(data):
            raise WorkerError(f"invalid PNG: truncated chunk header in {path}")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(">IIBBBBB", payload)
            if bit_depth != 8 or color_type not in {2, 6} or compression != 0 or filter_method != 0 or interlace != 0:
                raise WorkerError("visual diff supports non-interlaced 8-bit RGB/RGBA PNG screenshots")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    if width is None or height is None or bit_depth is None or color_type is None:
        raise WorkerError(f"invalid PNG: missing IHDR in {path}")
    if width < 1 or height < 1:
        raise WorkerError(f"invalid PNG dimensions in {path}: width and height must be positive")
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    try:
        raw = zlib.decompress(bytes(compressed))
    except zlib.error as exc:
        raise WorkerError(f"invalid PNG compression in {path}: {exc}") from exc
    expected = (stride + 1) * height
    if len(raw) != expected:
        raise WorkerError(f"invalid PNG scanline length in {path}")
    rows: list[bytes] = []
    pos = 0
    previous = bytes(stride)
    for _ in range(height):
        filter_type = raw[pos]
        pos += 1
        scanline = bytearray(raw[pos : pos + stride])
        pos += stride
        for i, value in enumerate(scanline):
            left = scanline[i - channels] if i >= channels else 0
            up = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0
            if filter_type == 0:
                reconstructed = value
            elif filter_type == 1:
                reconstructed = value + left
            elif filter_type == 2:
                reconstructed = value + up
            elif filter_type == 3:
                reconstructed = value + ((left + up) // 2)
            elif filter_type == 4:
                reconstructed = value + _paeth(left, up, upper_left)
            else:
                raise WorkerError(f"unsupported PNG filter type {filter_type} in {path}")
            scanline[i] = reconstructed & 0xFF
        previous = bytes(scanline)
        rows.append(previous)
    pixels: list[tuple[int, int, int, int]] = []
    for row in rows:
        for i in range(0, len(row), channels):
            if channels == 4:
                pixels.append((row[i], row[i + 1], row[i + 2], row[i + 3]))
            else:
                pixels.append((row[i], row[i + 1], row[i + 2], 255))
    return width, height, pixels


def _write_png_rgba(path: Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    raw_rows = []
    for y in range(height):
        start = y * width
        row = b"".join(bytes(pixel) for pixel in pixels[start : start + width])
        raw_rows.append(b"\x00" + row)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(b"".join(raw_rows)))
        + _png_chunk(b"IEND", b"")
    )


def compute_visual_diff(
    *,
    reference_path: Path,
    candidate_path: Path,
    threshold: float,
    diff_output: Path | None = None,
    report_output: Path | None = None,
) -> dict[str, Any]:
    if not math.isfinite(threshold) or threshold < 0 or threshold > 1:
        raise WorkerError("--threshold must be between 0 and 1")
    ref_width, ref_height, reference = _read_png_rgba(reference_path)
    cand_width, cand_height, candidate = _read_png_rgba(candidate_path)
    if (ref_width, ref_height) != (cand_width, cand_height):
        raise WorkerError(
            "visual diff screenshots must have matching dimensions: "
            f"reference={ref_width}x{ref_height} candidate={cand_width}x{cand_height}"
        )
    diff_pixels: list[tuple[int, int, int, int]] = []
    changed_pixels = 0
    for ref_pixel, candidate_pixel in zip(reference, candidate):
        if ref_pixel != candidate_pixel:
            changed_pixels += 1
            diff_pixels.append((255, 0, 0, 255))
        else:
            diff_pixels.append((0, 0, 0, 0))
    total_pixels = ref_width * ref_height
    diff_score = changed_pixels / total_pixels if total_pixels else 0.0
    if diff_output is not None:
        _write_png_rgba(diff_output, ref_width, ref_height, diff_pixels)
    report = {
        "reference": str(reference_path),
        "candidate": str(candidate_path),
        "diff_image": str(diff_output) if diff_output is not None else None,
        "viewport": f"{ref_width}x{ref_height}",
        "changed_pixels": changed_pixels,
        "total_pixels": total_pixels,
        "diff_score": diff_score,
        "threshold": threshold,
        "below_threshold": diff_score <= threshold,
    }
    if report_output is not None:
        report_output.parent.mkdir(parents=True, exist_ok=True)
        report_output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report
