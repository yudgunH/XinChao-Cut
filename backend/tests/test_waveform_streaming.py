"""waveform_peaks streams PCM instead of materialising it.

A 10 h track is ~288 MB of s16 mono PCM at 4 kHz; the old code joined the whole
stdout, copied it into an `array`, then sliced per bucket — ~2x live at once.
These tests pin the reducer's correctness (including a chunk boundary that
splits a 2-byte sample) and that nothing accumulates the full stream.
"""
from __future__ import annotations

import struct
import sys
import threading
import time

import pytest

from app import ffmpeg_utils as fu


def _pcm(samples: list[int]) -> bytes:
    return struct.pack("<" + "h" * len(samples), *samples)


@pytest.fixture
def fake_probe(monkeypatch):
    def _set(duration: float, has_audio: bool = True):
        monkeypatch.setattr(
            fu, "probe", lambda _p: {"durationSec": duration, "hasAudio": has_audio}
        )
    return _set


def _stub_stream(monkeypatch, chunks: list[bytes], seen: list[int] | None = None):
    """Feed `chunks` to the reducer; record the largest chunk handed over."""
    def _fake(
        cmd, on_stdout, *, cancel_check=None, chunk_size=65536,
        timeout_sec=None,
    ):  # noqa: ARG001
        for c in chunks:
            if seen is not None:
                seen.append(len(c))
            on_stdout(c)
    monkeypatch.setattr(fu, "_run_streaming", _fake)


def test_no_audio_returns_empty(fake_probe, monkeypatch):
    fake_probe(10.0, has_audio=False)
    _stub_stream(monkeypatch, [])
    assert fu.waveform_peaks("x.mp4") == []


def test_peak_is_max_abs_amplitude_per_bucket(fake_probe, monkeypatch):
    # duration 1 s @ sample_rate 8 → 8 samples; num_peaks = max(1, min(4000, 20)) = 20
    # expected_samples = 8, bucket = max(1, 8 // 20) = 1 → one peak per sample.
    fake_probe(1.0)
    samples = [0, 16384, -32768, 8192, 0, -4096, 32767, 100]
    _stub_stream(monkeypatch, [_pcm(samples)])
    peaks = fu.waveform_peaks("a.wav", sample_rate=8)
    expected = [round(abs(s) / 32768.0, 4) for s in samples]
    # -32768 → abs 32768 → 1.0 exactly
    assert peaks[:len(expected)] == expected


def test_handles_chunk_boundary_splitting_a_sample(fake_probe, monkeypatch):
    fake_probe(1.0)
    samples = [1000, -2000, 3000, -4000]
    raw = _pcm(samples)
    # Split mid-sample (odd offset) so the reducer must carry a byte across.
    chunks = [raw[:3], raw[3:5], raw[5:]]
    _stub_stream(monkeypatch, chunks)
    peaks = fu.waveform_peaks("a.wav", sample_rate=4)
    assert peaks == [round(abs(s) / 32768.0, 4) for s in samples]


def test_bucket_reduction_takes_max_of_the_window(fake_probe, monkeypatch):
    # 100 s @ 10 Hz = 1000 expected samples; max_peaks=2 → bucket = 1000 // 2 = 500.
    fake_probe(100.0)
    quiet, loud = 1, 30000
    # Loud sample sits at index 500 → the SECOND bucket [500:1000).
    samples = [quiet] * 500 + [loud] + [quiet] * 499
    _stub_stream(monkeypatch, [_pcm(samples)])
    peaks = fu.waveform_peaks("a.wav", max_peaks=2, sample_rate=10)
    assert len(peaks) == 2
    assert peaks[0] == round(quiet / 32768.0, 4)  # 0.0 after rounding
    assert peaks[1] == round(loud / 32768.0, 4)


def test_never_exceeds_max_peaks(fake_probe, monkeypatch):
    fake_probe(600.0)  # 10 min
    _stub_stream(monkeypatch, [_pcm([500] * 20_000)])
    peaks = fu.waveform_peaks("a.wav", max_peaks=50, sample_rate=100)
    assert len(peaks) <= 50


def test_streams_in_chunks_rather_than_one_blob(fake_probe, monkeypatch):
    """The reducer must accept many small chunks, not require the whole stream."""
    fake_probe(4.0)
    samples = list(range(-500, 500))
    raw = _pcm(samples)
    step = 64
    chunks = [raw[i:i + step] for i in range(0, len(raw), step)]
    seen: list[int] = []
    _stub_stream(monkeypatch, chunks, seen)
    peaks = fu.waveform_peaks("a.wav", sample_rate=250)
    assert len(seen) > 10  # actually fed incrementally
    assert peaks and max(peaks) <= 1.0


def test_silent_child_can_be_cancelled_without_waiting_for_stdout(monkeypatch):
    """Regression: a blocking ``stdout.read`` used to make cancel ineffective
    until FFmpeg emitted another byte (which a wedged decoder may never do)."""
    stop = threading.Event()

    def fast_kill(proc):
        proc.kill()
        proc.wait(timeout=2)

    monkeypatch.setattr(fu, "_kill_proc", fast_kill)
    timer = threading.Timer(0.2, stop.set)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(fu.FfmpegCancelled):
            fu._run_streaming(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                lambda _chunk: None,
                cancel_check=stop.is_set,
                timeout_sec=5,
            )
    finally:
        timer.cancel()
    assert time.monotonic() - started < 2


def test_silent_child_respects_streaming_timeout(monkeypatch):
    def fast_kill(proc):
        proc.kill()
        proc.wait(timeout=2)

    monkeypatch.setattr(fu, "_kill_proc", fast_kill)
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out"):
        fu._run_streaming(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            lambda _chunk: None,
            timeout_sec=0.2,
        )
    assert time.monotonic() - started < 2
