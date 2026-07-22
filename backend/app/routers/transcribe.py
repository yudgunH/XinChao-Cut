"""WhisperX transcription endpoint.

Returns subtitle cues with word-level timestamps, grouped into short phrases so
they match the in-browser captions style. WhisperX (faster-whisper + wav2vec2
forced alignment + VAD) gives noticeably better timing and fewer hallucinations
than the browser Whisper, especially for long-form audio and non-English speech.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import sys
import threading
import time
import unicodedata
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar, Token
from typing import Callable, Iterator

# ── Must be before any huggingface / torch / ctranslate2 import ────────────
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

# Let PyTorch grow its CUDA allocations in expandable segments instead of fixed
# blocks, which reduces fragmentation-driven OOM-retry thrashing. NOTE: this is
# a no-op on Windows (torch logs a one-time "not supported on this platform"
# warning) — there the real safeguard is the smaller large-model batch size
# below. Kept for Linux deployments where it does take effect.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# Leave half the logical CPUs free so the OS + other apps stay responsive.
# ctranslate2 (faster-whisper backend), PyTorch (alignment), numpy/BLAS all
# respect these env vars. Set before importing any of them.
_HALF_CORES = max(1, (os.cpu_count() or 4) // 2)
os.environ.setdefault("OMP_NUM_THREADS", str(_HALF_CORES))
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(_HALF_CORES))
os.environ.setdefault("MKL_NUM_THREADS", str(_HALF_CORES))
os.environ.setdefault("NUMEXPR_NUM_THREADS", str(_HALF_CORES))
# ───────────────────────────────────────────────────────────────────────────

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile  # noqa: E402

from ..config import get_settings  # noqa: E402
from ..ffmpeg_utils import probe_duration  # noqa: E402
from ..process_runner import media_timeout  # noqa: E402
from ..utils import (  # noqa: E402
    cleanup_temp_path,
    create_async_saved_upload,
    defer_temp_cleanup,
    resolve_source_path,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["transcribe"])

# Single-worker pool — one transcription at a time keeps memory predictable
# and prevents competing for CPU. Running in a thread lets the uvicorn event
# loop stay responsive (answer /health, etc.) while whisperX is busy.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisperx")

# Hard-kill isolation starts early enough that a cancelled editor job cannot
# retain WhisperX/GPU for tens of minutes. Very short clips keep the warm-model
# in-process fast path; long/heavy inputs trade startup time for reliable kill.
_LONG_FORM_SUBPROCESS_SEC = 5 * 60
_LONG_FORM_UNKNOWN_DURATION_BYTES = 128 * 1024 * 1024


class _TranscriptionInput:
    """Own an uploaded input until its executor future has really stopped.

    HTTP timeout/disconnect only requests cooperative cancellation; the worker
    may still be reading the media.  Transferring cleanup to the future avoids
    deleting the upload underneath FFmpeg/ASR when the request returns early.
    """

    def __init__(self, source_path: str | None, upload: UploadFile | None) -> None:
        self._source_path = source_path
        self._upload = upload
        self._owned_temp: str | None = None

    async def __aenter__(self) -> str:
        if self._source_path is not None:
            return self._source_path
        if self._upload is None:
            raise ValueError("Missing transcription input")
        self._owned_temp = await create_async_saved_upload(self._upload)
        return self._owned_temp

    def handoff(self, future: Future) -> None:
        if self._owned_temp is None:
            return
        defer_temp_cleanup(self._owned_temp, future)
        self._owned_temp = None

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        if self._owned_temp is not None:
            cleanup_temp_path(self._owned_temp)
            self._owned_temp = None


def _transcription_profile(path: str) -> tuple[float, float]:
    """Scale long-form ASR deadlines with media duration, still hard-bounded."""
    duration = probe_duration(path)
    timeout = media_timeout(
        duration,
        base=600,
        per_sec=2,
        minimum=600,
        hard_cap=12 * 3600,
    )
    return duration, timeout


def _should_isolate_transcription(
    path: str, duration_sec: float, model_name: str = ""
) -> bool:
    """Prefer hard-kill isolation when duration is long or probing was inconclusive.

    Large models are ALWAYS isolated regardless of duration: on an 8 GB card
    shared with the editor the monolithic ASR phase can crawl for many minutes
    (batch size collapses to 1), and the in-process path can only cancel at
    phase checkpoints — so a cancelled large-v3 job kept grinding the GPU and
    holding 3-4 GB VRAM long after the user hit Cancel. Tree-kill returns the
    VRAM to the OS immediately; the subprocess cold-start cost is noise next to
    a large-model run.
    """
    if _is_large_model(model_name):
        return True
    if duration_sec >= _LONG_FORM_SUBPROCESS_SEC:
        return True
    if duration_sec > 0:
        return False
    try:
        return os.path.getsize(path) >= _LONG_FORM_UNKNOWN_DURATION_BYTES
    except OSError:
        return False


# ── Busy-guard + per-job soft-cancel ────────────────────────────────────────
# `_busy` is try-acquired per request: a second transcription gets an instant
# 409 instead of silently queueing behind the first in the single-worker
# executor (which used to look like a 10-minute hang to the user).
#
# Normal user cancel is per job/attempt; the only process-global event is the
# application-lifespan shutdown signal:
#   * HTTP /transcribe owns a request-local Event (disconnect / timeout).
#   * `run_transcription_sync` takes an optional cooperative `cancel_check`.
#
# Checkpoints poll the active cancel_check so WhisperX exits between phases
# when an in-process caller cancels.
_busy = threading.Lock()
_http_admission = threading.Lock()
_runtime_stop = threading.Event()


def resume_runtime() -> None:
    """Allow ASR work for a newly-started application lifespan."""
    _runtime_stop.clear()


def shutdown_runtime() -> int:
    """Cooperatively stop every ASR path.

    Long-form WhisperX/FunASR run in tree-killable subprocesses and observe the
    flag through their cancel callback. Short in-process WhisperX observes it at
    phase checkpoints. Returning the number is intentionally just a signal
    count: shutdown never waits indefinitely for a third-party model call.
    """
    already_set = _runtime_stop.is_set()
    _runtime_stop.set()
    return 0 if already_set else 1


def _shutdown_aware_cancel(cancel_check: CancelCheck | None) -> CancelCheck:
    def check() -> bool:
        return _runtime_stop.is_set() or bool(cancel_check and cancel_check())

    return check


class _HttpAdmissionLease:
    """Keep an HTTP request admitted until its executor worker really exits."""

    def __init__(self) -> None:
        self._active = True
        self._state_lock = threading.Lock()

    def release(self) -> None:
        with self._state_lock:
            if not self._active:
                return
            self._active = False
            _http_admission.release()

    def handoff(self, future: Future) -> None:
        future.add_done_callback(lambda _future: self.release())


def _acquire_http_admission() -> _HttpAdmissionLease:
    if not _http_admission.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="A transcription is already running on the server. "
            "Wait for it to finish (or cancel it) and try again.",
        )
    return _HttpAdmissionLease()


CancelCheck = Callable[[], bool]
_active_cancel_check: ContextVar[CancelCheck | None] = ContextVar(
    "whisperx_cancel_check",
    default=None,
)

_PROGRESS_TOKEN_RE = re.compile(r"^[a-f0-9]{32}$")
_PROGRESS_BY_STAGE = {
    "queued": 1,
    "gpu-acquired": 4,
    "start": 6,
    "audio-loaded": 10,
    "model-loaded": 18,
    "asr-before": 22,
    "transcribed": 78,
    "aligned": 96,
    "done": 100,
}
_active_progress_path: ContextVar[str | None] = ContextVar(
    "whisperx_progress_path", default=None
)


def _progress_path(token: str, *, cleanup: bool = False) -> str:
    if not _PROGRESS_TOKEN_RE.fullmatch(token):
        raise ValueError("invalid progress token")
    root = os.path.join(get_settings().work_dir, "asr-progress")
    # Best-effort bounded hygiene: progress files are tiny but a workstation
    # can run thousands of caption jobs over time. Reclaim stale entries when a
    # new token arrives; never scan outside this dedicated directory.
    try:
        cutoff = time.time() - 24 * 3600
        if cleanup and os.path.isdir(root):
            for name in os.listdir(root):
                candidate = os.path.join(root, name)
                if name.endswith(".json") and os.path.getmtime(candidate) < cutoff:
                    os.remove(candidate)
    except OSError:
        pass
    return os.path.join(root, f"{token}.json")


def _write_progress_file(
    path: str,
    stage: str,
    pct: int,
    status: str = "running",
    *,
    estimated: bool = False,
) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "stage": stage,
        "pct": max(0, min(100, int(pct))),
        "status": status,
        "updatedAt": time.time(),
        "estimated": estimated,
    }
    tmp = path + f".{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(tmp, path)


def _advance_asr_estimate(
    path: str | None,
    duration_sec: float,
    model_name: str,
    elapsed_sec: float,
) -> None:
    """Move the long monolithic WhisperX phase without pretending it is exact."""
    if not path:
        return
    try:
        with open(path, encoding="utf-8") as handle:
            current = json.load(handle)
        if current.get("stage") not in ("asr-before", "asr-estimate"):
            return
        # GPU observations: small is commonly around 0.12x realtime; large-v3
        # around 0.30x. Cap below the real `transcribed` checkpoint and mark the
        # value estimated so the UI displays a leading ~.
        factor = 0.30 if _is_large_model(model_name) else 0.12
        expected = max(60.0, max(1.0, duration_sec) * factor)
        pct = min(76, 22 + int(54 * elapsed_sec / expected))
        if pct > int(current.get("pct") or 0):
            _write_progress_file(path, "asr-estimate", pct, estimated=True)
    except (OSError, ValueError, TypeError):
        return


def _emit_progress(stage: str) -> None:
    path = _active_progress_path.get() or os.environ.get("XINCHAO_ASR_PROGRESS_FILE", "")
    if not path:
        return
    pct = _PROGRESS_BY_STAGE.get(stage)
    if pct is None and stage.startswith("segment-batch-"):
        pct = 82
    if pct is None and stage.startswith("gap-fill-"):
        pct = 90
    if pct is not None:
        try:
            _write_progress_file(path, stage, pct)
        except OSError:
            log.debug("could not write ASR progress", exc_info=True)


@contextmanager
def _bound_progress_path(path: str | None) -> Iterator[None]:
    token = _active_progress_path.set(path)
    try:
        yield
    finally:
        _active_progress_path.reset(token)


class _Cancelled(Exception):
    """Raised inside the worker when a cancel check trips at a checkpoint."""


class TranscriptionCancelled(Exception):
    """Public cancel signal for in-process callers."""

    def __init__(self, stage: str = ""):
        super().__init__(stage or "transcription cancelled")
        self.stage = stage


@contextmanager
def _bound_cancel_check(cancel_check: CancelCheck | None) -> Iterator[None]:
    token: Token = _active_cancel_check.set(cancel_check)
    try:
        yield
    finally:
        _active_cancel_check.reset(token)


def _checkpoint(stage: str) -> None:
    _emit_progress(stage)
    check = _active_cancel_check.get()
    if check is None:
        return
    try:
        if check():
            log.info("Transcription cancelled at checkpoint: %s", stage)
            raise _Cancelled(stage)
    except _Cancelled:
        raise
    except Exception:  # noqa: BLE001 — never block cancel path on a bad check
        log.exception("cancel_check raised at %s; treating as cancel", stage)
        raise _Cancelled(stage) from None


# Match the in-browser segmentation so captions look consistent across engines.
MAX_PHRASE_WORDS = 7
PAUSE_THRESHOLD_SEC = 0.4
MIN_REPEAT_WORDS = 3
WORD_REPEAT_WINDOW_SEC = 8.0
# End a cue on a word that closes a sentence (once the phrase has enough words to
# be a real clause) so cue boundaries fall on sentence ends — captions read as
# whole thoughts and map 1:1 onto translation units instead of splitting a
# sentence across two cues.
_SENTENCE_END_PUNCT = (".", "!", "?", "。", "！", "？", "…")
MIN_SENTENCE_WORDS = 3
_WORD_EDGE_RE = re.compile(r"^\W+|\W+$", re.UNICODE)

# The frontend sends human-readable language names; whisper/faster-whisper wants
# ISO codes. Map the known names and pass through anything that already looks
# like a code; unknown values fall back to auto-detect (None) instead of 500.
_LANG_MAP = {
    "english": "en",
    "vietnamese": "vi",
    "japanese": "ja",
    "chinese": "zh",
    "korean": "ko",
    "spanish": "es",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "portuguese": "pt",
    "russian": "ru",
    "thai": "th",
    "indonesian": "id",
    "hindi": "hi",
    "arabic": "ar",
}


def _normalize_lang(language: str | None) -> str | None:
    if not language:
        return None
    l = language.strip().lower()  # noqa: E741 - local normalized language code
    if l in ("", "auto"):
        return None
    if l in _LANG_MAP:
        return _LANG_MAP[l]
    if 2 <= len(l) <= 3:  # already an ISO code (en, vi, yue, …)
        return l
    return None  # unknown name → let whisper auto-detect rather than crash


# ── Model cache (LRU-1: only one ASR model kept in RAM at a time) ───────────
# Keeping multiple large models simultaneously can exhaust RAM.
# When the user switches from large-v3 to tiny we load tiny and drop large-v3.
_asr_lock: threading.Lock = threading.Lock()
_asr_key: tuple | None = None  # currently cached key
_asr_model = None  # currently cached model

_align_cache: dict = {}  # alignment models are small — keep them all
# ────────────────────────────────────────────────────────────────────────────

# ── Idle eviction (releases ~3-4 GB VRAM so export/tts can use the GPU) ─────
# After a transcription completes, the WhisperX ASR + alignment models stay
# resident so a follow-up transcribe is instant. But on a single 8 GB card
# that's 3-4 GB sitting unused once captioning is done — blocking a later
# export/separate/TTS from getting VRAM. So a watcher unloads them after the
# user is plainly idle (no transcription in flight for IDLE_TTL_SEC). The next
# transcription pays the cold-load cost (a few seconds), which is what the
# user asked for: prefer free VRAM over warm-cache speed.
_IDLE_TTL_SEC = 120
_IDLE_POLL_SEC = 15
_last_used: float = 0.0  # epoch time the last transcription finished (any outcome)
_idle_watcher_started = False


def _evict_idle_models_if_due(now: float | None = None) -> bool:
    """Evict an expired warm cache from the WhisperX executor thread.

    CTranslate2/PyTorch CUDA objects must not be destroyed by the timer daemon
    on Windows: native cleanup can terminate the interpreter without a Python
    traceback. This function is submitted to ``_executor``, so destruction
    happens on the same long-lived worker that loads and uses WhisperX.
    """
    global _asr_model, _asr_key
    if _asr_model is None or _last_used <= 0:
        return False
    if not _busy.acquire(blocking=False):
        return False
    try:
        idle_for = (time.time() if now is None else now) - _last_used
        if idle_for <= _IDLE_TTL_SEC:
            return False
        with _asr_lock:
            if _asr_model is None:
                return False
            log.info(
                "WhisperX idle %.0fs (TTL %ds) → releasing %s + %d alignment model(s) to free VRAM",
                idle_for,
                _IDLE_TTL_SEC,
                _asr_key,
                len(_align_cache),
            )
            _asr_model = None
            _asr_key = None
            _align_cache.clear()
            _empty_cuda_cache()
            return True
    finally:
        _busy.release()


def _idle_watcher() -> None:
    """Background thread: evict the cached ASR + alignment models once the
    backend has been idle past the TTL. Skips when a job is in flight (`_busy`
    held) so it can never race the lifetime of a model still in use."""
    while True:
        time.sleep(_IDLE_POLL_SEC)
        if _asr_model is None or _last_used <= 0:
            continue
        if not _busy.acquire(blocking=False):
            continue  # transcribe is running — leave the model alone
        _busy.release()
        # Queue cleanup on WhisperX's own worker. It re-checks busy/TTL after
        # any work already ahead of it has completed.
        _executor.submit(_evict_idle_models_if_due)


def _ensure_idle_watcher() -> None:
    """Spawn the eviction watcher once — done lazily on the first model load so
    importing this module (e.g. in tests) doesn't start a background thread."""
    global _idle_watcher_started
    if _idle_watcher_started:
        return
    _idle_watcher_started = True
    threading.Thread(target=_idle_watcher, daemon=True, name="whisperx-idle").start()


def _is_large_model(name: str) -> bool:
    """large-v3 ≈ 3-4 GB VRAM — the size that, co-resident with OmniVoice (2 GB) +
    desktop baseline, overflows an 8 GB card. small/base/medium stay under and can
    coexist with TTS, so they're never cross-evicted (no needless reloads)."""
    return "large" in (name or "").lower()


def release_models(only_if_large: bool = False) -> bool:
    """Evict the cached WhisperX ASR + alignment models NOW (free ~0.5-4 GB) so
    another GPU subsystem (OmniVoice TTS) gets VRAM. Called on-demand before TTS
    loads, instead of waiting the 120s idle TTL. No-op if nothing's loaded, a
    transcription is in flight, or (only_if_large) the model is small enough to
    coexist. Returns True if it freed something."""
    global _asr_model, _asr_key
    if _asr_model is None:
        return False
    if only_if_large and not _is_large_model((_asr_key or ("",))[0]):
        return False
    if not _busy.acquire(blocking=False):
        return False  # transcription running — leave the model alone
    try:
        with _asr_lock:
            if _asr_model is None:
                return False
            log.info("WhisperX released on demand (free VRAM for TTS/other GPU job)")
            _asr_model = None
            _asr_key = None
            _align_cache.clear()
            _empty_cuda_cache()
            return True
    finally:
        _busy.release()


def free_asr_vram(only_if_large: bool = False) -> None:
    """Evict the resident ASR models to free VRAM before another GPU subsystem
    (TTS, diarization) loads. only_if_large keeps a small WhisperX resident (it
    coexists with TTS). FunASR runs in a one-shot subprocess now — nothing of it
    is resident here, its release() is a compatibility no-op. Best effort —
    never raises, so a release-path bug can't block the caller."""
    try:
        release_models(only_if_large=only_if_large)
    except Exception:  # noqa: BLE001 — best effort; never block the caller
        pass
    try:
        from ..asr import funasr_runtime

        funasr_runtime.release()
    except Exception:  # noqa: BLE001 — best effort; never block the caller
        pass


# ────────────────────────────────────────────────────────────────────────────


# Resolved (device, compute_type) — computed once, then cached for the process.
_resolved_runtime: tuple[str, str] | None = None


def _resolve_device_compute() -> tuple[str, str]:
    """Turn the "auto" settings into concrete (device, compute_type) values.

    device  "auto" → "cuda" when a CUDA-enabled torch + GPU are present, else "cpu".
    compute "auto" → "float16" on GPU (fast, fits 8 GB even for large-v3),
                     "int8" on CPU.
    """
    global _resolved_runtime
    if _resolved_runtime is not None:
        return _resolved_runtime

    s = get_settings()
    device = s.whisper_device
    compute = s.whisper_compute_type

    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"

    log.info("WhisperX runtime resolved: device=%s compute_type=%s", device, compute)
    _resolved_runtime = (device, compute)
    return _resolved_runtime


def whisperx_available() -> bool:
    """Cheap presence check (metadata only). A real `import whisperx` pulls in
    torch + pyannote (10-30s cold) — doing that here made the first /health
    call hang past the frontend's 2.5s timeout, so the backend looked offline
    for the first minute after start. The heavy import still happens lazily in
    the worker (and is pre-warmed in the background at startup — see main.py)."""
    import importlib.util

    return importlib.util.find_spec("whisperx") is not None


_runtime_prepared = False


def _prepare_whisperx_runtime() -> None:
    """Apply Windows/dependency workarounds before loading any model.

    1) speechbrain↔pyannote↔lightning crash: loading pyannote's VAD calls
       `inspect.stack()`, which probes every module with `hasattr(m,"__file__")`.
       speechbrain's LazyModule raises ImportError on *any* attribute (incl.
       `__file__`) when its optional target (`speechbrain.integrations.k2_fsa`,
       needs the k2 package) is absent — turning a harmless probe into a crash.
       Patch it so dunder probes raise AttributeError (→ hasattr False).

    2) HuggingFace model downloads fail on Windows without Developer Mode/admin
       (`WinError 1314` on os.symlink). Force the copy code path instead.

    3) Limit PyTorch thread count to match OMP settings.
    """
    global _runtime_prepared
    if _runtime_prepared:
        return
    _runtime_prepared = True

    # (1) speechbrain lazy-import guard
    try:
        from speechbrain.utils import importutils as iu

        original = iu.LazyModule.__getattr__

        def safe_getattr(self, attr):  # type: ignore[no-untyped-def]
            if attr.startswith("__") and attr.endswith("__"):
                raise AttributeError(attr)
            return original(self, attr)

        iu.LazyModule.__getattr__ = safe_getattr
    except Exception:
        pass

    # (2) avoid HF cache symlinks (Windows privilege error)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    try:
        import huggingface_hub.file_download as fd

        fd.are_symlinks_supported = lambda *a, **k: False  # type: ignore[assignment]
    except Exception:
        pass

    # (3) cap PyTorch intra-op threads to match OMP setting
    try:
        import torch

        torch.set_num_threads(_HALF_CORES)
        torch.set_num_interop_threads(max(1, _HALF_CORES // 2))
    except Exception:
        pass

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def _empty_cuda_cache() -> None:
    """Free any VRAM a failed/evicted model left allocated, before retrying."""
    import gc

    gc.collect()
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:
        pass


def _compute_fallbacks(device: str, compute: str) -> list[str]:
    """Ordered compute types to try when loading an ASR model.

    Pascal-and-older GPUs (compute capability < 7.0, e.g. GTX 10-series) have no
    efficient float16 / int8_float16 path, so ctranslate2 raises when asked for
    one. Fall back to int8_float32 then plain int8 — both supported on every CUDA
    device — so an old GPU still runs *on the GPU* instead of crashing or being
    forced to CPU. On CPU there's nothing to fall back to.
    """
    if device != "cuda":
        return [compute]
    chain = [compute]
    for alt in ("int8_float32", "int8"):
        if alt not in chain:
            chain.append(alt)
    return chain


def _get_asr(model_name: str, language: str | None):
    """Return the cached ASR model, loading (and evicting the old one) if needed."""
    import whisperx

    _prepare_whisperx_runtime()
    _ensure_idle_watcher()
    global _resolved_runtime
    s = get_settings()
    device, compute = _resolve_device_compute()
    key = (model_name, language or "auto", device, compute)

    global _asr_key, _asr_model
    with _asr_lock:
        if _asr_key != key:
            if _asr_model is not None:
                log.info("Evicting ASR model %s to load %s", _asr_key, model_name)
                # Release the old model's memory before loading the new one.
                try:
                    del _asr_model
                    _asr_model = None
                    _empty_cuda_cache()
                except Exception:
                    pass

            # 8GB headroom: a LARGE whisper (~3-4GB) + a resident OmniVoice worker
            # (2GB) overflows the card → evict the idle TTS worker first.
            if _is_large_model(model_name):
                try:
                    from . import tts

                    tts._WORKER_MGR.shutdown_if_idle()  # non-blocking; skips a running synth
                except Exception:  # noqa: BLE001 — best effort; never block captioning
                    pass

            # VRAM gate: with our own models evicted above, make sure the CARD
            # (incl. other processes) actually has room before loading. If it
            # doesn't free up in time, run THIS load on CPU — slow, but the
            # machine stays responsive instead of thrashing shared memory.
            if device == "cuda":
                from .. import gpu_guard

                need = (
                    gpu_guard.NEED_WHISPER_LARGE
                    if _is_large_model(model_name)
                    else gpu_guard.NEED_WHISPER_SMALL
                )
                if not gpu_guard.wait_for_vram(need, kind=f"whisper:{model_name}"):
                    log.warning(
                        "Insufficient free VRAM for WhisperX %s — loading on CPU for this run.",
                        model_name,
                    )
                    device, compute = "cpu", "int8"
                    key = (model_name, language or "auto", device, compute)

            candidates = _compute_fallbacks(device, compute)
            last_err: Exception | None = None
            for i, ctype in enumerate(candidates):
                log.info(
                    "Loading WhisperX model %s (device=%s, compute=%s, cpu_threads=%d)",
                    model_name,
                    device,
                    ctype,
                    _HALF_CORES,
                )
                try:
                    _asr_model = whisperx.load_model(
                        model_name,
                        device=device,
                        compute_type=ctype,
                        download_root=s.whisper_cache,
                        language=language,
                        # whisperx forwards `threads` to ctranslate2's cpu_threads.
                        # Limits CPU thread use so the machine stays responsive (CPU
                        # only; ignored on GPU).
                        threads=_HALF_CORES,
                    )
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    _empty_cuda_cache()
                    if i + 1 < len(candidates):
                        log.warning(
                            "compute_type=%s failed on this GPU (%s); retrying with %s",
                            ctype,
                            e,
                            candidates[i + 1],
                        )
                        continue
                    raise  # exhausted fallbacks — surface the real error
                # Success. Remember the working compute type for the rest of the
                # process so we don't re-attempt the broken one on every model
                # switch, and key the cache on it.
                if ctype != compute:
                    log.info(
                        "Using compute_type=%s for the rest of this session", ctype
                    )
                    _resolved_runtime = (device, ctype)
                _asr_key = (model_name, language or "auto", device, ctype)
                break
            else:  # pragma: no cover — loop only exits via break/raise
                raise last_err or RuntimeError("Failed to load ASR model")

        return _asr_model


def _get_align(language_code: str):
    import whisperx

    device, _ = _resolve_device_compute()
    if language_code not in _align_cache:
        log.info("Loading alignment model for language '%s'", language_code)
        model, metadata = whisperx.load_align_model(
            language_code=language_code, device=device
        )
        _align_cache[language_code] = (model, metadata)
    return _align_cache[language_code]


def _normalize_word(text: str) -> str:
    return _WORD_EDGE_RE.sub("", unicodedata.normalize("NFKC", text).lower())


def _matching_word_prefix_len(
    words: list[dict], index: int, accepted: list[dict], accepted_index: int
) -> int:
    length = 0
    while index + length < len(words) and accepted_index + length < len(accepted):
        word = _normalize_word(words[index + length]["word"])
        accepted_word = _normalize_word(accepted[accepted_index + length]["word"])
        if not word or word != accepted_word:
            break
        length += 1
    return length


def _repeated_word_prefix_len(
    words: list[dict], index: int, accepted: list[dict]
) -> int:
    if index >= len(words):
        return 0

    current = words[index]
    best = 0
    for i in range(len(accepted) - 1, -1, -1):
        prev = accepted[i]
        if current["start"] - prev["end"] > WORD_REPEAT_WINDOW_SEC:
            break

        length = _matching_word_prefix_len(words, index, accepted, i)
        if length < MIN_REPEAT_WORDS:
            continue

        candidate_end = words[index + length - 1]["end"]
        matched_start = prev["start"]
        matched_end = accepted[i + length - 1]["end"]
        # A genuine ASR hallucination re-emits the SAME audio span, so the
        # repeated run OVERLAPS the original in time. A person actually
        # repeating a phrase (extremely common in bodycam/command footage:
        # "stop resisting" x3, "get on the ground") speaks it in a LATER,
        # non-overlapping span with a real pause between — that MUST be kept as
        # a separate caption, not deleted. Previously this used a ±0.6s
        # proximity window, which swallowed those real re-utterances (measured:
        # ~37% of words dropped on repetitive dialogue) and left gaps in the
        # caption track. Require actual time overlap instead.
        overlap = min(candidate_end, matched_end) - max(current["start"], matched_start)
        if overlap > 0:
            best = max(best, length)
    return best


def _dedupe_repeated_words(words: list[dict]) -> list[dict]:
    out: list[dict] = []
    i = 0
    while i < len(words):
        repeated = _repeated_word_prefix_len(words, i, out)
        if repeated >= MIN_REPEAT_WORDS:
            i += repeated
            continue

        word = words[i]
        prev = out[-1] if out else None
        if (
            prev
            and _normalize_word(prev["word"]) == _normalize_word(word["word"])
            and abs(prev["start"] - word["start"]) <= 0.08
            and abs(prev["end"] - word["end"]) <= 0.12
        ):
            i += 1
            continue

        out.append(word)
        i += 1
    return out


def _is_cjk_char(ch: str) -> bool:
    """A single CJK/Japanese/Korean character — one that carries a whole syllable
    and is written WITHOUT surrounding spaces."""
    return any(
        "一" <= c <= "鿿"  # CJK unified ideographs
        or "぀" <= c <= "ヿ"  # hiragana + katakana
        or "가" <= c <= "힣"  # hangul syllables
        for c in ch
    )


def _join_cue_words(words: list[str]) -> str:
    """Join tokens into a line: no space between two adjacent CJK characters
    (WhisperX emits Chinese char-by-char, so a naive space-join produces
    '我 是 你'), a normal space between Latin words."""
    out = ""
    for w in words:
        if out and not (_is_cjk_char(out[-1]) and _is_cjk_char(w[:1])):
            out += " "
        out += w
    return out


# For CJK there are no word gaps, so WhisperX hands back one token per character.
# Capping a phrase at MAX_PHRASE_WORDS (7) would shred a sentence every 7 glyphs;
# cap by character count instead so a cue is a readable clause-length chunk.
CJK_MAX_CUE_CHARS = 28


def _group_into_cues(words: list[dict]) -> list[dict]:
    """Flatten aligned words into short phrase cues (content + relative words)."""
    flat: list[dict] = []
    cursor = 0.0
    for w in words:
        text = (w.get("word") or "").strip()
        if not text:
            continue
        start = w.get("start")
        end = w.get("end")
        start = float(start) if start is not None else cursor
        end = float(end) if end is not None else start + 0.3
        end = max(end, start + 0.05)
        flat.append({"word": text, "start": start, "end": end})
        cursor = end

    flat = _dedupe_repeated_words(flat)

    cues: list[dict] = []
    phrase: list[dict] = []

    def flush() -> None:
        if not phrase:
            return
        s0 = phrase[0]["start"]
        e0 = phrase[-1]["end"]
        cues.append(
            {
                "content": _join_cue_words([p["word"] for p in phrase]),
                "startSec": s0,
                "endSec": max(e0, s0 + 0.3),
                "words": [
                    {
                        "word": p["word"],
                        "startSec": p["start"] - s0,
                        "endSec": p["end"] - s0,
                    }
                    for p in phrase
                ],
            }
        )

    for w in flat:
        last = phrase[-1] if phrase else None
        pause = (w["start"] - last["end"]) if last else 0.0
        # CJK phrases (char-per-token) cap by character count; Latin by word count.
        cjk_phrase = bool(phrase) and _is_cjk_char(phrase[-1]["word"][-1:])
        over_budget = (
            sum(len(p["word"]) for p in phrase) >= CJK_MAX_CUE_CHARS
            if cjk_phrase
            else len(phrase) >= MAX_PHRASE_WORDS
        )
        if phrase and (over_budget or pause >= PAUSE_THRESHOLD_SEC):
            flush()
            phrase = []
        phrase.append(w)
        # Close the cue on a sentence-ending word (once it's a real clause) so a
        # sentence isn't carried into the next cue.
        if len(phrase) >= MIN_SENTENCE_WORDS and w["word"].rstrip().endswith(
            _SENTENCE_END_PUNCT
        ):
            flush()
            phrase = []
    flush()

    # Merge an identical adjacent phrase ONLY when it's essentially contiguous
    # (< 0.2s gap) — that's hallucination residue where one utterance got split.
    # If a real pause separates them the speaker genuinely repeated the phrase
    # (e.g. a shouted command), so keep both as distinct captions instead of
    # collapsing them into one long caption (which also desynced word-level
    # karaoke timing, since the merged cue's word list only covered the first
    # utterance).
    out: list[dict] = []
    for cue in cues:
        prev = out[-1] if out else None
        if (
            prev
            and prev["content"] == cue["content"]
            and cue["startSec"] - prev["endSec"] < 0.2
        ):
            prev["endSec"] = max(prev["endSec"], cue["endSec"])
        else:
            out.append(cue)
    return out


def _gpu_mem_mb() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            return (
                f"{(total - free) // (1024 * 1024)}/{total // (1024 * 1024)} MiB used"
            )
    except Exception:
        pass
    return "n/a"


def _gpu_free_mb() -> int | None:
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.mem_get_info()[0] // (1024 * 1024)
    except Exception:
        pass
    return None


def _pick_batch_size(device: str, model_name: str) -> int:
    """Choose a transcription batch size that fits the *currently free* VRAM.

    Call this AFTER the ASR model is loaded so the measurement reflects the
    real headroom left for activations + the alignment model + the browser /
    canvas preview. For long videos or when the GPU is busy elsewhere this
    automatically scales the batch down instead of OOM-thrashing.
    """
    if device == "cpu":
        return 1

    is_large = "large" in model_name
    cap = 8 if is_large else 16  # upper bound when memory is plentiful
    per_item = 200 if is_large else 90  # rough MiB of activations per batch item

    free = _gpu_free_mb()
    if free is None:
        return 4 if is_large else 8  # sensible default if we can't measure

    # Reserve room for the alignment model + desktop/browser spikes.
    usable = free - 1300
    batch = int(usable // per_item)
    batch = max(1, min(batch, cap))
    log.info("[batch] free=%d MiB → batch_size=%d (model=%s)", free, batch, model_name)
    return batch


def _reconcile_segment_words(
    raw_segments: list[dict], aligned_segments: list[dict]
) -> list[dict]:
    """Flatten whisperX's aligned segments into a flat word list, patching over
    forced-alignment word loss.

    WhisperX's `align()` silently OMITS individual words from a segment's
    `words` list when it can't confidently align them to the audio (noise,
    cross-talk, music, fast/mumbled speech) — this does not raise, so the
    existing top-level `except Exception` fallback never sees it. The result
    was captions with real gaps: a segment that ASR transcribed correctly
    could lose several words during alignment with no trace left downstream.

    Only reconciles when segment counts line up 1:1, which is the normal
    whisperX contract (`align()` maps each input segment to one output
    segment). If counts differ, whole segments were dropped rather than
    individual words — a different failure mode this isn't scoped to guess
    at, so it falls back to the plain (pre-fix) behavior instead of risking
    a wrong raw/aligned pairing.
    """
    words: list[dict] = []
    can_reconcile = len(raw_segments) == len(aligned_segments)
    for i, seg in enumerate(aligned_segments):
        seg_words = seg.get("words", []) or []
        if not can_reconcile:
            words.extend(seg_words)
            continue

        timed_words = [
            w
            for w in seg_words
            if w.get("start") is not None and w.get("end") is not None
        ]
        raw_text = str(raw_segments[i].get("text", "") or "")
        raw_words = raw_text.split()
        # Below 70% word-count coverage → treat as a lossy alignment for this
        # segment. A small gap (punctuation/number-format differences between
        # the raw ASR text and aligned tokens) is normal and shouldn't trigger
        # this; a large one means real words vanished.
        if raw_words and len(timed_words) < len(raw_words) * 0.7:
            seg_start, seg_end = seg.get("start"), seg.get("end")
            if seg_start is None or seg_end is None:
                words.extend(
                    seg_words
                )  # no segment-level timing to fall back to either
                continue
            log.warning(
                "[align] segment %d lost %d/%d words during forced alignment; "
                "using even-split fallback timing for this segment's raw text",
                i,
                len(raw_words) - len(timed_words),
                len(raw_words),
            )
            seg_dur = max(0.05, float(seg_end) - float(seg_start))
            n = len(raw_words)
            for wi, rw in enumerate(raw_words):
                words.append(
                    {
                        "word": rw,
                        "start": float(seg_start) + (wi / n) * seg_dur,
                        "end": float(seg_start) + ((wi + 1) / n) * seg_dur,
                    }
                )
        else:
            words.extend(seg_words)
    return words


def _fallback_segment_words(raw_segments: list[dict]) -> list[dict]:
    """Turn segment-level ASR output into real word timestamps.

    WhisperX alignment can fail for a language/model or noisy passage. The old
    fallback emitted the entire segment text as one `word`, which defeated the
    seven-word cue cap and made karaoke highlight a sentence at a time. Preserve
    the segment's timing, but distribute it over its lexical words (or CJK
    characters) so all downstream contracts remain word-based.
    """
    words: list[dict] = []
    for seg in raw_segments:
        text = str(seg.get("text", "") or "").strip()
        start_raw, end_raw = seg.get("start"), seg.get("end")
        if not text or start_raw is None or end_raw is None:
            continue
        start, end = float(start_raw), float(end_raw)
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            continue
        tokens = text.split()
        if len(tokens) == 1 and any(_is_cjk_char(ch) for ch in text):
            tokens = [ch for ch in text if not ch.isspace()]
        if not tokens:
            continue
        duration = end - start
        for index, token in enumerate(tokens):
            words.append(
                {
                    "word": token,
                    "start": start + index / len(tokens) * duration,
                    "end": start + (index + 1) / len(tokens) * duration,
                }
            )
    return words


def _find_word_gaps(
    words: list[dict], duration_sec: float, min_gap_sec: float
) -> list[tuple[float, float]]:
    """Spans of the audio (in seconds) with no transcribed word covering them —
    candidates for the gap-fill re-transcribe pass below."""
    spans = sorted(
        (float(w["start"]), float(w["end"]))
        for w in words
        if w.get("start") is not None and w.get("end") is not None
    )
    gaps: list[tuple[float, float]] = []
    prev_end = 0.0
    for start, end in spans:
        if start - prev_end > min_gap_sec:
            gaps.append((prev_end, start))
        prev_end = max(prev_end, end)
    if duration_sec - prev_end > min_gap_sec:
        gaps.append((prev_end, duration_sec))
    return gaps


# Gap-fill tuning: margin gives the re-decode a little context on each side of
# the cut so a word isn't clipped mid-syllable; the RMS floor is an
# approximate "is there anything here at all" gate (audio is float32 in
# [-1, 1]), not a speech detector — a real VAD already ran in pass 1.
_GAP_FILL_MARGIN_SEC = 0.2
_GAP_FILL_MIN_WINDOW_SEC = 1.0
_GAP_FILL_SILENCE_RMS = 0.003
_GAP_FILL_MIN_GAP_SEC = 2.5

# Pass-1 decode window. WhisperX merges VAD speech regions into chunks up to
# this many seconds and decodes each chunk ONCE; on noisy/overlapping audio a
# long window invites an early EOT that silently drops the rest of the chunk
# (the root cause of the caption holes gap-fill patches). Shorter windows keep
# each decode small enough that a stall loses little. Measured on a real noisy
# bodycam video (small model, gap-fill on): 30s → 552 words/11 holes @16s;
# 6s → 585 words/8 holes @8s — better AND faster (fewer/smaller holes left for
# the gap-fill pass). On a clean narration video 6s vs 30s was a wash
# (203 vs 205 words, identical text), so there's no clean-audio downside.
_ASR_CHUNK_SIZE_SEC = 6


def _gap_fill_words(
    asr,
    audio,
    language: str | None,
    gaps: list[tuple[float, float]],
) -> list[dict]:
    """Re-transcribe each word-coverage gap IN ISOLATION and return any words
    recovered, offset back to absolute audio time.

    Two distinct failure modes leave these gaps in pass 1, and this pass
    addresses both:

    1. WhisperX merges VAD speech regions into chunks and decodes each ONCE;
       on noisy/overlapping audio Whisper can transcribe part of a chunk and
       stop early (EOT), silently dropping the rest. A fresh decode of just
       the hole recovers it (measured: an 18s hole gave back the exact
       narration burned into the source video).
    2. pyannote VAD refuses to mark screamed/emotional speech as speech at
       all, so those spans never reach Whisper in the first place — going
       back through `asr.transcribe` (VAD-gated) for the hole returns nothing
       or a stray word. Measured on a real arrest video: the VAD-gated decode
       of one hole gave "terms." while a raw no-VAD decode of the same audio
       gave "I'm not resisting! I'm not resisting! No, I'm not! I'm not!".

    So the holes are decoded with the RAW sequential faster-whisper model
    (`asr.model`) with `vad_filter=False` — no VAD gate, built-in temperature
    fallback, and native word timestamps (whisperx.align tends to fail on
    screams anyway: "backtrack failed"). faster-whisper's own
    no_speech/log-prob suppression still guards against transcribing pure
    noise, and near-silent windows (RMS below `_GAP_FILL_SILENCE_RMS`) are
    skipped up front — silence is a classic trigger for hallucinated phantom
    text ("thank you for watching").
    """
    import numpy as np

    raw_model = getattr(asr, "model", None)  # underlying faster_whisper.WhisperModel
    if raw_model is None:
        return []

    recovered: list[dict] = []
    for gap_i, (gap_start, gap_end) in enumerate(gaps):
        # Cooperative cancel between gaps so CANCELLING does not wait for every hole.
        _checkpoint(f"gap-fill-{gap_i}")
        window_start = max(0.0, gap_start - _GAP_FILL_MARGIN_SEC)
        window_end = gap_end + _GAP_FILL_MARGIN_SEC
        start_sample = int(window_start * 16000)
        end_sample = int(window_end * 16000)
        chunk = audio[start_sample:end_sample]
        if len(chunk) < _GAP_FILL_MIN_WINDOW_SEC * 16000:
            continue
        rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        if rms < _GAP_FILL_SILENCE_RMS:
            continue

        try:
            segments, _info = raw_model.transcribe(
                chunk,
                language=language,
                vad_filter=False,
                word_timestamps=True,
                beam_size=5,
            )
            gap_words = [
                {"word": (w.word or "").strip(), "start": w.start, "end": w.end}
                for seg in segments
                for w in (seg.words or [])
            ]
        except Exception as e:  # noqa: BLE001 — one bad gap must not sink the whole pass
            log.warning(
                "[gap-fill] failed to re-transcribe [%.1f-%.1f]s: %s",
                gap_start,
                gap_end,
                e,
            )
            continue

        for w in gap_words:
            if not w["word"] or w.get("start") is None or w.get("end") is None:
                continue
            abs_start = float(w["start"]) + window_start
            abs_end = float(w["end"]) + window_start
            # Pass 1 already owns everything outside the gap — only keep words
            # that actually land inside it (small fudge for boundary words).
            if abs_start < gap_start - 0.1 or abs_start > gap_end + 0.1:
                continue
            recovered.append({"word": w["word"], "start": abs_start, "end": abs_end})

    if recovered:
        log.info(
            "[gap-fill] recovered %d word(s) from %d gap(s)", len(recovered), len(gaps)
        )
    return recovered


def _run_transcription(path: str, model_name: str, lang: str | None) -> dict:
    """CPU-bound whisperX work — always called from the thread-pool executor.

    Calls `_checkpoint()` at each phase boundary so a cancelled request (client
    disconnect / timeout) stops at the next phase instead of running to the end.
    """
    import time
    import whisperx

    _checkpoint("start")
    t0 = time.perf_counter()
    audio = whisperx.load_audio(path)
    audio_sec = len(audio) / 16000.0
    _checkpoint("audio-loaded")
    asr = _get_asr(model_name, lang)
    device, _ = _resolve_device_compute()
    t_load = time.perf_counter()
    log.info(
        "[timing] load+model: %.1fs (audio=%.1fs, gpu=%s)",
        t_load - t0,
        audio_sec,
        _gpu_mem_mb(),
    )
    _checkpoint("model-loaded")

    # Adaptive batch size — fits whatever VRAM is free right now (auto-scales
    # down for long videos / when the GPU is busy elsewhere).
    batch_size = _pick_batch_size(device, model_name)
    _checkpoint("asr-before")
    result = asr.transcribe(
        audio, batch_size=batch_size, language=lang, chunk_size=_ASR_CHUNK_SIZE_SEC
    )
    detected = result.get("language", lang or "en")
    t_asr = time.perf_counter()
    log.info(
        "[timing] ASR transcribe: %.1fs (bs=%d, segs=%d, gpu=%s)",
        t_asr - t_load,
        batch_size,
        len(result.get("segments", [])),
        _gpu_mem_mb(),
    )
    _checkpoint("transcribed")
    # Per-segment checkpoints so CANCELLING can exit before alignment on long jobs.
    segs = result.get("segments") or []
    for i, _seg in enumerate(segs):
        if i > 0 and i % 25 == 0:
            _checkpoint(f"segment-batch-{i}")

    words: list[dict] = []
    try:
        align_model, metadata = _get_align(detected)
        aligned = whisperx.align(
            result["segments"],
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        log.info(
            "[timing] alignment: %.1fs (gpu=%s)",
            time.perf_counter() - t_asr,
            _gpu_mem_mb(),
        )
        words = _reconcile_segment_words(
            result.get("segments", []), aligned.get("segments", [])
        )

        # Gap-fill second pass (see _gap_fill_words for the full story): pass 1
        # can leave large holes in otherwise-clear speech, so re-decode each
        # one in isolation and merge back anything recovered.
        t_gapfill = time.perf_counter()
        gaps = _find_word_gaps(words, audio_sec, _GAP_FILL_MIN_GAP_SEC)
        if gaps:
            try:
                # Force the language whisper already detected for the full
                # clip — re-auto-detecting on a short, noisy isolated snippet
                # is unreliable and could pick the wrong alignment model.
                recovered = _gap_fill_words(asr, audio, detected, gaps)
                if recovered:
                    words = sorted(
                        words + recovered, key=lambda w: float(w.get("start") or 0)
                    )
                log.info(
                    "[timing] gap-fill: %.1fs (%d gap(s), gpu=%s)",
                    time.perf_counter() - t_gapfill,
                    len(gaps),
                    _gpu_mem_mb(),
                )
            except _Cancelled:
                raise
            except Exception as e:  # noqa: BLE001 — never let gap-fill sink an otherwise-good result
                log.warning("Gap-fill pass failed (%s); keeping pass-1 words only", e)
    except _Cancelled:
        raise
    except Exception as e:
        log.warning("Alignment failed (%s); falling back to segment timings", e)
        words = _fallback_segment_words(result.get("segments", []))
    _checkpoint("aligned")

    return {"language": detected, "cues": _group_into_cues(words)}


class _AsrBusy(Exception):
    """Another ASR job holds `_busy` — map to HTTP 409."""


class _TranscriptionTimedOut(Exception):
    """An isolated long-form worker exceeded its media-scaled deadline."""


def _guarded_transcription(
    path: str,
    model_name: str,
    lang: str | None,
    cancel_check: CancelCheck | None = None,
    *,
    gpu_owner: str = "whisperx-http",
    progress_path: str | None = None,
) -> dict:
    """Worker entry: GPU_MODEL first, then `_busy`, then WhisperX.

    Lock order is always **GPU → busy** (same as sync ASR / FunASR) to avoid
    deadlocks. Busy is only held during actual inference, not while waiting for
    TTS/Demucs. If busy is already held after GPU grant → ``_AsrBusy`` (409).
    """
    global _last_used
    cancel_check = _shutdown_aware_cancel(cancel_check)
    from app.resource_coordinator import (
        AcquireCancelledError,
        ResourceKind,
        resource_guard,
    )

    with _bound_cancel_check(cancel_check), _bound_progress_path(progress_path):
        try:
            with resource_guard(
                ResourceKind.GPU_MODEL,
                cancel_check=cancel_check,
                owner=gpu_owner,
            ):
                _checkpoint("gpu-acquired")
                if not _busy.acquire(blocking=False):
                    raise _AsrBusy()
                try:
                    return _run_transcription(path, model_name, lang)
                finally:
                    _last_used = time.time()
                    _busy.release()
        except AcquireCancelledError as e:
            raise _Cancelled("gpu-wait") from e


def _guarded_transcription_isolated(
    path: str,
    model_name: str,
    lang: str | None,
    cancel_check: CancelCheck,
    timeout_sec: float,
    progress_path: str | None = None,
) -> dict:
    """Run the full WhisperX alignment contract in a tree-killable process."""
    global _last_used
    cancel_check = _shutdown_aware_cancel(cancel_check)
    from ..config import BACKEND_ROOT
    from ..export.job import safe_rmtree_jobdir
    from ..resource_coordinator import (
        AcquireCancelledError,
        ResourceKind,
        resource_guard,
    )
    from ..process_runner import ProcessOutcome, run_process

    work = os.path.abspath(
        os.path.join(
            get_settings().work_dir, "asr", "whisperx_" + uuid.uuid4().hex[:10]
        )
    )
    out_path = os.path.join(work, "result.json")
    acquired_busy = False
    try:
        with resource_guard(
            ResourceKind.GPU_MODEL,
            cancel_check=cancel_check,
            owner="whisperx-http-isolated",
        ):
            # The isolated worker loads its own model. Evict any cached parent
            # WhisperX/alignment weights before taking _busy so the child sees
            # the full VRAM budget instead of silently degrading to CPU.
            release_models()
            while not _busy.acquire(timeout=0.25):
                if cancel_check():
                    raise _Cancelled("busy-wait")
            acquired_busy = True
            if cancel_check():
                raise _Cancelled("before-worker")
            if _is_large_model(model_name):
                try:
                    from . import tts

                    tts._WORKER_MGR.shutdown_if_idle()
                except Exception:  # noqa: BLE001
                    pass
            os.makedirs(work, exist_ok=True)
            def run_attempt(device_mode: str) -> tuple[dict | None, str]:
                result = run_process(
                    [
                    sys.executable,
                    "-m",
                    "whisper_worker_entry",
                    "--whisperx",
                    path,
                    model_name,
                    lang or "-",
                    device_mode,
                    out_path,
                    ],
                    cwd=BACKEND_ROOT,
                    env={
                        **os.environ,
                        **({"XINCHAO_ASR_PROGRESS_FILE": progress_path} if progress_path else {}),
                    },
                    timeout=timeout_sec,
                    cancel_check=cancel_check,
                    max_log_bytes=16 * 1024,
                    raise_on_error=False,
                )
                if result.outcome == ProcessOutcome.CANCELLED:
                    raise _Cancelled("worker")
                if result.outcome == ProcessOutcome.TIMED_OUT:
                    raise _TranscriptionTimedOut()
                try:
                    with open(out_path, encoding="utf-8") as f:
                        payload = json.load(f)
                except (OSError, ValueError):
                    return None, (result.stderr or "worker returned no result")[-800:]
                value = payload.get("result")
                if result.returncode == 0 and payload.get("status") == "done" and isinstance(value, dict):
                    return value, ""
                return None, str(
                    payload.get("error") or (result.stderr or "WhisperX worker failed")
                )[:2000]

            value, gpu_error = run_attempt("auto")
            if value is not None:
                return value
            if cancel_check():
                raise _Cancelled("before-cpu-retry")
            try:
                os.remove(out_path)
            except OSError:
                pass
            value, cpu_error = run_attempt("cpu")
            if value is not None:
                return value
            raise RuntimeError(
                f"WhisperX isolated worker failed (GPU/auto: {gpu_error}; CPU: {cpu_error})"
            )
    except AcquireCancelledError as e:
        raise _Cancelled("gpu-wait") from e
    finally:
        _last_used = time.time()
        if acquired_busy:
            _busy.release()
        safe_rmtree_jobdir(work)


def run_transcription_sync(
    path: str,
    model_name: str | None = None,
    language: str | None = None,
    cancel_check: CancelCheck | None = None,
) -> dict:
    """Blocking transcription for in-process callers.

    Shares `_busy` with HTTP /transcribe and holds ``ResourceKind.GPU_MODEL`` so
    WhisperX serialises with TTS, Demucs, and export.

    ``cancel_check`` — optional cooperative cancel. Polled at
    checkpoints and while waiting for the GPU permit. Does **not** touch any
    HTTP cancel signal (#3b).

    Raises ``TranscriptionCancelled`` when cancel_check trips (map to JobCancelled).
    """
    from app.resource_coordinator import (
        AcquireCancelledError,
        ResourceKind,
        resource_guard,
    )

    global _last_used
    cancel_check = _shutdown_aware_cancel(cancel_check)
    if not whisperx_available():
        raise RuntimeError("WhisperX chưa được cài trên server (pip install whisperx).")
    s = get_settings()
    model_name = model_name or s.whisper_model
    lang = _normalize_lang(language)

    with _bound_cancel_check(cancel_check):
        try:
            # GPU first so we don't hold `_busy` while waiting for TTS/Demucs.
            with resource_guard(
                ResourceKind.GPU_MODEL,
                cancel_check=cancel_check,
                owner="whisperx-transcribe-sync",
            ):
                _checkpoint("gpu-acquired")
                if cancel_check is not None and cancel_check():
                    raise _Cancelled("before-busy")
                _busy.acquire()  # serialize with UI /transcribe on WhisperX stack
                try:
                    return _run_transcription(path, model_name, lang)
                finally:
                    _last_used = time.time()
                    _busy.release()
        except _Cancelled as e:
            raise TranscriptionCancelled(str(e) or "cancelled") from e
        except AcquireCancelledError as e:
            raise TranscriptionCancelled("gpu-wait") from e


@router.post("/transcribe")
async def transcribe(
    request: Request,
    file: UploadFile | None = File(None),
    language: str = Form("auto"),
    model: str = Form(""),
    sourcePath: str = Form(""),
    provider: str = Form("auto"),
    progressToken: str = Form(""),
) -> dict:
    from ..asr.select import FUNASR, select_asr_provider

    progress_path: str | None = None
    if progressToken:
        try:
            progress_path = _progress_path(progressToken, cleanup=True)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid progress token") from None
        _write_progress_file(progress_path, "queued", 1)

    # provider=auto + Chinese → FunASR; everything else → WhisperX (unchanged).
    resolved = select_asr_provider(provider, language)

    if resolved == FUNASR:
        source_path = resolve_source_path(sourcePath) if sourcePath else None
        if source_path is None and file is None:
            raise HTTPException(
                status_code=422, detail="Provide a file upload or sourcePath"
            )
        from ..asr import funasr_runtime, service

        cancel_ev = threading.Event()
        cancel_check = _shutdown_aware_cancel(cancel_ev.is_set)
        media_source = _TranscriptionInput(source_path, file)
        async with media_source as path:
            try:
                # FunASR acquires GPU_MODEL + `_busy` inside funasr_runtime.
                # Run on the executor so blocking acquire never stalls uvicorn.
                loop = asyncio.get_running_loop()
                _duration_sec, timeout_sec = await asyncio.to_thread(
                    _transcription_profile, path
                )
                if progress_path:
                    _write_progress_file(progress_path, "transcribing", 5, estimated=True)
                admission = _acquire_http_admission()
                try:
                    future = loop.run_in_executor(
                        _executor,
                        lambda: funasr_runtime.transcribe(
                            path,
                            language=_normalize_lang(language),
                            cancel_check=cancel_check,
                            timeout_sec=timeout_sec,
                        ),
                    )
                    admission.handoff(future)
                    media_source.handoff(future)
                except BaseException:
                    admission.release()
                    raise
                future.add_done_callback(lambda f: f.cancelled() or f.exception())
                deadline = loop.time() + timeout_sec
                wait_started = loop.time()
                last_estimate_at = wait_started
                while True:
                    done, _pending = await asyncio.wait({future}, timeout=1.0)
                    if done:
                        segments = future.result()
                        break
                    if loop.time() >= deadline:
                        cancel_ev.set()
                        raise HTTPException(
                            status_code=504,
                            detail=f"Transcription timed out after {timeout_sec / 60:.0f} minutes.",
                        )
                    now = loop.time()
                    if now - last_estimate_at >= 2.0:
                        _advance_asr_estimate(
                            progress_path, _duration_sec, "small", now - wait_started,
                        )
                        last_estimate_at = now
                    if await request.is_disconnected():
                        cancel_ev.set()
                        return {"language": "", "cues": [], "cancelled": True}
            except funasr_runtime.FunAsrCancelled:
                return {"language": "", "cues": [], "cancelled": True}
            except RuntimeError as e:  # funasr not installed
                raise HTTPException(status_code=503, detail=str(e))
        if progress_path:
            _write_progress_file(progress_path, "done", 100, "done")
        return {
            "language": language,
            "cues": service.segments_to_cues(segments),
            "provider": FUNASR,
        }

    if not whisperx_available():
        raise HTTPException(
            status_code=503,
            detail="WhisperX is not installed on the server. Run: pip install whisperx",
        )

    source_path = resolve_source_path(sourcePath) if sourcePath else None
    if source_path is None and file is None:
        raise HTTPException(
            status_code=422, detail="Provide a file upload or sourcePath"
        )

    # Soft busy probe (no hold): true 409 is raised from the worker via `_AsrBusy`
    # after GPU grant so lock order stays GPU → busy.
    if _busy.locked():
        raise HTTPException(
            status_code=409,
            detail="A transcription is already running on the server. "
            "Wait for it to finish (or cancel it) and try again.",
        )

    s = get_settings()
    model_name = model or s.whisper_model
    lang = _normalize_lang(language)

    # Per-request cancel — never a process-global Event (#3b).
    cancel_ev = threading.Event()
    cancel_check: CancelCheck = _shutdown_aware_cancel(cancel_ev.is_set)
    try:
        media_source = _TranscriptionInput(source_path, file)
        async with media_source as path:
            loop = asyncio.get_running_loop()
            duration_sec, timeout_sec = await asyncio.to_thread(
                _transcription_profile, path
            )
            isolated = _should_isolate_transcription(path, duration_sec, model_name)
            admission = _acquire_http_admission()
            try:
                if isolated:
                    future = loop.run_in_executor(
                        _executor,
                        _guarded_transcription_isolated,
                        path,
                        model_name,
                        lang,
                        cancel_check,
                        timeout_sec,
                        progress_path,
                    )
                else:
                    future = loop.run_in_executor(
                        _executor,
                        lambda: _guarded_transcription(
                            path,
                            model_name,
                            lang,
                            cancel_check,
                            progress_path=progress_path,
                        ),
                    )
                admission.handoff(future)
                media_source.handoff(future)
            except BaseException:
                admission.release()
                raise
            # If we walk away (timeout/disconnect), nothing ever awaits the
            # future — retrieve its exception so asyncio doesn't log
            # "exception was never retrieved" when the worker raises _Cancelled.
            future.add_done_callback(lambda f: f.cancelled() or f.exception())

            deadline = loop.time() + timeout_sec
            wait_started = loop.time()
            last_estimate_at = wait_started
            try:
                # Wait in 1s slices so we can notice a client disconnect and
                # enforce the hard timeout, soft-cancelling the worker in both
                # cases (it exits at its next phase checkpoint).
                while True:
                    done, _pending = await asyncio.wait({future}, timeout=1.0)
                    if done:
                        result = future.result()
                        break
                    now = loop.time()
                    if now - last_estimate_at >= 2.0:
                        _advance_asr_estimate(
                            progress_path,
                            duration_sec,
                            model_name,
                            now - wait_started,
                        )
                        last_estimate_at = now
                    if loop.time() >= deadline:
                        cancel_ev.set()
                        raise HTTPException(
                            status_code=504,
                            detail=f"Transcription timed out after {timeout_sec / 60:.0f} minutes.",
                        )
                    if await request.is_disconnected():
                        log.info(
                            "Client disconnected — cancelling transcription (%s)",
                            "isolated/tree-kill"
                            if isolated
                            else "in-process/checkpoint",
                        )
                        cancel_ev.set()
                        return {"language": "", "cues": [], "cancelled": True}
            except _Cancelled:
                # Worker hit a checkpoint after a cancel — nothing to return.
                return {"language": "", "cues": [], "cancelled": True}
            except _TranscriptionTimedOut:
                raise HTTPException(
                    status_code=504,
                    detail=f"Transcription timed out after {timeout_sec / 60:.0f} minutes.",
                ) from None
            except _AsrBusy:
                raise HTTPException(
                    status_code=409,
                    detail="A transcription is already running on the server. "
                    "Wait for it to finish (or cancel it) and try again.",
                )
            except HTTPException:
                raise
            except Exception as e:
                # Executor wraps _AsrBusy / _Cancelled in the future result path.
                if isinstance(e, _AsrBusy) or isinstance(
                    getattr(e, "__cause__", None), _AsrBusy
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="A transcription is already running on the server. "
                        "Wait for it to finish (or cancel it) and try again.",
                    )
                import traceback

                tb = traceback.format_exc()
                log.error("Transcription failed:\n%s", tb)
                raise HTTPException(
                    status_code=500,
                    detail=f"{type(e).__name__}: {e}\n\nTraceback:\n{tb}"[:4000],
                )
    except _AsrBusy:
        raise HTTPException(
            status_code=409,
            detail="A transcription is already running on the server. "
            "Wait for it to finish (or cancel it) and try again.",
        )

    if progress_path:
        _write_progress_file(progress_path, "done", 100, "done")
    return result


@router.get("/transcribe/progress/{token}")
def transcribe_progress(token: str) -> dict:
    try:
        path = _progress_path(token)
    except ValueError:
        raise HTTPException(status_code=404, detail="Progress not found") from None
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        raise HTTPException(status_code=404, detail="Progress not found") from None
    return payload
