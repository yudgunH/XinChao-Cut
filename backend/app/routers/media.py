"""FFmpeg-backed media endpoints: probe, thumbnail strip, waveform, proxy."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .. import ffmpeg_utils
from ..config import get_settings
from ..export.ffmpeg_build import detect_video_encoder, proxy_quality_args
from ..export.integrity import reserve_output_exclusive
from ..export.job import (
    HEAVY_JOB_SEMAPHORE,
    cancel_job,
    create_job,
    get_job,
    release_external_output,
    reserve_external_output,
    run_job,
)
from ..ffmpeg_utils import FfmpegCancelled, ffmpeg_available
from ..process_watchdog import iter_process_lines
from ..process_runner import kill_process_tree
from ..utils import (
    async_saved_upload,
    cleanup_temp_path,
    register_temp_path,
    resolve_source_path,
    save_upload_bounded,
    saved_upload,
)
from .assets import asset_path, content_hash_path

router = APIRouter(prefix="/media", tags=["media"])
log = logging.getLogger(__name__)
_SCENE_PTS_TIME = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")
_SCENE_OUT_TIME_US = re.compile(r"out_time_us=(\d+)")
_STDERR_TAIL = 50
_CONTENT_HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _require_ffmpeg() -> None:
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg/ffprobe not found on the server")


@contextmanager
def _source_media(file: UploadFile | None, hash_: str, source_path: str = ""):
    """Yield a readable path for the media to process.

    Prefers an already-uploaded asset referenced by content hash — avoiding a
    redundant re-upload of a (possibly multi-GB) file the server already has —
    and falls back to the multipart upload otherwise. Backward compatible:
    callers that only send `file` keep working.
    """
    if hash_:
        stored = asset_path(hash_)
        if stored:
            yield stored
            return
    if source_path:
        yield resolve_source_path(source_path)
        return
    if file is None:
        raise HTTPException(
            status_code=422,
            detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
        )
    with saved_upload(file) as path:
        yield path


@asynccontextmanager
async def _source_media_async(file: UploadFile | None, hash_: str, source_path: str = ""):
    """Event-loop-safe counterpart for async media routes."""
    if hash_:
        stored = asset_path(hash_)
        if stored:
            yield stored
            return
    if source_path:
        yield resolve_source_path(source_path)
        return
    if file is None:
        raise HTTPException(
            status_code=422,
            detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
        )
    async with async_saved_upload(file) as path:
        yield path


async def _run_with_disconnect_cancel(request: Request, fn):
    """Run blocking FFmpeg work; tree-kill path via cancel_check when client drops."""
    cancel = threading.Event()

    async def _watch() -> None:
        while not cancel.is_set():
            try:
                if await request.is_disconnected():
                    cancel.set()
                    return
            except Exception:  # noqa: BLE001
                cancel.set()
                return
            await asyncio.sleep(0.4)

    watcher = asyncio.create_task(_watch())
    try:
        return await asyncio.to_thread(fn, cancel.is_set)
    except FfmpegCancelled:
        raise HTTPException(status_code=499, detail="Client disconnected") from None
    finally:
        cancel.set()
        watcher.cancel()
        try:
            await watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


@router.post("/probe")
def media_probe(
    file: UploadFile | None = File(None),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    _require_ffmpeg()
    with _source_media(file, hash, sourcePath) as path:
        try:
            return ffmpeg_utils.probe(path)
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))


@router.post("/thumbnails")
async def media_thumbnails(
    request: Request,
    file: UploadFile | None = File(None),
    count: int = Form(12),
    width: int = Form(160),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    """Generate an evenly-spaced thumbnail strip (JPEG data URLs)."""
    _require_ffmpeg()
    count = max(1, min(count, 60))
    width = max(48, min(width, 480))
    # Materialise upload before the disconnect-watched thread (file stream is request-bound).
    async with _source_media_async(file, hash, sourcePath) as path:
        in_path = path
        # If path is a temp upload under the context, copy to a stable path for the thread.
        # saved_upload deletes on context exit — so we must finish inside the context.
        try:
            frames = await _run_with_disconnect_cancel(
                request,
                lambda cancel_check: ffmpeg_utils.thumbnail_strip(
                    in_path, count, width, cancel_check=cancel_check
                ),
            )
        except HTTPException:
            raise
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))
    return {"frames": frames}


# ── Scene detection (async job with progress) ────────────────────────────────
# Scene detection must decode every frame of the source (the scene filter
# compares consecutive frames), so on an HD/4K clip it takes a while. Running it
# synchronously inside the request both froze the FastAPI event loop (blocking
# health polls and everything else for the whole detection) and gave the user no
# feedback. It now runs in a background thread and reports progress (parsed from
# ffmpeg's -progress pipe) that the frontend polls into a progress bar.


@dataclass
class _SceneJob:
    id: str
    duration: float
    status: str = "running"          # running | done | error | cancelled
    pct: float = 0.0
    scenes: list[float] = field(default_factory=list)
    error: str | None = None
    started_at: float = 0.0          # epoch when detection started (for ETA)
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _scenes_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _admission_owned: bool = field(default=False, repr=False)


_SCENE_JOBS: dict[str, _SceneJob] = {}
_SCENE_JOBS_MAX = 32
_SCENE_ACTIVE_MAX = 8
_SCENE_ADMISSION = threading.BoundedSemaphore(_SCENE_ACTIVE_MAX)
# See export/job.py for the pattern: guards structural mutations only.
_SCENE_JOBS_LOCK = threading.Lock()


def _prune_scene_jobs() -> None:
    """Drop the oldest finished scene jobs once the registry grows past the cap."""
    with _SCENE_JOBS_LOCK:
        if len(_SCENE_JOBS) <= _SCENE_JOBS_MAX:
            return
        for jid in list(_SCENE_JOBS):
            if len(_SCENE_JOBS) <= _SCENE_JOBS_MAX:
                break
            if _SCENE_JOBS[jid].status != "running":
                del _SCENE_JOBS[jid]


def _run_scene_detect(
    job: _SceneJob, in_path: str, threshold: float, min_gap: float,
    max_scenes: int, cleanup_path: str | None,
) -> None:
    # Same pattern as export/job.py::run_job: serialise against other heavy jobs
    # (export / proxy / TTS) so scene-detect doesn't fight the GPU/CPU with them.
    acquired = HEAVY_JOB_SEMAPHORE.acquire(
        cancel_check=lambda: job.status == "cancelled",
    )
    if not acquired:
        if job.status != "cancelled":
            job.status = "error"
            job.error = "Scene detection was cancelled while queued"
        if cleanup_path:
            cleanup_temp_path(cleanup_path)
        if job._admission_owned:
            job._admission_owned = False
            _SCENE_ADMISSION.release()
        return
    try:
        # Cancelled while queued behind another heavy job → never start ffmpeg.
        if job.status == "cancelled":
            return
        try:
            job.started_at = time.time()
            cmd = ["ffmpeg", "-hide_banner"]
            # GPU-accelerated decode when a hardware encoder is present (a usable-GPU
            # proxy). Decode dominates scene-detection cost on HD/4K, and ffmpeg falls
            # back to software automatically if the accelerator can't take the input.
            try:
                if detect_video_encoder() != "libx264":
                    cmd += ["-hwaccel", "auto"]
            except Exception:  # noqa: BLE001
                pass
            cmd += [
                "-i", in_path,
                # Downscale to ~320px wide before the scene filter: detection compares
                # frame deltas and doesn't need full resolution, so this slashes the
                # filter cost on HD/4K (the dominant time on a long clip) while leaving
                # the detected timestamps unchanged. min() avoids upscaling small inputs.
                "-vf", f"scale='min(320,iw)':-2,select='gt(scene,{threshold:.4f})',showinfo",
                # -progress writes clean key=value lines to stdout; the showinfo
                # pts_time markers go to stderr — no collision (the null muxer writes
                # nothing to stdout).
                "-an", "-progress", "pipe:1", "-nostats", "-f", "null", "-",
            ]
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
            )
            job._proc = proc
            # Cancel could race after the queue check but before _proc was set.
            if job.status == "cancelled":
                try:
                    kill_process_tree(proc)
                finally:
                    job._proc = None
                return

            # Stream-parse showinfo timestamps in the drain thread. Keep only
            # max_scenes cuts + a short stderr tail for errors (never unbounded).
            err_tail: list[str] = []
            early_stop = threading.Event()
            last_scene = 0.0

            def drain_err() -> None:
                nonlocal last_scene
                assert proc.stderr is not None
                for line in proc.stderr:
                    err_tail.append(line)
                    if len(err_tail) > _STDERR_TAIL:
                        del err_tail[0]
                    m = _SCENE_PTS_TIME.search(line)
                    if not m:
                        continue
                    sec = float(m.group(1))
                    if sec <= 0.05 or sec - last_scene < min_gap:
                        continue
                    with job._scenes_lock:
                        if len(job.scenes) >= max_scenes:
                            early_stop.set()
                            break
                        job.scenes.append(sec)
                        last_scene = sec
                        if len(job.scenes) >= max_scenes:
                            early_stop.set()
                            break
                if early_stop.is_set() and proc.poll() is None:
                    # Enough scenes — stop decoding the rest of the video.
                    kill_process_tree(proc)

            err_thread = threading.Thread(target=drain_err, daemon=True)
            err_thread.start()

            assert proc.stdout is not None
            for line in iter_process_lines(
                proc,
                proc.stdout,
                hard_timeout_sec=max(600.0, job.duration * 20.0 + 300.0),
                idle_timeout_sec=180.0,
                kill=kill_process_tree,
                cancel_check=lambda: job.status == "cancelled",
            ):
                if job.status == "cancelled" or early_stop.is_set():
                    break
                m = _SCENE_OUT_TIME_US.search(line)
                if m and job.duration > 0:
                    secs = int(m.group(1)) / 1_000_000
                    job.pct = max(0.0, min(99.0, secs / job.duration * 100))
            # Early maxScenes stop (drain thread) or cancel may already have killed;
            # ensure the tree is reaped either way.
            if proc.poll() is None:
                kill_process_tree(proc)
            try:
                code = proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                code = proc.returncode if proc.returncode is not None else -1
            err_thread.join(timeout=2)
            job._proc = None

            if job.status == "cancelled":
                return

            with job._scenes_lock:
                n_scenes = len(job.scenes)
            # Early maxScenes stop or clean exit → done. Killed tree often returns
            # non-zero; still success when we intentionally stopped at the cap.
            if n_scenes >= max_scenes or code == 0:
                job.pct = 100.0
                job.status = "done"
                return
            job.status = "error"
            job.error = ("".join(err_tail))[-1500:] or f"ffmpeg exited {code}"
        except Exception as e:  # noqa: BLE001
            if job.status != "cancelled":
                job.status = "error"
                job.error = str(e)[:1500]
    finally:
        HEAVY_JOB_SEMAPHORE.release()
        if job._admission_owned:
            job._admission_owned = False
            _SCENE_ADMISSION.release()
        if cleanup_path:
            cleanup_temp_path(cleanup_path)


@router.post("/scenes")
def media_scenes(
    file: UploadFile | None = File(None),
    threshold: float = Form(0.35),
    minGapSec: float = Form(0.6),
    maxScenes: int = Form(300),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    """Start an async scene-change detection job. Returns a job id to poll."""
    _require_ffmpeg()
    if not _SCENE_ADMISSION.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail=f"Too many scene jobs queued/running (limit {_SCENE_ACTIVE_MAX})",
        )
    handed_to_worker = False
    try:
        result = _media_scenes_admitted(file, threshold, minGapSec, maxScenes, hash, sourcePath)
        handed_to_worker = True
        return result
    finally:
        # Once a worker owns the slot it releases in _run_scene_detect.finally.
        # A validation/probe failure before thread start releases here.
        if not handed_to_worker:
            _SCENE_ADMISSION.release()


def _media_scenes_admitted(
    file: UploadFile | None,
    threshold: float,
    minGapSec: float,
    maxScenes: int,
    hash: str,
    sourcePath: str,
) -> dict:
    threshold = max(0.05, min(float(threshold), 0.95))
    min_gap = max(0.1, min(float(minGapSec), 10.0))
    max_scenes = max(1, min(int(maxScenes), 1000))

    # Resolve a path that outlives the request (the job runs in a background
    # thread). A stored asset / desktop source is used in place; a raw upload is
    # copied to a temp file the worker deletes when it finishes.
    cleanup: str | None = None
    stored = asset_path(hash) if hash else None
    if stored:
        in_path = stored
    elif sourcePath:
        in_path = resolve_source_path(sourcePath)
    elif file is not None:
        base = os.path.abspath(os.path.join(get_settings().work_dir, "scenes"))
        os.makedirs(base, exist_ok=True)
        suffix = os.path.splitext(file.filename or "")[1] or ".bin"
        fd, in_path = tempfile.mkstemp(suffix=suffix, dir=base)
        os.close(fd)
        try:
            save_upload_bounded(file, in_path)
        except Exception:  # noqa: BLE001 - cleanup must cover every failed upload
            # save_upload_bounded publishes atomically via a sibling .part file,
            # but mkstemp itself already created this empty destination. Scene
            # jobs do not have a job-dir sweeper, so a rejected/full-disk upload
            # would otherwise leave one orphan per attempt forever.
            try:
                os.remove(in_path)
            except OSError:
                pass
            raise
        cleanup = register_temp_path(in_path)
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
        )

    try:
        duration = float(ffmpeg_utils.probe(in_path).get("durationSec") or 0)
    except RuntimeError as e:
        if cleanup:
            cleanup_temp_path(cleanup)
        raise HTTPException(status_code=422, detail=str(e))

    job = _SceneJob(id=uuid.uuid4().hex[:12], duration=max(0.01, duration))
    job._admission_owned = True
    _prune_scene_jobs()
    with _SCENE_JOBS_LOCK:
        _SCENE_JOBS[job.id] = job
    threading.Thread(
        target=_run_scene_detect,
        args=(job, in_path, threshold, min_gap, max_scenes, cleanup),
        daemon=True,
    ).start()
    return {"jobId": job.id}


@router.get("/scenes/{job_id}")
async def media_scenes_status(job_id: str) -> dict:
    job = _SCENE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    with job._scenes_lock:
        scenes = list(job.scenes)
    return {
        "id": job.id,
        "status": job.status,
        "pct": round(job.pct, 1),
        "scenes": scenes,
        "error": job.error,
    }


@router.post("/scenes/{job_id}/cancel")
def media_scenes_cancel(job_id: str) -> dict:
    job = _SCENE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "running":
        job.status = "cancelled"
        proc = job._proc
        if proc is not None:
            try:
                kill_process_tree(proc)
            finally:
                job._proc = None
    return {"ok": True}


def shutdown_active_scene_jobs() -> int:
    """Best-effort process-tree cancellation for graceful backend shutdown."""
    with _SCENE_JOBS_LOCK:
        jobs = [job for job in _SCENE_JOBS.values() if job.status == "running"]
    for job in jobs:
        # Work from the object snapshot instead of the route lookup: pruning is
        # allowed to mutate the registry concurrently, but the live process
        # still has to be reaped even if its status row disappears.
        job.status = "cancelled"
        proc = job._proc
        if proc is not None:
            try:
                kill_process_tree(proc)
            finally:
                job._proc = None
    return len(jobs)


# ── Browser-safe video normalization ─────────────────────────────────────────

_NORMALIZE_JOBS_MAX = 64
_NORMALIZED_GRACE_SEC = 15 * 60
_NORMALIZE_ACTIVE_MAX = 4
_NORMALIZE_ADMISSION = threading.BoundedSemaphore(_NORMALIZE_ACTIVE_MAX)


@dataclass
class _NormalizeJob:
    id: str
    content_hash: str
    source_path: str
    output_path: str
    temp_path: str
    duration: float
    cleanup_path: str | None = None
    status: str = "queued"       # queued | running | done | error | cancelled
    pct: float = 0.0
    phase: str = "queued"        # queued | remux | transcode | done
    error: str | None = None
    cached: bool = False
    created_at: float = field(default_factory=time.time)
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _admission_owned: bool = field(default=False, repr=False)
    _admission_token: str | None = field(default=None, repr=False)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "pct": round(self.pct, 1),
            "phase": self.phase,
            "error": self.error,
            "hash": self.content_hash,
            "cached": self.cached,
        }


_NORMALIZE_JOBS: dict[str, _NormalizeJob] = {}
_NORMALIZE_BY_HASH: dict[str, str] = {}
_NORMALIZE_JOBS_LOCK = threading.Lock()


def _normalized_dir() -> str:
    path = os.path.abspath(os.path.join(get_settings().work_dir, "normalized"))
    os.makedirs(path, exist_ok=True)
    return path


def _normalized_cache_path(content_hash: str) -> str:
    if not _CONTENT_HASH_RE.fullmatch(content_hash):
        raise ValueError("Invalid normalized media content hash")
    return os.path.join(_normalized_dir(), f"{content_hash.lower()}.mp4")


def cleanup_normalized_cache(exclude: set[str] | None = None) -> int:
    """Enforce TTL + LRU quota for content-addressed normalized MP4 outputs."""
    protected = {os.path.abspath(path) for path in (exclude or set())}
    directory = _normalized_dir()
    now = time.time()
    entries: list[tuple[str, float, int]] = []
    removed = 0
    for entry in os.scandir(directory):
        path = os.path.abspath(entry.path)
        if not entry.is_file():
            continue
        if ".part-" in entry.name:
            try:
                if now - entry.stat().st_mtime >= _NORMALIZED_GRACE_SEC:
                    os.remove(path)
                    removed += 1
            except OSError:
                pass
            continue
        if not re.fullmatch(r"[0-9a-fA-F]{64}\.mp4", entry.name):
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        entries.append((path, stat.st_mtime, stat.st_size))

    settings = get_settings()

    def remove_if_safe(path: str, mtime: float) -> bool:
        if path in protected or now - mtime < _NORMALIZED_GRACE_SEC:
            return False
        try:
            os.remove(path)
            return True
        except OSError:
            return False

    if settings.normalized_ttl_days > 0:
        cutoff = now - settings.normalized_ttl_days * 86400
        kept: list[tuple[str, float, int]] = []
        for path, mtime, size in entries:
            if mtime < cutoff and remove_if_safe(path, mtime):
                removed += 1
            else:
                kept.append((path, mtime, size))
        entries = kept

    if settings.normalized_quota_mb > 0:
        quota = settings.normalized_quota_mb * 1024 * 1024
        total = sum(size for _path, _mtime, size in entries)
        if total > quota:
            for path, mtime, size in sorted(entries, key=lambda value: value[1]):
                if total <= quota:
                    break
                if remove_if_safe(path, mtime):
                    total -= size
                    removed += 1

    if removed:
        log.info("Normalized media cleanup: evicted %d file(s)", removed)
    return removed


def _prune_normalize_jobs() -> None:
    with _NORMALIZE_JOBS_LOCK:
        if len(_NORMALIZE_JOBS) <= _NORMALIZE_JOBS_MAX:
            return
        finished = sorted(
            (
                job for job in _NORMALIZE_JOBS.values()
                if job.status not in {"queued", "running"}
            ),
            key=lambda job: job.created_at,
        )
        for job in finished:
            if len(_NORMALIZE_JOBS) <= _NORMALIZE_JOBS_MAX:
                break
            _NORMALIZE_JOBS.pop(job.id, None)


def _run_normalize_command(
    job: _NormalizeJob,
    cmd: list[str],
    *,
    pct_start: float,
    pct_span: float,
) -> tuple[int, str]:
    popen_kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "bufsize": 1,
    }
    if sys.platform == "win32":
        popen_kwargs["creationflags"] = getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kwargs)
    job._proc = proc
    if job.status == "cancelled":
        try:
            kill_process_tree(proc)
        finally:
            job._proc = None
        return -1, "cancelled"

    err_tail: list[str] = []

    def drain_err() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            err_tail.append(line)
            if len(err_tail) > _STDERR_TAIL:
                del err_tail[0]

    err_thread = threading.Thread(target=drain_err, daemon=True)
    err_thread.start()
    assert proc.stdout is not None
    try:
        for line in iter_process_lines(
            proc,
            proc.stdout,
            hard_timeout_sec=max(1800.0, job.duration * 50.0 + 600.0),
            idle_timeout_sec=180.0,
            kill=kill_process_tree,
            cancel_check=lambda: job.status == "cancelled",
        ):
            match = _SCENE_OUT_TIME_US.search(line)
            if match and job.duration > 0:
                seconds = int(match.group(1)) / 1_000_000
                phase_pct = min(0.99, max(0.0, seconds / job.duration))
                job.pct = max(job.pct, pct_start + phase_pct * pct_span)
        if job.status == "cancelled" and proc.poll() is None:
            kill_process_tree(proc)
        try:
            code = proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            if proc.poll() is None:
                kill_process_tree(proc)
            code = proc.returncode if proc.returncode is not None else -1
        return int(code), "".join(err_tail)[-3000:]
    finally:
        if proc.poll() is None:
            kill_process_tree(proc)
        err_thread.join(timeout=2)
        job._proc = None


def _normalize_transcode_cmd(in_path: str, out_path: str, encoder: str) -> list[str]:
    quality = (
        ["-preset", "p4", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
        if encoder == "h264_nvenc"
        else ["-preset", "veryfast", "-crf", "18"]
    )
    return [
        "ffmpeg", "-hide_banner", "-y", "-i", in_path,
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", encoder, *quality,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        out_path,
    ]


def _run_normalize_job(job: _NormalizeJob) -> None:
    acquired = HEAVY_JOB_SEMAPHORE.acquire(
        cancel_check=lambda: job.status == "cancelled",
    )
    if not acquired:
        if job.status != "cancelled":
            job.status = "error"
            job.error = "Normalization was cancelled while queued"
        if job.cleanup_path:
            cleanup_temp_path(job.cleanup_path)
        if job._admission_owned:
            job._admission_owned = False
            _NORMALIZE_ADMISSION.release()
        return
    reservation_id = f"normalize:{job.id}"
    reserved = False
    try:
        if job.status == "cancelled":
            return
        job.status = "running"
        source_bytes = max(1, os.path.getsize(job.source_path))
        cache_dir = _normalized_dir()
        reserve_external_output(
            reservation_id,
            source_bytes + max(source_bytes, 128 * 1024 * 1024),
            shutil.disk_usage(cache_dir).free,
            f"dev:{os.stat(cache_dir).st_dev}",
            store_path=cache_dir,
        )
        reserved = True
        metadata = ffmpeg_utils.probe(job.source_path)
        source_is_h264 = metadata.get("videoCodec") == "h264"

        remux_error = ""
        if source_is_h264:
            job.phase = "remux"
            remux_cmd = [
                "ffmpeg", "-hide_banner", "-y", "-i", job.source_path,
                "-map", "0:v:0", "-map", "0:a?",
                "-c", "copy", "-movflags", "+faststart",
                "-progress", "pipe:1", "-nostats",
                job.temp_path,
            ]
            code, remux_error = _run_normalize_command(
                job, remux_cmd, pct_start=0.0, pct_span=20.0
            )
            if job.status == "cancelled":
                return
            if code == 0:
                try:
                    if ffmpeg_utils.probe(job.temp_path).get("videoCodec") == "h264":
                        os.replace(job.temp_path, job.output_path)
                        job.pct = 100.0
                        job.phase = "done"
                        job.status = "done"
                        return
                except Exception as exc:  # noqa: BLE001
                    remux_error = str(exc)
            try:
                os.remove(job.temp_path)
            except OSError:
                pass

        job.phase = "transcode"
        try:
            detected = detect_video_encoder("h264")
        except TypeError:
            # Compatibility with tests/older monkeypatches that expose the
            # historical zero-argument callable.
            detected = detect_video_encoder()
        encoder = "h264_nvenc" if detected == "h264_nvenc" else "libx264"
        code, transcode_error = _run_normalize_command(
            job,
            _normalize_transcode_cmd(job.source_path, job.temp_path, encoder),
            pct_start=20.0 if source_is_h264 else 0.0,
            pct_span=79.0 if source_is_h264 else 99.0,
        )
        if job.status == "cancelled":
            return
        if code != 0 and encoder == "h264_nvenc":
            try:
                os.remove(job.temp_path)
            except OSError:
                pass
            code, cpu_error = _run_normalize_command(
                job,
                _normalize_transcode_cmd(job.source_path, job.temp_path, "libx264"),
                pct_start=max(job.pct, 20.0),
                pct_span=max(1.0, 99.0 - max(job.pct, 20.0)),
            )
            transcode_error = cpu_error or transcode_error
        if job.status == "cancelled":
            return
        if code != 0:
            detail = transcode_error or remux_error or f"ffmpeg exited {code}"
            raise RuntimeError(detail)
        if ffmpeg_utils.probe(job.temp_path).get("videoCodec") != "h264":
            raise RuntimeError("Normalized output is not H.264")
        os.replace(job.temp_path, job.output_path)
        job.pct = 100.0
        job.phase = "done"
        job.status = "done"
    except Exception as exc:  # noqa: BLE001
        if job.status != "cancelled":
            job.status = "error"
            job.error = str(exc)[-3000:]
    finally:
        if reserved:
            release_external_output(reservation_id)
        job._proc = None
        HEAVY_JOB_SEMAPHORE.release()
        try:
            os.remove(job.temp_path)
        except OSError:
            pass
        if job.cleanup_path:
            cleanup_temp_path(job.cleanup_path)
        with _NORMALIZE_JOBS_LOCK:
            if _NORMALIZE_BY_HASH.get(job.content_hash) == job.id:
                _NORMALIZE_BY_HASH.pop(job.content_hash, None)
        try:
            if job.status == "done":
                try:
                    os.utime(job.output_path, None)
                except OSError:
                    pass
                cleanup_normalized_cache({job.output_path})
        except Exception:  # noqa: BLE001
            log.exception("Normalized media cleanup failed for job %s", job.id)
        finally:
            _prune_normalize_jobs()
            if job._admission_owned:
                job._admission_owned = False
                _NORMALIZE_ADMISSION.release()


def _media_normalize_admitted(
    file: UploadFile | None = File(None),
    hash: str = Form(""),
    sourcePath: str = Form(""),
    admission_token: str | None = None,
) -> dict:
    """Queue a content-addressed browser-safe H.264 MP4 normalization."""
    _require_ffmpeg()
    cleanup_path: str | None = None
    source_path: str

    if sourcePath:
        source_path = resolve_source_path(sourcePath)
        content_hash = content_hash_path(source_path)
    else:
        stored = asset_path(hash) if hash else None
        if stored:
            source_path = stored
            content_hash = (
                hash.lower()
                if _CONTENT_HASH_RE.fullmatch(hash)
                else content_hash_path(stored)
            )
        elif file is not None:
            inputs = os.path.abspath(os.path.join(get_settings().work_dir, "normalize-inputs"))
            os.makedirs(inputs, exist_ok=True)
            ext = os.path.splitext(file.filename or "")[1] or ".bin"
            source_path = os.path.join(inputs, f"{uuid.uuid4().hex}{ext}")
            save_upload_bounded(file, source_path)
            cleanup_path = source_path
            content_hash = content_hash_path(source_path)
        else:
            raise HTTPException(
                status_code=422,
                detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
            )

    output_path = _normalized_cache_path(content_hash)
    with _NORMALIZE_JOBS_LOCK:
        active_id = _NORMALIZE_BY_HASH.get(content_hash)
        active = _NORMALIZE_JOBS.get(active_id or "")
        if active and active.status in {"queued", "running"}:
            if cleanup_path:
                cleanup_temp_path(cleanup_path)
            return active.public()
        if os.path.isfile(output_path):
            try:
                os.utime(output_path, None)
            except OSError:
                pass
            if cleanup_path:
                cleanup_temp_path(cleanup_path)
            job = _NormalizeJob(
                id=uuid.uuid4().hex,
                content_hash=content_hash,
                source_path=source_path,
                output_path=output_path,
                temp_path="",
                duration=0.0,
                status="done",
                pct=100.0,
                phase="done",
                cached=True,
            )
            _NORMALIZE_JOBS[job.id] = job
            return job.public()

        try:
            duration = float(ffmpeg_utils.probe(source_path).get("durationSec") or 0.0)
        except Exception:
            duration = 0.0
        job = _NormalizeJob(
            id=uuid.uuid4().hex,
            content_hash=content_hash,
            source_path=source_path,
            output_path=output_path,
            temp_path=os.path.join(
                _normalized_dir(), f"{content_hash}.part-{uuid.uuid4().hex}.mp4"
            ),
            duration=max(0.01, duration),
            cleanup_path=cleanup_path,
        )
        _NORMALIZE_JOBS[job.id] = job
        _NORMALIZE_BY_HASH[content_hash] = job.id

    job._admission_owned = True
    job._admission_token = admission_token
    try:
        threading.Thread(
            target=_run_normalize_job,
            args=(job,),
            daemon=True,
            name=f"normalize-{job.id[:8]}",
        ).start()
    except Exception:
        job._admission_owned = False
        with _NORMALIZE_JOBS_LOCK:
            _NORMALIZE_JOBS.pop(job.id, None)
            if _NORMALIZE_BY_HASH.get(content_hash) == job.id:
                _NORMALIZE_BY_HASH.pop(content_hash, None)
        if cleanup_path:
            cleanup_temp_path(cleanup_path)
        raise
    return job.public()


@router.post("/normalize")
def media_normalize(
    file: UploadFile | None = File(None),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    """Queue normalization with bounded admission before upload/hash work."""
    if not _NORMALIZE_ADMISSION.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail=f"Too many normalization jobs queued/running (limit {_NORMALIZE_ACTIVE_MAX})",
        )
    handed_to_worker = False
    admission_token = uuid.uuid4().hex
    try:
        result = _media_normalize_admitted(file, hash, sourcePath, admission_token)
        job = _NORMALIZE_JOBS.get(str(result.get("id") or ""))
        handed_to_worker = bool(job and job._admission_token == admission_token)
        return result
    finally:
        if not handed_to_worker:
            _NORMALIZE_ADMISSION.release()


@router.get("/normalize/{job_id}")
async def media_normalize_status(job_id: str) -> dict:
    job = _NORMALIZE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Normalization job not found")
    return job.public()


@router.get("/normalize/{job_id}/download")
async def media_normalize_download(job_id: str):
    job = _NORMALIZE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Normalization job not found")
    if job.status != "done" or not os.path.isfile(job.output_path):
        raise HTTPException(status_code=409, detail=f"Not ready (status: {job.status})")
    try:
        os.utime(job.output_path, None)
    except OSError:
        pass
    return FileResponse(
        job.output_path,
        media_type="video/mp4",
        filename=f"{job.content_hash}.mp4",
    )


@router.post("/normalize/{job_id}/cancel")
def media_normalize_cancel(job_id: str) -> dict:
    job = _NORMALIZE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Normalization job not found")
    if job.status in {"queued", "running"}:
        job.status = "cancelled"
        proc = job._proc
        if proc is not None:
            try:
                kill_process_tree(proc)
            finally:
                job._proc = None
    return {"ok": True}


def shutdown_active_normalize_jobs() -> int:
    with _NORMALIZE_JOBS_LOCK:
        jobs = [
            job for job in _NORMALIZE_JOBS.values()
            if job.status in {"queued", "running"}
        ]
    for job in jobs:
        media_normalize_cancel(job.id)
    return len(jobs)


@router.post("/waveform")
async def media_waveform(
    request: Request,
    file: UploadFile | None = File(None),
    maxPeaks: int = Form(4000),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    """Extract normalised 0..1 waveform peaks for timeline rendering."""
    _require_ffmpeg()
    maxPeaks = max(100, min(maxPeaks, 20000))
    async with _source_media_async(file, hash, sourcePath) as path:
        try:
            peaks = await _run_with_disconnect_cancel(
                request,
                lambda cancel_check: ffmpeg_utils.waveform_peaks(
                    path, max_peaks=maxPeaks, cancel_check=cancel_check
                ),
            )
        except HTTPException:
            raise
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))
    return {"peaks": peaks}


# ── Proxy generation ────────────────────────────────────────────────────────
# Transcode a (possibly 4K) source to a lightweight H.264 file at `height`p so
# the in-browser preview can scrub/playback smoothly. The original is still used
# for export. Async job (reuses the export job runner) since long clips take a
# while; the frontend polls and then downloads the result.


@router.post("/proxy")
def media_proxy(
    file: UploadFile | None = File(None),
    height: int = Form(480),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    _require_ffmpeg()
    height = max(120, min(height, 1080))

    base = os.path.abspath(os.path.join(get_settings().work_dir, "proxies"))
    os.makedirs(base, exist_ok=True)

    # Create job first so the directory name IS the job id (startup recovery
    # derives work/proxies/<id> from kind+id — a random UUID dir was orphaned).
    job = create_job(0.01, out_path="", kind="proxy", status="setup")
    job_dir = os.path.join(base, job.id)
    os.makedirs(job_dir, exist_ok=True)
    job.job_dir = job_dir

    # Resolve the input. The job runs async (background thread), so the source
    # must outlive this request: a stored asset already persists (use it
    # directly, no copy); an upload is copied into the job dir.
    stored = asset_path(hash) if hash else None
    try:
        if stored:
            in_path = stored
        elif sourcePath:
            in_path = resolve_source_path(sourcePath)
        elif file is not None:
            ext = os.path.splitext(file.filename or "")[1] or ".bin"
            in_path = os.path.join(job_dir, f"input{ext}")
            save_upload_bounded(file, in_path)
        else:
            from ..export.job import fail_job_setup
            fail_job_setup(job, "Provide a file upload, sourcePath, or content hash")
            raise HTTPException(
                status_code=422,
                detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
            )

        try:
            duration = float(ffmpeg_utils.probe(in_path).get("durationSec") or 0)
        except Exception:
            duration = 0.0
        job.duration = max(0.01, duration)

        # Render to temp, publish atomically to reserved final (integrity helpers).
        out_path = reserve_output_exclusive(job_dir, "proxy.mp4")
        temp_path = os.path.join(job_dir, "proxy.part.mp4")
        job.out_path = out_path
        job.temp_path = temp_path
        job.reserved_out = True
        job.save()

        encoder = detect_video_encoder()
        cmd = [
            "ffmpeg", "-hide_banner", "-y", "-i", in_path,
            # scale=-2:H keeps aspect with an even width. The preview plays audio
            # from this same media element, so the proxy must carry audio too.
            # Encode video with hardware when available; AAC is browser-safe.
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale=-2:{height}",
            "-c:v", encoder, *proxy_quality_args(encoder),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ac", "2",
            "-movflags", "+faststart",
            temp_path,  # temp; run_job publishes → out_path on success
        ]
        run_job(job, cmd, cwd=job_dir)
        return {"jobId": job.id}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        from ..export.job import fail_job_setup
        fail_job_setup(job, str(e))
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("/proxy/{job_id}")
async def media_proxy_status(job_id: str) -> dict:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public()


@router.get("/proxy/{job_id}/download")
async def media_proxy_download(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "done" or not os.path.exists(job.out_path):
        raise HTTPException(status_code=409, detail=f"Not ready (status: {job.status})")
    return FileResponse(job.out_path, media_type="video/mp4", filename="proxy.mp4")


@router.post("/proxy/{job_id}/cancel")
def media_proxy_cancel(job_id: str) -> dict:
    """Cancel one preview proxy without exposing cancellation of other jobs."""
    job = get_job(job_id)
    if not job or job.kind != "proxy":
        raise HTTPException(status_code=404, detail="Proxy job not found")
    cancel_job(job_id)
    return {"ok": True}
