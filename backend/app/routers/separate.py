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
    HEAVY_JOB_SEMAPHORE,
    delete_job_row,
    load_rows,
    persist_job,
    safe_rmtree_jobdir,
)
from ..ffmpeg_utils import ffmpeg_available
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
    _proc: Optional[subprocess.Popen] = field(default=None, repr=False)

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
        JOBS[job.id] = job
        if job.status == "done" and job.out_dir:
            keep.add(os.path.abspath(job.out_dir))
    return keep


def _prune() -> None:
    if len(JOBS) <= MAX_JOBS:
        return
    for jid in list(JOBS.keys()):
        if len(JOBS) <= MAX_JOBS:
            break
        job = JOBS[jid]
        if job.status == "running":
            continue
        safe_rmtree_jobdir(job.out_dir)
        del JOBS[jid]
        delete_job_row(jid)


def _run(job: SepJob, in_path: str, work: str) -> None:
    """Background thread: extract audio → demucs → locate stems."""

    def worker() -> None:
        # Serialise against export/proxy/separate (one heavy job at a time).
        HEAVY_JOB_SEMAPHORE.acquire()
        try:
            # Cancelled while queued behind another job → never start work.
            if job.status == "cancelled":
                return
            # 1. Normalise to a 44.1 kHz stereo WAV so demucs always gets a
            #    format it can load (works for video inputs too).
            wav = os.path.join(work, "audio.wav")
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", in_path, "-vn", "-ac", "2", "-ar", "44100", wav],
                capture_output=True, text=True,
            )
            if r.returncode != 0 or not os.path.exists(wav):
                job.status = "error"
                job.error = (r.stderr or "ffmpeg failed to extract audio")[-1500:]
                job.save()
                return

            # 2. Two-stem separation (vocals vs the rest).
            # IMPORTANT: use sys.executable (the venv interpreter running this
            # server), NOT a bare "python" which resolves via PATH to a
            # different interpreter that may not have demucs/torch installed.
            dev = _device()
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
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
            job._proc = proc
            # Cancel could have raced in before _proc was set — re-check + kill.
            if job.status == "cancelled":
                proc.terminate()
                return
            assert proc.stdout is not None

            # Demucs writes a tqdm bar with carriage returns — read char by char
            # and flush on \r or \n to catch the live percentage. Keep a tail of
            # recent lines so a failure reports the real cause, not just a code.
            buf = ""
            tail: list[str] = []
            last_saved_pct = 0.0
            for ch in iter(lambda: proc.stdout.read(1), ""):
                if ch in "\r\n":
                    if buf.strip():
                        tail.append(buf.strip())
                        if len(tail) > 40:
                            del tail[0]
                    m = _PCT.search(buf)
                    if m:
                        job.pct = max(0.0, min(99.0, float(m.group(1))))
                        if job.pct - last_saved_pct >= 1.0:
                            last_saved_pct = job.pct
                            job.save()
                    buf = ""
                else:
                    buf += ch

            code = proc.wait()
            if job.status == "cancelled":
                return
            if code != 0:
                job.status = "error"
                job.error = ("\n".join(tail))[-1500:] or f"demucs exited with code {code}"
                job.save()
                return

            # 3. Locate the produced stems: <out>/<model>/audio/{vocals,no_vocals}.wav
            base = os.path.join(out, _MODEL, "audio")
            vocals = os.path.join(base, "vocals.wav")
            music = os.path.join(base, "no_vocals.wav")
            if not (os.path.exists(vocals) and os.path.exists(music)):
                job.status = "error"
                job.error = "Separation finished but stem files were not found"
                job.save()
                return

            job.vocals, job.music = vocals, music
            job.pct = 100.0
            job.status = "done"
            job.save()
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            job.error = str(e)[:1500]
            job.save()
        finally:
            HEAVY_JOB_SEMAPHORE.release()

    threading.Thread(target=worker, daemon=True).start()


@router.post("")
async def start_separation(
    file: UploadFile | None = File(None),
    sourcePath: str = Form(""),
) -> dict:
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg not found on the server")
    if not demucs_available():
        raise HTTPException(
            status_code=503,
            detail="Demucs is not installed on the server. Run: pip install demucs",
        )

    _prune()
    jid = uuid.uuid4().hex[:12]
    work = os.path.abspath(os.path.join(get_settings().work_dir, "separate", jid))
    os.makedirs(work, exist_ok=True)

    if sourcePath:
        in_path = resolve_source_path(sourcePath)
    elif file is not None:
        ext = os.path.splitext(file.filename or "")[1] or ".bin"
        in_path = os.path.join(work, f"input{ext}")
        with open(in_path, "wb") as out:
            shutil.copyfileobj(file.file, out)
    else:
        raise HTTPException(status_code=422, detail="Provide a file upload or sourcePath")

    job = SepJob(id=jid, out_dir=work)
    JOBS[jid] = job
    job.save()
    _run(job, in_path, work)
    return {"jobId": jid}


@router.get("/{job_id}")
async def separation_status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public()


@router.post("/{job_id}/cancel")
async def separation_cancel(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "running":
        # _proc may be None if still queued behind the heavy-job semaphore;
        # mark cancelled so the worker bails. Terminate the process if running.
        if job._proc:
            job._proc.terminate()
        job.status = "cancelled"
        job.save()
    return {"ok": True}


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
