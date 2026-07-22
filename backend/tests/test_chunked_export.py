from __future__ import annotations

import json
import os
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from app.export import chunked
from app.export import ffmpeg_build as fb
from app.export.integrity import MaterializeCancelled
from app.export.job import Job
from app.routers import export as export_router


def _clip(index: int, *, start: float | None = None, duration: float = 1.0) -> dict:
    return {
        "id": f"c{index}",
        "trackId": "v1",
        "kind": "video",
        "assetId": f"a{index}",
        "startSec": float(index if start is None else start),
        "inPointSec": 0.0,
        "outPointSec": duration,
        "speed": 1.0,
    }


def _spec(clips: list[dict], duration: float) -> dict:
    return {
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "durationSec": duration,
        "videoBitrateKbps": 8000,
        "tracks": [{"id": "v1"}],
        "clips": clips,
    }


def test_sequential_large_timeline_is_partitioned_under_input_budget():
    spec = _spec([_clip(i) for i in range(140)], 140.0)

    chunks = chunked.plan_time_chunks(spec)

    assert len(chunks) > 1
    assert chunks[0].start == 0
    assert chunks[-1].end == 140
    for window in chunks:
        count = sum(
            1 for clip in spec["clips"]
            if clip["startSec"] < window.end
            and clip["startSec"] + 1 > window.start
        )
        assert count <= chunked.CHUNK_INPUT_TARGET


def test_more_than_budget_simultaneous_layers_fails_actionably():
    spec = _spec(
        [_clip(i, start=0, duration=2) for i in range(chunked.CHUNK_INPUT_TARGET + 1)],
        2.0,
    )

    with pytest.raises(ValueError, match="simultaneous media layers"):
        chunked.plan_time_chunks(spec)


def test_plain_long_single_clip_keeps_the_fast_path():
    spec = _spec([_clip(0, duration=3600)], 3600)

    assert not chunked.benefits_from_incremental_chunks(spec, 300)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("opacity", 0.5),
        ("volume", 0.5),
        ("adjust", {"brightness": 10, "contrast": 0, "saturation": 0}),
        ("transform", {"x": 0.6, "y": 0.5, "scale": 1}),
        ("canvasFill", {"mode": "blur", "blurPx": 34}),
    ],
)
def test_long_edited_single_clip_uses_incremental_chunks(field, value):
    clip = _clip(0, duration=3600)
    clip[field] = value
    spec = _spec([clip], 3600)

    assert chunked.benefits_from_incremental_chunks(spec, 300)


def test_incremental_chunk_duration_is_bounded():
    clip = _clip(0, duration=3600)
    clip["effects"] = [{"type": "fade-in", "params": {"duration": 1}}]
    spec = _spec([clip], 3600)

    chunks = chunked.plan_time_chunks(spec, max_duration=300)

    assert len(chunks) > 1
    assert max(window.duration for window in chunks) <= 300 + 1e-9
    assert chunks[0].start == 0
    assert chunks[-1].end == 3600


def test_chunk_planning_can_be_cancelled_before_large_work_starts():
    spec = _spec([_clip(i) for i in range(10_000)], 10_000.0)

    with pytest.raises(MaterializeCancelled, match="planning was cancelled"):
        chunked.plan_time_chunks(spec, cancel_check=lambda: True)


def test_chunk_planner_does_not_recompute_every_clip_per_boundary(monkeypatch):
    spec = _spec([_clip(i) for i in range(2_000)], 2_000.0)
    original = chunked._clip_window
    calls = 0

    def counted(clip):
        nonlocal calls
        calls += 1
        return original(clip)

    monkeypatch.setattr(chunked, "_clip_window", counted)
    chunks = chunked.plan_time_chunks(spec)

    assert len(chunks) > 1
    # Input filtering currently probes each clip twice, then planning computes
    # each surviving window once. The old boundary scorer was quadratic.
    assert calls <= len(spec["clips"]) * 4


def test_chunk_slice_preserves_source_and_animation_clock():
    original = _clip(1, start=5, duration=20)
    original["speed"] = 2.0
    original["outPointSec"] = 20.0  # ten timeline seconds: [5, 15]

    sliced = fb._slice_clips_for_chunk([original], 8.0, 12.0)

    assert len(sliced) == 1
    clip = sliced[0]
    assert clip["startSec"] == 0
    assert clip["inPointSec"] == 6
    assert clip["outPointSec"] == 14
    assert clip["_animationOffsetSec"] == 3
    assert clip["_animationDurationSec"] == 10


def test_build_runner_manifest_has_identical_chunk_stream_contract(monkeypatch, tmp_path):
    spec = _spec([_clip(i) for i in range(100)], 100.0)
    spec["audioMastering"] = "social"
    seen: list[dict] = []

    def fake_build(chunk_spec, _assets, output, _work):
        seen.append(chunk_spec)
        return ["ffmpeg", "-i", "input", output]

    monkeypatch.setattr(chunked, "build_command", fake_build)
    command, chunks = chunked.build_chunk_runner_command(
        spec, {}, str(tmp_path / "final.mp4"), str(tmp_path)
    )

    assert command[0]
    assert os.path.basename(command[1]) == "chunk_runner.py"
    assert len(chunks) == len(seen) > 1
    assert all(
        s["_disableFastPath"] and s["_forceAudioStream"] and s["_chunkIntermediate"]
        for s in seen
    )
    assert all(s["audioMastering"] == "off" for s in seen)
    assert seen[0]["_seamAudioFadeInSec"] == 0
    assert seen[0]["_seamAudioFadeOutSec"] > 0
    assert seen[-1]["_seamAudioFadeInSec"] > 0
    assert seen[-1]["_seamAudioFadeOutSec"] == 0
    with open(command[2], encoding="utf-8") as f:
        manifest = json.load(f)
    assert len(manifest["stages"]) == len(chunks)
    assert 1 <= manifest["maxParallel"] <= min(4, len(chunks))
    assert all(stage["cachePath"].endswith(".mkv") for stage in manifest["stages"])
    assert "loudnorm=I=-14" in " ".join(manifest["concat"])
    assert manifest["concat"][-1] == str(tmp_path / "final.mp4")


def test_chunk_slice_fades_only_stateful_audio_crossing_a_seam():
    stateful = _clip(0, start=0, duration=10)
    stateful["denoise"] = "medium"
    plain = _clip(1, start=0, duration=10)

    sliced = fb._slice_clips_for_chunk(
        [stateful, plain],
        2,
        8,
        seam_fade_in_sec=0.005,
        seam_fade_out_sec=0.005,
    )

    assert sliced[0]["_seamFadeInSec"] == 0.005
    assert sliced[0]["_seamFadeOutSec"] == 0.005
    assert "_seamFadeInSec" not in sliced[1]
    assert "_seamFadeOutSec" not in sliced[1]


def test_chunk_slice_does_not_replay_real_clip_edge_fades_mid_clip():
    clip = _clip(0, start=0, duration=10)
    clip["audioFadeInSec"] = 0.008
    clip["audioFadeOutSec"] = 0.012

    middle = fb._slice_clips_for_chunk([clip], 2, 8)[0]
    first = fb._slice_clips_for_chunk([clip], 0, 8)[0]
    last = fb._slice_clips_for_chunk([clip], 2, 10)[0]

    assert "audioFadeInSec" not in middle and "audioFadeOutSec" not in middle
    assert first["audioFadeInSec"] == 0.008 and "audioFadeOutSec" not in first
    assert "audioFadeInSec" not in last and last["audioFadeOutSec"] == 0.012


def test_chunk_parallelism_auto_respects_cpu_and_encoder_limits(monkeypatch):
    monkeypatch.setattr(
        chunked,
        "get_settings",
        lambda: SimpleNamespace(export_chunk_parallelism=0),
    )
    monkeypatch.setattr(chunked.os, "cpu_count", lambda: 24)

    assert chunked.choose_chunk_parallelism(10, encoder="h264_nvenc") == 2
    assert chunked.choose_chunk_parallelism(10, encoder="libx264") == 3
    assert chunked.choose_chunk_parallelism(
        10, encoder=None, audio_only=True
    ) == 3


def test_chunk_parallelism_operator_override_wins(monkeypatch):
    monkeypatch.setattr(
        chunked,
        "get_settings",
        lambda: SimpleNamespace(export_chunk_parallelism=4),
    )
    monkeypatch.setattr(chunked.os, "cpu_count", lambda: 2)

    assert chunked.choose_chunk_parallelism(3, encoder="h264_nvenc") == 3


def test_chunk_fonts_are_hardlinked_not_copied_per_chunk(monkeypatch, tmp_path):
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    source_font = fonts / "used.ttf"
    source_font.write_bytes(b"font-bytes")
    monkeypatch.setattr(
        chunked,
        "build_command",
        lambda _spec, _assets, output, _work: ["ffmpeg", "-i", "input", output],
    )

    _cmd, chunks = chunked.build_chunk_runner_command(
        _spec([_clip(0), _clip(1)], 2.0),
        {},
        str(tmp_path / "final.mp4"),
        str(tmp_path),
        target=1,
    )

    assert len(chunks) == 2
    for index in range(2):
        linked = tmp_path / "chunks" / f"work-{index:05d}" / "fonts" / "used.ttf"
        assert linked.is_file()
        assert os.path.samefile(source_font, linked)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg unavailable")
def test_real_chunk_render_and_concat_produces_valid_mp4(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            str(source),
        ],
        check=True,
    )
    clips = []
    assets = {}
    for i in range(4):
        clip = _clip(i, start=i * 0.25, duration=0.25)
        clips.append(clip)
        assets[clip["assetId"]] = str(source)
    background = _clip(10, start=0, duration=1)
    background["effects"] = [
        {"type": "fade-in", "params": {"duration": 0.3}},
        {"type": "zoom-in", "params": {"amount": 0.2}},
    ]
    background["keyframes"] = {
        "x": [{"t": 0, "v": 0.4}, {"t": 1, "v": 0.6}],
    }
    background["hasAudio"] = True
    clips.append(background)
    assets[background["assetId"]] = str(source)
    spec = _spec(clips, 1.0)
    spec["width"] = 160
    spec["height"] = 90
    spec["fps"] = 10
    spec["videoBitrateKbps"] = 500
    # Keep this integration test independent of host GPU availability.
    monkeypatch.setattr(fb, "detect_video_encoder", lambda _codec="h264": "libx264")

    output = tmp_path / "joined.mp4"
    command, chunks = chunked.build_chunk_runner_command(
        spec, assets, str(output), str(tmp_path), target=3
    )
    result = subprocess.run(command, cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 0, result.stderr[-2000:]
    assert len(chunks) == 2
    assert output.stat().st_size > 0
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert float(probe.stdout.strip()) == pytest.approx(1.0, abs=0.15)


def test_export_setup_starts_chunk_supervisor_without_injected_ffmpeg_args(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    job = Job("chunk-job", 100.0, str(tmp_path / "out.mp4"), status="setup")
    job.job_dir = str(tmp_path)
    job.temp_path = str(tmp_path / "part.mp4")
    job.save = lambda: None  # type: ignore[method-assign]
    calls: list[tuple[list[str], str, bool]] = []

    monkeypatch.setattr(export_router, "_reserve_scratch_or_507", lambda *_a: 0)
    monkeypatch.setattr(export_router, "reserve_export_scratch", lambda *_a: None)
    monkeypatch.setattr(export_router, "lease_paths", lambda paths: list(paths))
    monkeypatch.setattr(
        export_router,
        "materialize_assets",
        lambda *_a, **_k: ({"asset": str(source)}, [], []),
    )
    monkeypatch.setattr(export_router, "requires_chunking", lambda _spec: True)
    monkeypatch.setattr(
        export_router,
        "build_chunk_runner_command",
        lambda *_a, **_k: (["python", "chunk_runner.py", "manifest.json"], [object(), object()]),
    )
    monkeypatch.setattr(export_router, "preempt_proxies", lambda: 0)
    monkeypatch.setattr(
        export_router,
        "run_job",
        lambda _job, cmd, cwd, inject_progress_args=True: calls.append(
            (cmd, cwd, inject_progress_args)
        ),
    )
    spec = _spec([_clip(0)], 100.0)

    export_router._setup_export_job(
        job, spec, {"asset": str(source)}, spec["clips"], str(tmp_path)
    )

    assert calls == [
        (["python", "chunk_runner.py", "manifest.json"], str(tmp_path), False)
    ]
    assert job.diag["path"] == "chunked"
    assert job.diag["chunks"] == 2
