"""WhisperX transcription endpoint.

Returns subtitle cues with word-level timestamps, grouped into short phrases so
they match the in-browser captions style. WhisperX (faster-whisper + wav2vec2
forced alignment + VAD) gives noticeably better timing and fewer hallucinations
than the browser Whisper, especially for long-form audio and non-English speech.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext

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
os.environ.setdefault("OMP_NUM_THREADS",      str(_HALF_CORES))
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(_HALF_CORES))
os.environ.setdefault("MKL_NUM_THREADS",      str(_HALF_CORES))
os.environ.setdefault("NUMEXPR_NUM_THREADS",  str(_HALF_CORES))
# ───────────────────────────────────────────────────────────────────────────

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from ..config import get_settings
from ..utils import resolve_source_path, saved_upload

log = logging.getLogger(__name__)
router = APIRouter(tags=["transcribe"])

# Single-worker pool — one transcription at a time keeps memory predictable
# and prevents competing for CPU. Running in a thread lets the uvicorn event
# loop stay responsive (answer /health, etc.) while whisperX is busy.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisperx")

# Maximum seconds we wait for a transcription before giving up.
_TIMEOUT_SEC = 600  # 10 minutes

# ── Busy-guard + soft-cancel ────────────────────────────────────────────────
# `_busy` is try-acquired per request: a second transcription gets an instant
# 409 instead of silently queueing behind the first in the single-worker
# executor (which used to look like a 10-minute hang to the user).
#
# `_cancel` is the soft-cancel signal. A thread running whisperX can't be
# interrupted mid-inference, but `_run_transcription` checks this event at its
# phase boundaries (audio load → model load → ASR → alignment) and bails out at
# the next one — so an abandoned request frees the GPU and the executor slot
# in seconds-to-a-phase rather than running to completion.
_busy = threading.Lock()
_cancel = threading.Event()


class _Cancelled(Exception):
    """Raised inside the worker when the cancel event is set at a checkpoint."""


def _checkpoint(stage: str) -> None:
    if _cancel.is_set():
        log.info("Transcription cancelled at checkpoint: %s", stage)
        raise _Cancelled(stage)

# Match the in-browser segmentation so captions look consistent across engines.
MAX_PHRASE_WORDS   = 7
PAUSE_THRESHOLD_SEC = 0.4
MIN_REPEAT_WORDS = 3
WORD_REPEAT_GRACE_SEC = 0.6
WORD_REPEAT_WINDOW_SEC = 8.0
_WORD_EDGE_RE = re.compile(r"^\W+|\W+$", re.UNICODE)

# The frontend sends human-readable language names; whisper/faster-whisper wants
# ISO codes. Map the known names and pass through anything that already looks
# like a code; unknown values fall back to auto-detect (None) instead of 500.
_LANG_MAP = {
    "english": "en", "vietnamese": "vi", "japanese": "ja",
    "chinese": "zh", "korean": "ko", "spanish": "es", "french": "fr",
    "german": "de", "italian": "it", "portuguese": "pt", "russian": "ru",
    "thai": "th", "indonesian": "id", "hindi": "hi", "arabic": "ar",
}


def _normalize_lang(language: str | None) -> str | None:
    if not language:
        return None
    l = language.strip().lower()
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
_asr_lock:  threading.Lock = threading.Lock()
_asr_key:   tuple | None  = None   # currently cached key
_asr_model                 = None   # currently cached model

_align_cache: dict = {}            # alignment models are small — keep them all
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

    s       = get_settings()
    device  = s.whisper_device
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
    global _resolved_runtime
    s                = get_settings()
    device, compute  = _resolve_device_compute()
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

            candidates = _compute_fallbacks(device, compute)
            last_err: Exception | None = None
            for i, ctype in enumerate(candidates):
                log.info("Loading WhisperX model %s (device=%s, compute=%s, cpu_threads=%d)",
                         model_name, device, ctype, _HALF_CORES)
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
                            ctype, e, candidates[i + 1],
                        )
                        continue
                    raise  # exhausted fallbacks — surface the real error
                # Success. Remember the working compute type for the rest of the
                # process so we don't re-attempt the broken one on every model
                # switch, and key the cache on it.
                if ctype != compute:
                    log.info("Using compute_type=%s for the rest of this session", ctype)
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


def _repeated_word_prefix_len(words: list[dict], index: int, accepted: list[dict]) -> int:
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
        if (
            current["start"] <= matched_end + WORD_REPEAT_GRACE_SEC
            and candidate_end >= matched_start - WORD_REPEAT_GRACE_SEC
        ):
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


def _group_into_cues(words: list[dict]) -> list[dict]:
    """Flatten aligned words into short phrase cues (content + relative words)."""
    flat: list[dict] = []
    cursor = 0.0
    for w in words:
        text = (w.get("word") or "").strip()
        if not text:
            continue
        start = w.get("start")
        end   = w.get("end")
        start = float(start) if start is not None else cursor
        end   = float(end)   if end   is not None else start + 0.3
        end   = max(end, start + 0.05)
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
        cues.append({
            "content": " ".join(p["word"] for p in phrase),
            "startSec": s0,
            "endSec": max(e0, s0 + 0.3),
            "words": [
                {"word": p["word"], "startSec": p["start"] - s0, "endSec": p["end"] - s0}
                for p in phrase
            ],
        })

    for w in flat:
        last  = phrase[-1] if phrase else None
        pause = (w["start"] - last["end"]) if last else 0.0
        if phrase and (len(phrase) >= MAX_PHRASE_WORDS or pause >= PAUSE_THRESHOLD_SEC):
            flush()
            phrase = []
        phrase.append(w)
    flush()

    # Drop consecutive duplicate phrases (hallucination residue).
    out: list[dict] = []
    for cue in cues:
        if out and out[-1]["content"] == cue["content"]:
            out[-1]["endSec"] = max(out[-1]["endSec"], cue["endSec"])
        else:
            out.append(cue)
    return out


def _gpu_mem_mb() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            return f"{(total - free) // (1024*1024)}/{total // (1024*1024)} MiB used"
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
    cap      = 8 if is_large else 16        # upper bound when memory is plentiful
    per_item = 200 if is_large else 90      # rough MiB of activations per batch item

    free = _gpu_free_mb()
    if free is None:
        return 4 if is_large else 8         # sensible default if we can't measure

    # Reserve room for the alignment model + desktop/browser spikes.
    usable = free - 1300
    batch  = int(usable // per_item)
    batch  = max(1, min(batch, cap))
    log.info("[batch] free=%d MiB → batch_size=%d (model=%s)", free, batch, model_name)
    return batch


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
    asr   = _get_asr(model_name, lang)
    device, _ = _resolve_device_compute()
    t_load = time.perf_counter()
    log.info("[timing] load+model: %.1fs (audio=%.1fs, gpu=%s)",
             t_load - t0, audio_sec, _gpu_mem_mb())
    _checkpoint("model-loaded")

    # Adaptive batch size — fits whatever VRAM is free right now (auto-scales
    # down for long videos / when the GPU is busy elsewhere).
    batch_size = _pick_batch_size(device, model_name)
    result   = asr.transcribe(audio, batch_size=batch_size, language=lang)
    detected = result.get("language", lang or "en")
    t_asr = time.perf_counter()
    log.info("[timing] ASR transcribe: %.1fs (bs=%d, segs=%d, gpu=%s)",
             t_asr - t_load, batch_size, len(result.get("segments", [])), _gpu_mem_mb())
    _checkpoint("transcribed")

    words: list[dict] = []
    try:
        align_model, metadata = _get_align(detected)
        aligned = whisperx.align(
            result["segments"], align_model, metadata, audio,
            device, return_char_alignments=False,
        )
        log.info("[timing] alignment: %.1fs (gpu=%s)",
                 time.perf_counter() - t_asr, _gpu_mem_mb())
        for seg in aligned.get("segments", []):
            words.extend(seg.get("words", []))
    except Exception as e:
        log.warning("Alignment failed (%s); falling back to segment timings", e)
        for seg in result.get("segments", []):
            words.append({
                "word":  seg.get("text", ""),
                "start": seg.get("start"),
                "end":   seg.get("end"),
            })

    return {"language": detected, "cues": _group_into_cues(words)}


def _guarded_transcription(path: str, model_name: str, lang: str | None) -> dict:
    """Worker entry point: releases the busy lock when the THREAD finishes.

    The lock must not be released by the request handler — after a timeout or
    client disconnect the handler returns immediately while this thread keeps
    running until the next cancel checkpoint. Releasing here means the guard
    only opens once the executor slot is genuinely free, so a new request can
    never silently queue behind a half-cancelled one.
    """
    try:
        return _run_transcription(path, model_name, lang)
    finally:
        _busy.release()


@router.post("/transcribe")
async def transcribe(
    request:  Request,
    file:     UploadFile | None = File(None),
    language: str        = Form("auto"),
    model:    str        = Form(""),
    sourcePath: str      = Form(""),
) -> dict:
    if not whisperx_available():
        raise HTTPException(
            status_code=503,
            detail="WhisperX is not installed on the server. Run: pip install whisperx",
        )

    source_path = resolve_source_path(sourcePath) if sourcePath else None
    if source_path is None and file is None:
        raise HTTPException(status_code=422, detail="Provide a file upload or sourcePath")

    # Busy-guard: instant 409 instead of an invisible queue behind a running job.
    if not _busy.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="A transcription is already running on the server. "
                   "Wait for it to finish (or cancel it) and try again.",
        )

    s          = get_settings()
    model_name = model or s.whisper_model
    lang       = _normalize_lang(language)

    _cancel.clear()
    submitted = False
    try:
        media_source = nullcontext(source_path) if source_path else saved_upload(file)
        with media_source as path:
            loop   = asyncio.get_running_loop()
            future = loop.run_in_executor(
                _executor, _guarded_transcription, path, model_name, lang
            )
            submitted = True
            # If we walk away (timeout/disconnect), nothing ever awaits the
            # future — retrieve its exception so asyncio doesn't log
            # "exception was never retrieved" when the worker raises _Cancelled.
            future.add_done_callback(lambda f: f.cancelled() or f.exception())

            deadline = loop.time() + _TIMEOUT_SEC
            try:
                # Wait in 1s slices so we can notice a client disconnect and
                # enforce the hard timeout, soft-cancelling the worker in both
                # cases (it exits at its next phase checkpoint).
                while True:
                    done, _pending = await asyncio.wait({future}, timeout=1.0)
                    if done:
                        result = future.result()
                        break
                    if loop.time() >= deadline:
                        _cancel.set()
                        raise HTTPException(
                            status_code=504,
                            detail=f"Transcription timed out after {_TIMEOUT_SEC // 60} minutes.",
                        )
                    if await request.is_disconnected():
                        log.info("Client disconnected — soft-cancelling transcription")
                        _cancel.set()
                        return {"language": "", "cues": [], "cancelled": True}
            except _Cancelled:
                # Worker hit a checkpoint after a cancel — nothing to return.
                return {"language": "", "cues": [], "cancelled": True}
            except HTTPException:
                raise
            except Exception as e:
                import traceback
                tb = traceback.format_exc()
                log.error("Transcription failed:\n%s", tb)
                raise HTTPException(
                    status_code=500,
                    detail=f"{type(e).__name__}: {e}\n\nTraceback:\n{tb}"[:4000],
                )
    finally:
        # The worker releases the lock itself; only release here if we failed
        # before ever submitting it (e.g. saving the upload blew up).
        if not submitted:
            _busy.release()

    return result
