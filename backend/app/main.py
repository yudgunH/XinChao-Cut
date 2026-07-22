"""XinChao-Cut backend — FastAPI app exposing FFmpeg media + WhisperX transcription.

Run locally:
    cd backend
    python -m venv .venv && . .venv/Scripts/activate   # Windows
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000
"""
# ── Must be first, before *any* huggingface_hub import ──────────────────────
# huggingface_hub evaluates HF_HUB_DISABLE_XET once at constants.py import
# time.  If hf_xet is installed it tries to use a local xet CAS proxy that
# doesn't exist (defaults to localhost:8080), producing 401 errors for every
# model load even when the model is already cached.  Setting the flag here
# guarantees it is visible before the constant is frozen.
import os
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# ────────────────────────────────────────────────────────────────────────────

import logging
import importlib.util
import shutil
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import ai_config, assets, export, media, metrics, separate, transcribe, translate, tts

logging.basicConfig(level=logging.INFO)

log = logging.getLogger(__name__)

settings = get_settings()

# Runtime diagnostics filled in by the background warm-up thread. /health reads
# this as-is so it never blocks: fields read null until the (slow) probes
# finish, then the frontend's next poll picks up the real encoder / GPU info.
# Surfacing this is what turns the silent CPU fallback into something the user
# can actually see (GPU Diagnostics in the UI).
_runtime: dict = {"videoEncoder": None, "cuda": {"available": False, "device": None}}


def _probe_cuda() -> dict:
    try:
        import torch
        if torch.cuda.is_available():
            return {"available": True, "device": torch.cuda.get_device_name(0)}
    except Exception:
        pass
    return {"available": False, "device": None}


def _live_job_dirs() -> set:
    """Output dirs of every job currently in the in-memory registries (ANY
    status). _clean_work runs in a background thread while the app already
    serves requests, so a job created in that window must be protected even
    before it's persisted — checking this set at delete time closes the race
    where a freshly-started job's dir would be treated as orphaned and wiped."""
    dirs: set = set()
    try:
        from .export.job import JOBS as export_jobs
        from .routers.separate import JOBS as sep_jobs
        for j in list(export_jobs.values()):
            if j.out_path:
                dirs.add(os.path.abspath(os.path.dirname(j.out_path)))
        for j in list(sep_jobs.values()):
            if j.out_dir:
                dirs.add(os.path.abspath(j.out_dir))
    except Exception:  # noqa: BLE001
        pass
    return dirs


def _clean_work() -> None:
    """Restore persisted jobs, then delete orphaned job output dirs.

    Jobs live in jobs.db across restarts: finished ones are reloaded so their
    status stays pollable and their outputs downloadable; ones that were
    running when the previous process died are failed with a clear error.
    Only output dirs that no completed job references get deleted. assets/
    and models/ are persistent and are never touched."""
    from .export.job import init_and_sweep, restore_into_memory
    from .routers.separate import restore_sep_jobs

    keep: set = set()
    restore_ok = False
    try:
        init_and_sweep()
        keep |= restore_into_memory()
        keep |= restore_sep_jobs()
        restore_ok = True
    except Exception as e:  # noqa: BLE001
        log.error("Job restore failed; destructive job cleanup disabled: %s", e)

    work = os.path.abspath(get_settings().work_dir)
    count = 0
    if restore_ok:
        for sub in ("exports", "proxies", "separate", "tts"):
            top = os.path.join(work, sub)
            if not os.path.isdir(top):
                continue
            for entry in os.scandir(top):
                if not entry.is_dir():
                    continue
                path = os.path.abspath(entry.path)
                if path in keep or path in _live_job_dirs():
                    continue
                shutil.rmtree(path, ignore_errors=True)
                count += 1
    if count:
        log.info("Startup cleanup: removed %d orphaned job dir(s) from .work", count)

    # Persistent asset store: enforce its quota/TTL (unlike the job dirs above,
    # assets survive restarts, so this is where stale ones get reclaimed).
    try:
        from .routers.assets import cleanup_assets
        cleanup_assets()
    except Exception as e:  # noqa: BLE001
        log.warning("Asset store cleanup failed: %s", e)


def _warm() -> None:
    """Pre-pay the slow one-time costs in the background so the first real
    request is fast: the FFmpeg encoder probe (a few test encodes) and the
    heavy AI imports (torch chain, 10-30s cold). Also populates `_runtime` so
    /health can report the chosen encoder + GPU without blocking. Missing AI
    modules are fine — that's a Lite install; capabilities just stay false."""
    _clean_work()
    t0 = time.perf_counter()
    try:
        from .export.ffmpeg_build import detect_video_encoder
        enc = detect_video_encoder()
        _runtime["videoEncoder"] = enc
        log.info("Warm-up: video encoder = %s", enc)
    except Exception as e:  # noqa: BLE001
        log.warning("Warm-up: encoder detection failed: %s", e)
    for mod in ("whisperx", "demucs"):
        try:
            __import__(mod)
            log.info("Warm-up: %s imported (%.1fs elapsed)", mod, time.perf_counter() - t0)
        except Exception:
            log.info("Warm-up: %s not installed (Lite install) — skipping", mod)
    # torch is imported (or absent) by now — probe the GPU once it's loaded.
    _runtime["cuda"] = _probe_cuda()
    log.info("Warm-up done in %.1fs (cuda=%s)", time.perf_counter() - t0, _runtime["cuda"])


@asynccontextmanager
async def lifespan(_app: FastAPI):
    transcribe.resume_runtime()
    threading.Thread(target=_warm, daemon=True, name="warmup").start()
    try:
        yield
    finally:
        try:
            transcribe.shutdown_runtime()
            export.cleanup_active_browser_streams()
            separate.shutdown_active_jobs()
            tts.shutdown_active_jobs()
        except Exception as exc:  # noqa: BLE001
            log.warning("Runtime shutdown cleanup skipped: %s", exc)


app = FastAPI(title="XinChao-Cut Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(media.router)
app.include_router(transcribe.router)
app.include_router(assets.router)
app.include_router(export.router)
app.include_router(separate.router)
app.include_router(translate.router)
app.include_router(ai_config.router)
app.include_router(tts.router)
app.include_router(metrics.router)


@app.get("/health")
def health() -> dict:
    """Liveness probe — the frontend uses this to decide whether the backend
    is available before routing work to it."""
    return {
        "status": "ok",
        "service": "xinchao-cut-backend",
        "version": app.version,
        "capabilities": {
            "media": media.ffmpeg_available(),
            "transcribe": transcribe.whisperx_available(),
            "funasr": importlib.util.find_spec("funasr") is not None,
            "export": media.ffmpeg_available(),
            "separate": separate.demucs_available(),
            "sceneSplit": media.ffmpeg_available(),
            "translate": translate.translate_available(),
            "tts": tts.tts_available(),
        },
        # videoEncoder/cuda are null until the warm-up probe finishes (a few
        # seconds after start); the frontend just shows "detecting…" until then.
        "runtime": _runtime,
    }
