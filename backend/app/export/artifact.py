"""Bounded validation of a completed export before it is published.

FFmpeg returning zero proves that the process exited cleanly, not that the
container has the streams and duration the timeline promised.
"""
from __future__ import annotations

import os

from ..ffmpeg_utils import probe


class ExportArtifactError(RuntimeError):
    """The encoded file does not satisfy its declared export contract."""


def validate_export_artifact(
    path: str,
    *,
    expected_duration: float,
    expect_audio: bool = False,
) -> dict:
    """Probe the final temp MP4 and return compact diagnostics or raise."""
    if not path or not os.path.isfile(path) or os.path.getsize(path) < 256:
        raise ExportArtifactError("encoded output is missing or empty")
    try:
        meta = probe(path)
    except Exception as exc:  # noqa: BLE001 - normalized as an artifact failure
        raise ExportArtifactError(f"encoded output cannot be probed: {exc}") from exc
    if not meta.get("hasVideo"):
        raise ExportArtifactError("encoded output has no video stream")
    actual_duration = float(meta.get("durationSec") or 0.0)
    expected = max(0.0, float(expected_duration or 0.0))
    tolerance = max(0.5, min(2.0, expected * 0.01))
    if actual_duration <= 0 or (
        expected > 0 and abs(actual_duration - expected) > tolerance
    ):
        raise ExportArtifactError(
            "encoded duration mismatch: "
            f"expected {expected:.3f}s, got {actual_duration:.3f}s "
            f"(tolerance {tolerance:.3f}s)"
        )
    if expect_audio and not meta.get("hasAudio"):
        raise ExportArtifactError("encoded output has no audio stream")

    return {
        "durationSec": round(actual_duration, 3),
        "hasVideo": bool(meta.get("hasVideo")),
        "hasAudio": bool(meta.get("hasAudio")),
        "bytes": os.path.getsize(path),
    }
