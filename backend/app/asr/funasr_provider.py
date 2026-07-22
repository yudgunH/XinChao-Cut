"""FunASR (Alibaba DAMO) ASR provider — Mandarin-optimized.

Kept independent of the HTTP layer so it can run inside an isolated worker.
Paraformer + fsmn-vad + ct-punc together yield sentence-level timestamps
directly (`res[0]["sentence_info"]`), which map 1:1 onto ASRSegment — no extra
segmentation needed. torch/funasr are imported lazily so this module (and the
rest of app.asr) stays importable on machines without them.
"""
from __future__ import annotations

import gc
import logging
import os
import re

from .base import ASRSegment

logger = logging.getLogger(__name__)

# One paraformer token ≈ one CJK character or one contiguous Latin/digit run —
# the same granularity FunASR's `timestamp` list is emitted at, which lets the
# punctuation splitter below pair text back up with token timing.
_TOKEN_RE = re.compile(r"[一-鿿぀-ヿ가-힣]|[A-Za-z0-9']+")
_SENTENCE_END_PUNCT = "。！？!?…"
_SOFT_BREAK_PUNCT = "，,、;；:："
# Force a break at the next comma once a sentence runs past this many chars so
# a single run-on sentence still renders as readable caption-sized chunks.
_MAX_SENTENCE_CHARS = 30


def _cuda_available() -> bool:
    try:
        import torch
    except Exception:  # noqa: BLE001 — torch absent or broken install
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 — driver quirks
        return False


def _resolve_device(device: str | None) -> str:
    """Fall back to CPU when CUDA is requested but unusable, and normalize a
    bare ``cuda``/``gpu`` to ``cuda:0`` (what torch/FunASR expect)."""
    value = (device or "cpu").strip().lower() or "cpu"
    if value in ("gpu", "cuda"):
        value = "cuda:0" if _cuda_available() else "cpu"
        return value
    if value.startswith("cuda"):
        if not _cuda_available():
            logger.warning("FunASR requested %r but CUDA is unavailable — using CPU.", device)
            return "cpu"
        return value
    return value


def _release_vram() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            if hasattr(torch.cuda, "ipc_collect"):
                torch.cuda.ipc_collect()
    except Exception:  # noqa: BLE001 — best effort
        pass


def _split_punctuated_text(text: str, timestamps: list) -> list[ASRSegment]:
    """Split ct-punc's merged transcript into sentence segments using the
    per-token ``timestamp`` list ([[start_ms, end_ms], …]).

    This is the fallback for FunASR builds/configs that return no
    ``sentence_info`` even with ``sentence_timestamp=True`` — without it the
    whole clip collapsed into ONE dense caption. Token i takes timestamps[i]
    (clamped to the last entry if the counts drift, e.g. mixed-language
    tokenization differences); a sentence closes on sentence-ending
    punctuation, or on a soft break once it is past _MAX_SENTENCE_CHARS.
    """
    tokens = list(_TOKEN_RE.finditer(text))
    valid_ts = [
        t
        for t in timestamps
        if isinstance(t, (list, tuple)) and len(t) >= 2
    ]
    if not tokens or not valid_ts:
        return []

    segments: list[ASRSegment] = []
    sent_start_pos = 0  # char offset where the current sentence begins
    sent_start_ms: float | None = None
    for i, match in enumerate(tokens):
        ts = valid_ts[min(i, len(valid_ts) - 1)]
        if sent_start_ms is None:
            sent_start_ms = float(ts[0])
        end_ms = float(ts[1])

        # Punctuation lives between this token and the next one.
        next_pos = tokens[i + 1].start() if i + 1 < len(tokens) else len(text)
        trailing = text[match.end() : next_pos]
        is_last = i + 1 == len(tokens)
        hard_break = any(ch in _SENTENCE_END_PUNCT for ch in trailing)
        soft_break = any(ch in _SOFT_BREAK_PUNCT for ch in trailing)
        long_enough = match.end() - sent_start_pos >= _MAX_SENTENCE_CHARS
        if not (is_last or hard_break or (soft_break and long_enough)):
            continue

        chunk = text[sent_start_pos:next_pos].strip()
        if chunk:
            segments.append(
                ASRSegment(
                    start=sent_start_ms / 1000.0,
                    end=max(end_ms, sent_start_ms) / 1000.0,
                    text=chunk,
                )
            )
        sent_start_pos = next_pos
        sent_start_ms = None
    return segments


def map_funasr_result(result: list | None) -> list[ASRSegment]:
    """Convert FunASR's ``generate()`` output into ASRSegment[].

    Prefers sentence-level timing (``sentence_info``); falls back to splitting
    the merged transcript at punctuation via the token ``timestamp`` list, then
    whole-clip ``timestamp`` bounds, then a single duration-estimated segment.
    Pure/stdlib so it can be unit-tested without funasr installed.
    """
    if not result:
        return []
    entry = result[0]

    sentences = entry.get("sentence_info")
    if sentences:
        segments: list[ASRSegment] = []
        for s in sentences:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            speaker = str(s["spk"]) if s.get("spk") is not None else None
            # A comma-only run-on sentence can still be a wall of text; re-split
            # overlong ones at soft breaks using the sentence's own token
            # timestamps (absolute ms, same clock as start/end).
            if len(text) > _MAX_SENTENCE_CHARS and s.get("timestamp"):
                sub = _split_punctuated_text(text, s["timestamp"])
                if len(sub) > 1:
                    for seg in sub:
                        seg.speaker_id = speaker
                    segments.extend(sub)
                    continue
            segments.append(
                ASRSegment(
                    start=s.get("start", 0) / 1000.0,
                    end=s.get("end", 0) / 1000.0,
                    text=text,
                    speaker_id=speaker,
                )
            )
        return segments

    text = (entry.get("text") or "").strip()
    timestamps = entry.get("timestamp")
    if text and timestamps:
        split = _split_punctuated_text(text, timestamps)
        if split:
            return split
        return [
            ASRSegment(
                start=timestamps[0][0] / 1000.0,
                end=timestamps[-1][1] / 1000.0,
                text=text,
            )
        ]
    if text:
        return [ASRSegment(start=0.0, end=max(1.0, len(text) / 4.0), text=text)]
    return []


class FunASRProvider:
    """Real ASR via FunASR, optimized for Mandarin Chinese.

    Requires ``pip install funasr modelscope`` (torch is already present in the
    WhisperX/Demucs tier). Weights fetch from ModelScope by default; point
    ``FUNASR_MODEL_DIR`` (+ ``_VAD_DIR`` / ``_PUNC_DIR``) at pre-downloaded
    folders to bypass the network entirely.
    """

    def __init__(
        self,
        device: str = "cpu",
        hub: str | None = None,
        model_dir: str | None = None,
        vad_dir: str | None = None,
        punc_dir: str | None = None,
    ):
        try:
            from funasr import AutoModel
        except ImportError as exc:  # pragma: no cover - optional dep
            raise RuntimeError(
                "funasr is not installed. Run `pip install funasr modelscope` "
                "to enable Chinese ASR, or use provider=whisperx."
            ) from exc

        hub = hub or os.getenv("FUNASR_HUB", "ms")
        model = model_dir or os.getenv("FUNASR_MODEL_DIR") or "paraformer-zh"
        vad_model = vad_dir or os.getenv("FUNASR_VAD_DIR") or "fsmn-vad"
        punc_model = punc_dir or os.getenv("FUNASR_PUNC_DIR") or "ct-punc"

        self._device = _resolve_device(device)
        self._model = AutoModel(
            model=model,
            vad_model=vad_model,
            vad_kwargs={"max_single_segment_time": 60000},
            punc_model=punc_model,
            device=self._device,
            hub=hub,
            disable_update=True,
        )

    def release(self) -> None:
        """Unload FunASR weights and return GPU memory to the driver."""
        model = self._model
        if model is None:
            return
        for name in ("punc_model", "vad_model", "model", "spk_model"):
            if hasattr(model, name):
                setattr(model, name, None)
        self._model = None
        _release_vram()

    def transcribe(
        self,
        audio_path: str,
        language: str | None = None,
        word_timestamps: bool = True,
        batch_size_s: int = 60,
    ) -> list[ASRSegment]:
        # batch_size_s = seconds of audio per inference batch. Activation memory
        # scales with it: the old 300 produced peaks that overflowed an 8GB card
        # sharing VRAM with other jobs (native crash); 60 is safe and barely slower.
        if self._model is None:
            raise RuntimeError("FunASRProvider has been released; construct a new one.")
        # sentence_timestamp=True asks the vad+punc pipeline for sentence-level
        # `sentence_info`. Recent funasr releases only emit it when this flag
        # (or a speaker model) is set — without it the result is one merged
        # `text` blob, which rendered as a single wall-of-text caption.
        result = self._model.generate(
            input=audio_path, batch_size_s=batch_size_s, sentence_timestamp=True
        )
        return map_funasr_result(result)
