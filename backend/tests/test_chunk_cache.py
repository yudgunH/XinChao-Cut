from __future__ import annotations

import json
import os
from types import SimpleNamespace

from app.export import chunk_cache, chunk_runner, chunked


def test_content_addressed_asset_key_ignores_job_materialization_path(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(chunk_cache, "_ffmpeg_identity", lambda: "ffmpeg-test")
    asset_id = "a" * 64
    spec = {"clips": [{"assetId": asset_id, "startSec": 0}]}
    first = chunk_cache.chunk_cache_key(
        "video", spec, {asset_id: str(tmp_path / "job-a.mp4")}, encoder="h264"
    )
    second = chunk_cache.chunk_cache_key(
        "video", spec, {asset_id: str(tmp_path / "job-b.mp4")}, encoder="h264"
    )
    assert first == second


def test_local_source_key_changes_when_file_changes(monkeypatch, tmp_path):
    monkeypatch.setattr(chunk_cache, "_ffmpeg_identity", lambda: "ffmpeg-test")
    source = tmp_path / "local.mp4"
    source.write_bytes(b"one")
    spec = {"clips": [{"assetId": "local-asset", "startSec": 0}]}
    first = chunk_cache.chunk_cache_key(
        "video", spec, {"local-asset": str(source)}, encoder="h264"
    )
    source.write_bytes(b"two-two")
    second = chunk_cache.chunk_cache_key(
        "video", spec, {"local-asset": str(source)}, encoder="h264"
    )
    assert first != second


def test_cache_publish_restore_and_corruption_rejection(tmp_path):
    output = tmp_path / "job" / "chunk.mkv"
    output.parent.mkdir()
    output.write_bytes(b"valid-media")
    cached = tmp_path / "cache" / "key.mkv"

    chunk_runner._publish_cached_chunk(str(output), str(cached))
    output.unlink()
    assert chunk_runner._restore_cached_chunk(str(cached), str(output))
    assert output.read_bytes() == b"valid-media"

    metadata = f"{cached}.json"
    with open(metadata, "w", encoding="utf-8") as handle:
        json.dump({"size": 999}, handle)
    output.unlink()
    assert not chunk_runner._restore_cached_chunk(str(cached), str(output))
    assert not output.exists()


def test_runner_cache_hit_skips_ffmpeg(monkeypatch, tmp_path):
    source = tmp_path / "rendered.mkv"
    source.write_bytes(b"cached")
    cached = tmp_path / "cache" / "key.mkv"
    chunk_runner._publish_cached_chunk(str(source), str(cached))
    output = tmp_path / "job" / "chunk.mkv"
    monkeypatch.setattr(
        chunk_runner,
        "_run_stage",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("spawned")),
    )
    manifest = {
        "totalDuration": 1,
        "maxParallel": 1,
        "stages": [{
            "cmd": ["ffmpeg"], "cwd": str(tmp_path), "duration": 1,
            "offset": 0, "output": str(output), "cachePath": str(cached),
        }],
    }
    assert chunk_runner._run_stages(manifest) == 0
    assert output.read_bytes() == b"cached"


def test_prune_enforces_lru_quota(monkeypatch, tmp_path):
    root = tmp_path / "export-chunk-cache" / "video" / "aa"
    root.mkdir(parents=True)
    old = root / "old.mkv"
    new = root / "new.mkv"
    old.write_bytes(b"x" * 700_000)
    new.write_bytes(b"y" * 700_000)
    os.utime(old, (1, 1))
    os.utime(new, (2, 2))
    monkeypatch.setattr(
        chunk_cache,
        "get_settings",
        lambda: SimpleNamespace(
            work_dir=str(tmp_path),
            export_chunk_cache_mb=1,
            export_chunk_cache_ttl_days=0,
        ),
    )
    chunk_cache.prune_chunk_cache()
    assert not old.exists()
    assert new.exists()


def test_editing_late_window_keeps_earlier_chunk_cache_keys(monkeypatch, tmp_path):
    asset_ids = [f"{index:064x}" for index in range(4)]
    clips = [
        {
            "id": f"c{index}", "trackId": "v", "kind": "video",
            "assetId": asset_ids[index], "startSec": index,
            "inPointSec": 0, "outPointSec": 1, "speed": 1,
        }
        for index in range(4)
    ]
    spec = {
        "width": 640, "height": 360, "fps": 30, "durationSec": 4,
        "videoBitrateKbps": 1000, "tracks": [{"id": "v"}], "clips": clips,
    }
    monkeypatch.setattr(chunked, "prune_chunk_cache", lambda: None)
    monkeypatch.setattr(chunked, "detect_video_encoder", lambda _codec="h264": "libx264")
    monkeypatch.setattr(
        chunked,
        "build_command",
        lambda _spec, _assets, output, _work: ["ffmpeg", output],
    )
    paths = {asset_id: f"/materialized/{asset_id}.mp4" for asset_id in asset_ids}
    first_cmd, _ = chunked.build_chunk_runner_command(
        spec, paths, str(tmp_path / "a.mp4"), str(tmp_path / "job-a"), target=1
    )
    first = json.loads(open(first_cmd[2], encoding="utf-8").read())

    edited = {**spec, "clips": [dict(clip) for clip in clips]}
    edited["clips"][-1]["volume"] = 0.5
    second_cmd, _ = chunked.build_chunk_runner_command(
        edited, paths, str(tmp_path / "b.mp4"), str(tmp_path / "job-b"), target=1
    )
    second = json.loads(open(second_cmd[2], encoding="utf-8").read())

    first_keys = [stage["cachePath"] for stage in first["stages"]]
    second_keys = [stage["cachePath"] for stage in second["stages"]]
    assert first_keys[:-1] == second_keys[:-1]
    assert first_keys[-1] != second_keys[-1]
