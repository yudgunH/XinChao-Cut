"""Browser-safe media normalization endpoint."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def normalize_env(monkeypatch, tmp_path):
    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path))
    from app.config import get_settings

    get_settings.cache_clear()
    from app.routers import media as M

    with M._NORMALIZE_JOBS_LOCK:
        M._NORMALIZE_JOBS.clear()
        M._NORMALIZE_BY_HASH.clear()
    monkeypatch.setattr(M, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(M, "resolve_source_path", lambda path: path)

    class ImmediateThread:
        def __init__(self, *, target, args, **_kwargs):
            self.target = target
            self.args = args

        def start(self):
            self.target(*self.args)

    monkeypatch.setattr(M.threading, "Thread", ImmediateThread)
    yield M, tmp_path
    with M._NORMALIZE_JOBS_LOCK:
        M._NORMALIZE_JOBS.clear()
        M._NORMALIZE_BY_HASH.clear()
    get_settings.cache_clear()


def test_normalize_remuxes_h264_and_publishes_atomically(normalize_env, monkeypatch):
    M, tmp_path = normalize_env
    source = tmp_path / "fragmented.mp4"
    source.write_bytes(b"source bytes")
    monkeypatch.setattr(
        M.ffmpeg_utils,
        "probe",
        lambda _path: {"durationSec": 3.0, "videoCodec": "h264"},
    )
    commands: list[list[str]] = []

    def fake_command(job, cmd, **_kwargs):
        commands.append(cmd)
        Path(job.temp_path).write_bytes(b"browser-safe mp4")
        return 0, ""

    monkeypatch.setattr(M, "_run_normalize_command", fake_command)

    result = M.media_normalize(sourcePath=str(source))

    assert result["status"] == "done"
    assert result["cached"] is False
    assert commands and "-c" in commands[0] and "copy" in commands[0]
    job = M._NORMALIZE_JOBS[result["id"]]
    assert Path(job.output_path).read_bytes() == b"browser-safe mp4"
    assert not Path(job.temp_path).exists()


def test_normalize_hash_hit_does_not_start_ffmpeg(normalize_env, monkeypatch):
    M, tmp_path = normalize_env
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"same content")
    monkeypatch.setattr(
        M.ffmpeg_utils,
        "probe",
        lambda _path: {"durationSec": 1.0, "videoCodec": "h264"},
    )
    calls = 0

    def fake_command(job, _cmd, **_kwargs):
        nonlocal calls
        calls += 1
        Path(job.temp_path).write_bytes(b"normalized")
        return 0, ""

    monkeypatch.setattr(M, "_run_normalize_command", fake_command)
    first = M.media_normalize(sourcePath=str(source))
    second = M.media_normalize(sourcePath=str(source))

    assert first["hash"] == second["hash"]
    assert calls == 1
    assert second["status"] == "done"
    assert second["cached"] is True


def test_normalize_cancel_kills_running_process(normalize_env, monkeypatch):
    M, _tmp_path = normalize_env
    proc = MagicMock()
    job = M._NormalizeJob(
        id="normalize-cancel",
        content_hash="a" * 64,
        source_path="source.mp4",
        output_path="output.mp4",
        temp_path="part.mp4",
        duration=2.0,
        status="running",
    )
    job._proc = proc
    with M._NORMALIZE_JOBS_LOCK:
        M._NORMALIZE_JOBS[job.id] = job
    killed: list[object] = []
    monkeypatch.setattr(M, "kill_process_tree", lambda value: killed.append(value))

    assert M.media_normalize_cancel(job.id) == {"ok": True}
    assert job.status == "cancelled"
    assert killed == [proc]
    assert job._proc is None
