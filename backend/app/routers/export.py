"""Server-side export: build an FFmpeg command from the timeline and run it."""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import get_settings
from ..ffmpeg_utils import ffmpeg_available
from ..export.ffmpeg_build import build_command
from ..export.job import create_job, get_job, run_job, cancel_job, preempt_proxies
from ..utils import resolve_source_path
from .assets import asset_path

router = APIRouter(prefix="/export", tags=["export"])


# ── Request schema ──────────────────────────────────────────────────────────
# `extra="allow"` keeps every field the frontend sends (transform / adjust /
# effects / textData / opacity / volume / hasAudio / muted / denoise …) so
# `model_dump()` reproduces the exact dict `build_command` already reads — we get
# validation of the scalars that cause cryptic failures without having to model
# (and risk dropping) the whole clip shape. Malformed requests now return a clean
# 422 with field-level errors instead of a 500 deep inside the command builder.

class ExportTrack(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    muted: bool = False


class ExportClip(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    trackId: str
    kind: str
    assetId: str | None = None
    startSec: float = 0.0
    inPointSec: float = 0.0
    outPointSec: float = 0.0
    speed: float = Field(default=1.0, gt=0)


class ExportSpec(BaseModel):
    model_config = ConfigDict(extra="allow")
    width: int = Field(gt=0, le=7680)
    height: int = Field(gt=0, le=4320)
    fps: int = Field(default=30, gt=0, le=240)
    durationSec: float = Field(gt=0)
    videoBitrateKbps: int = Field(default=8000, gt=0)
    tracks: list[ExportTrack] = Field(default_factory=list)
    clips: list[ExportClip] = Field(min_length=1)  # non-empty timeline


@router.post("")
async def start_export(spec: ExportSpec) -> dict:
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg not found on the server")

    # Plain dict for build_command (unchanged); extras survive model_dump().
    spec_data = spec.model_dump()
    clips = spec_data["clips"]

    # Resolve every referenced asset to a stored file (must be uploaded first).
    asset_paths: dict[str, str] = {}
    missing: list[str] = []
    for c in clips:
        aid = c.get("assetId")
        if not aid or aid in asset_paths:
            continue
        source_path = c.get("sourcePath")
        if source_path:
            asset_paths[aid] = resolve_source_path(str(source_path))
            continue
        p = asset_path(aid)
        if p:
            asset_paths[aid] = p
        else:
            missing.append(aid)
    if missing:
        raise HTTPException(
            status_code=409,
            detail=f"Missing {len(missing)} asset(s) on server — upload them first",
        )

    duration = spec_data["durationSec"]  # validated > 0 by the model

    job = create_job(duration, out_path="")
    # Absolute so ffmpeg (run with cwd=job_dir) resolves inputs/outputs correctly.
    job_dir = os.path.abspath(os.path.join(get_settings().work_dir, "exports", job.id))
    os.makedirs(job_dir, exist_ok=True)
    out_path = os.path.join(job_dir, "out.mp4")
    job.out_path = out_path
    job.save()  # re-persist now that the output path (job dir) is known

    try:
        cmd = build_command(spec_data, asset_paths, out_path, job_dir)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Failed to build command: {e}")

    # The user is waiting on this export — background proxies yield the
    # heavy-job semaphore instead of blocking it for minutes (they regenerate
    # automatically afterwards).
    preempt_proxies()
    run_job(job, cmd, cwd=job_dir)
    return {"jobId": job.id}


@router.get("/{job_id}")
async def export_status(job_id: str) -> dict:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public()


@router.post("/{job_id}/cancel")
async def export_cancel(job_id: str) -> dict:
    if not get_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    cancel_job(job_id)
    return {"ok": True}


@router.get("/{job_id}/download")
async def export_download(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "done" or not os.path.exists(job.out_path):
        raise HTTPException(status_code=409, detail=f"Not ready (status: {job.status})")
    return FileResponse(job.out_path, media_type="video/mp4", filename="export.mp4")
