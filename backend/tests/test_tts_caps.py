"""start_tts input caps: too-many lines / too-large total → 422 BEFORE the
OmniVoice availability probe runs, so a rogue request never spins up the model
subprocess just to be told the payload is over budget."""
from __future__ import annotations

import asyncio
import json

import pytest

from app.routers import tts


def _call(texts_list) -> None:
    """Drive start_tts as a coroutine; caller expects an HTTPException."""
    asyncio.run(tts.start_tts(texts=json.dumps(texts_list)))


def test_over_line_count_returns_422():
    with pytest.raises(Exception) as exc:
        _call(["hi"] * (tts._TTS_MAX_LINES + 1))
    assert getattr(exc.value, "status_code", None) == 422


def test_over_total_chars_returns_422():
    # A modest number of lines, each large enough that the sum blows the cap.
    lines = ["x" * 500] * ((tts._TTS_MAX_TOTAL_CHARS // 500) + 1)
    with pytest.raises(Exception) as exc:
        _call(lines)
    assert getattr(exc.value, "status_code", None) == 422


def test_empty_input_returns_422():
    with pytest.raises(Exception) as exc:
        _call([])
    assert getattr(exc.value, "status_code", None) == 422


def test_over_single_line_length_returns_422():
    """A single oversized line still fails fast — even when the count + total
    are fine, one 200k-char string handed to OmniVoice would OOM the GPU.
    Catches the case where an attacker packs the whole budget into one item."""
    with pytest.raises(Exception) as exc:
        _call(["x" * (tts._TTS_MAX_LINE_CHARS + 1)])
    assert getattr(exc.value, "status_code", None) == 422
