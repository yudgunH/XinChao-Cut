from __future__ import annotations

import json
import os

from app.export.hybrid import HYBRID_PCM_CHUNK_MAX_SEC, build_hybrid_command


def test_hybrid_many_audio_clips_uses_pcm_chunks_then_one_aac_mux(tmp_path):
    clips = []
    for index in range(100):
        clips.append({
            "id": f"c{index}",
            "kind": "audio",
            "assetId": "a",
            "trackId": "audio",
            "startSec": index * 2.0,
            "inPointSec": index * 3.0,
            "outPointSec": index * 3.0 + 1.0,
            "speed": 1,
            "volume": 1,
            "hasAudio": True,
        })
    spec = {
        "durationSec": 200,
        "fps": 30,
        "tracks": [{"id": "audio", "muted": False}],
        "clips": clips,
    }

    cmd, chunks = build_hybrid_command(
        spec,
        {"a": "/source.wav"},
        "/browser.mp4",
        "/final.mp4",
        str(tmp_path),
    )

    assert chunks > 1
    assert os.path.basename(cmd[1]) == "chunk_runner.py"
    manifest = json.loads(open(cmd[2], encoding="utf-8").read())
    assert all("pcm_s16le" in stage["cmd"] for stage in manifest["stages"])
    final = manifest["concat"]
    assert final[final.index("-c:v") + 1] == "copy"
    assert final[final.index("-c:a") + 1] == "aac"


def test_hybrid_pcm_chunks_are_bounded_and_use_non_riff_container(tmp_path):
    duration = 12 * 3600
    clips = []
    paths = {}
    for index in range(100):
        asset_id = f"a{index}"
        start = index * duration / 100
        clips.append({
            "id": f"c{index}", "kind": "audio", "assetId": asset_id,
            "trackId": "audio", "startSec": start, "inPointSec": 0,
            "outPointSec": duration / 100 - 1, "speed": 1, "volume": 1,
            "hasAudio": True,
        })
        paths[asset_id] = f"/source/{asset_id}.wav"
    clips.append({
        "id": "bed", "kind": "audio", "assetId": "bed", "trackId": "audio",
        "startSec": 0, "inPointSec": 0, "outPointSec": duration * 2,
        "speed": 2, "volume": 1, "hasAudio": True,
    })
    paths["bed"] = "/source/bed.wav"
    spec = {
        "durationSec": duration, "fps": 30,
        "tracks": [{"id": "audio", "muted": False}], "clips": clips,
    }

    cmd, chunks = build_hybrid_command(
        spec, paths, "/browser.mp4", "/final.mp4", str(tmp_path),
    )
    manifest = json.loads(open(cmd[2], encoding="utf-8").read())
    assert chunks >= 6
    assert all(stage["duration"] <= HYBRID_PCM_CHUNK_MAX_SEC + 1e-6 for stage in manifest["stages"])
    assert all(stage["cmd"][-1].endswith(".nut") for stage in manifest["stages"])
    assert all("nut" in stage["cmd"] for stage in manifest["stages"])
    assert any(
        any("afade=t=out" in arg or "afade=t=in" in arg for arg in stage["cmd"])
        for stage in manifest["stages"]
    )


def test_long_edited_hybrid_audio_uses_reusable_cache_segments(tmp_path):
    duration = 1800
    clips = [
        {
            "id": "dialog", "kind": "audio", "assetId": "dialog",
            "trackId": "audio", "startSec": 0, "inPointSec": 0,
            "outPointSec": duration, "speed": 1, "volume": 1,
            "hasAudio": True,
        },
        {
            "id": "music", "kind": "audio", "assetId": "music",
            "trackId": "audio", "startSec": 0, "inPointSec": 0,
            "outPointSec": duration, "speed": 1, "volume": 0.25,
            "hasAudio": True,
        },
    ]
    spec = {
        "durationSec": duration, "fps": 30,
        "tracks": [{"id": "audio", "muted": False}], "clips": clips,
    }

    cmd, chunks = build_hybrid_command(
        spec,
        {"dialog": "/source/dialog.wav", "music": "/source/music.wav"},
        "/browser.mp4",
        "/final.mp4",
        str(tmp_path),
    )

    manifest = json.loads(open(cmd[2], encoding="utf-8").read())
    assert chunks > 1
    assert max(stage["duration"] for stage in manifest["stages"]) <= 300
    assert all(stage["cachePath"].endswith(".nut") for stage in manifest["stages"])


def test_detach_first_segment_hybrid_audio_keeps_later_segments(tmp_path):
    """Part 1 moves to an audio track; parts 2+ must remain in Hybrid audio."""
    from unittest.mock import patch
    import re

    import app.export.ffmpeg_build as fb

    clips = [
        {
            "id": f"c{i}", "assetId": "A", "trackId": "video", "kind": "video",
            "startSec": i * 10.0, "inPointSec": i * 10.0,
            "outPointSec": (i + 1) * 10.0, "speed": 1, "volume": 1,
            "muted": i == 0, "effects": [], "transform": {}, "adjust": {},
        }
        for i in range(4)
    ]
    clips.append({
        "id": "detached", "assetId": "A", "trackId": "audio", "kind": "audio",
        "startSec": 0.0, "inPointSec": 0.0, "outPointSec": 10.0,
        "speed": 1, "volume": 1, "muted": False, "effects": [],
        "transform": {}, "adjust": {}, "detachedFromClipId": "c0",
    })
    spec = {
        "width": 1920, "height": 1080, "fps": 30, "durationSec": 40.0,
        "audioBitrateKbps": 192,
        "tracks": [
            {"id": "video", "kind": "video", "muted": False},
            {"id": "audio", "kind": "audio", "muted": False},
        ],
        "clips": clips,
    }
    with patch.object(fb, "_has_audio_stream", return_value=True):
        cmd, chunks = build_hybrid_command(
            spec, {"A": "/in.mp4"}, "/browser.mp4", "/final.mp4", str(tmp_path)
        )

    assert chunks == 0
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert sorted(int(value) for value in re.findall(r"adelay=(\d+)", graph)) == [
        0, 10000,
    ]
    # Parts 2-4 merge into one continuous source run starting at 10 seconds.
    assert "apad=whole_dur=40.000000,atrim=duration=40.000000" in graph


def test_hybrid_late_audio_input_is_mixed_over_full_timeline_anchor(tmp_path):
    """Late video audio must survive after early detached clips reach EOF."""
    from unittest.mock import patch
    import re

    import app.export.ffmpeg_build as fb

    spec = {
        "width": 608, "height": 1080, "fps": 30, "durationSec": 62.11,
        "audioBitrateKbps": 192,
        "tracks": [
            {"id": "audio", "kind": "audio", "muted": False},
            {"id": "video", "kind": "video", "muted": False},
        ],
        "clips": [
            {"id": "d0", "assetId": "A", "trackId": "audio", "kind": "audio",
             "startSec": 0.0, "inPointSec": 0.0, "outPointSec": 15.0,
             "speed": 1, "volume": 1, "muted": False, "effects": [],
             "transform": {}, "adjust": {}},
            {"id": "d1", "assetId": "A", "trackId": "audio", "kind": "audio",
             "startSec": 15.0, "inPointSec": 15.0, "outPointSec": 20.0,
             "speed": 1, "volume": 2.168, "muted": False, "effects": [],
             "transform": {}, "adjust": {}},
            {"id": "v", "assetId": "A", "trackId": "video", "kind": "video",
             "startSec": 20.0, "inPointSec": 20.0, "outPointSec": 62.11,
             "speed": 1, "volume": 1, "muted": False, "effects": [],
             "transform": {}, "adjust": {}},
        ],
    }
    with patch.object(fb, "_has_audio_stream", return_value=True):
        cmd, chunks = build_hybrid_command(
            spec, {"A": "/in.mp4"}, "/browser.mp4", "/final.mp4", str(tmp_path)
        )

    assert chunks == 0
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "anullsrc=r=48000:cl=stereo,atrim=duration=62.110000[mixanchor]" in graph
    assert "[mixanchor]" in graph and "amix=inputs=4" in graph
    assert sorted(int(value) for value in re.findall(r"adelay=(\d+)", graph)) == [
        0, 15000, 20000,
    ]
