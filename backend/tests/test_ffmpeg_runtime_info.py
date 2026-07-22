from __future__ import annotations

from types import SimpleNamespace

from app import ffmpeg_utils


def test_ffmpeg_runtime_info_reports_resolved_version(monkeypatch):
    monkeypatch.setattr(
        ffmpeg_utils.shutil,
        "which",
        lambda name: f"C:/runtime/{name}.exe",
    )
    monkeypatch.setattr(
        ffmpeg_utils.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="ffmpeg version 8.0.1-essentials_build\nconfiguration: pinned\n",
            stderr="",
        ),
    )

    info = ffmpeg_utils.ffmpeg_runtime_info()

    assert info["available"] is True
    assert info["version"] == "ffmpeg version 8.0.1-essentials_build"
    assert info["path"].replace("\\", "/").endswith("C:/runtime/ffmpeg.exe")


def test_ffmpeg_runtime_info_degrades_when_missing(monkeypatch):
    monkeypatch.setattr(ffmpeg_utils.shutil, "which", lambda _name: None)

    assert ffmpeg_utils.ffmpeg_runtime_info() == {
        "available": False,
        "path": None,
        "probePath": None,
        "version": None,
    }
