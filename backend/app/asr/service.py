"""Unified ASR entry point: route a transcription to WhisperX or FunASR based
on the requested provider + language, and normalize between the two shapes
(WhisperX phrase "cues" ↔ ASRSegment[]).

Keeps the WhisperX path a straight pass-through (no behavior change when the
resolved provider is whisperx — see the T1.4 regression test).
"""
from __future__ import annotations

from collections.abc import Callable

from .base import ASRSegment
from .select import FUNASR, WHISPERX, select_asr_provider

__all__ = [
    "run_asr", "cues_to_segments", "segments_to_cues", "WHISPERX", "FUNASR",
    "AsrCancelled",
]


class AsrCancelled(Exception):
    """Provider-neutral cooperative ASR cancellation."""


def cues_to_segments(cues: list[dict]) -> list[ASRSegment]:
    """WhisperX cue dicts → ASRSegment[]. Cue word times are relative to the
    cue start; re-absolutize them onto the segment."""
    out: list[ASRSegment] = []
    for c in cues:
        start = float(c.get("startSec", 0.0))
        end = float(c.get("endSec", start))
        words = [
            {
                "word": w.get("word", ""),
                "start": start + float(w.get("startSec", 0.0)),
                "end": start + float(w.get("endSec", 0.0)),
            }
            for w in c.get("words", [])
        ]
        out.append(ASRSegment(start=start, end=end, text=c.get("content", ""), words=words))
    return out


def segments_to_cues(segments: list[ASRSegment]) -> list[dict]:
    """ASRSegment[] → WhisperX-style cue dicts (word times relative to cue
    start). FunASR segments usually carry no word list, so `words` is empty."""
    cues: list[dict] = []
    for s in segments:
        words = [
            {
                "word": w.get("word", ""),
                "startSec": float(w.get("start", s.start)) - s.start,
                "endSec": float(w.get("end", s.end)) - s.start,
            }
            for w in (s.words or [])
        ]
        cues.append(
            {"content": s.text, "startSec": s.start, "endSec": s.end, "words": words}
        )
    return cues


def run_asr(
    audio_path: str,
    provider: str | None,
    language: str | None,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[str, list[ASRSegment]]:
    """Transcribe `audio_path`, returning (used_provider, segments).

    Routing (see dubbing-integration-plan §4.1): explicit provider wins;
    "auto" + Chinese → FunASR, else WhisperX.
    """
    resolved = select_asr_provider(provider, language)
    if resolved == FUNASR:
        from . import funasr_runtime

        try:
            return resolved, funasr_runtime.transcribe(
                audio_path, language=language, cancel_check=cancel_check
            )
        except funasr_runtime.FunAsrCancelled as exc:
            raise AsrCancelled(str(exc) or "FunASR cancelled") from exc

    # WhisperX — shares the /transcribe busy-lock so the GPU is never
    # double-booked; returns {"language", "cues"}.
    from ..routers.transcribe import TranscriptionCancelled, run_transcription_sync

    try:
        result = run_transcription_sync(
            audio_path, language=language, cancel_check=cancel_check
        )
    except TranscriptionCancelled as exc:
        raise AsrCancelled(str(exc) or "WhisperX cancelled") from exc
    return resolved, cues_to_segments(result.get("cues", []))
