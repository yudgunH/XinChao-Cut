"""Observability endpoint — a cheap, non-blocking snapshot of what the backend
is doing right now: job-queue depth per subsystem, GPU/VRAM usage, the shared
heavy-job semaphore, and which AI models are resident.

This exists to debug the "treo do VRAM" episodes (see CLAUDE.md memory): when a
job hangs, `/metrics` tells you at a glance whether the GPU is full, which
worker holds the heavy-job semaphore, and how deep each queue is — without
attaching a profiler or reading worker.log.

Everything here is best-effort and must NEVER block or raise: each probe is
wrapped so a missing module / unloaded torch just yields nulls. The frontend (or
`curl`) polls it like /health.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time

from fastapi import APIRouter

log = logging.getLogger(__name__)
router = APIRouter(tags=["metrics"])


def _semaphore_free(sem) -> int | None:
    """How many permits the heavy-job semaphore has left (1 = idle, 0 = a heavy
    GPU job is running). Reads the private counter best-effort — there's no public
    API and this is diagnostics only."""
    try:
        return int(getattr(sem, "_value"))
    except Exception:  # noqa: BLE001
        return None


def _vram() -> dict:
    """Per-device VRAM snapshot from torch, or {available: False} when torch /
    CUDA isn't loaded. torch.cuda.* is cheap once initialised; if torch hasn't
    been imported yet we do NOT import it here (that 10-30s cold cost belongs to
    the warm-up thread, not a metrics poll)."""
    import sys
    torch = sys.modules.get("torch")
    if torch is None:
        return _vram_from_nvidia_smi() or {"available": False, "reason": "GPU telemetry unavailable"}
    try:
        if not torch.cuda.is_available():
            return {"available": False, "reason": "no cuda device"}
        devices = []
        for i in range(torch.cuda.device_count()):
            free, total = torch.cuda.mem_get_info(i)
            props = torch.cuda.get_device_properties(i)
            devices.append({
                "index": i,
                "name": props.name,
                "totalMB": round(total / 1024 / 1024),
                "freeMB": round(free / 1024 / 1024),
                "usedMB": round((total - free) / 1024 / 1024),
                # What THIS process holds (vs other processes on the card).
                "allocatedMB": round(torch.cuda.memory_allocated(i) / 1024 / 1024),
                "reservedMB": round(torch.cuda.memory_reserved(i) / 1024 / 1024),
                "utilizationPct": round(100.0 * (total - free) / total, 1) if total else None,
            })
        return {
            "available": True,
            "devices": devices,
            # Active allocator tuning (set in app.main before torch's first
            # import) — surfaced so a before/after of allocatedMB/reservedMB
            # can be tied to the config that produced it.
            "allocConf": os.environ.get("PYTORCH_CUDA_ALLOC_CONF"),
        }
    except Exception as e:  # noqa: BLE001
        return _vram_from_nvidia_smi() or {"available": False, "reason": str(e)[:200]}


def _vram_from_nvidia_smi() -> dict | None:
    """Device-wide telemetry without importing torch into the idle backend."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.total,memory.free,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode != 0:
            return None
        devices = []
        for line in result.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) != 5:
                continue
            index, name, total, free, used = parts
            total_mb = int(total)
            used_mb = int(used)
            devices.append({
                "index": int(index),
                "name": name,
                "totalMB": total_mb,
                "freeMB": int(free),
                "usedMB": used_mb,
                "allocatedMB": 0,
                "reservedMB": 0,
                "utilizationPct": round(100.0 * used_mb / total_mb, 1) if total_mb else None,
            })
        return {"available": True, "devices": devices, "source": "nvidia-smi"} if devices else None
    except Exception:  # noqa: BLE001
        return None


def _gpu_guard() -> dict:
    """VRAM admission-gate state: free VRAM + anything currently blocked waiting
    for the card to free up (the signal that other processes are hogging the GPU)."""
    try:
        from ..gpu_guard import snapshot
        return snapshot()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def _eta_sec(started_at: float | None, pct: float | None) -> int | None:
    """Linear ETA from elapsed time and percent done. None until there's a
    meaningful sample (pct ≥ 2 and ≥1s elapsed) so the UI doesn't flash a wild
    estimate at the very start."""
    try:
        if not started_at or pct is None or pct < 2:
            return None
        elapsed = time.time() - started_at
        if elapsed < 1:
            return None
        remaining = elapsed * (100.0 - pct) / pct
        if remaining < 0 or remaining > 86400:
            return None
        return round(remaining)
    except Exception:  # noqa: BLE001
        return None


_EXPORT_LABEL = {"export": "Export video", "proxy": "Create preview proxy"}


def _active_tasks() -> list[dict]:
    """Every task actively using the GPU/CPU right now, with percent + ETA, so the
    UI can show "what's running" with a progress bar and time remaining. Each entry
    = {kind, id, label, pct, etaSec, step}."""
    tasks: list[dict] = []

    def add(kind, jid, label, pct, started_at=None, step=None):
        p = round(float(pct or 0.0), 1)
        tasks.append({
            "kind": kind, "id": jid, "label": label, "pct": p,
            "etaSec": _eta_sec(started_at, p), "step": step,
        })

    try:
        from ..export.job import JOBS
        for j in list(JOBS.values()):
            if j.status == "running":
                add(j.kind, j.id, _EXPORT_LABEL.get(j.kind, j.kind), j.pct, j.started_at)
    except Exception:  # noqa: BLE001
        pass
    try:
        from .separate import JOBS as sep
        for j in list(sep.values()):
            if j.status == "running":
                add("separate", j.id, "Separate vocals (Demucs)", j.pct, j.started_at)
    except Exception:  # noqa: BLE001
        pass
    try:
        from .media import _SCENE_JOBS
        for j in list(_SCENE_JOBS.values()):
            if j.status == "running":
                add("scenes", j.id, "Scene detection", j.pct, j.started_at)
    except Exception:  # noqa: BLE001
        pass
    try:
        from .tts import JOBS as tts_jobs
        for j in list(tts_jobs.values()):
            p = j.read_progress()
            if p.get("status") in ("queued", "loading", "running"):
                add("tts", j.id, "Voiceover (TTS)", p.get("pct", 0.0), j.started_at)
    except Exception:  # noqa: BLE001
        pass
    return tasks


def _count_by_status(values, status_attr: str = "status") -> dict:
    """Tally job statuses for an in-memory registry of dataclass jobs."""
    out: dict[str, int] = {}
    for j in list(values):
        st = getattr(j, status_attr, None) or "unknown"
        out[st] = out.get(st, 0) + 1
    return out


def _export_jobs() -> dict:
    try:
        from ..export.job import JOBS, HEAVY_JOB_SEMAPHORE
        return {
            "byStatus": _count_by_status(JOBS.values()),
            "total": len(JOBS),
            # Legacy field name kept for dashboards; value comes from the
            # unified coordinator pool (S5).
            "heavyJobSemaphoreFree": _semaphore_free(HEAVY_JOB_SEMAPHORE),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def _resource_coordinator() -> dict:
    try:
        from ..resource_coordinator import get_coordinator
        return get_coordinator().metrics()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def _separate_jobs() -> dict:
    try:
        from .separate import JOBS
        return {"byStatus": _count_by_status(JOBS.values()), "total": len(JOBS)}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def _scene_jobs() -> dict:
    try:
        from .media import _SCENE_JOBS
        return {"byStatus": _count_by_status(_SCENE_JOBS.values()), "total": len(_SCENE_JOBS)}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def _tts_state() -> dict:
    try:
        from .tts import JOBS, _WORKER_MGR
        # read_progress() is cheap (reads a small json); fall back to raw on error.
        statuses: dict[str, int] = {}
        for j in list(JOBS.values()):
            try:
                st = j.read_progress().get("status", "unknown")
            except Exception:  # noqa: BLE001
                st = "unknown"
            statuses[st] = statuses.get(st, 0) + 1
        return {
            "byStatus": statuses,
            "total": len(JOBS),
            "residentWorker": {
                "alive": bool(_WORKER_MGR._alive()),  # noqa: SLF001 — diagnostics
                "lastUsed": round(_WORKER_MGR._last_used, 1) or None,  # noqa: SLF001
            },
        }
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def _whisper_state() -> dict:
    """Whether a WhisperX ASR model is currently resident (eats VRAM) — the other
    half of the caption↔TTS VRAM tug-of-war."""
    try:
        from .import transcribe  # type: ignore
    except Exception:  # noqa: BLE001
        return {"available": False}
    try:
        # transcribe.py keeps the loaded model in a module global; probe it
        # without importing torch or touching the busy lock.
        model = getattr(transcribe, "_asr_model", None)
        last_used = getattr(transcribe, "_last_used", None)
        return {
            "available": True,
            "modelResident": model is not None,
            "lastUsed": round(last_used, 1) if isinstance(last_used, (int, float)) and last_used else None,
        }
    except Exception as e:  # noqa: BLE001
        return {"available": True, "error": str(e)[:200]}


@router.get("/metrics")
def metrics() -> dict:
    """Live snapshot of job queues + GPU usage. Non-blocking, best-effort: any
    subsystem that can't be probed returns `{error}` rather than failing the
    whole response."""
    return {
        "vram": _vram(),
        "gpuGuard": _gpu_guard(),
        "activeTasks": _active_tasks(),
        # S5: unified pool (gpu_model / hw_encoder / heavy_cpu → "heavy" by default).
        "resourceCoordinator": _resource_coordinator(),
        "jobs": {
            "export": _export_jobs(),
            "separate": _separate_jobs(),
            "scenes": _scene_jobs(),
            "tts": _tts_state(),
        },
        "models": {
            "whisper": _whisper_state(),
        },
    }
