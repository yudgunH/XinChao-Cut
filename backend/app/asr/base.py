"""ASR provider interface.

Stdlib + typing only — no third-party deps — so it can be imported anywhere without
pulling in torch/whisperx. Concrete providers (WhisperX adapter, FunASR) live
alongside this module and satisfy the ASRProvider Protocol.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class ASRSegment:
    start: float
    end: float
    text: str
    speaker_id: str | None = None
    words: list[dict] = field(default_factory=list)
    confidence: float | None = None


@runtime_checkable
class ASRProvider(Protocol):
    def transcribe(
        self,
        audio_path: str,
        language: str | None = None,
        word_timestamps: bool = True,
    ) -> list[ASRSegment]: ...
