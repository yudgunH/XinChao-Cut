"""thumbnail_strip must fast-seek each frame with bounded parallelism.

A single `fps=` invocation reads the file sequentially and therefore decodes
almost the whole video — pathological on multi-hour 4K footage. An unbounded
process-per-frame spawn (~60 at once) starves preview/export instead. The shape
we want: one `-ss <t> -i <path>` per frame, at most _THUMB_MAX_WORKERS running.
"""
from __future__ import annotations

import threading

import pytest

from app import ffmpeg_utils as fu


@pytest.fixture
def fake_probe(monkeypatch):
    monkeypatch.setattr(fu, "probe", lambda _p: {"durationSec": 100.0, "hasAudio": True})


def _stub_run(monkeypatch, record: list[list[str]], *, live: list[int] | None = None):
    lock = threading.Lock()
    running = 0

    def _fake_run(cmd, *, cancel_check=None):  # noqa: ARG001
        nonlocal running
        with lock:
            running += 1
            if live is not None:
                live.append(running)
        # Write the output file ffmpeg would have produced (last arg).
        out = cmd[-1]
        with open(out, "wb") as fh:
            fh.write(b"\xff\xd8jpeg")
        with lock:
            record.append(list(cmd))
            running -= 1
        return b""

    monkeypatch.setattr(fu, "_run", _fake_run)


def test_uses_input_seek_per_frame(fake_probe, monkeypatch):
    cmds: list[list[str]] = []
    _stub_run(monkeypatch, cmds)

    frames = fu.thumbnail_strip("v.mp4", count=5, width=160)

    assert len(frames) == 5
    assert all(f.startswith("data:image/jpeg;base64,") for f in frames)
    # One ffmpeg per frame …
    assert len(cmds) == 5
    for cmd in cmds:
        # … and -ss must come BEFORE -i (input seek, not output seek).
        assert cmd.index("-ss") < cmd.index("-i")
        # No sequential fps filter.
        assert not any(a.startswith("fps=") for a in cmd)


def test_timestamps_span_the_video_evenly(fake_probe, monkeypatch):
    cmds: list[list[str]] = []
    _stub_run(monkeypatch, cmds)
    fu.thumbnail_strip("v.mp4", count=4)

    seeks = sorted(float(c[c.index("-ss") + 1]) for c in cmds)
    # duration=100, count=4 → 0, 25, 50, 75
    assert seeks == pytest.approx([0.0, 25.0, 50.0, 75.0], abs=0.01)


def test_concurrency_is_bounded(fake_probe, monkeypatch):
    cmds: list[list[str]] = []
    live: list[int] = []
    _stub_run(monkeypatch, cmds, live=live)

    fu.thumbnail_strip("v.mp4", count=20)

    assert len(cmds) == 20
    assert max(live) <= fu._THUMB_MAX_WORKERS


def test_zero_count_short_circuits(fake_probe, monkeypatch):
    cmds: list[list[str]] = []
    _stub_run(monkeypatch, cmds)
    assert fu.thumbnail_strip("v.mp4", count=0) == []
    assert cmds == []


def test_cancel_before_work_raises(fake_probe, monkeypatch):
    cmds: list[list[str]] = []
    _stub_run(monkeypatch, cmds)
    with pytest.raises(fu.FfmpegCancelled):
        fu.thumbnail_strip("v.mp4", count=4, cancel_check=lambda: True)
    assert cmds == []


def test_missing_output_truncates_rather_than_inventing_blanks(fake_probe, monkeypatch):
    """Short/corrupt media: stop at the first missing frame.

    Keyed on the output filename, not call order — frames are grabbed by a
    thread pool, so "the first two calls" is not deterministic.
    """
    from pathlib import Path

    def _fake_run(cmd, *, cancel_check=None):  # noqa: ARG001
        out = Path(cmd[-1])
        # ffmpeg produces f0.jpg and f1.jpg; frames 2..4 are past the real end.
        if out.stem in ("f0", "f1"):
            out.write_bytes(b"\xff\xd8jpeg")
        return b""

    monkeypatch.setattr(fu, "_run", _fake_run)
    frames = fu.thumbnail_strip("v.mp4", count=5)
    assert len(frames) == 2
