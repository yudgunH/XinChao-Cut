"""FFmpeg-backed media endpoints: probe, thumbnail strip, waveform, proxy."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import ffmpeg_utils
from ..config import get_settings
from ..export.ffmpeg_build import detect_video_encoder, proxy_quality_args
from ..export.job import create_job, get_job, run_job
from ..ffmpeg_utils import ffmpeg_available
from ..utils import resolve_source_path, saved_upload
from .assets import asset_path

router = APIRouter(prefix="/media", tags=["media"])
_SCENE_PTS_TIME = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")
_SCENE_OUT_TIME_US = re.compile(r"out_time_us=(\d+)")


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


@router.post("/probe")
async def media_probe(
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
    with _source_media(file, hash, sourcePath) as path:
        try:
            frames = ffmpeg_utils.thumbnail_strip(path, count, width)
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
    _proc: subprocess.Popen | None = field(default=None, repr=False)


_SCENE_JOBS: dict[str, _SceneJob] = {}
_SCENE_JOBS_MAX = 32


def _prune_scene_jobs() -> None:
    """Drop the oldest finished scene jobs once the registry grows past the cap."""
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
    try:
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
        if job.status == "cancelled":
            proc.terminate()
            return

        # Drain stderr concurrently (showinfo cut markers + any error text);
        # leaving it unread would deadlock once the pipe buffer fills.
        err_lines: list[str] = []

        def drain_err() -> None:
            for line in proc.stderr:  # type: ignore[union-attr]
                err_lines.append(line)

        err_thread = threading.Thread(target=drain_err, daemon=True)
        err_thread.start()

        for line in proc.stdout:  # type: ignore[union-attr]
            m = _SCENE_OUT_TIME_US.search(line)
            if m and job.duration > 0:
                secs = int(m.group(1)) / 1_000_000
                job.pct = max(0.0, min(99.0, secs / job.duration * 100))
        code = proc.wait()
        err_thread.join(timeout=2)

        if job.status == "cancelled":
            return
        if code != 0:
            job.status = "error"
            job.error = ("".join(err_lines))[-1500:] or f"ffmpeg exited {code}"
            return

        scenes: list[float] = []
        last = 0.0
        for match in _SCENE_PTS_TIME.finditer("".join(err_lines)):
            sec = float(match.group(1))
            if sec <= 0.05 or sec - last < min_gap:
                continue
            scenes.append(sec)
            last = sec
            if len(scenes) >= max_scenes:
                break
        job.scenes = scenes
        job.pct = 100.0
        job.status = "done"
    except Exception as e:  # noqa: BLE001
        job.status = "error"
        job.error = str(e)[:1500]
    finally:
        if cleanup_path:
            try:
                os.remove(cleanup_path)
            except OSError:
                pass


@router.post("/scenes")
async def media_scenes(
    file: UploadFile | None = File(None),
    threshold: float = Form(0.35),
    minGapSec: float = Form(0.6),
    maxScenes: int = Form(300),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    """Start an async scene-change detection job. Returns a job id to poll."""
    _require_ffmpeg()
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
        with os.fdopen(fd, "wb") as out:
            shutil.copyfileobj(file.file, out)
        cleanup = in_path
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
        )

    try:
        duration = float(ffmpeg_utils.probe(in_path).get("durationSec") or 0)
    except RuntimeError as e:
        if cleanup:
            try:
                os.remove(cleanup)
            except OSError:
                pass
        raise HTTPException(status_code=422, detail=str(e))

    job = _SceneJob(id=uuid.uuid4().hex[:12], duration=max(0.01, duration))
    _prune_scene_jobs()
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
    return {
        "id": job.id,
        "status": job.status,
        "pct": round(job.pct, 1),
        "scenes": job.scenes,
        "error": job.error,
    }


@router.post("/scenes/{job_id}/cancel")
async def media_scenes_cancel(job_id: str) -> dict:
    job = _SCENE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "running":
        if job._proc:
            job._proc.terminate()
        job.status = "cancelled"
    return {"ok": True}


@router.post("/waveform")
async def media_waveform(
    file: UploadFile | None = File(None),
    maxPeaks: int = Form(4000),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    """Extract normalised 0..1 waveform peaks for timeline rendering."""
    _require_ffmpeg()
    maxPeaks = max(100, min(maxPeaks, 20000))
    with _source_media(file, hash, sourcePath) as path:
        try:
            peaks = ffmpeg_utils.waveform_peaks(path, max_peaks=maxPeaks)
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))
    return {"peaks": peaks}


# ── Proxy generation ────────────────────────────────────────────────────────
# Transcode a (possibly 4K) source to a lightweight H.264 file at `height`p so
# the in-browser preview can scrub/playback smoothly. The original is still used
# for export. Async job (reuses the export job runner) since long clips take a
# while; the frontend polls and then downloads the result.


@router.post("/proxy")
async def media_proxy(
    file: UploadFile | None = File(None),
    height: int = Form(480),
    hash: str = Form(""),
    sourcePath: str = Form(""),
) -> dict:
    _require_ffmpeg()
    height = max(120, min(height, 1080))

    base = os.path.abspath(os.path.join(get_settings().work_dir, "proxies"))
    os.makedirs(base, exist_ok=True)
    job_dir = os.path.join(base, uuid.uuid4().hex[:12])
    os.makedirs(job_dir, exist_ok=True)

    # Resolve the input. The job runs async (background thread), so the source
    # must outlive this request: a stored asset already persists (use it
    # directly, no copy); an upload is copied into the job dir.
    stored = asset_path(hash) if hash else None
    if stored:
        in_path = stored
    elif sourcePath:
        in_path = resolve_source_path(sourcePath)
    elif file is not None:
        ext = os.path.splitext(file.filename or "")[1] or ".bin"
        in_path = os.path.join(job_dir, f"input{ext}")
        with open(in_path, "wb") as out:
            shutil.copyfileobj(file.file, out)
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide a file upload, sourcePath, or the content hash of an uploaded asset",
        )

    try:
        duration = float(ffmpeg_utils.probe(in_path).get("durationSec") or 0)
    except Exception:
        duration = 0.0

    out_path = os.path.join(job_dir, "proxy.mp4")
    job = create_job(duration, out_path=out_path, kind="proxy")

    encoder = detect_video_encoder()
    cmd = [
        "ffmpeg", "-hide_banner", "-y", "-i", in_path,
        # scale=-2:H keeps aspect with an even width; drop audio (preview audio
        # comes from the original via the Web Audio engine). Encode with the
        # hardware encoder when one works (NVENC/QSV/AMF — same detection as
        # server export), else libx264 veryfast/crf 26.
        "-vf", f"scale=-2:{height}",
        "-c:v", encoder, *proxy_quality_args(encoder),
        "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
        out_path,
    ]
    run_job(job, cmd, cwd=job_dir)
    return {"jobId": job.id}


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
