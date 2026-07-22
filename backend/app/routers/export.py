"""Server-side export: build an FFmpeg command from the timeline and run it."""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..ffmpeg_utils import ffmpeg_available
from ..export.ffmpeg_build import build_command
from ..export.chunked import (
    benefits_from_incremental_chunks,
    build_chunk_runner_command,
    requires_chunking,
)
from ..export.hybrid import build_hybrid_command, hybrid_requires_chunking
from ..export.integrity import (
    MaterializeCancelled,
    cleanup_job_fs,
    lease_paths,
    materialize_assets,
    materialize_input,
    reserve_output_exclusive,
    release_paths,
)
from ..export.job import (
    InsufficientSpace,
    Job,
    QuotaExceeded,
    cancel_job,
    create_job,
    fail_job_setup,
    reserve_export_quota,
    reserve_export_scratch,
    reserve_external_output,
    release_external_output,
    update_external_output_written,
    get_job,
    load_persisted_job,
    persisted_job_status,
    preempt_proxies,
    run_job,
)
from ..resource_coordinator import ResourceKind
from ..utils import resolve_source_path
from .assets import asset_path

router = APIRouter(prefix="/export", tags=["export"])

_NAME_SANITIZE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_DEVICE_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_MAX_OUTPUT_STEM_CHARS = 180
_MAX_NUMBERED_NAME_PROBES = 256
_BROWSER_STREAM_MAX_CHUNK = 32 * 1024 * 1024
_BROWSER_STREAM_STALE_SEC = 24 * 3600
_BROWSER_STREAM_IDLE_SEC = 3600
_BROWSER_STREAM_NO_PROGRESS_SEC = 6 * 3600
_BROWSER_STREAM_MAX_AGE_SEC = 48 * 3600
_BROWSER_STREAM_COMPLETED_TTL_SEC = 3600
_BROWSER_STREAM_MANIFEST_VERSION = 2


def _browser_stream_payload_ceiling(estimated_bytes: int) -> int:
    """Maximum payload accepted by the chunk endpoint.

    Admission and write validation MUST use the same number. Previously the
    writer allowed 2x the estimate while disk admission reserved only estimate
    + 128 MiB, so a legitimate VBR overshoot could fill the destination volume.
    """
    return max(max(0, int(estimated_bytes)) * 2, 128 * 1024 * 1024)


@dataclass
class _BrowserStream:
    id: str
    final_path: str
    temp_path: str
    estimated_bytes: int
    hybrid_spec: dict | None = None
    asset_paths: dict[str, str] = field(default_factory=dict)
    leased_paths: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    last_progress_at: float = field(default_factory=time.time)
    progress_bytes: int = 0
    checkpoint_bytes: int = 0
    last_checkpoint_at: float = field(default_factory=time.time)
    written_ranges: list[tuple[int, int]] = field(default_factory=list)
    closed: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass(frozen=True)
class _CompletedBrowserStream:
    path: str
    expected_size: int
    job_id: str | None = None
    completed_at: float = field(default_factory=time.time)


_BROWSER_STREAMS: dict[str, _BrowserStream] = {}
_BROWSER_STREAM_COMPLETED: dict[str, _CompletedBrowserStream] = {}
_BROWSER_STREAM_CANCELLED: dict[str, float] = {}
_BROWSER_STREAMS_LOCK = threading.Lock()
_BROWSER_STREAM_START_LOCK = threading.Lock()
_EXPORT_START_LOCK = threading.Lock()
_EXPORT_START_REQUESTS: dict[str, str] = {}
_EXPORT_START_CANCELLED: dict[str, float] = {}
_EXPORT_START_STATE_LOCK = threading.Lock()


def _export_start_was_cancelled(request_id: str) -> bool:
    with _EXPORT_START_STATE_LOCK:
        return request_id in _EXPORT_START_CANCELLED


def _remember_cancelled_export_start(request_id: str) -> None:
    now = time.time()
    with _EXPORT_START_STATE_LOCK:
        _EXPORT_START_CANCELLED[request_id] = now
        cutoff = now - 48 * 3600
        for stale_id, cancelled_at in list(_EXPORT_START_CANCELLED.items()):
            if cancelled_at < cutoff:
                _EXPORT_START_CANCELLED.pop(stale_id, None)
        while len(_EXPORT_START_CANCELLED) > 1000:
            _EXPORT_START_CANCELLED.pop(next(iter(_EXPORT_START_CANCELLED)))


def _safe_basename(name: str | None) -> str:
    """A filesystem-safe '<name>.mp4' (no path separators / reserved chars)."""
    base = _NAME_SANITIZE.sub("_", (name or "").strip()).rstrip(" .") or "export"
    if base.lower().endswith(".mp4"):
        base = base[:-4].rstrip(" .") or "export"
    base = base[:_MAX_OUTPUT_STEM_CHARS].rstrip(" .") or "export"
    if base.upper() in _WINDOWS_DEVICE_NAMES:
        base = f"_{base}"
    return f"{base}.mp4"


def _unique_in_dir(directory: str, basename: str) -> str:
    """Legacy name helper used by suggest-name (read-only collision probe).

    Actual export reservations use :func:`reserve_output_exclusive` (O_EXCL).
    """
    stem, ext = os.path.splitext(basename)
    for n in range(_MAX_NUMBERED_NAME_PROBES):
        name = basename if n == 0 else f"{stem}({n}){ext}"
        candidate = os.path.join(directory, name)
        if not os.path.exists(candidate):
            return candidate
    for _ in range(16):
        candidate = os.path.join(directory, f"{stem}-{uuid.uuid4().hex[:8]}{ext}")
        if not os.path.exists(candidate):
            return candidate
    raise OSError(f"cannot suggest a free output name under {directory}")


def _resolve_output_path(output_dir: str, name: str | None) -> str:
    """Validate a user-chosen export directory and **atomically reserve** an mp4 path.

    Uses ``O_CREAT | O_EXCL`` (S11 / F14) so two concurrent exports with the same
    name never share a path. Never check-then-create alone.
    """
    raw = os.path.expanduser(output_dir.strip())
    if not os.path.isabs(raw):
        raise HTTPException(status_code=400, detail="Export folder must be an absolute path")
    d = os.path.abspath(raw)
    work = os.path.abspath(get_settings().work_dir)
    if d == work or d.startswith(work + os.sep):
        raise HTTPException(status_code=400, detail="Export folder cannot be inside the app data dir")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Cannot create export folder: {e}")
    try:
        return reserve_output_exclusive(d, _safe_basename(name))
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Cannot reserve export path: {e}")


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


#: Audio is muxed at roughly this rate; container/index overhead adds a few %.
_AUDIO_BITRATE_KBPS = 192
_CONTAINER_OVERHEAD = 1.05


def estimate_output_bytes(duration_sec: float, video_bitrate_kbps: int) -> int:
    """Rough encoded size from duration x bitrate. Used to fail fast BEFORE a
    long encode whose output could never fit (quota or free disk)."""
    if duration_sec <= 0 or video_bitrate_kbps <= 0:
        return 0
    bits = (video_bitrate_kbps + _AUDIO_BITRATE_KBPS) * 1000.0 * duration_sec
    return int(bits / 8.0 * _CONTAINER_OVERHEAD)


def _free_bytes_on_volume(path: str) -> int | None:
    """Free bytes on the volume that will hold `path` (its nearest existing
    ancestor). None when it can't be determined."""
    probe = os.path.abspath(path)
    while probe and not os.path.isdir(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


def _volume_key(path: str) -> str:
    """Stable key for the nearest existing ancestor's filesystem volume."""
    probe = os.path.abspath(path)
    while probe and not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    try:
        return f"dev:{os.stat(probe).st_dev}"
    except OSError:
        drive = os.path.splitdrive(probe)[0]
        return os.path.normcase(drive or probe)


def _reserve_output_or_413(job_id: str, estimated: int, output_dir: str | None) -> None:
    """Atomically reserve the estimated output against the jobs quota AND the free
    space of the volume that will actually hold the file (the user's export dir
    for an external output, else the work dir). Aggregates across in-flight
    exports so concurrent jobs can't jointly overrun (#4).

    External folders do not consume XINCHAO_JOBS_QUOTA_MB (jobs store); they only
    compete for free space on their destination volume.
    """
    if estimated <= 0:
        return
    target = output_dir or os.path.join(get_settings().work_dir, "exports")
    free = _free_bytes_on_volume(str(target))
    volume = _volume_key(str(target))
    # None / empty outputDir → final lives under work/exports (jobs store).
    counts_jobs = not bool(output_dir and str(output_dir).strip())
    try:
        reserve_export_quota(
            job_id,
            estimated,
            free,
            volume,
            counts_toward_jobs_quota=counts_jobs,
        )
    except QuotaExceeded as e:
        raise HTTPException(status_code=413, detail=str(e)) from None
    except InsufficientSpace as e:
        raise HTTPException(status_code=507, detail=str(e)) from None


def _cross_volume_copy_bytes(asset_paths: dict[str, str], job_dir: str) -> int:
    """Bytes that are guaranteed to be copied rather than hardlinked."""
    dest_volume = _volume_key(job_dir)
    total = 0
    for src in asset_paths.values():
        try:
            if _volume_key(src) != dest_volume:
                total += max(0, os.path.getsize(src))
        except OSError:
            # Resolution validated the path earlier; a disappearance here is
            # handled by materialize_assets. Do not invent a misleading size.
            continue
    return total


def _reserve_scratch_or_507(job_id: str, asset_paths: dict[str, str], job_dir: str) -> int:
    estimated = _cross_volume_copy_bytes(asset_paths, job_dir)
    if estimated <= 0:
        return 0
    try:
        reserve_export_scratch(
            job_id,
            estimated,
            _free_bytes_on_volume(job_dir),
            _volume_key(job_dir),
        )
    except InsufficientSpace as e:
        raise HTTPException(status_code=507, detail=str(e)) from None
    return estimated


class ExportSpec(BaseModel):
    model_config = ConfigDict(extra="allow")
    width: int = Field(gt=0, le=7680)
    height: int = Field(gt=0, le=4320)
    fps: int = Field(default=30, gt=0, le=240)
    durationSec: float = Field(gt=0)
    requestId: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    videoBitrateKbps: int = Field(default=8000, gt=0)
    qualityProfile: Literal["fast", "balanced", "quality"] = "balanced"
    audioBitrateKbps: int = Field(default=192, ge=64, le=512)
    audioMastering: Literal["off", "social", "voice"] = "off"
    videoCodec: Literal["h264", "hevc", "av1"] = "h264"
    dynamicRange: Literal["sdr", "hdr10"] = "sdr"
    tracks: list[ExportTrack] = Field(default_factory=list)
    clips: list[ExportClip] = Field(min_length=1)  # non-empty timeline


def _resolve_spec_assets(
    spec_data: dict, *, audio_only: bool = False
) -> dict[str, str]:
    """Resolve referenced content hashes/local sources to authoritative paths."""
    hidden = {t.get("id") for t in spec_data.get("tracks", []) if t.get("hidden")}
    muted = {t.get("id") for t in spec_data.get("tracks", []) if t.get("muted")}
    asset_paths: dict[str, str] = {}
    missing: list[str] = []
    for clip in spec_data.get("clips", []):
        if clip.get("trackId") in hidden:
            continue
        if audio_only and (
            clip.get("kind") not in ("video", "audio")
            or clip.get("muted")
            or clip.get("trackId") in muted
            or float(clip.get("volume", 1) or 0) <= 0
        ):
            continue
        aid = clip.get("assetId")
        if not aid or aid in asset_paths or aid in missing:
            continue
        source_path = clip.get("sourcePath")
        if source_path:
            try:
                asset_paths[aid] = resolve_source_path(str(source_path))
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=400, detail=f"Invalid sourcePath: {exc}"
                ) from None
            continue
        path = asset_path(aid)
        if path:
            asset_paths[aid] = path
        else:
            missing.append(aid)
    if missing:
        raise HTTPException(
            status_code=409,
            detail=f"Missing {len(missing)} asset(s) on server — upload them first",
        )
    return asset_paths


def _artifact_expectations(spec_data: dict, cmd: list[str]) -> dict:
    """Contract persisted on the job for the post-encode artifact gate."""
    expect_audio = any(
        cmd[index] in {"-c:a", "-codec:a"}
        for index in range(max(0, len(cmd) - 1))
    )
    return {
        "validateArtifact": True,
        "expectAudio": expect_audio,
    }


def _setup_export_job(
    job: Job,
    spec_data: dict,
    asset_paths: dict[str, str],
    clips: list[dict],
    job_dir: str,
) -> None:
    """Cancellable background setup: snapshot inputs, build command, queue ffmpeg."""
    cancel_ev = getattr(job, "_cancel_event", None)

    def cancelled() -> bool:
        return job.status == "cancelled" or bool(cancel_ev and cancel_ev.is_set())

    try:
        if cancelled():
            raise MaterializeCancelled("export setup cancelled")
        reserved_scratch = _reserve_scratch_or_507(job.id, asset_paths, job_dir)
        work_volume = _volume_key(job_dir)

        def reserve_unexpected_copy(src: str, size: int) -> None:
            nonlocal reserved_scratch
            if _volume_key(src) != work_volume:
                return
            reserved_scratch += max(0, size)
            reserve_export_scratch(
                job.id,
                reserved_scratch,
                _free_bytes_on_volume(job_dir),
                work_volume,
            )

        # Lease before the first byte is copied; asset cleanup must not remove a
        # source while setup is still materializing it.
        job.leased_paths = lease_paths(asset_paths.values())
        job.save()
        local_paths, _sources, _mat = materialize_assets(
            asset_paths,
            job_dir,
            before_copy=reserve_unexpected_copy,
            cancel_check=cancelled,
        )
        if cancelled():
            raise MaterializeCancelled("export setup cancelled")

        for f in spec_data.get("captionFonts") or []:
            if cancelled():
                raise MaterializeCancelled("export setup cancelled")
            p = asset_path(str((f or {}).get("hash") or ""))
            if not p:
                continue
            name = _NAME_SANITIZE.sub("_", os.path.basename(str(f.get("name") or "")))
            if not name:
                name = os.path.basename(p)
            fonts_dir = os.path.join(job_dir, "fonts")
            os.makedirs(fonts_dir, exist_ok=True)
            try:
                materialize_input(
                    p,
                    os.path.join(fonts_dir, name),
                    cancel_check=cancelled,
                )
            except OSError:
                pass

        cache_segment_sec = max(
            0, int(get_settings().export_chunk_cache_segment_sec)
        )
        incremental_chunks = benefits_from_incremental_chunks(
            spec_data, cache_segment_sec
        )
        chunked = requires_chunking(spec_data) or incremental_chunks
        chunks = []
        if chunked:
            # Chunk files temporarily consume roughly one final output's worth
            # of work-volume space. Include that in the aggregate reservation
            # before rendering the first byte.
            # Intermediate audio is 48 kHz stereo s16 PCM (1536 kbps), not AAC.
            # Reserve against that real peak scratch footprint.
            duration = float(spec_data["durationSec"])
            video_kbps = int(spec_data.get("videoBitrateKbps") or 0)
            chunk_bytes = int((video_kbps + 1536) * 1000 * duration / 8 * 1.10)
            reserved_scratch += chunk_bytes
            reserve_export_scratch(
                job.id,
                reserved_scratch,
                _free_bytes_on_volume(job_dir),
                work_volume,
            )
            cmd, chunks = build_chunk_runner_command(
                spec_data,
                local_paths,
                job.temp_path,
                job_dir,
                before_font_copy=reserve_unexpected_copy,
                cancel_check=cancelled,
                max_duration=(cache_segment_sec if incremental_chunks else None),
            )
        else:
            cmd = build_command(spec_data, local_paths, job.temp_path, job_dir)
        if cancelled():
            raise MaterializeCancelled("export setup cancelled")

        from ..export.ffmpeg_build import codec_family_for_encoder, detect_video_encoder
        output_encoders = [
            cmd[index + 1]
            for index in range(len(cmd) - 1)
            if cmd[index] == "-c:v"
        ]
        video_copy = bool(output_encoders and output_encoders[-1] == "copy")
        encoder = (
            "copy" if video_copy
            else output_encoders[-1] if output_encoders
            else detect_video_encoder(str(spec_data.get("videoCodec") or "h264"))
        )
        cpu_filtergraph = (
            chunked or "-filter_complex" in cmd or "-filter_complex_script" in cmd
        )
        decode = (
            "none" if video_copy
            else "per-chunk" if chunked
            else "cuvid" if any("cuvid" in a for a in cmd)
            else "hwaccel" if "-hwaccel" in cmd
            else "cpu"
        )
        fc_idx = (
            cmd.index("-filter_complex") if "-filter_complex" in cmd
            else cmd.index("-filter_complex_script") if "-filter_complex_script" in cmd
            else -1
        )
        job.diag = {
            "encoder": encoder,
            "encodeOnGpu": any(
                encoder.endswith(suffix)
                for suffix in ("_nvenc", "_qsv", "_amf", "_videotoolbox")
            ),
            "decode": decode,
            "path": (
                "chunked" if chunked else "general" if cpu_filtergraph
                else "copy" if video_copy else "fast"
            ),
            "cpuCompositor": cpu_filtergraph,
            "clips": len(clips),
            "filtergraphChars": len(cmd[fc_idx + 1]) if fc_idx >= 0 else 0,
            "inputsMaterialized": len(local_paths),
            "chunks": len(chunks),
            "videoReencoded": not video_copy,
            "videoCodec": (
                str(spec_data.get("videoCodec") or "h264")
                if video_copy else codec_family_for_encoder(encoder)
            ),
            "requestedVideoCodec": str(spec_data.get("videoCodec") or "h264"),
            "dynamicRange": str(spec_data.get("dynamicRange") or "sdr"),
            **_artifact_expectations(spec_data, cmd),
        }
        job.save()
        preempt_proxies()
        if chunked:
            run_job(job, cmd, cwd=job_dir, inject_progress_args=False)
        else:
            run_job(job, cmd, cwd=job_dir)
    except MaterializeCancelled:
        job.status = "cancelled"
        cleanup_job_fs(job, success=False)
        job.save()
    except Exception as e:  # noqa: BLE001
        if cancelled():
            job.status = "cancelled"
            cleanup_job_fs(job, success=False)
            job.save()
        else:
            detail = e.detail if isinstance(e, HTTPException) else str(e)
            fail_job_setup(job, f"Export setup failed: {detail}")


def _start_export_locked(spec: ExportSpec) -> dict:
    """Create an export job with S11 integrity transaction:

    1. Resolve assets (no job row yet for pure validation failures).
    2. Create job in ``setup`` (not worker-running).
    3. Materialize inputs into job_dir + lease sources (F13).
    4. Reserve final output with O_EXCL (F14).
    5. Build ffmpeg cmd targeting **temp** output under job_dir.
    6. On any setup error → ``fail_job_setup`` (no ghost running) (F15).
    7. Queue worker only after setup succeeds.
    """
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg not found on the server")

    if spec.requestId:
        if _export_start_was_cancelled(spec.requestId):
            raise HTTPException(status_code=409, detail="Export start was cancelled")
        existing_id = _EXPORT_START_REQUESTS.get(spec.requestId) or spec.requestId
        existing = get_job(existing_id) if existing_id else None
        if existing is None and existing_id:
            existing = load_persisted_job(existing_id)
        if existing is not None:
            return {
                "jobId": existing.id,
                "outputPath": existing.out_path if spec.model_dump().get("outputDir") else None,
            }

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
            try:
                asset_paths[aid] = resolve_source_path(str(source_path))
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"Invalid sourcePath: {e}")
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
    estimated = estimate_output_bytes(
        float(duration), int(spec_data.get("videoBitrateKbps") or 0)
    )
    output_dir = spec_data.get("outputDir")

    # F15: job starts in setup — only becomes running when the worker starts.
    job = create_job(
        duration,
        out_path="",
        status="setup",
        job_id=spec.requestId,
    )
    # Reserve output space atomically NOW that the job is registered: an output
    # that can't fit (alone OR together with other in-flight exports) is rejected
    # before the long encode, instead of a 'done' job the quota cleanup then
    # deletes / a disk-full failure at publish. Fail → drop the job row.
    try:
        _reserve_output_or_413(job.id, estimated, str(output_dir) if output_dir else None)
    except HTTPException:
        fail_job_setup(job, "Output reservation rejected")
        raise
    job_dir = os.path.abspath(os.path.join(get_settings().work_dir, "exports", job.id))
    job.job_dir = job_dir
    try:
        os.makedirs(job_dir, exist_ok=True)
    except OSError as e:
        fail_job_setup(job, f"Cannot create job dir: {e}")
        raise HTTPException(status_code=500, detail=f"Cannot create job dir: {e}")

    try:
        # Reserve the final name synchronously so the response can return the
        # exact path. Multi-GB input materialization happens after response in a
        # cancellable setup thread.
        if output_dir:
            out_path = _resolve_output_path(str(output_dir), spec_data.get("outputName"))
            job.reserved_out = True
        else:
            out_path = reserve_output_exclusive(job_dir, "out.mp4")
            job.reserved_out = True
        job.out_path = out_path
        # The temp MUST sit on the SAME volume as the final: publish is
        # os.replace(), which is atomic only within a filesystem. A user export
        # dir on D: with work_dir on C: made every cross-volume export fail at
        # publish — after the full render. Put temp next to the final instead.
        temp_path = os.path.join(
            os.path.dirname(out_path), f".render.part-{job.id}.mp4"
        )
        job.temp_path = temp_path
        job._cancel_event = threading.Event()  # type: ignore[attr-defined]
        job.save()
    except HTTPException as e:
        # Validation/reservation failures raised after create_job (for example an
        # invalid outputDir) must terminalize setup too. Otherwise the ghost job
        # remains active and its aggregate quota reservation never drops until a
        # backend restart.
        if job.status in ("setup", "running"):
            fail_job_setup(job, str(e.detail))
        raise
    except Exception as e:  # noqa: BLE001
        fail_job_setup(job, str(e))
        raise HTTPException(status_code=500, detail=f"Export setup failed: {e}")

    try:
        if spec.requestId and _export_start_was_cancelled(spec.requestId):
            cancel_job(job.id)
            raise HTTPException(status_code=409, detail="Export start was cancelled")
        threading.Thread(
            target=_setup_export_job,
            args=(job, spec_data, asset_paths, clips, job_dir),
            daemon=True,
            name=f"export-setup-{job.id}",
        ).start()
    except (RuntimeError, OSError) as e:
        fail_job_setup(job, f"Cannot start export worker: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Cannot start export worker: {e}",
        ) from None
    if spec.requestId:
        _EXPORT_START_REQUESTS[spec.requestId] = job.id
        while len(_EXPORT_START_REQUESTS) > 100:
            _EXPORT_START_REQUESTS.pop(next(iter(_EXPORT_START_REQUESTS)))
    return {"jobId": job.id, "outputPath": out_path if output_dir else None}


@router.post("")
def start_export(spec: ExportSpec) -> dict:
    # Serializing only the short setup transaction makes requestId idempotent:
    # a retry after the response was lost observes the already-created job.
    if spec.requestId:
        with _EXPORT_START_LOCK:
            return _start_export_locked(spec)
    return _start_export_locked(spec)


@router.get("/suggest-name")
def suggest_name(dir: str, name: str | None = None) -> dict:
    """Next non-colliding basename (no extension) for a folder, so the dialog can
    pre-fill '2406(1)' when '2406.mp4' already exists. Never creates the folder."""
    base = _safe_basename(name)            # e.g. "2406.mp4"
    raw = os.path.expanduser((dir or "").strip())
    if raw and os.path.isabs(raw) and os.path.isdir(os.path.abspath(raw)):
        base = os.path.basename(_unique_in_dir(os.path.abspath(raw), base))
    return {"name": base[:-4] if base.lower().endswith(".mp4") else base}


class BrowserStreamStart(BaseModel):
    outputDir: str
    outputName: str | None = None
    estimatedBytes: int = Field(default=0, ge=0)
    requestId: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    # Present only for Hybrid Export. Browser uploads video-only MP4; backend
    # later mixes this portable timeline spec and stream-copies the video.
    hybridSpec: ExportSpec | None = None


class BrowserStreamFinalize(BaseModel):
    expectedSize: int = Field(gt=0)
    videoCodec: Literal["h264", "hevc", "av1"] | None = None


def _cleanup_stale_browser_streams(directory: str) -> None:
    """Remove only our own old sibling temps and their zero-byte reservations."""
    now = time.time()
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for entry in entries:
        name = entry.name
        if not (
            entry.is_file(follow_symlinks=False)
            and name.startswith(".")
            and ".browser-" in name
            and name.endswith(".uploading")
        ):
            continue
        try:
            if now - entry.stat(follow_symlinks=False).st_mtime < _BROWSER_STREAM_STALE_SEC:
                continue
            marker = name.rfind(".browser-")
            final_name = name[1:marker]
            if not final_name or os.path.basename(final_name) != final_name:
                continue
            os.remove(entry.path)
            reservation = os.path.join(directory, final_name)
            if (
                os.path.isfile(reservation)
                and os.path.getsize(reservation) == 0
                and now - os.path.getmtime(reservation) >= _BROWSER_STREAM_STALE_SEC
            ):
                os.remove(reservation)
        except OSError:
            continue


def _prune_completed_browser_streams() -> None:
    cutoff = time.time() - _BROWSER_STREAM_COMPLETED_TTL_SEC
    with _BROWSER_STREAMS_LOCK:
        stale = [
            stream_id
            for stream_id, done in _BROWSER_STREAM_COMPLETED.items()
            if done.completed_at < cutoff or not os.path.isfile(done.path)
        ]
        for stream_id in stale:
            _BROWSER_STREAM_COMPLETED.pop(stream_id, None)
            _remove_browser_stream_manifest(stream_id)
        cancel_cutoff = time.time() - 5 * 60
        for stream_id, cancelled_at in list(_BROWSER_STREAM_CANCELLED.items()):
            if cancelled_at < cancel_cutoff:
                _BROWSER_STREAM_CANCELLED.pop(stream_id, None)


def _merge_written_range(stream: _BrowserStream, start: int, end: int) -> None:
    merged: list[tuple[int, int]] = []
    for old_start, old_end in sorted([*stream.written_ranges, (start, end)]):
        if not merged or old_start > merged[-1][1]:
            merged.append((old_start, old_end))
        else:
            prev_start, prev_end = merged[-1]
            merged[-1] = (prev_start, max(prev_end, old_end))
    stream.written_ranges = merged


def _has_complete_coverage(stream: _BrowserStream, expected_size: int) -> bool:
    return stream.written_ranges == [(0, expected_size)]


def _write_all(out, data: bytes) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        count = out.write(view[written:])
        if not count:
            raise OSError(f"short write after {written}/{len(view)} bytes")
        written += count


def _browser_stream_manifest_dir() -> str:
    return os.path.join(get_settings().work_dir, "browser-streams")


def _browser_stream_manifest_path(stream_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", stream_id):
        raise ValueError("invalid browser stream id")
    return os.path.join(_browser_stream_manifest_dir(), f"{stream_id}.json")


def _browser_stream_hybrid_spec_path(stream_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", stream_id):
        raise ValueError("invalid browser stream id")
    return os.path.join(_browser_stream_manifest_dir(), f"{stream_id}.hybrid.json")


def _write_browser_stream_hybrid_spec(stream: _BrowserStream) -> None:
    """Persist the immutable Hybrid audio contract once, outside checkpoints.

    The active manifest is rewritten after every durable media chunk. Keeping a
    multi-megabyte caption/keyframe spec in that hot file made direct output
    repeatedly serialize and fsync the entire timeline.
    """
    if stream.hybrid_spec is None:
        return
    directory = _browser_stream_manifest_dir()
    os.makedirs(directory, exist_ok=True)
    path = _browser_stream_hybrid_spec_path(stream.id)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as out:
        json.dump(stream.hybrid_spec, out, separators=(",", ":"))
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)


def _write_browser_stream_manifest(stream: _BrowserStream) -> None:
    directory = _browser_stream_manifest_dir()
    os.makedirs(directory, exist_ok=True)
    path = _browser_stream_manifest_path(stream.id)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as out:
        json.dump(
            {
                "version": _BROWSER_STREAM_MANIFEST_VERSION,
                "state": "active",
                "id": stream.id,
                "finalPath": stream.final_path,
                "tempPath": stream.temp_path,
                "createdAt": stream.created_at,
                "estimatedBytes": stream.estimated_bytes,
                "lastActivity": stream.last_activity,
                "lastProgressAt": stream.last_progress_at,
                "progressBytes": stream.progress_bytes,
                "writtenRanges": stream.written_ranges,
                "hybridSpecFile": (
                    os.path.basename(_browser_stream_hybrid_spec_path(stream.id))
                    if stream.hybrid_spec is not None
                    else None
                ),
            },
            out,
        )
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)


def _write_browser_stream_completed_manifest(
    stream: _BrowserStream, expected_size: int
) -> None:
    directory = _browser_stream_manifest_dir()
    os.makedirs(directory, exist_ok=True)
    path = _browser_stream_manifest_path(stream.id)
    temp = path + ".tmp"
    completed_at = time.time()
    with open(temp, "w", encoding="utf-8") as out:
        json.dump(
            {
                "state": "completed",
                "id": stream.id,
                "finalPath": stream.final_path,
                "expectedSize": expected_size,
                "completedAt": completed_at,
            },
            out,
        )
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)


def _remove_browser_stream_manifest(stream_id: str) -> None:
    for path_fn in (_browser_stream_manifest_path, _browser_stream_hybrid_spec_path):
        try:
            os.remove(path_fn(stream_id))
        except (OSError, ValueError):
            pass


def cleanup_orphaned_browser_stream_manifests() -> int:
    """Recover direct-stream files left by a previous backend process.

    Version-2 active manifests contain exact byte coverage (and, for Hybrid,
    reference an immutable spec sidecar), so a restarted backend can safely
    accept subsequent random-access muxer writes and finalize without forcing a
    multi-hour browser render to restart.
    """
    directory = _browser_stream_manifest_dir()
    try:
        names = os.listdir(directory)
    except OSError:
        return 0
    cleaned = 0
    for name in names:
        if not re.fullmatch(r"[0-9a-f]{32}\.json", name):
            continue
        path = os.path.join(directory, name)
        stream_id = ""
        final_path = ""
        temp_path = ""
        try:
            with open(path, encoding="utf-8") as src:
                raw = json.load(src)
            stream_id = str(raw.get("id") or "")
            final_path = os.path.abspath(str(raw.get("finalPath") or ""))
            temp_path = os.path.abspath(str(raw.get("tempPath") or ""))
            state = str(raw.get("state") or "active")
            if (
                stream_id == name[:-5]
                and state == "completed"
                and os.path.isfile(final_path)
            ):
                expected = int(raw.get("expectedSize") or os.path.getsize(final_path))
                if expected == os.path.getsize(final_path) and expected > 0:
                    with _BROWSER_STREAMS_LOCK:
                        _BROWSER_STREAM_COMPLETED[stream_id] = _CompletedBrowserStream(
                            path=final_path,
                            expected_size=expected,
                            completed_at=float(raw.get("completedAt") or time.time()),
                        )
                    continue
            expected_temp = os.path.join(
                os.path.dirname(final_path),
                f".{os.path.basename(final_path)}.browser-{stream_id}.uploading",
            )
            if (
                stream_id == name[:-5]
                and os.path.normcase(temp_path) == os.path.normcase(expected_temp)
            ):
                try:
                    durable_job_status = persisted_job_status(stream_id)
                except Exception:  # noqa: BLE001 - preserve bytes on DB uncertainty
                    # An unavailable/corrupt Job DB cannot prove which subsystem
                    # owns the upload. Leave manifest + files untouched for a
                    # later healthy restart instead of choosing a destructive
                    # owner during degraded startup.
                    continue
                if durable_job_status is not None:
                    # Hybrid finalize durably transferred this upload to a Job,
                    # but the process died before deleting the old active
                    # manifest. Never resurrect two owners with the same id.
                    # The Job restart sweep cannot resume FFmpeg, so discard its
                    # owned browser input while preserving any published final.
                    _discard_browser_stream(
                        _BrowserStream(stream_id, final_path, temp_path, 0)
                    )
                    release_external_output(stream_id)
                    _remove_browser_stream_manifest(stream_id)
                    cleaned += 1
                    continue
                if not os.path.exists(temp_path) and os.path.getsize(final_path) > 0:
                    # Crash after atomic publish but before the completed
                    # manifest/tombstone commit: infer success from the final.
                    expected = os.path.getsize(final_path)
                    done = _BrowserStream(stream_id, final_path, temp_path, expected)
                    _write_browser_stream_completed_manifest(done, expected)
                    with _BROWSER_STREAMS_LOCK:
                        _BROWSER_STREAM_COMPLETED[stream_id] = _CompletedBrowserStream(
                            path=final_path, expected_size=expected
                        )
                elif (
                    int(raw.get("version") or 0) == _BROWSER_STREAM_MANIFEST_VERSION
                    and state == "active"
                    and os.path.isfile(temp_path)
                    and os.path.isfile(final_path)
                    and os.path.getsize(final_path) == 0
                ):
                    estimated = max(0, int(raw.get("estimatedBytes") or 0))
                    file_size = os.path.getsize(temp_path)
                    ranges: list[tuple[int, int]] = []
                    for item in raw.get("writtenRanges") or []:
                        if not isinstance(item, list) or len(item) != 2:
                            raise ValueError("invalid browser stream range")
                        start, end = int(item[0]), int(item[1])
                        if start < 0 or end <= start or end > file_size:
                            raise ValueError("browser stream range exceeds temp file")
                        ranges.append((start, end))
                    restored = _BrowserStream(
                        stream_id,
                        final_path,
                        temp_path,
                        estimated,
                        created_at=float(raw.get("createdAt") or time.time()),
                    )
                    # Version-2 legacy manifests embedded the full spec. New
                    # manifests keep it in a fixed-name immutable sidecar so a
                    # checkpoint remains O(number of written ranges).
                    hybrid_raw = raw.get("hybridSpec")
                    hybrid_file = raw.get("hybridSpecFile")
                    if hybrid_raw is None and hybrid_file:
                        expected_name = f"{stream_id}.hybrid.json"
                        if hybrid_file != expected_name:
                            raise ValueError("invalid Hybrid spec sidecar name")
                        with open(
                            _browser_stream_hybrid_spec_path(stream_id),
                            encoding="utf-8",
                        ) as hybrid_src:
                            hybrid_raw = json.load(hybrid_src)
                    if hybrid_raw is not None:
                        hybrid_spec = ExportSpec.model_validate(hybrid_raw).model_dump()
                        restored.hybrid_spec = hybrid_spec
                        restored.asset_paths = _resolve_spec_assets(
                            hybrid_spec, audio_only=True
                        )
                        restored.leased_paths = lease_paths(
                            restored.asset_paths.values()
                        )
                    for start, end in ranges:
                        _merge_written_range(restored, start, end)
                    # Reject a manifest whose ranges overlap/merge differently;
                    # exact canonical coverage is required for safe finalize.
                    if restored.written_ranges != ranges:
                        raise ValueError("non-canonical browser stream ranges")
                    covered = sum(end - start for start, end in ranges)
                    if file_size > 0 and not ranges:
                        raise ValueError("browser stream has data without coverage")
                    restored.progress_bytes = covered
                    restored.checkpoint_bytes = covered
                    restored.last_checkpoint_at = time.time()
                    # Give the reconnecting renderer a fresh idle lease while
                    # retaining the original hard max-age via created_at.
                    restored.last_activity = time.time()
                    restored.last_progress_at = time.time()
                    try:
                        _reserve_browser_stream_space(
                            stream_id,
                            final_path,
                            estimated,
                            initial_written_bytes=covered,
                        )
                    except HTTPException:
                        # Valid partial, but not enough free space to resume now.
                        # Preserve both bytes and manifest for a later restart
                        # instead of converting admission failure into data loss.
                        if restored.leased_paths:
                            release_paths(restored.leased_paths)
                            restored.leased_paths = []
                        continue
                    with _BROWSER_STREAMS_LOCK:
                        _BROWSER_STREAMS[stream_id] = restored
                    continue
                else:
                    orphan = _BrowserStream(stream_id, final_path, temp_path, 0)
                    _discard_browser_stream(orphan)
                    cleaned += 1
        except Exception:  # noqa: BLE001
            # Invalid/legacy active manifests cannot be resumed safely. Only
            # delete paths that match our exact owned temp naming convention.
            if stream_id == name[:-5] and final_path and temp_path:
                expected_temp = os.path.join(
                    os.path.dirname(final_path),
                    f".{os.path.basename(final_path)}.browser-{stream_id}.uploading",
                )
                if os.path.normcase(temp_path) == os.path.normcase(expected_temp):
                    _discard_browser_stream(
                        _BrowserStream(stream_id, final_path, temp_path, 0)
                    )
                    release_external_output(stream_id)
                    cleaned += 1
        if stream_id not in _BROWSER_STREAM_COMPLETED:
            _remove_browser_stream_manifest(stream_id)
    return cleaned


def _take_browser_stream(stream_id: str) -> _BrowserStream | None:
    with _BROWSER_STREAMS_LOCK:
        return _BROWSER_STREAMS.pop(stream_id, None)


def _get_browser_stream(stream_id: str) -> _BrowserStream:
    with _BROWSER_STREAMS_LOCK:
        stream = _BROWSER_STREAMS.get(stream_id)
    if stream is None:
        raise HTTPException(status_code=404, detail="Browser export stream not found")
    return stream


def _discard_browser_stream(stream: _BrowserStream) -> None:
    for path in (stream.temp_path, stream.final_path):
        try:
            if path == stream.final_path and os.path.getsize(path) > 0:
                continue
            os.remove(path)
        except OSError:
            pass
    if stream.leased_paths:
        release_paths(stream.leased_paths)
        stream.leased_paths = []


def cleanup_active_browser_streams() -> int:
    """Cancel every live direct writer during graceful backend shutdown."""
    with _BROWSER_STREAMS_LOCK:
        streams = list(_BROWSER_STREAMS.values())
        _BROWSER_STREAMS.clear()
    for stream in streams:
        with stream.lock:
            stream.closed = True
            _discard_browser_stream(stream)
        release_external_output(stream.id)
        _remove_browser_stream_manifest(stream.id)
    return len(streams)


def sweep_idle_browser_streams(
    max_idle_sec: float = _BROWSER_STREAM_IDLE_SEC,
    max_no_progress_sec: float = _BROWSER_STREAM_NO_PROGRESS_SEC,
    max_age_sec: float = _BROWSER_STREAM_MAX_AGE_SEC,
) -> int:
    now = time.time()
    idle_cutoff = now - max_idle_sec
    progress_cutoff = now - max_no_progress_sec
    age_cutoff = now - max_age_sec
    with _BROWSER_STREAMS_LOCK:
        stale_ids = [
            stream_id
            for stream_id, stream in _BROWSER_STREAMS.items()
            if (
                stream.last_activity < idle_cutoff
                or stream.last_progress_at < progress_cutoff
                or stream.created_at < age_cutoff
            )
        ]
        streams = [_BROWSER_STREAMS.pop(stream_id) for stream_id in stale_ids]
    for stream in streams:
        with stream.lock:
            stream.closed = True
            _discard_browser_stream(stream)
        release_external_output(stream.id)
        _remove_browser_stream_manifest(stream.id)
    _prune_completed_browser_streams()
    return len(streams)


def browser_stream_watchdog(stop_event: threading.Event) -> None:
    while not stop_event.wait(300):
        try:
            sweep_idle_browser_streams()
        except Exception:  # noqa: BLE001
            pass


def _reserve_browser_stream_space(
    reservation_id: str,
    final_path: str,
    estimated_bytes: int,
    *,
    initial_written_bytes: int = 0,
) -> None:
    # Keep a fixed safety reserve so filesystem metadata/log writes still have
    # room even when the estimate is exact.
    required = _browser_stream_payload_ceiling(estimated_bytes) + 128 * 1024 * 1024
    try:
        reserve_external_output(
            reservation_id,
            required,
            _free_bytes_on_volume(final_path),
            _volume_key(final_path),
            initial_written_bytes=initial_written_bytes,
        )
    except (InsufficientSpace, ValueError) as e:
        raise HTTPException(status_code=507, detail=str(e)) from None


@router.post("/browser-stream/preflight")
def browser_stream_preflight(req: BrowserStreamStart) -> dict:
    final_path = _resolve_output_path(req.outputDir, req.outputName)
    reservation_id = f"preflight-{uuid.uuid4().hex}"
    try:
        _reserve_browser_stream_space(reservation_id, final_path, req.estimatedBytes)
        return {"ok": True, "path": final_path}
    finally:
        release_external_output(reservation_id)
        try:
            os.remove(final_path)
        except OSError:
            pass


@router.post("/browser-stream/start")
def browser_stream_start(req: BrowserStreamStart) -> dict:
    stream_id = req.requestId or uuid.uuid4().hex
    # A client may lose the response after the server committed the start. Keep
    # one stable request id across retries and serialize creation so that retrying
    # cannot reserve a second filename or create a second upload temp.
    with _BROWSER_STREAM_START_LOCK:
        _prune_completed_browser_streams()
        with _BROWSER_STREAMS_LOCK:
            if stream_id in _BROWSER_STREAM_CANCELLED:
                raise HTTPException(status_code=409, detail="Browser export start was cancelled")
            existing = _BROWSER_STREAMS.get(stream_id)
        if existing is not None:
            requested_hybrid = req.hybridSpec.model_dump() if req.hybridSpec else None
            if existing.hybrid_spec != requested_hybrid:
                raise HTTPException(
                    status_code=409,
                    detail="Browser export request id was reused with a different Hybrid spec",
                )
            return {"streamId": stream_id, "path": existing.final_path}

        hybrid_spec = req.hybridSpec.model_dump() if req.hybridSpec else None
        hybrid_asset_paths = (
            _resolve_spec_assets(hybrid_spec, audio_only=True)
            if hybrid_spec is not None
            else {}
        )

        raw = os.path.expanduser(req.outputDir.strip())
        if os.path.isabs(raw):
            _cleanup_stale_browser_streams(os.path.abspath(raw))
        final_path = _resolve_output_path(req.outputDir, req.outputName)
        try:
            _reserve_browser_stream_space(stream_id, final_path, req.estimatedBytes)
        except HTTPException:
            try:
                os.remove(final_path)
            except OSError:
                pass
            raise
        temp_path = os.path.join(
            os.path.dirname(final_path),
            f".{os.path.basename(final_path)}.browser-{stream_id}.uploading",
        )
        try:
            with open(temp_path, "xb"):
                pass
        except OSError as e:
            release_external_output(stream_id)
            try:
                os.remove(final_path)
            except OSError:
                pass
            raise HTTPException(status_code=400, detail=f"Cannot create export stream: {e}")
        stream = _BrowserStream(
            id=stream_id,
            final_path=final_path,
            temp_path=temp_path,
            estimated_bytes=req.estimatedBytes,
            hybrid_spec=hybrid_spec,
            asset_paths=hybrid_asset_paths,
            leased_paths=lease_paths(hybrid_asset_paths.values()),
        )
        try:
            _write_browser_stream_hybrid_spec(stream)
            _write_browser_stream_manifest(stream)
        except OSError as e:
            _discard_browser_stream(stream)
            release_external_output(stream_id)
            _remove_browser_stream_manifest(stream_id)
            raise HTTPException(status_code=500, detail=f"Cannot persist export stream: {e}")
        with _BROWSER_STREAMS_LOCK:
            _BROWSER_STREAMS[stream_id] = stream
        return {"streamId": stream_id, "path": final_path}


@router.put("/browser-stream/{stream_id}/chunk")
async def browser_stream_chunk(stream_id: str, request: Request, position: int) -> dict:
    if position < 0:
        raise HTTPException(status_code=422, detail="position must be non-negative")
    stream = _get_browser_stream(stream_id)
    raw_length = request.headers.get("content-length")
    if raw_length:
        try:
            if int(raw_length) > _BROWSER_STREAM_MAX_CHUNK:
                raise HTTPException(status_code=413, detail="Browser export chunk too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from None
    parts: list[bytes] = []
    total = 0
    async for part in request.stream():
        if not part:
            continue
        total += len(part)
        if total > _BROWSER_STREAM_MAX_CHUNK:
            raise HTTPException(status_code=413, detail="Browser export chunk too large")
        parts.append(bytes(part))
    data = b"".join(parts)
    if not data:
        raise HTTPException(
            status_code=413,
            detail=f"Browser export chunk must be 1..{_BROWSER_STREAM_MAX_CHUNK} bytes",
        )
    # Bound sparse writes caused by corrupt/malicious positions while retaining
    # generous headroom for VBR overshoot and inaccurate estimates.
    ceiling = _browser_stream_payload_ceiling(stream.estimated_bytes)
    if position + len(data) > ceiling:
        raise HTTPException(status_code=413, detail="Browser export exceeded reserved size envelope")
    def write_chunk() -> int:
        with stream.lock:
            if stream.closed:
                raise HTTPException(status_code=409, detail="Browser export stream is closed")
            out = open(stream.temp_path, "r+b", buffering=0)
            try:
                out.seek(position)
                _write_all(out, data)
                _merge_written_range(stream, position, position + len(data))
                now = time.time()
                stream.last_activity = now
                covered = sum(end - start for start, end in stream.written_ranges)
                if covered > stream.progress_bytes:
                    stream.progress_bytes = covered
                    stream.last_progress_at = now
                # A successful chunk response is a durability acknowledgement.
                # Persist both the media bytes and their exact random-access
                # coverage before returning it.  Delaying this checkpoint used
                # to lose up to 256 MiB of acknowledged coverage on a backend
                # crash: the bytes remained in the temp file, but recovery could
                # not safely infer whether holes had been written by the muxer.
                os.fsync(out.fileno())
                stream.checkpoint_bytes = covered
                stream.last_checkpoint_at = now
            finally:
                out.close()
            _write_browser_stream_manifest(stream)
            return covered

    try:
        written_size = await run_in_threadpool(write_chunk)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Cannot write export chunk: {e}")
    update_external_output_written(stream_id, written_size)
    return {"ok": True}


@router.post("/browser-stream/{stream_id}/heartbeat")
def browser_stream_heartbeat(stream_id: str) -> dict:
    stream = _get_browser_stream(stream_id)
    with stream.lock:
        if stream.closed:
            raise HTTPException(status_code=409, detail="Browser export stream is closed")
        # Liveness and durable byte progress are separate invariants. The client
        # only knows a muxer high-water offset (which may include queued/sparse
        # bytes); disk accounting advances exclusively after chunk write+fsync.
        stream.last_activity = time.time()
    return {"ok": True}


def _setup_hybrid_export_job(
    job: Job,
    spec_data: dict,
    asset_paths: dict[str, str],
    browser_video_path: str,
    job_dir: str,
) -> None:
    """Snapshot audio sources, then queue the audio-only final mux."""
    cancel_ev = getattr(job, "_cancel_event", None)

    def cancelled() -> bool:
        return job.status == "cancelled" or bool(cancel_ev and cancel_ev.is_set())

    try:
        if cancelled():
            raise MaterializeCancelled("Hybrid export setup cancelled")
        # Native sourcePath files already had to remain readable throughout the
        # Browser visual render. Read their audio directly instead of copying a
        # multi-GB video to work_dir after rendering. App-managed uploaded assets
        # are still hardlinked/materialized for cleanup-safe snapshot semantics.
        direct_ids = {
            str(clip.get("assetId"))
            for clip in spec_data.get("clips", [])
            if clip.get("assetId") and clip.get("sourcePath")
        }
        direct_paths = {
            aid: path for aid, path in asset_paths.items() if aid in direct_ids
        }
        snapshot_paths = {
            aid: path for aid, path in asset_paths.items() if aid not in direct_ids
        }
        reserved_scratch = _reserve_scratch_or_507(
            job.id, snapshot_paths, job_dir
        )
        work_volume = _volume_key(job_dir)

        def reserve_unexpected_copy(src: str, size: int) -> None:
            nonlocal reserved_scratch
            if _volume_key(src) != work_volume:
                return
            reserved_scratch += max(0, size)
            reserve_export_scratch(
                job.id,
                reserved_scratch,
                _free_bytes_on_volume(job_dir),
                work_volume,
            )

        # Chunked Hybrid audio writes the full timeline once as 48 kHz stereo
        # s16 PCM (~192 kB/s) on the work volume. Reserve that aggregate scratch
        # before materializing/rendering so concurrent jobs cannot fill it.
        if hybrid_requires_chunking(spec_data):
            pcm_bytes = int(
                float(spec_data.get("durationSec") or 0) * 48_000 * 2 * 2 * 1.05
            )
            reserved_scratch += max(0, pcm_bytes)
            reserve_export_scratch(
                job.id,
                reserved_scratch,
                _free_bytes_on_volume(job_dir),
                work_volume,
            )
        materialized_paths, _sources, _materialized = materialize_assets(
            snapshot_paths,
            job_dir,
            before_copy=reserve_unexpected_copy,
            cancel_check=cancelled,
        )
        local_paths = {**materialized_paths, **direct_paths}
        if cancelled():
            raise MaterializeCancelled("Hybrid export setup cancelled")
        cmd, chunk_count = build_hybrid_command(
            spec_data,
            local_paths,
            browser_video_path,
            job.temp_path,
            job_dir,
        )
        job.diag = {
            "encoder": "copy",
            "encodeOnGpu": False,
            "decode": "cpu",
            "path": "hybrid-chunked" if chunk_count else "hybrid",
            "cpuCompositor": False,
            "clips": len(spec_data.get("clips", [])),
            "chunks": chunk_count,
            "videoReencoded": False,
            "videoCodec": str(spec_data.get("videoCodec") or "h264"),
            "requestedVideoCodec": str(spec_data.get("videoCodec") or "h264"),
            "dynamicRange": "sdr",  # browser compositor is intentionally 8-bit
            **_artifact_expectations(spec_data, cmd),
        }
        job.save()
        preempt_proxies()
        run_job(
            job,
            cmd,
            cwd=job_dir,
            inject_progress_args=not bool(chunk_count),
            resource_kind=ResourceKind.HEAVY_CPU,
        )
    except MaterializeCancelled:
        job.status = "cancelled"
        cleanup_job_fs(job, success=False)
        job.save()
    except Exception as exc:  # noqa: BLE001
        if cancelled():
            job.status = "cancelled"
            cleanup_job_fs(job, success=False)
            job.save()
        else:
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            fail_job_setup(job, f"Hybrid export setup failed: {detail}")


def _queue_hybrid_export(stream: _BrowserStream, expected_size: int) -> Job:
    """Atomically transfer a finalized browser stream into an async export Job."""
    existing = get_job(stream.id)
    if existing is not None:
        return existing
    with _BROWSER_STREAMS_LOCK:
        if stream.id in _BROWSER_STREAM_CANCELLED:
            raise OSError("Browser export was cancelled during finalize")

    # The uploaded video and final mux coexist. Grow/recheck the existing direct
    # stream reservation using the actual byte count before starting FFmpeg.
    required = max(
        _browser_stream_payload_ceiling(stream.estimated_bytes) + 128 * 1024 * 1024,
        expected_size * 2 + 256 * 1024 * 1024,
    )
    try:
        reserve_external_output(
            stream.id,
            required,
            _free_bytes_on_volume(stream.final_path),
            _volume_key(stream.final_path),
            initial_written_bytes=expected_size,
        )
    except (InsufficientSpace, ValueError) as exc:
        raise OSError(str(exc)) from None

    job_dir = os.path.abspath(os.path.join(get_settings().work_dir, "exports", stream.id))
    try:
        os.makedirs(job_dir, exist_ok=True)
        job_temp_path = os.path.join(
            os.path.dirname(stream.final_path), f".render.part-{stream.id}.mp4"
        )
        job = create_job(
            float((stream.hybrid_spec or {}).get("durationSec") or 0.01),
            out_path=stream.final_path,
            status="setup",
            job_id=stream.id,
            job_dir=job_dir,
            temp_path=job_temp_path,
            reserved_out=True,
            external_reservation_id=stream.id,
            cleanup_paths=[stream.temp_path],
            leased_paths=stream.leased_paths,
        )
        stream.leased_paths = []
        job._cancel_event = threading.Event()  # type: ignore[attr-defined]
        with _BROWSER_STREAMS_LOCK:
            cancelled_during_transfer = stream.id in _BROWSER_STREAM_CANCELLED
        if cancelled_during_transfer:
            cancel_job(job.id)
            raise OSError("Browser export was cancelled during finalize")
        threading.Thread(
            target=_setup_hybrid_export_job,
            args=(
                job,
                dict(stream.hybrid_spec or {}),
                dict(stream.asset_paths),
                stream.temp_path,
                job_dir,
            ),
            daemon=True,
            name=f"hybrid-export-setup-{job.id}",
        ).start()
    except Exception as exc:  # noqa: BLE001
        job = get_job(stream.id)
        if job is not None and job.status != "cancelled":
            fail_job_setup(job, f"Cannot start Hybrid export worker: {exc}")
        raise OSError(str(exc)) from None
    return job


@router.post("/browser-stream/{stream_id}/finalize")
def browser_stream_finalize(stream_id: str, req: BrowserStreamFinalize) -> dict:
    _prune_completed_browser_streams()
    with _BROWSER_STREAMS_LOCK:
        completed = _BROWSER_STREAM_COMPLETED.get(stream_id)
    if completed is not None:
        if completed.expected_size != req.expectedSize:
            raise HTTPException(status_code=409, detail="Finalize size differs from completed stream")
        result = {"path": completed.path}
        if completed.job_id:
            result["jobId"] = completed.job_id
        return result
    existing_job = get_job(stream_id)
    if existing_job is not None:
        return {"path": existing_job.out_path, "jobId": existing_job.id}
    stream = _get_browser_stream(stream_id)
    try:
        with stream.lock:
            if stream.closed:
                # A retry can overlap the first finalize after a client-side
                # timeout. The first request holds this lock through replace,
                # so seeing the completed final here is a successful replay even
                # if it has not populated the tombstone map yet.
                try:
                    if (
                        not os.path.exists(stream.temp_path)
                        and os.path.getsize(stream.final_path) == req.expectedSize
                    ):
                        return {"path": stream.final_path}
                except OSError:
                    pass
                raise OSError("stream is already closed")
            stream.closed = True
            with open(stream.temp_path, "r+b") as out:
                if not _has_complete_coverage(stream, req.expectedSize):
                    raise OSError(
                        f"stream has incomplete byte coverage: {stream.written_ranges}"
                    )
                out.flush()
                os.fsync(out.fileno())
                actual = out.seek(0, os.SEEK_END)
            if actual != req.expectedSize:
                raise OSError(
                    f"stream size mismatch (expected {req.expectedSize}, found {actual})"
                )
            hybrid_job = None
            if stream.hybrid_spec is not None:
                if req.videoCodec:
                    # The Browser may safely fall back from HEVC/AV1 to H.264
                    # after the stream was reserved. Persist the codec actually
                    # written so Hybrid diagnostics/cache profiles never claim
                    # the requested family for a different bitstream.
                    stream.hybrid_spec["videoCodec"] = req.videoCodec
                    _write_browser_stream_hybrid_spec(stream)
                hybrid_job = _queue_hybrid_export(stream, req.expectedSize)
                _remove_browser_stream_manifest(stream.id)
            else:
                os.replace(stream.temp_path, stream.final_path)
                try:
                    _write_browser_stream_completed_manifest(stream, req.expectedSize)
                except OSError:
                    # Keep the active manifest: startup recovery recognizes
                    # temp-missing + non-empty final as a completed publish.
                    pass
    except OSError as e:
        _take_browser_stream(stream_id)
        _discard_browser_stream(stream)
        release_external_output(stream_id)
        _remove_browser_stream_manifest(stream_id)
        raise HTTPException(status_code=400, detail=f"Cannot finalize export stream: {e}")
    with _BROWSER_STREAMS_LOCK:
        _BROWSER_STREAMS.pop(stream_id, None)
        _BROWSER_STREAM_COMPLETED[stream_id] = _CompletedBrowserStream(
            path=stream.final_path,
            expected_size=req.expectedSize,
            job_id=hybrid_job.id if hybrid_job is not None else None,
        )
    if hybrid_job is None:
        release_external_output(stream_id)
        return {"path": stream.final_path}
    return {"path": stream.final_path, "jobId": hybrid_job.id}


@router.delete("/browser-stream/{stream_id}")
def browser_stream_cancel(stream_id: str) -> dict:
    with _BROWSER_STREAM_START_LOCK:
        with _BROWSER_STREAMS_LOCK:
            if re.fullmatch(r"[0-9a-f]{32}", stream_id):
                _BROWSER_STREAM_CANCELLED[stream_id] = time.time()
            stream = _BROWSER_STREAMS.get(stream_id)
        if stream is not None:
            # Do not remove the stream before taking its lifecycle lock. A
            # concurrent finalize owns this lock while transferring the same id
            # into a Job; removing first used to make DELETE miss that new job,
            # delete its input and release its reservation underneath FFmpeg.
            with stream.lock:
                with _BROWSER_STREAMS_LOCK:
                    current = _BROWSER_STREAMS.pop(stream_id, None)
                if get_job(stream_id) is not None:
                    cancel_job(stream_id)
                elif current is not None:
                    stream.closed = True
                    _discard_browser_stream(stream)
                    release_external_output(stream_id)
                    _remove_browser_stream_manifest(stream_id)
        else:
            # Finalize may already have transferred this stream into an async
            # Hybrid job. The same stable id keeps hard-cancel idempotent.
            cancel_job(stream_id)
    return {"ok": True}


@router.post("/save-local")
def export_save_local(
    file: UploadFile = File(...),
    outputDir: str = Form(...),
    outputName: str | None = Form(None),
) -> dict:
    """Write an already-rendered file (browser/WebCodecs export) straight to the
    user's chosen folder, so it doesn't have to be downloaded separately.

    ``_resolve_output_path`` already O_EXCL-reserves the final path; we stream
    into a sibling temp then atomic-replace so a crash never leaves a
    half-written name that blocks the next export forever.
    """
    out_path = _resolve_output_path(outputDir, outputName)
    tmp = out_path + f".{os.getpid()}.uploading"
    reservation_id = f"save-local-{uuid.uuid4().hex}"
    reported = max(0, int(getattr(file, "size", 0) or 0))
    fallback = max(1, int(get_settings().upload_max_bytes or 0))
    expected = reported or fallback
    try:
        try:
            reserve_external_output(
                reservation_id,
                expected + 128 * 1024 * 1024,
                _free_bytes_on_volume(out_path),
                _volume_key(out_path),
            )
        except (InsufficientSpace, ValueError) as e:
            raise HTTPException(status_code=507, detail=str(e)) from None
        written = 0
        with open(tmp, "wb") as out:
            while chunk := file.file.read(8 * 1024 * 1024):
                written += len(chunk)
                if not reported and written > fallback:
                    raise HTTPException(status_code=413, detail="Export upload exceeds configured limit")
                out.write(chunk)
                update_external_output_written(reservation_id, written)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, out_path)
    except HTTPException:
        for path in (tmp, out_path):
            try:
                os.remove(path)
            except OSError:
                pass
        raise
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        try:
            os.remove(out_path)  # drop empty reservation on failure
        except OSError:
            pass
        raise HTTPException(status_code=400, detail=f"Cannot write export: {e}")
    finally:
        release_external_output(reservation_id)
    return {"path": out_path}


@router.get("/{job_id}")
async def export_status(job_id: str) -> dict:
    # get_job is an in-memory dict lookup (the common poll path). Only the miss
    # touches sqlite, so keep that off the event loop instead of blocking it.
    job = get_job(job_id) or await run_in_threadpool(load_persisted_job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public()


@router.post("/{job_id}/cancel")
def export_cancel(job_id: str) -> dict:
    if not get_job(job_id):
        if re.fullmatch(r"[0-9a-f]{32}", job_id):
            _remember_cancelled_export_start(job_id)
            return {"ok": True}
        raise HTTPException(status_code=404, detail="Job not found")
    cancel_job(job_id)
    return {"ok": True}


@router.get("/{job_id}/download")
async def export_download(job_id: str, filename: str | None = None):
    job = get_job(job_id) or await run_in_threadpool(load_persisted_job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "done" or not os.path.exists(job.out_path):
        raise HTTPException(status_code=409, detail=f"Not ready (status: {job.status})")
    # FileResponse streams from disk and sets Content-Disposition: attachment, so
    # the client downloads via a direct anchor/navigation WITHOUT fetching the
    # whole MP4 into a renderer Blob first (P0 OOM on multi-GB exports). The
    # optional `filename` (sanitised, extension enforced) keeps the client's name.
    return FileResponse(
        job.out_path, media_type="video/mp4", filename=_safe_basename(filename)
    )
