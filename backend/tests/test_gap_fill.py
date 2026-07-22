"""Tests for the gap-fill second pass — re-transcribing word-coverage holes
that whisperX's pass 1 leaves in otherwise-clear speech. The holes are decoded
with the RAW sequential faster-whisper model with vad_filter=False, because
pyannote VAD refuses screamed/emotional speech entirely (measured on a real
arrest video: VAD-gated re-decode of a hole gave "terms." while the raw no-VAD
decode of the same audio gave "I'm not resisting! I'm not resisting!...")."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from app.routers.transcribe import _find_word_gaps, _gap_fill_words

SR = 16000


def _w(word: str, start: float, end: float) -> dict:
    return {"word": word, "start": start, "end": end}


def _fw_word(word: str, start: float, end: float):
    """A faster-whisper Word-like object (attribute access)."""
    return SimpleNamespace(word=word, start=start, end=end)


def _fw_segment(words):
    return SimpleNamespace(words=words)


class _FakeRawModel:
    """Mimics faster_whisper.WhisperModel.transcribe — returns (segments, info)."""

    def __init__(self, segments_by_call):
        self.segments_by_call = list(segments_by_call)
        self.calls: list[dict] = []

    def transcribe(self, audio, language=None, vad_filter=None, word_timestamps=None, beam_size=None):
        self.calls.append({
            "len": len(audio), "language": language,
            "vad_filter": vad_filter, "word_timestamps": word_timestamps,
        })
        segs = self.segments_by_call.pop(0) if self.segments_by_call else []
        return iter(segs), {}


class _FakeAsr:
    """The whisperx pipeline wrapper: gap-fill only touches `.model`."""

    def __init__(self, segments_by_call):
        self.model = _FakeRawModel(segments_by_call)


def _tone(seconds: float, amplitude: float = 0.2) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n, dtype=np.float32) / SR
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def _silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def test_find_word_gaps_reports_interior_and_trailing_holes():
    words = [_w("a", 0.0, 1.0), _w("b", 1.1, 2.0), _w("c", 10.0, 11.0)]
    gaps = _find_word_gaps(words, duration_sec=20.0, min_gap_sec=2.5)
    assert gaps == [(2.0, 10.0), (11.0, 20.0)]


def test_find_word_gaps_ignores_short_pauses():
    words = [_w("a", 0.0, 1.0), _w("b", 1.5, 2.5)]  # 0.5s pause, below threshold
    gaps = _find_word_gaps(words, duration_sec=2.5, min_gap_sec=2.5)
    assert gaps == []


def test_gap_fill_recovers_and_offsets_words_into_absolute_time():
    audio = np.concatenate([_silence(5.0), _tone(10.0), _silence(5.0)])  # gap = [5, 15]
    asr = _FakeAsr([[_fw_segment([_fw_word("hello", 0.3, 0.6), _fw_word("there", 0.6, 0.9)])]])

    recovered = _gap_fill_words(asr, audio, "en", [(5.0, 15.0)])

    # Window is [4.8, 15.2] (0.2s margin) → words at local 0.3/0.6 land at 5.1/5.4 absolute.
    assert [w["word"] for w in recovered] == ["hello", "there"]
    assert recovered[0]["start"] == pytest.approx(5.1)
    assert recovered[1]["start"] == pytest.approx(5.4)
    call = asr.model.calls[0]
    assert call["language"] == "en"
    assert call["vad_filter"] is False       # the whole point: no VAD gate on holes
    assert call["word_timestamps"] is True


def test_gap_fill_skips_near_silent_window():
    audio = np.concatenate([_silence(5.0), _silence(10.0), _silence(5.0)])
    asr = _FakeAsr([[_fw_segment([_fw_word("ghost", 0.0, 0.3)])]])

    recovered = _gap_fill_words(asr, audio, "en", [(5.0, 15.0)])

    assert recovered == []
    assert asr.model.calls == []  # silent window never reaches the model


def test_gap_fill_skips_windows_shorter_than_minimum():
    audio = np.concatenate([_tone(5.0), _tone(0.3), _tone(5.0)])  # 0.3s gap window
    asr = _FakeAsr([[_fw_segment([_fw_word("x", 0.0, 0.1)])]])

    recovered = _gap_fill_words(asr, audio, "en", [(5.0, 5.3)])

    assert recovered == []
    assert asr.model.calls == []


def test_gap_fill_clamps_words_that_spill_outside_the_gap():
    audio = np.concatenate([_silence(5.0), _tone(10.0), _silence(5.0)])
    # "early" lands before the gap even with margin, "late" lands well after it.
    asr = _FakeAsr([[_fw_segment([
        _fw_word("early", -1.0, -0.5), _fw_word("mid", 5.0, 5.3), _fw_word("late", 20.0, 20.3),
    ])]])

    recovered = _gap_fill_words(asr, audio, "en", [(5.0, 15.0)])

    assert [w["word"] for w in recovered] == ["mid"]


def test_gap_fill_one_bad_gap_does_not_sink_the_others():
    audio = np.concatenate([_tone(3.0), _silence(3.0), _tone(3.0), _silence(3.0), _tone(3.0)])

    class _RaisingThenWorkingModel(_FakeRawModel):
        def transcribe(self, audio, **kw):
            if not self.calls:
                self.calls.append({})
                raise RuntimeError("decoder blew up")
            return super().transcribe(audio, **kw)

    asr = _FakeAsr([])
    asr.model = _RaisingThenWorkingModel([[_fw_segment([_fw_word("ok", 0.1, 0.3)])]])

    recovered = _gap_fill_words(asr, audio, "en", [(3.0, 6.0), (9.0, 12.0)])

    # First gap's exception is swallowed; the second gap still recovers a word.
    assert [w["word"] for w in recovered] == ["ok"]


def test_gap_fill_without_raw_model_is_a_noop():
    class _NoModelAsr:
        pass

    audio = _tone(10.0)
    assert _gap_fill_words(_NoModelAsr(), audio, "en", [(2.0, 8.0)]) == []
