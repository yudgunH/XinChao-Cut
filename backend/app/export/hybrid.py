"""Scalable audio-finalization pipeline for Browser Hybrid Export.

The browser supplies a video-only MP4 whose pixels already match preview.  For
normal timelines one FFmpeg process mixes the original sources and stream-copies
that video.  Timelines with many independent audio clips are partitioned by
time, mixed to PCM chunks, concatenated losslessly, then AAC-encoded exactly
once during the final video mux.
"""
from __future__ import annotations

import json
import os
import sys

from ..config import get_settings
from .chunked import (
    CHUNK_INPUT_TARGET,
    benefits_from_incremental_chunks,
    choose_chunk_parallelism,
    plan_time_chunks,
    requires_chunking,
)
from .chunk_cache import chunk_cache_key, chunk_cache_path, prune_chunk_cache
from .ffmpeg_build import (
    _slice_clips_for_chunk,
    audio_mastering_filter,
    build_hybrid_audio_mux_command,
    build_hybrid_audio_pcm_command,
)

HYBRID_PCM_CHUNK_MAX_SEC = 2 * 3600
HYBRID_STATEFUL_SEAM_FADE_SEC = 0.005


def _clip_window(clip: dict) -> tuple[float, float]:
    start = float(clip.get("startSec", 0) or 0)
    speed = max(0.01, float(clip.get("speed", 1) or 1))
    source_duration = max(
        0.0,
        float(clip.get("outPointSec", 0) or 0)
        - float(clip.get("inPointSec", 0) or 0),
    )
    return start, start + source_duration / speed


def _is_stateful_audio(clip: dict) -> bool:
    speed = max(0.01, float(clip.get("speed", 1) or 1))
    return bool(clip.get("denoise")) or abs(speed - 1) > 1e-6


def _slice_audio_clips_for_chunk(
    clips: list[dict],
    start: float,
    end: float,
    *,
    fade_in: bool,
    fade_out: bool,
) -> list[dict]:
    """Slice a chunk and mark only stateful inputs that cross its boundaries.

    Applying the seam fade after ``amix`` caused a notch in every concurrent
    input, including uninterrupted music beds. Private per-clip flags let the
    shared audio chain soften only the filter whose state is being restarted.
    """
    originals = {str(clip.get("id")): clip for clip in clips if clip.get("id")}
    sliced = _slice_clips_for_chunk(clips, start, end)
    for clip in sliced:
        original = originals.get(str(clip.get("id")))
        if not original or not _is_stateful_audio(original):
            continue
        clip_start, clip_end = _clip_window(original)
        if fade_in and clip_start < start < clip_end:
            clip["_seamFadeInSec"] = HYBRID_STATEFUL_SEAM_FADE_SEC
        if fade_out and clip_start < end < clip_end:
            clip["_seamFadeOutSec"] = HYBRID_STATEFUL_SEAM_FADE_SEC
    return sliced


def _audio_only_spec(spec: dict) -> dict:
    """Exclude visual/text/fx inputs from Hybrid audio chunk admission."""
    excluded_tracks = {
        t.get("id")
        for t in spec.get("tracks", [])
        if t.get("muted") or t.get("hidden")
    }
    clips = [
        c for c in spec.get("clips", [])
        if c.get("kind") in ("video", "audio")
        and c.get("assetId")
        and not c.get("muted")
        and c.get("trackId") not in excluded_tracks
        and float(c.get("volume", 1) or 0) > 0
    ]
    return {**spec, "clips": clips}


def hybrid_requires_chunking(spec: dict) -> bool:
    audio_spec = _audio_only_spec(spec)
    cache_segment_sec = max(
        0, int(get_settings().export_chunk_cache_segment_sec)
    )
    return requires_chunking(audio_spec) or benefits_from_incremental_chunks(
        audio_spec, cache_segment_sec
    )


def build_hybrid_command(
    spec: dict,
    asset_paths: dict[str, str],
    browser_video_path: str,
    final_temp: str,
    work_dir: str,
) -> tuple[list[str], int]:
    """Return the direct FFmpeg command or a chunk-runner supervisor command."""
    audio_spec = _audio_only_spec(spec)
    cache_segment_sec = max(
        0, int(get_settings().export_chunk_cache_segment_sec)
    )
    incremental_chunks = benefits_from_incremental_chunks(
        audio_spec, cache_segment_sec
    )
    if not requires_chunking(audio_spec) and not incremental_chunks:
        return (
            build_hybrid_audio_mux_command(
                spec, asset_paths, browser_video_path, final_temp, work_dir
            ),
            0,
        )

    chunk_max_duration = HYBRID_PCM_CHUNK_MAX_SEC
    if cache_segment_sec > 0:
        chunk_max_duration = min(chunk_max_duration, cache_segment_sec)
    chunks = plan_time_chunks(
        audio_spec,
        target=CHUNK_INPUT_TARGET,
        max_duration=chunk_max_duration,
    )
    max_parallel = choose_chunk_parallelism(
        len(chunks), encoder=None, audio_only=True
    )
    prune_chunk_cache()
    chunk_dir = os.path.join(work_dir, "hybrid-audio-chunks")
    os.makedirs(chunk_dir, exist_ok=True)
    stages: list[dict] = []
    outputs: list[str] = []

    for idx, chunk in enumerate(chunks):
        # NUT has no RIFF 4-GiB ceiling. A 48 kHz stereo s16 WAV crosses that
        # ceiling after ~6h12m, which made very long Hybrid exports fail late.
        output = os.path.join(chunk_dir, f"audio-{idx:05d}.nut")
        chunk_work = os.path.join(chunk_dir, f"work-{idx:05d}")
        os.makedirs(chunk_work, exist_ok=True)
        chunk_spec = {
            **spec,
            "durationSec": chunk.duration,
            "audioMastering": "off",
            "_parallelChunks": max_parallel,
            "clips": _slice_audio_clips_for_chunk(
                list(spec.get("clips", [])),
                chunk.start,
                chunk.end,
                fade_in=idx > 0,
                fade_out=idx + 1 < len(chunks),
            ),
        }
        cache_key = chunk_cache_key(
            "hybrid-audio",
            {
                key: value
                for key, value in chunk_spec.items()
                if key not in {"requestId", "_parallelChunks"}
            },
            asset_paths,
            encoder="pcm-s16le-48k-stereo",
        )
        cache_path = chunk_cache_path("hybrid-audio", cache_key, ".nut")
        cmd = build_hybrid_audio_pcm_command(
            chunk_spec, asset_paths, output, chunk_work
        )
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
    with open(concat_path, "w", encoding="utf-8", newline="\n") as out:
        for path in outputs:
            escaped = os.path.abspath(path).replace("\\", "/").replace("'", "'\\''")
            out.write(f"file '{escaped}'\n")

    # The concat demuxer reads the PCM NUT chunks as one continuous stream. AAC
    # is encoded only here, so no per-chunk encoder delay/click is introduced.
    audio_bitrate_kbps = max(
        64, min(512, int(spec.get("audioBitrateKbps", 192)))
    )
    final_cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-i", browser_video_path,
        "-f", "concat", "-safe", "0", "-i", concat_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
    ]
    mastering = audio_mastering_filter(spec)
    if mastering:
        final_cmd += ["-af", mastering]
    final_cmd += [
        "-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k", "-ac", "2", "-ar", "48000",
        "-t", f"{float(spec['durationSec']):.6f}",
        "-movflags", "+faststart", final_temp,
    ]
    manifest = os.path.join(chunk_dir, "manifest.json")
    with open(manifest, "w", encoding="utf-8") as out:
        json.dump({
            "totalDuration": float(spec["durationSec"]),
            "maxParallel": max_parallel,
            "stages": stages,
            "concat": final_cmd,
        }, out)

    runner = os.path.join(os.path.dirname(__file__), "chunk_runner.py")
    return [sys.executable, runner, manifest], len(chunks)
