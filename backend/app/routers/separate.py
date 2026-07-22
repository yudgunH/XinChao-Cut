"""Vocal / music separation via Demucs (htdemucs).

Splits an audio (or video) file into two stems — `vocals` and `no_vocals`
(the instrumental / music bed) — using the htdemucs model. Demucs is slow
(seconds to minutes depending on length and CPU/GPU), so this uses the same
async job + polling pattern as server export rather than a blocking request.

The model runs on CUDA when a CUDA-enabled torch + GPU are present (reusing the
same detection as transcription), else CPU.
"""
from __future__ import annotations

import json
import logging
import os
import time
import re
import shutil
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import get_settings
from ..export.job import (
    InsufficientSpace,
    QuotaExceeded,
    cleanup_job_dirs,
    delete_job_row,
    load_rows,
    persist_job,
    release_external_output,
    reserve_external_output,
    safe_rmtree_jobdir,
    update_external_output_written,
)
from ..ffmpeg_utils import ffmpeg_available, probe_duration
from ..process_runner import (
    ProcessCancelled,
    ProcessFailed,
    ProcessTimedOut,
    kill_process_tree,
    media_timeout,
    run_process,
)
from ..utils import resolve_source_path

log = logging.getLogger(__name__)
router = APIRouter(prefix="/separate", tags=["separate"])

# Demucs / tqdm print progress like " 42.5%"; grab the last percentage seen.
_PCT = re.compile(r"(\d+(?:\.\d+)?)%")
MAX_JOBS = 10
_MODEL = "htdemucs"


def demucs_available() -> bool:
    """Cheap presence check (metadata only) — a real `import demucs` pulls in
    torch, which stalls the first /health call (see whisperx_available)."""
    import importlib.util
    return importlib.util.find_spec("demucs") is not None


def _device() -> str:
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


@dataclass
class SepJob:
    id: str
    status: str = "running"  # running | done | error | cancelled
    pct: float = 0.0
    error: Optional[str] = None
    out_dir: str = ""
    vocals: Optional[str] = None
    music: Optional[str] = None
    started_at: float = 0.0  # epoch when real work began (for ETA)
    _proc: Optional[subprocess.Popen] = field(default=None, repr=False)
    _reservation_id: str = field(default="", repr=False)
    _release_pending: bool = field(default=False, repr=False)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "pct": round(self.pct, 1),
            "error": self.error,
            "stems": {"vocals": bool(self.vocals), "music": bool(self.music)},
        }

    def save(self) -> None:
        """Mirror this job into the shared jobs.db (survives restarts)."""
        persist_job(
            id=self.id, kind="separate", status=self.status, pct=self.pct,
            error=self.error, duration=0.0, out_path="", keep_dir=self.out_dir,
            extra=json.dumps({"vocals": self.vocals, "music": self.music}),
        )


JOBS: dict[str, SepJob] = {}
# See export/job.py for the pattern: guards structural mutations only.
_JOBS_LOCK = threading.Lock()
_START_LOCK = threading.Lock()
_CANCELLED_STARTS: dict[str, float] = {}
_PENDING_RELEASES: set[str] = set()


def _publish_completed_stems(job: SepJob, vocals: str, music: str) -> bool:
    """Atomically publish terminal output against cancel/release.

    A project delete can arrive after Demucs exits but while the worker locates
    its files. The last state transition must share the same lock as release;
    otherwise a cancelled job can be resurrected as ``done``.
    """
    with _JOBS_LOCK:
        if JOBS.get(job.id) is not job or job.status != "running":
            return False
        job.vocals, job.music = vocals, music
        job.pct = 100.0
        job.status = "done"
        return True


def _start_was_cancelled(job_id: str) -> bool:
    with _JOBS_LOCK:
        return job_id in _CANCELLED_STARTS


def _remember_cancelled_start(job_id: str) -> None:
    now = time.time()
    _CANCELLED_STARTS[job_id] = now
    cutoff = now - 48 * 3600
    for stale_id, cancelled_at in list(_CANCELLED_STARTS.items()):
        if cancelled_at < cutoff:
            _CANCELLED_STARTS.pop(stale_id, None)
    while len(_CANCELLED_STARTS) > 1000:
        _CANCELLED_STARTS.pop(next(iter(_CANCELLED_STARTS)))


def restore_sep_jobs() -> set[str]:
    """Reload persisted separation jobs into JOBS (after job.init_and_sweep).

    Returns the output dirs of completed jobs — their stems are still on disk
    and must survive the startup cleanup so downloads keep working.
    """
    keep: set[str] = set()
    for r in load_rows(("separate",)):
        extra = json.loads(r["extra"] or "{}")
        job = SepJob(
            id=r["id"], status=r["status"], pct=r["pct"], error=r["error"],
            out_dir=r["keep_dir"], vocals=extra.get("vocals"), music=extra.get("music"),
        )
        with _JOBS_LOCK:
            JOBS[job.id] = job
        if job.status == "done" and job.out_dir:
            keep.add(os.path.abspath(job.out_dir))
    return keep


def _prune() -> None:
    victims: list[tuple[str, str]] = []
    from ..export.integrity import is_path_leased

    with _JOBS_LOCK:
        if len(JOBS) <= MAX_JOBS:
            return
        for jid in list(JOBS.keys()):
            if len(JOBS) <= MAX_JOBS:
                break
            job = JOBS[jid]
            if job.status == "running":
                continue
            if any(
                path and is_path_leased(path)
                for path in (job.vocals, job.music)
            ):
                continue
            victims.append((jid, job.out_dir))
            del JOBS[jid]
    for jid, out_dir in victims:
        safe_rmtree_jobdir(out_dir)
        delete_job_row(jid)


def _cancel_check(job: SepJob):
    """True when the job was cancelled (polled by process_runner / GPU wait)."""
    return lambda: job.status == "cancelled"


def _run(job: SepJob, in_path: str, work: str) -> None:
    """Background thread: extract audio (CPU) → demucs (GPU) → locate stems."""

    def worker() -> None:
        from app.resource_coordinator import (
            AcquireCancelledError,
            ResourceKind,
            resource_guard,
        )

        cancel = _cancel_check(job)

        def run_tracked(cmd, **kwargs):
            """Expose the current root to the cancel endpoint until reaped."""

            def remember(proc) -> None:
                job._proc = proc
                # Cancel can race the tiny Popen -> observer window. If it won,
                # do not wait for the normal poll before releasing GPU/handles.
                if cancel() and proc.poll() is None:
                    kill_process_tree(proc)

            try:
                return run_process(cmd, on_spawn=remember, **kwargs)
            finally:
                job._proc = None

        try:
            if cancel():
                return
            job.started_at = time.time()  # anchor ETA at real start
            job.pct = 2.0
            job.save()

            # 1. Normalise to 44.1 kHz stereo WAV — pure CPU FFmpeg, no GPU permit.
            wav = os.path.join(work, "audio.wav")
            try:
                run_tracked(
                    [
                        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                        "-i", in_path,
                        "-vn", "-ac", "2", "-ar", "44100",
                        wav,
                    ],
                    timeout=media_timeout(None, base=180, per_sec=2),
                    cancel_check=cancel,
                    raise_on_error=True,
                )
            except ProcessCancelled:
                job.status = "cancelled"
                job.save()
                return
            except (ProcessFailed, ProcessTimedOut) as e:
                job.status = "error"
                job.error = (getattr(e, "stderr_tail", None) or str(e))[-1500:]
                job.save()
                return

            if cancel() or not os.path.exists(wav):
                if cancel():
                    job.status = "cancelled"
                else:
                    job.status = "error"
                    job.error = "ffmpeg failed to extract audio"
                job.save()
                return

            job.pct = 12.0
            job.save()

            # 2. Demucs only under GPU_MODEL — do not hold the permit for ffmpeg.
            try:
                with resource_guard(
                    ResourceKind.GPU_MODEL,
                    cancel_check=cancel,
                    owner=f"demucs:{job.id}",
                ):
                    if cancel():
                        job.status = "cancelled"
                        job.save()
                        return

                    dev = _device()
                    # VRAM gate: don't fire Demucs on a full card (→ thrash).
                    if dev == "cuda":
                        from .. import gpu_guard
                        if not gpu_guard.wait_for_vram(
                            gpu_guard.NEED_DEMUCS,
                            kind="separate",
                            cancel=cancel,
                        ):
                            log.warning(
                                "[separate] insufficient free VRAM — running Demucs on CPU."
                            )
                            dev = "cpu"
                    if cancel():
                        job.status = "cancelled"
                        job.save()
                        return

                    out = os.path.join(work, "stems")
                    cmd = [
                        sys.executable, "-m", "demucs",
                        "--two-stems", "vocals",
                        "-n", _MODEL,
                        "--device", dev,
                        "-o", out,
                        wav,
                    ]
                    log.info("[separate] %s (device=%s)", " ".join(cmd), dev)
                    job.pct = 15.0
                    job.save()
                    # process_runner: timeout + cancel_check tree-kills demucs + CUDA kids.
                    try:
                        result = run_tracked(
                            cmd,
                            timeout=media_timeout(None, base=600, per_sec=8, hard_cap=6 * 3600),
                            cancel_check=cancel,
                            raise_on_error=True,
                        )
                    except ProcessCancelled:
                        job.status = "cancelled"
                        job.save()
                        return
                    except ProcessTimedOut as e:
                        job.status = "error"
                        job.error = (getattr(e, "stderr_tail", None) or str(e))[-1500:]
                        job.save()
                        return
                    except ProcessFailed as e:
                        job.status = "error"
                        tail = (getattr(e, "stderr_tail", None) or str(e))[-1500:]
                        job.error = tail or f"demucs exited with code {e.returncode}"
                        for m in _PCT.finditer(tail or ""):
                            job.pct = max(0.0, min(99.0, float(m.group(1))))
                        job.save()
                        return

                    if cancel():
                        job.status = "cancelled"
                        job.save()
                        return
                    del result  # success — stems on disk

                    # 3. Locate stems: <out>/<model>/audio/{vocals,no_vocals}.wav
                    base = os.path.join(out, _MODEL, "audio")
                    vocals = os.path.join(base, "vocals.wav")
                    music = os.path.join(base, "no_vocals.wav")
                    if not (os.path.exists(vocals) and os.path.exists(music)):
                        # demucs names the folder after the input basename (audio).
                        # Fall back to scanning one level under model.
                        model_dir = os.path.join(out, _MODEL)
                        found_v = found_m = None
                        if os.path.isdir(model_dir):
                            for root, _dirs, files in os.walk(model_dir):
                                if "vocals.wav" in files:
                                    found_v = os.path.join(root, "vocals.wav")
                                if "no_vocals.wav" in files:
                                    found_m = os.path.join(root, "no_vocals.wav")
                        vocals = found_v or vocals
                        music = found_m or music
                    if not (os.path.exists(vocals) and os.path.exists(music)):
                        job.status = "error"
                        job.error = "Separation finished but stem files were not found"
                        job.save()
                        return

                    if not _publish_completed_stems(job, vocals, music):
                        if job.status != "cancelled":
                            job.status = "cancelled"
                        job.save()
                        return
                    job.save()
            except AcquireCancelledError:
                job.status = "cancelled"
                job.save()
                return
        except ProcessCancelled:
            job.status = "cancelled"
            job.save()
        except Exception as e:  # noqa: BLE001
            if job.status != "cancelled":
                job.status = "error"
                job.error = str(e)[:1500]
                job.save()
        finally:
            # Reap any leftover tree (cancel race / partial spawn).
            proc = job._proc
            if proc is not None and proc.poll() is None:
                kill_process_tree(proc)
            job._proc = None
            if job.status == "done" or job._release_pending:
                # Retain only the two downloadable stems. The normalized input
                # and uploaded source are multi-GB scratch on long media.
                for scratch in (os.path.join(work, "audio.wav"), in_path):
                    try:
                        if os.path.commonpath([work, os.path.abspath(scratch)]) == work:
                            os.remove(scratch)
                    except (OSError, ValueError):
                        pass
            else:
                safe_rmtree_jobdir(work)
            if job._reservation_id:
                release_external_output(job._reservation_id)
                job._reservation_id = ""
            try:
                cleanup_job_dirs()
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=worker, daemon=True).start()


def _start_separation_locked(
    file: UploadFile | None = File(None),
    sourcePath: str = Form(""),
    requestId: str = Form(""),
) -> dict:
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg not found on the server")
    if not demucs_available():
        raise HTTPException(
            status_code=503,
            detail="Demucs is not installed on the server. Run: pip install demucs",
        )

    jid = requestId or uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        existing = JOBS.get(jid)
        cancelled = jid in _CANCELLED_STARTS
    if existing is not None:
        return {"jobId": existing.id}
    if cancelled:
        raise HTTPException(status_code=409, detail="Separation start was cancelled")

    # Reclaim old terminal outputs before admission so their bytes do not make a
    # valid new job fail unnecessarily.
    cleanup_job_dirs()
    _prune()
    work = os.path.abspath(os.path.join(get_settings().work_dir, "separate", jid))
    os.makedirs(work, exist_ok=True)
    reservation_id = f"separate-{jid}"
    volume = f"dev:{os.stat(work).st_dev}"
    safety = 512 * 1024 * 1024
    job: SepJob | None = None

    def rollback_setup() -> None:
        try:
            if job is not None:
                with _JOBS_LOCK:
                    if JOBS.get(jid) is job:
                        JOBS.pop(jid, None)
                delete_job_row(jid)
        finally:
            release_external_output(reservation_id)
            safe_rmtree_jobdir(work)

    try:
        if sourcePath:
            in_path = resolve_source_path(sourcePath)
            copy_bytes = 0
        elif file is not None:
            ext = os.path.splitext(file.filename or "")[1] or ".bin"
            in_path = os.path.join(work, f"input{ext}")
            # Starlette supplies UploadFile.size. If an older runtime omits it,
            # reserve the configured upload cap rather than accepting an
            # unbounded stream into the jobs volume.
            reported = max(0, int(getattr(file, "size", 0) or 0))
            fallback = max(1, int(get_settings().upload_max_bytes or 0))
            copy_bytes = reported or fallback
        else:
            raise HTTPException(status_code=422, detail="Provide a file upload or sourcePath")

        reserve_external_output(
            reservation_id,
            max(1, copy_bytes) + safety,
            shutil.disk_usage(work).free,
            volume,
            counts_toward_jobs_quota=True,
            store_path=work,
        )
        if _start_was_cancelled(jid):
            raise HTTPException(status_code=409, detail="Separation start was cancelled")
        if file is not None and not sourcePath:
            with open(in_path, "wb") as out:
                while chunk := file.file.read(1024 * 1024):
                    if _start_was_cancelled(jid):
                        raise HTTPException(status_code=409, detail="Separation start was cancelled")
                    out.write(chunk)
            actual_copy = os.path.getsize(in_path)
            update_external_output_written(reservation_id, actual_copy)
            copy_bytes = actual_copy

        duration = probe_duration(in_path)
        if _start_was_cancelled(jid):
            raise HTTPException(status_code=409, detail="Separation start was cancelled")
        if duration <= 0:
            raise HTTPException(status_code=422, detail="Cannot determine media duration")
        pcm_bytes = int(duration * 44_100 * 2 * 2)
        # Peak scratch: optional uploaded source + normalized WAV + two stems.
        peak_bytes = max(1, copy_bytes) + pcm_bytes * 3 + safety
        reserve_external_output(
            reservation_id,
            peak_bytes,
            shutil.disk_usage(work).free,
            volume,
            counts_toward_jobs_quota=True,
            store_path=work,
        )

        job = SepJob(
            id=jid,
            out_dir=work,
            _reservation_id=reservation_id,
        )
        with _JOBS_LOCK:
            if jid in _CANCELLED_STARTS:
                raise HTTPException(status_code=409, detail="Separation start was cancelled")
            JOBS[jid] = job
        job.save()
        _run(job, in_path, work)
        return {"jobId": jid}
    except QuotaExceeded as e:
        rollback_setup()
        raise HTTPException(status_code=413, detail=str(e)) from None
    except InsufficientSpace as e:
        rollback_setup()
        raise HTTPException(status_code=507, detail=str(e)) from None
    except Exception:
        rollback_setup()
        raise


@router.post("")
def start_separation(
    file: UploadFile | None = File(None),
    sourcePath: str = Form(""),
    requestId: str = Form(""),
) -> dict:
    requestId = requestId if isinstance(requestId, str) else ""
    if requestId and not re.fullmatch(r"[0-9a-f]{32}", requestId):
        raise HTTPException(status_code=422, detail="requestId must be 32 lowercase hex characters")
    # Stable request ids make response-loss retries return the same job. The
    # expensive body runs in FastAPI's sync threadpool, so serializing duplicate
    # starts does not block the event loop.
    if requestId:
        with _START_LOCK:
            return _start_separation_locked(file, sourcePath, requestId)
    return _start_separation_locked(file, sourcePath, requestId)


def start_separation_from_path(source_path: str, request_id: str) -> dict:
    """Internal stable-id entry point for workflows that already own media.

    This avoids uploading a multi-GB source back through HTTP.
    The same request id returns the existing running/completed job, so repeated
    exports reuse the stem rather than running Demucs again.
    """
    if not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise ValueError("request_id must be 32 lowercase hex characters")
    with _START_LOCK:
        return _start_separation_locked(None, source_path, request_id)


def completed_stem_path(job_id: str, stem: str) -> str | None:
    """Return a completed local stem path without exposing it over the API."""
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None or job.status != "done":
            return None
        path = {"vocals": job.vocals, "music": job.music}.get(stem)
        # Treat use by a downstream workflow as recent so the >MAX_JOBS pruner
        # chooses older terminal stems first.
        JOBS.pop(job_id, None)
        JOBS[job_id] = job
    return path if path and os.path.isfile(path) else None


def separation_job_state(job_id: str) -> str | None:
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        return job.status if job is not None else None


def discard_completed_stem(job_id: str, stem: str) -> None:
    """Delete an unneeded cached stem after a workflow selected its counterpart."""
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None or job.status != "done":
            return
        path = {"vocals": job.vocals, "music": job.music}.get(stem)
        if stem == "vocals":
            job.vocals = None
        elif stem == "music":
            job.music = None
        else:
            return
        job.save()
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def release_separation_job(job_id: str) -> None:
    """Cancel or delete a cached job no longer owned by its parent workflow."""
    proc = None
    terminal_dir = ""
    defer_release = False
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        if job.status == "running":
            job.status = "cancelled"
            proc = job._proc
            job._proc = None
            job.save()
        else:
            from ..export.integrity import is_path_leased

            if any(
                path and is_path_leased(path)
                for path in (job.vocals, job.music)
            ):
                # An export already owns the stem. Terminalize the cache entry
                # now so it cannot be reused, but retain bytes until that lease
                # is released. Persisting cancelled also makes restart cleanup
                # reclaim it if the process exits before the reaper runs.
                job.status = "cancelled"
                job._release_pending = True
                job.save()
                if job_id not in _PENDING_RELEASES:
                    _PENDING_RELEASES.add(job_id)
                    defer_release = True
            else:
                terminal_dir = job.out_dir
                JOBS.pop(job_id, None)
    if proc is not None:
        kill_process_tree(proc)
    if terminal_dir:
        safe_rmtree_jobdir(terminal_dir)
        delete_job_row(job_id)
    if defer_release:
        threading.Thread(
            target=_release_after_leases,
            args=(job_id, job),
            daemon=True,
        ).start()


def _release_after_leases(job_id: str, expected: SepJob) -> None:
    """Deferred terminal cleanup for stems held by an active export lease."""
    from ..export.integrity import is_path_leased

    while True:
        with _JOBS_LOCK:
            current = JOBS.get(job_id)
            if current is not expected:
                _PENDING_RELEASES.discard(job_id)
                return
            leased = any(
                path and is_path_leased(path)
                for path in (current.vocals, current.music)
            )
            if not leased:
                JOBS.pop(job_id, None)
                _PENDING_RELEASES.discard(job_id)
                terminal_dir = current.out_dir
                break
        time.sleep(0.5)
    safe_rmtree_jobdir(terminal_dir)
    delete_job_row(job_id)


@router.get("/{job_id}")
async def separation_status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public()


@router.post("/{job_id}/cancel")
def separation_cancel(job_id: str) -> dict:
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None and re.fullmatch(r"[0-9a-f]{32}", job_id):
            # The client knows the stable id before the multipart upload/start
            # response completes. Tombstone it so a racing start cannot launch.
            _remember_cancelled_start(job_id)
    if not job:
        if re.fullmatch(r"[0-9a-f]{32}", job_id):
            return {"ok": True}
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "running":
        # Mark first so process_runner cancel_check / GPU waiters exit; then
        # tree-kill any live demucs/ffmpeg root (CUDA children reaped on Windows
        # via taskkill /T, POSIX process group).
        job.status = "cancelled"
        job.save()
        proc = job._proc
        if proc is not None:
            kill_process_tree(proc)
            job._proc = None
    return {"ok": True}


def shutdown_active_jobs() -> int:
    """Cancel every active separation without holding the registry lock."""
    with _JOBS_LOCK:
        job_ids = [
            job_id for job_id, job in JOBS.items() if job.status == "running"
        ]
    for job_id in job_ids:
        # ``separation_cancel`` marks the durable row before tree-killing, so a
        # restart never restores a shutdown-interrupted Demucs job as running.
        separation_cancel(job_id)
    return len(job_ids)


@router.get("/{job_id}/download/{stem}")
async def separation_download(job_id: str, stem: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "done":
        raise HTTPException(status_code=409, detail=f"Not ready (status: {job.status})")
    path = {"vocals": job.vocals, "music": job.music}.get(stem)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(path, media_type="audio/wav", filename=f"{stem}.wav")
