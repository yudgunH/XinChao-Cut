"""Time-partitioned FFmpeg export for timelines too large for one process.

Each chunk contains only clips that overlap its time window.  The regular
command builder still does all compositing; its private chunk fields rebase the
window while preserving clip-local animation time.  Chunks are encoded with an
identical stream layout and concatenated without another lossy encode.
"""
from __future__ import annotations

import json
import os
import sys
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Callable

from ..config import get_settings
from .chunk_cache import chunk_cache_key, chunk_cache_path, prune_chunk_cache
from .ffmpeg_build import (
    _MAX_GENERAL_INPUTS,
    _merge_contiguous_runs,
    _slice_clips_for_chunk,
    audio_mastering_filter,
    build_command,
    detect_video_encoder,
)
from .integrity import MaterializeCancelled, materialize_input


CHUNK_INPUT_TARGET = _MAX_GENERAL_INPUTS
MIN_CHUNK_SEC = 1 / 240
STATEFUL_AUDIO_SEAM_FADE_SEC = 0.005


@dataclass(frozen=True)
class TimeChunk:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def _clip_window(clip: dict) -> tuple[float, float]:
    start = float(clip.get("startSec", 0) or 0)
    speed = max(0.01, float(clip.get("speed", 1) or 1))
    source = max(
        0.0,
        float(clip.get("outPointSec", 0) or 0)
        - float(clip.get("inPointSec", 0) or 0),
    )
    return start, start + source / speed


def _input_clips(spec: dict) -> list[dict]:
    hidden = {t.get("id") for t in spec.get("tracks", []) if t.get("hidden")}
    visible = [
        c for c in spec.get("clips", [])
        if c.get("kind") not in ("text", "fx")
        and c.get("assetId")
        and c.get("trackId") not in hidden
        and _clip_window(c)[1] > _clip_window(c)[0]
    ]
    return [
        c for c in _merge_contiguous_runs(visible)
        if c.get("kind") not in ("text", "fx") and c.get("assetId")
    ]


def independent_input_count(spec: dict) -> int:
    """Conservative count; contiguous-run merging may make the real count lower."""
    return len(_input_clips(spec))


def requires_chunking(spec: dict) -> bool:
    return independent_input_count(spec) > _MAX_GENERAL_INPUTS


def benefits_from_incremental_chunks(spec: dict, segment_sec: float) -> bool:
    """Long edited timelines benefit; plain one-clip transcodes stay fast-path."""
    if segment_sec <= 0 or float(spec.get("durationSec", 0) or 0) <= segment_sec:
        return False
    media = [
        clip for clip in spec.get("clips", [])
        if clip.get("kind") in ("video", "audio", "image") and clip.get("assetId")
    ]
    if len(media) > 1:
        return True

    def number(value: object, default: float) -> float:
        return default if value is None else float(value)

    def non_neutral_transform(clip: dict) -> bool:
        transform = clip.get("transform") or {}
        crop = transform.get("crop") or {}
        return (
            abs(number(transform.get("x"), 0.5) - 0.5) > 1e-6
            or abs(number(transform.get("y"), 0.5) - 0.5) > 1e-6
            or abs(number(transform.get("scale"), 1) - 1) > 1e-6
            or abs(number(transform.get("scaleX"), 1) - 1) > 1e-6
            or abs(number(transform.get("scaleY"), 1) - 1) > 1e-6
            or abs(number(transform.get("rotation"), 0)) > 1e-6
            or bool(transform.get("flipH"))
            or bool(transform.get("flipV"))
            or any(abs(number(crop.get(side), 0)) > 1e-6 for side in "lrtb")
        )

    def is_edited(clip: dict) -> bool:
        adjust = clip.get("adjust") or {}
        fill = clip.get("canvasFill") or {}
        return (
            clip.get("kind") in ("text", "fx")
            or bool(clip.get("effects"))
            or bool(clip.get("keyframes"))
            or bool(clip.get("denoise"))
            or abs(number(clip.get("speed"), 1) - 1) > 1e-6
            or abs(number(clip.get("opacity"), 1) - 1) > 1e-6
            or abs(number(clip.get("volume"), 1) - 1) > 1e-6
            or any(
                abs(number(adjust.get(key), 0)) > 1e-6
                for key in ("brightness", "contrast", "saturation")
            )
            or fill.get("mode") == "blur"
            or non_neutral_transform(clip)
        )

    return any(is_edited(clip) for clip in spec.get("clips", []))


def choose_chunk_parallelism(
    chunk_count: int,
    *,
    encoder: str | None,
    audio_only: bool = False,
) -> int:
    """Choose bounded concurrency without oversubscribing CPU/GPU sessions.

    A positive config remains an explicit operator override. Auto mode budgets
    roughly six logical CPUs per FFmpeg filtergraph; hardware video is capped at
    two concurrent encoder sessions, while PCM-only work can scale to three.
    """
    if chunk_count <= 0:
        return 1
    configured = int(get_settings().export_chunk_parallelism)
    if configured > 0:
        return min(chunk_count, max(1, min(4, configured)))
    logical_cpus = max(1, os.cpu_count() or 1)
    cpu_slots = max(1, logical_cpus // 6)
    if audio_only:
        desired = min(3, cpu_slots)
    elif encoder and any(
        encoder.endswith(suffix)
        for suffix in ("_nvenc", "_qsv", "_amf", "_videotoolbox")
    ):
        desired = min(2, cpu_slots)
    else:
        desired = min(3, cpu_slots)
    return min(chunk_count, max(1, desired))


def plan_time_chunks(
    spec: dict,
    target: int = CHUNK_INPUT_TARGET,
    *,
    max_duration: float | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> list[TimeChunk]:
    """Bisect until every window references at most ``target`` media inputs.

    Time partitioning cannot help a frame with more than ``target`` simultaneous
    layers.  Detect that case at frame-scale and return an actionable error
    instead of recursing forever.
    """
    duration = float(spec["durationSec"])
    fps = max(1, int(spec.get("fps", 30) or 30))

    def check_cancelled() -> None:
        if cancel_check and cancel_check():
            raise MaterializeCancelled("Chunk planning was cancelled")

    check_cancelled()
    inputs = _input_clips(spec)
    check_cancelled()
    minimum = max(MIN_CHUNK_SEC, 1 / fps)
    windows: list[tuple[float, float]] = []
    for index, clip in enumerate(inputs):
        if index % 256 == 0:
            check_cancelled()
        windows.append(_clip_window(clip))
    starts = sorted(start for start, _end in windows)
    ends = sorted(end for _start, end in windows)
    boundaries = sorted({point for window in windows for point in window})
    spanning_by_boundary: dict[float, int] = {}
    for index, point in enumerate(boundaries):
        if index % 256 == 0:
            check_cancelled()
        spanning_by_boundary[point] = (
            bisect_left(starts, point) - bisect_right(ends, point)
        )

    def overlapping(start: float, end: float) -> int:
        return bisect_left(starts, end) - bisect_right(ends, start)

    out: list[TimeChunk] = []

    def split(start: float, end: float) -> None:
        check_cancelled()
        count = overlapping(start, end)
        duration_ok = max_duration is None or end - start <= max_duration + 1e-9
        if count <= target and duration_ok:
            out.append(TimeChunk(start, end))
            return
        if count > target and end - start <= minimum * 1.01:
            raise ValueError(
                f"Timeline has {count} simultaneous media layers near {start:.3f}s; "
                f"chunk rendering supports at most {target}. Flatten/nest some layers."
            )
        mid = (start + end) / 2
        # Prefer a nearby source boundary with the fewest spanning clips. This
        # avoids resetting stateful audio filters in the middle of a clip when
        # the same planner is used by Hybrid PCM stages.
        lo = start + (end - start) * 0.2
        hi = end - (end - start) * 0.2
        first = bisect_right(boundaries, lo)
        last = bisect_left(boundaries, hi)
        if first < last:
            best: tuple[int, float, float] | None = None
            for index in range(first, last):
                if index % 256 == 0:
                    check_cancelled()
                point = boundaries[index]
                score = (spanning_by_boundary[point], abs(point - mid), point)
                if best is None or score < best:
                    best = score
            if best is not None:
                mid = best[2]
        # Snap to a frame so adjacent chunks have deterministic boundaries.
        mid = round(mid * fps) / fps
        if mid <= start + minimum / 2 or mid >= end - minimum / 2:
            mid = (start + end) / 2
        split(start, mid)
        split(mid, end)

    split(0.0, duration)
    return out


def build_chunk_runner_command(
    spec: dict,
    asset_paths: dict[str, str],
    final_temp: str,
    work_dir: str,
    *,
    target: int = CHUNK_INPUT_TARGET,
    before_font_copy: Callable[[str, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    max_duration: float | None = None,
) -> tuple[list[str], list[TimeChunk]]:
    chunks = plan_time_chunks(
        spec,
        target=target,
        max_duration=max_duration,
        cancel_check=cancel_check,
    )
    encoder = detect_video_encoder(str(spec.get("videoCodec") or "h264"))
    max_parallel = choose_chunk_parallelism(
        len(chunks), encoder=encoder
    )
    prune_chunk_cache()
    chunk_dir = os.path.join(work_dir, "chunks")
    os.makedirs(chunk_dir, exist_ok=True)
    stages: list[dict] = []
    outputs: list[str] = []

    for idx, chunk in enumerate(chunks):
        output = os.path.join(chunk_dir, f"chunk-{idx:05d}.mkv")
        chunk_work = os.path.join(chunk_dir, f"work-{idx:05d}")
        os.makedirs(chunk_work, exist_ok=True)
        fonts = os.path.join(work_dir, "fonts")
        if os.path.isdir(fonts):
            for name in os.listdir(fonts):
                src = os.path.join(fonts, name)
                if not os.path.isfile(src):
                    continue
                materialize_input(
                    src,
                    os.path.join(chunk_work, "fonts", name),
                    before_copy=before_font_copy,
                    cancel_check=cancel_check,
                )
        chunk_spec = {
            **spec,
            "durationSec": chunk.duration,
            "_chunkStartSec": chunk.start,
            "_chunkEndSec": chunk.end,
            "_disableFastPath": True,
            "_forceAudioStream": True,
            "_chunkIntermediate": True,
            "_seamAudioFadeInSec": (
                STATEFUL_AUDIO_SEAM_FADE_SEC if idx > 0 else 0
            ),
            "_seamAudioFadeOutSec": (
                STATEFUL_AUDIO_SEAM_FADE_SEC if idx + 1 < len(chunks) else 0
            ),
            "audioMastering": "off",
            "_parallelChunks": max_parallel,
        }
        cache_spec = {
            key: value
            for key, value in chunk_spec.items()
            if key not in {
                "requestId", "clips", "_chunkStartSec", "_chunkEndSec",
                "_parallelChunks",
            }
        }
        cache_spec["clips"] = _slice_clips_for_chunk(
            list(spec.get("clips", [])), chunk.start, chunk.end
        )
        cache_key = chunk_cache_key(
            "server-video",
            cache_spec,
            asset_paths,
            encoder=encoder,
        )
        cache_path = chunk_cache_path("server-video", cache_key, ".mkv")
        cmd = build_command(chunk_spec, asset_paths, output, chunk_work)
        stages.append({
            "cmd": cmd,
            "cwd": chunk_work,
            "duration": chunk.duration,
            "offset": chunk.start,
            "output": output,
            "cachePath": cache_path,
        })
        outputs.append(output)

    concat_path = os.path.join(chunk_dir, "concat.txt")
    with open(concat_path, "w", encoding="utf-8", newline="\n") as f:
        for path in outputs:
            # concat-demuxer escaping: single quote is represented as '\''.
            escaped = os.path.abspath(path).replace("\\", "/").replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    manifest = os.path.join(chunk_dir, "manifest.json")
    audio_bitrate_kbps = max(
        64, min(512, int(spec.get("audioBitrateKbps", 192)))
    )
    with open(manifest, "w", encoding="utf-8") as f:
        concat_cmd = [
            "ffmpeg", "-hide_banner", "-y", "-f", "concat", "-safe", "0",
            "-i", concat_path,
        ]
        mastering = audio_mastering_filter(spec)
        if mastering:
            concat_cmd += ["-af", mastering]
        concat_cmd += [
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k",
            "-ac", "2", "-ar", "48000",
            "-movflags", "+faststart", final_temp,
        ]
        json.dump({
            "totalDuration": float(spec["durationSec"]),
            "maxParallel": max_parallel,
            "stages": stages,
            "concat": concat_cmd,
        }, f)

    runner = os.path.join(os.path.dirname(__file__), "chunk_runner.py")
    return [sys.executable, runner, manifest], chunks
