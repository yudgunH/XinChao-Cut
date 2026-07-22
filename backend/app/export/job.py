"""In-memory export job registry + background FFmpeg runner with progress.

Job state is mirrored into a small SQLite database (``{work_dir}/jobs.db``) so
it survives a backend restart: finished jobs keep answering status polls and
their outputs stay downloadable, while jobs that were running when the server
died are marked failed with an explanatory error (their ffmpeg/demucs child
process died with the server — re-running from scratch is the only resume).
Persistence is best-effort: a broken DB never blocks the actual job.
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator, Optional

from ..config import get_settings
from ..process_watchdog import iter_process_lines
from ..resource_coordinator import (
    HEAVY_JOB_SEMAPHORE,  # noqa: F401 - compatibility re-export for media/metrics
    AcquireCancelledError,
    ResourceKind,
    resource_guard,
)

log = logging.getLogger(__name__)

MAX_JOBS = 20  # keep at most this many finished jobs (older ones are pruned)
_KILL_USES_WINDOWS = os.name == "nt"

# HEAVY_JOB_SEMAPHORE is a façade over the unified ResourceCoordinator.
# Editor export, proxy creation, Demucs, ASR and TTS share one heavy-work pool.

_OUT_TIME_US = re.compile(r"out_time_us=(\d+)")
_OUT_TIME = re.compile(r"out_time=(\d+):(\d+):(\d+\.\d+)")

# ── SQLite persistence layer ────────────────────────────────────────────────

_RESTART_MSG = (
    "The server restarted while this job was running — its encoder process "
    "was lost. Start the job again."
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,            -- export | proxy | separate
  status     TEXT NOT NULL,            -- running | done | error | cancelled
  pct        REAL NOT NULL DEFAULT 0,
  error      TEXT,
  duration   REAL NOT NULL DEFAULT 0,
  out_path   TEXT NOT NULL DEFAULT '',
  keep_dir   TEXT NOT NULL DEFAULT '', -- output dir to preserve across restarts
  extra      TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
)
"""


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    path = os.path.abspath(os.path.join(get_settings().work_dir, "jobs.db"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        with conn:  # one transaction per call site
            yield conn
    finally:
        conn.close()


def persist_job(
    *, id: str, kind: str, status: str, pct: float, error: Optional[str],
    duration: float, out_path: str, keep_dir: str, extra: str = "{}",
    strict: bool = False,
) -> None:
    """Upsert one job row. Best-effort — failures are logged, never raised."""
    try:
        now = time.time()
        with _db() as c:
            c.execute(
                """INSERT INTO jobs (id, kind, status, pct, error, duration,
                                     out_path, keep_dir, extra, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     status=excluded.status, pct=excluded.pct, error=excluded.error,
                     out_path=excluded.out_path, keep_dir=excluded.keep_dir,
                     extra=excluded.extra, updated_at=excluded.updated_at""",
                (id, kind, status, pct, error, duration, out_path, keep_dir,
                 extra, now, now),
            )
    except Exception as e:  # noqa: BLE001
        log.warning("Job persistence failed for %s: %s", id, e)
        if strict:
            raise


def delete_job_row(job_id: str) -> None:
    try:
        with _db() as c:
            c.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    except Exception as e:  # noqa: BLE001
        log.warning("Job row delete failed for %s: %s", job_id, e)


def load_rows(kinds: tuple[str, ...]) -> list[dict]:
    try:
        with _db() as c:
            marks = ",".join("?" * len(kinds))
            rows = c.execute(f"SELECT * FROM jobs WHERE kind IN ({marks})", kinds).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:  # noqa: BLE001
        log.warning("Job rows load failed: %s", e)
        return []


def _job_dir_for_kind(work: str, kind: str, jid: str) -> str:
    """Canonical scratch dir under work_dir for a job kind (export | proxy)."""
    if not jid:
        return ""
    if kind == "proxy":
        return os.path.join(work, "proxies", jid)
    if kind == "export":
        return os.path.join(work, "exports", jid)
    return ""


def _parse_job_extra(raw: str | None) -> dict:
    try:
        data = json.loads(raw or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _published_output_after_crash(row: dict) -> bool:
    """True only for the narrow crash window after atomic publish, before save.

    The last persisted setup/running snapshot still names the sibling temp and
    says the final path was exclusively reserved. Atomic publish removes that
    temp and leaves a non-empty final. Requiring all three facts avoids treating
    an in-progress/legacy direct write as a completed export.
    """
    extra = _parse_job_extra(row.get("extra"))
    temp_path = str(extra.get("temp_path") or "").strip()
    final_path = str(row.get("out_path") or "").strip()
    if not bool(extra.get("reserved_out")) or not temp_path or not final_path:
        return False
    if os.path.abspath(temp_path) == os.path.abspath(final_path):
        return False
    try:
        return not os.path.exists(temp_path) and os.path.getsize(final_path) > 0
    except OSError:
        return False


def _cleanup_orphaned_job_fs(row: dict, *, published: bool = False) -> None:
    """Drop filesystem leftovers for a setup/running job abandoned by a restart.

    Rebuilds enough of a Job for ``cleanup_job_fs`` from persisted out_path /
    keep_dir / extra (job_dir, temp_path, reserved_out). Derives job_dir by
    kind when extra is missing so proxy dirs under work/proxies/<id> are reaped
    (not only work/exports/<id>).
    """
    from .integrity import cleanup_job_fs

    jid = row.get("id") or ""
    kind = row.get("kind") or "export"
    out_path = row.get("out_path") or ""
    extra = _parse_job_extra(row.get("extra"))
    work = os.path.abspath(get_settings().work_dir)

    job_dir = (extra.get("job_dir") or "").strip()
    if not job_dir:
        cand = _job_dir_for_kind(work, kind, jid)
        if cand and os.path.isdir(cand):
            job_dir = cand
    # Also honour keep_dir when it looks like the job scratch folder.
    keep = (row.get("keep_dir") or "").strip()
    if not job_dir and keep and os.path.isdir(keep):
        # keep_dir is dirname(out_path) — for proxy/export that's the job dir.
        if jid and (os.path.basename(os.path.abspath(keep)) == jid or kind == "proxy"):
            job_dir = os.path.abspath(keep)

    temp_path = (extra.get("temp_path") or "").strip()
    if not temp_path and job_dir:
        for name in ("proxy.part.mp4", "render.part.mp4"):
            cand_temp = os.path.join(job_dir, name)
            if os.path.isfile(cand_temp):
                temp_path = cand_temp
                break

    reserved = bool(extra.get("reserved_out")) if "reserved_out" in extra else bool(out_path)

    pseudo = Job(
        id=jid or "orphan",
        duration=float(row.get("duration") or 0) or 0.01,
        out_path=out_path,
        status="done" if published else "error",
        kind=kind,
        error=None if published else _RESTART_MSG,
        job_dir=job_dir,
        temp_path=temp_path,
        reserved_out=reserved,
        external_reservation_id=str(extra.get("external_reservation_id") or ""),
        cleanup_paths=[
            str(path) for path in (extra.get("cleanup_paths") or []) if path
        ],
    )
    try:
        cleanup_job_fs(pseudo, success=published)
    except Exception:  # noqa: BLE001
        log.debug("orphan cleanup_job_fs failed for %s", jid, exc_info=True)
    if not published and pseudo.job_dir:
        safe_rmtree_jobdir(pseudo.job_dir)
    # If job_dir wasn't set but keep_dir/out parent still exists for this id, drop it.
    elif (
        not published
        and keep
        and jid
        and os.path.basename(os.path.abspath(keep)) == jid
    ):
        safe_rmtree_jobdir(keep)


def init_and_sweep() -> None:
    """Startup pass over the persisted jobs.

    Any job still marked ``running`` *or* ``setup`` belonged to the previous
    process — its child encoder (if any) died with it, and a kill mid-setup
    leaves a zero-byte O_EXCL reservation forever unless we reclaim it. Fail
    both states with a clear message, cleanup FS, then prune past MAX_JOBS.
    """
    try:
        abandoned: list[dict] = []
        with _db() as c:
            # Snapshot rows before status rewrite so we still know out_path/etc.
            abandoned = [
                dict(r)
                for r in c.execute(
                    "SELECT * FROM jobs WHERE status IN ('running', 'setup')"
                ).fetchall()
            ]
            now = time.time()
            for row in abandoned:
                if _published_output_after_crash(row):
                    c.execute(
                        "UPDATE jobs SET status='done', pct=100, error=NULL, updated_at=? "
                        "WHERE id=? AND status IN ('running', 'setup')",
                        (now, row["id"]),
                    )
                else:
                    c.execute(
                        "UPDATE jobs SET status='error', error=?, updated_at=? "
                        "WHERE id=? AND status IN ('running', 'setup')",
                        (_RESTART_MSG, now, row["id"]),
                    )
            # Materialise the keep-set in Python first: a DELETE whose subquery
            # selects from the same table it deletes from is non-deterministic in
            # SQLite (the subquery is re-evaluated against the shrinking table and
            # can cascade-delete almost everything).
            keep = [
                r[0] for r in c.execute(
                    "SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?", (MAX_JOBS,)
                ).fetchall()
            ]
            if keep:
                marks = ",".join("?" * len(keep))
                c.execute(f"DELETE FROM jobs WHERE id NOT IN ({marks})", keep)
        for row in abandoned:
            try:
                _cleanup_orphaned_job_fs(
                    row,
                    published=_published_output_after_crash(row),
                )
            except Exception:  # noqa: BLE001
                log.warning(
                    "Orphan job FS cleanup failed for %s",
                    row.get("id"),
                    exc_info=True,
                )
    except Exception as e:  # noqa: BLE001
        log.warning("Job DB sweep failed: %s", e)


# ── In-memory registry (holds the live process handle) ──────────────────────


@dataclass
class Job:
    id: str
    duration: float
    out_path: str
    status: str = "running"          # setup | running | done | error | cancelled
    pct: float = 0.0
    error: Optional[str] = None
    kind: str = "export"             # export | proxy
    started_at: float = 0.0          # epoch when ffmpeg actually started (for ETA)
    # How the render is wired (encoder/decode/path) — surfaced so "why is CPU high?"
    # is answerable: NVENC encode + CPU compositor vs libx264 fallback, fast vs general.
    diag: dict = field(default_factory=dict)
    # S11 integrity: temp render target, job scratch dir, asset leases.
    temp_path: str = ""
    job_dir: str = ""
    leased_paths: list = field(default_factory=list)
    reserved_out: bool = False       # out_path was O_EXCL-reserved by this job
    # Estimated output size reserved against the jobs quota / free space while
    # this job is setup|running. Aggregate uses *remaining* reservation
    # max(0, est_bytes - bytes already on temp/out) so disk free (which already
    # shrinks as temp grows) is not double-counted against the full estimate.
    # No explicit release: only setup|running jobs are counted.
    est_bytes: int = 0
    # Stable identifier of the filesystem volume that will hold the render temp
    # and final output. Free-space reservations are aggregated per volume.
    est_volume: str = ""
    # True when the final output lands in the app jobs store (work_dir/exports).
    # External user folders only compete for free space on their volume, not the
    # XINCHAO_JOBS_QUOTA_MB jobs-store budget.
    est_counts_jobs_quota: bool = True
    # Cross-volume sources cannot be hardlinked into job_dir/inputs and must be
    # copied. Reserve that scratch separately on the work volume so concurrent
    # setup requests cannot jointly fill it before ffmpeg even starts.
    est_scratch_bytes: int = 0
    scratch_volume: str = ""
    # Hybrid Browser Export transfers ownership of the direct-stream disk
    # reservation to this FFmpeg job. Keep it until publish/cancel/failure so
    # the uploaded video-only file and final mux cannot jointly fill the volume.
    external_reservation_id: str = ""
    # Owned files outside job_dir (notably the sibling browser video upload).
    # Persisted so restart recovery removes multi-GB scratch as well.
    cleanup_paths: list[str] = field(default_factory=list)
    _proc: Optional[subprocess.Popen] = field(default=None, repr=False)
    # Linearizes cancel against final publish/cleanup.
    _lifecycle_lock: threading.RLock = field(
        default_factory=threading.RLock, repr=False, compare=False,
    )

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "pct": round(self.pct, 1),
            "error": self.error,
            "diag": self.diag,
        }

    def save(self, *, strict: bool = False) -> None:
        # Persist job_dir/temp/reserved so startup recovery can clean proxy dirs
        # (kind=proxy lives under work/proxies/<id>, not exports/<id>).
        extra = json.dumps({
            "job_dir": self.job_dir or "",
            "temp_path": self.temp_path or "",
            "reserved_out": bool(self.reserved_out),
            "est_bytes": max(0, int(self.est_bytes or 0)),
            "est_volume": self.est_volume or "",
            "external_reservation_id": self.external_reservation_id or "",
            "cleanup_paths": list(self.cleanup_paths or []),
        })
        persist_job(
            id=self.id, kind=self.kind, status=self.status, pct=self.pct,
            error=self.error, duration=self.duration, out_path=self.out_path,
            keep_dir=(
                self.job_dir
                or (os.path.dirname(self.out_path) if self.out_path else "")
            ),
            extra=extra,
            strict=strict,
        )


JOBS: dict[str, Job] = {}
# Guards structural changes to JOBS (insert / delete / iterate-during-mutation).
# A single-key `.get()` is left unlocked — GIL makes it atomic and we never mix
# it with a mutation on the same key. Never held across ffmpeg / rmtree calls:
# snapshot the targets under the lock, then act outside it.
_JOBS_LOCK = threading.Lock()


@dataclass
class _ExternalOutputReservation:
    volume: str
    estimated_bytes: int
    written_bytes: int = 0
    counts_jobs_quota: bool = False
    store_path: str = ""


# Direct browser streams do not have Job rows, but they compete for the exact
# same filesystem bytes. Keep them under the jobs lock so admission is atomic
# across browser-stream and FFmpeg exports.
_EXTERNAL_OUTPUT_RESERVATIONS: dict[str, _ExternalOutputReservation] = {}
# Finished job directories are immutable. Cache their recursively-computed size
# by directory identity/ctime so each start does not re-walk a retained store.
_TERMINAL_DIR_SIZE_CACHE: dict[str, tuple[tuple[int, int, int], int]] = {}
_TERMINAL_DIR_SIZE_CACHE_LOCK = threading.Lock()


def restore_into_memory() -> set[str]:
    """Reload export/proxy jobs from the DB into JOBS (after init_and_sweep).

    Returns the set of output dirs that must survive the startup cleanup —
    i.e. the dirs of completed jobs whose files are still downloadable.
    """
    keep: set[str] = set()
    for r in load_rows(("export", "proxy")):
        job = Job(
            id=r["id"], duration=r["duration"], out_path=r["out_path"],
            status=r["status"], pct=r["pct"], error=r["error"], kind=r["kind"],
        )
        with _JOBS_LOCK:
            JOBS[job.id] = job
        if job.status == "done" and r["keep_dir"]:
            keep.add(os.path.abspath(r["keep_dir"]))
    if JOBS:
        log.info("Restored %d persisted job(s) (%d output dir(s) kept)", len(JOBS), len(keep))
    return keep


def safe_rmtree_jobdir(target: str) -> None:
    """Remove a job's output dir — but NEVER the work dir itself or anything at
    or above it. A job output path is always work_dir/<kind>/<id>/...; if a
    shallow out_path ever made the dir resolve to the work dir, an unguarded
    rmtree would wipe the persistent assets/, models/ and jobs.db with it."""
    if not target:
        return
    work = os.path.abspath(get_settings().work_dir)
    t = os.path.abspath(target)
    if t == work or not t.startswith(work + os.sep):
        log.warning("Refusing to delete non-job path during cleanup: %s", t)
        return
    shutil.rmtree(t, ignore_errors=True)


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _running_job_dirs() -> set[str]:
    """Output dirs of jobs that are currently running/queued (any kind) — must
    never be evicted mid-job. Registries are imported lazily to avoid cycles."""
    dirs: set[str] = set()
    try:
        for j in list(JOBS.values()):
            if j.status in ("running", "setup") and j.out_path:
                dirs.add(os.path.abspath(os.path.dirname(j.out_path)))
    except Exception:  # noqa: BLE001
        pass
    try:
        from ..routers.separate import JOBS as sep_jobs
        for j in list(sep_jobs.values()):
            if getattr(j, "status", "") == "running" and getattr(j, "out_dir", ""):
                dirs.add(os.path.abspath(j.out_dir))
    except Exception:  # noqa: BLE001
        pass
    try:
        from ..routers.tts import JOBS as tts_jobs
        for j in list(tts_jobs.values()):
            running = j.read_progress().get("status") in (
                "queued", "loading", "running", "cancelling"
            )
            if running and getattr(j, "out_dir", ""):
                dirs.add(os.path.abspath(j.out_dir))
    except Exception:  # noqa: BLE001
        pass
    return dirs


# Just-finished job dirs must survive the post-render cleanup_job_dirs() so the
# client can download (status=done then 404 was the bug when output > quota).
JOB_DIR_GRACE_SEC = 15 * 60


def jobs_quota_bytes() -> int:
    """Configured jobs store cap in bytes (0 = unlimited)."""
    s = get_settings()
    if s.jobs_quota_mb and s.jobs_quota_mb > 0:
        return int(s.jobs_quota_mb) * 1024 * 1024
    return 0


def assert_output_fits_jobs_quota(estimated_bytes: int) -> None:
    """Raise ValueError when a single output cannot fit the jobs quota.

    Called before long encodes when size is known/estimated so we fail clearly
    instead of reporting done and then LRU-deleting the file.
    """
    quota = jobs_quota_bytes()
    if quota <= 0 or estimated_bytes <= 0:
        return
    if estimated_bytes > quota:
        raise ValueError(
            f"Output (~{estimated_bytes // (1024**2)} MB) exceeds the jobs store "
            f"quota ({quota // (1024**2)} MB). Raise XINCHAO_JOBS_QUOTA_MB or free space."
        )


class QuotaExceeded(ValueError):
    """Aggregate output reservation would exceed the jobs quota."""


class InsufficientSpace(ValueError):
    """Aggregate output reservation would exceed free disk space."""


def _path_size_bytes(path: str) -> int:
    """Bytes already occupying disk for a file (0 if missing / unreadable)."""
    if not path:
        return 0
    try:
        if os.path.isfile(path):
            return max(0, int(os.path.getsize(path)))
    except OSError:
        return 0
    return 0


def _job_written_bytes(job: Job) -> int:
    """Bytes this job has already written (temp preferred, else reserved out).

    ``disk_usage().free`` already reflects these; reservation remaining must
    subtract them so we do not double-count against free space.
    """
    written = _path_size_bytes(getattr(job, "temp_path", "") or "")
    if written > 0:
        return written
    return _path_size_bytes(getattr(job, "out_path", "") or "")


def remaining_reservation_bytes(job: Job, written: int | None = None) -> int:
    """Reservation still outstanding: max(0, est − bytes already on disk)."""
    est = max(0, int(job.est_bytes or 0))
    w = _job_written_bytes(job) if written is None else max(0, int(written))
    return max(0, est - w)


def _snapshot_active_written() -> dict[str, int]:
    """Stat temp/out sizes outside the jobs lock (I/O can be slow)."""
    with _JOBS_LOCK:
        targets = [
            (j.id, j.temp_path or "", j.out_path or "")
            for j in JOBS.values()
            if j.status in ("setup", "running")
        ]
    out: dict[str, int] = {}
    for jid, temp, outp in targets:
        n = _path_size_bytes(temp)
        if n <= 0:
            n = _path_size_bytes(outp)
        out[jid] = n
    return out


def _snapshot_active_scratch_written() -> dict[str, int]:
    """Snapshot copied input bytes outside the jobs lock."""
    with _JOBS_LOCK:
        targets = [
            (j.id, os.path.join(j.job_dir, "inputs") if j.job_dir else "")
            for j in JOBS.values()
            if j.status in ("setup", "running") and j.est_scratch_bytes > 0
        ]
    return {jid: _dir_size(path) if path and os.path.isdir(path) else 0 for jid, path in targets}


def _jobs_store_committed_snapshot() -> tuple[int, dict[str, int]]:
    """Return terminal/store bytes plus active-dir sizes excluded from that total.

    Active internal exports are represented by their full estimate during quota
    admission, not by their partially written directory. Finished outputs and
    other retained job kinds still consume the configured jobs-store budget.
    """
    with _JOBS_LOCK:
        active_dirs = {
            j.id: os.path.abspath(j.job_dir)
            for j in JOBS.values()
            if j.status in ("setup", "running") and j.job_dir
        }
        active_dirs.update({
            reservation_id: os.path.abspath(reservation.store_path)
            for reservation_id, reservation in _EXTERNAL_OUTPUT_RESERVATIONS.items()
            if reservation.counts_jobs_quota and reservation.store_path
        })
    raw_total = 0
    active_sizes: dict[str, int] = {}
    work = os.path.abspath(get_settings().work_dir)
    by_path = {os.path.normcase(path): jid for jid, path in active_dirs.items()}
    seen_terminal: set[str] = set()
    for sub in ("exports", "proxies", "separate", "tts"):
        top = os.path.join(work, sub)
        if not os.path.isdir(top):
            continue
        for entry in os.scandir(top):
            if not entry.is_dir():
                continue
            path = os.path.abspath(entry.path)
            jid = by_path.get(os.path.normcase(path))
            if jid is not None:
                # Active content changes while rendering; never cache it.
                size = _dir_size(path)
                active_sizes[jid] = size
            else:
                seen_terminal.add(path)
                try:
                    stat = entry.stat()
                    # Identity + ctime is stable across repeated reads on
                    # Windows (directory mtime may settle lazily after writes)
                    # and changes when the directory is recreated/mutated.
                    stamp = (stat.st_dev, stat.st_ino, stat.st_ctime_ns)
                except OSError:
                    stamp = (-1, -1, -1)
                with _TERMINAL_DIR_SIZE_CACHE_LOCK:
                    cached = _TERMINAL_DIR_SIZE_CACHE.get(path)
                if cached is not None and cached[0] == stamp:
                    size = cached[1]
                else:
                    size = _dir_size(path)
                    with _TERMINAL_DIR_SIZE_CACHE_LOCK:
                        _TERMINAL_DIR_SIZE_CACHE[path] = (stamp, size)
                raw_total += size
    with _TERMINAL_DIR_SIZE_CACHE_LOCK:
        for path in list(_TERMINAL_DIR_SIZE_CACHE):
            if path.startswith(work + os.sep) and path not in seen_terminal:
                _TERMINAL_DIR_SIZE_CACHE.pop(path, None)
        while len(_TERMINAL_DIR_SIZE_CACHE) > 5000:
            _TERMINAL_DIR_SIZE_CACHE.pop(next(iter(_TERMINAL_DIR_SIZE_CACHE)))
    return raw_total, active_sizes


def _active_remaining_bytes_locked(
    written_snap: dict[str, int],
    *,
    volume: str | None = None,
    jobs_quota_only: bool = False,
) -> int:
    """Sum remaining reservations for active jobs.

    Caller holds ``_JOBS_LOCK``. ``written_snap`` was taken outside the lock.
    - ``volume=None`` + ``jobs_quota_only=True`` → jobs-store budget (internal only).
    - ``volume=<key>`` → free-space admission on that filesystem.
    """
    total = 0
    for j in JOBS.values():
        if j.status not in ("setup", "running"):
            continue
        if volume is not None and j.est_volume != volume:
            continue
        if jobs_quota_only and not getattr(j, "est_counts_jobs_quota", True):
            continue
        total += remaining_reservation_bytes(j, written_snap.get(j.id, 0))
    return total


def _active_scratch_remaining_locked(
    written_snap: dict[str, int], *, volume: str | None = None,
) -> int:
    """Remaining cross-volume input-copy reservations for active exports."""
    total = 0
    for j in JOBS.values():
        if j.status not in ("setup", "running"):
            continue
        if volume is not None and j.scratch_volume != volume:
            continue
        total += max(0, int(j.est_scratch_bytes or 0) - written_snap.get(j.id, 0))
    return total


def _active_reserved_bytes_locked(volume: str | None = None) -> int:
    """Backward-compatible helper: remaining reservations (stats under lock).

    Prefer :func:`reserve_export_quota` which snapshots written sizes outside
    the lock. Kept for callers/tests that still use the old name.
    """
    written = {j.id: _job_written_bytes(j) for j in JOBS.values() if j.status in ("setup", "running")}
    return _active_remaining_bytes_locked(written, volume=volume, jobs_quota_only=False)


def _external_remaining_bytes_locked(volume: str | None = None) -> int:
    return sum(
        max(0, reservation.estimated_bytes - reservation.written_bytes)
        for reservation in _EXTERNAL_OUTPUT_RESERVATIONS.values()
        if volume is None or reservation.volume == volume
    )


def reserve_external_output(
    reservation_id: str,
    estimated_bytes: int,
    free_bytes: int | None,
    volume: str,
    *,
    initial_written_bytes: int = 0,
    counts_toward_jobs_quota: bool = False,
    store_path: str = "",
) -> None:
    """Atomically reserve a non-Job output against every active export."""
    if estimated_bytes <= 0:
        estimated_bytes = 1
    initial_written_bytes = max(0, min(int(initial_written_bytes), estimated_bytes))
    output_written = _snapshot_active_written()
    scratch_written = _snapshot_active_scratch_written()
    quota = jobs_quota_bytes()
    committed_bytes, excluded_active_dirs = (
        _jobs_store_committed_snapshot()
        if counts_toward_jobs_quota and quota > 0
        else (0, {})
    )
    with _JOBS_LOCK:
        existing = _EXTERNAL_OUTPUT_RESERVATIONS.get(reservation_id)
        if existing is not None:
            if (
                existing.volume != volume
                or existing.counts_jobs_quota != bool(counts_toward_jobs_quota)
                or os.path.normcase(existing.store_path or "")
                != os.path.normcase(os.path.abspath(store_path) if store_path else "")
            ):
                raise ValueError("external export reservation id was reused")
            if estimated_bytes <= existing.estimated_bytes:
                existing.written_bytes = max(existing.written_bytes, initial_written_bytes)
                return
            additional = estimated_bytes - existing.estimated_bytes
        else:
            # Recovery runs after the partial file has already consumed disk.
            # Admit only its remaining reservation, but retain the full estimate
            # in the ledger so subsequent accounting remains unchanged.
            additional = max(0, estimated_bytes - initial_written_bytes)
        required = (
            _active_remaining_bytes_locked(output_written, volume=volume)
            + _active_scratch_remaining_locked(scratch_written, volume=volume)
            + _external_remaining_bytes_locked(volume)
            + additional
        )
        if free_bytes is not None and required > max(0, free_bytes):
            raise InsufficientSpace(
                "This browser export plus remaining in-flight exports on the same "
                f"volume (~{required // (1024**2)} MB still needed) exceeds free "
                f"space ({free_bytes // (1024**2)} MB)."
            )
        if counts_toward_jobs_quota and quota > 0:
            for jid, size in excluded_active_dirs.items():
                live_job = JOBS.get(jid)
                live_external = _EXTERNAL_OUTPUT_RESERVATIONS.get(jid)
                if not (
                    (live_job is not None and live_job.status in ("setup", "running"))
                    or (live_external is not None and live_external.counts_jobs_quota)
                ):
                    committed_bytes += size
            active_jobs = sum(
                max(0, int(job.est_bytes or 0))
                for job in JOBS.values()
                if job.status in ("setup", "running")
                and getattr(job, "est_counts_jobs_quota", True)
            )
            active_external = sum(
                reservation.estimated_bytes
                for rid, reservation in _EXTERNAL_OUTPUT_RESERVATIONS.items()
                if reservation.counts_jobs_quota and rid != reservation_id
            )
            quota_total = committed_bytes + active_jobs + active_external + estimated_bytes
            if quota_total > quota:
                raise QuotaExceeded(
                    f"This job (~{estimated_bytes // (1024**2)} MB) plus retained and "
                    f"in-flight job data exceeds the jobs quota ({quota // (1024**2)} MB)."
                )
        if existing is not None:
            existing.estimated_bytes = estimated_bytes
        else:
            _EXTERNAL_OUTPUT_RESERVATIONS[reservation_id] = _ExternalOutputReservation(
                volume=volume,
                estimated_bytes=estimated_bytes,
                written_bytes=initial_written_bytes,
                counts_jobs_quota=bool(counts_toward_jobs_quota),
                store_path=os.path.abspath(store_path) if store_path else "",
            )


def update_external_output_written(reservation_id: str, written_bytes: int) -> None:
    with _JOBS_LOCK:
        reservation = _EXTERNAL_OUTPUT_RESERVATIONS.get(reservation_id)
        if reservation is not None:
            reservation.written_bytes = max(
                reservation.written_bytes, max(0, int(written_bytes))
            )


def release_external_output(reservation_id: str) -> None:
    with _JOBS_LOCK:
        _EXTERNAL_OUTPUT_RESERVATIONS.pop(reservation_id, None)


def reserve_export_quota(
    job_id: str,
    estimated_bytes: int,
    free_bytes: int | None = None,
    volume: str = "",
    *,
    counts_toward_jobs_quota: bool = True,
) -> None:
    """Atomically reserve `estimated_bytes` for `job_id` against BOTH the jobs
    quota (internal store only) and free disk on the destination volume.

    In-flight jobs contribute only their *remaining* estimate
    ``max(0, est − written_temp)`` so free space (already reduced by bytes on
    disk) is not double-counted against the original full estimate.

    Serialized on _JOBS_LOCK so two exports that each fit alone can't both pass
    and then together overrun (#4). Raises QuotaExceeded / InsufficientSpace on
    failure (caller maps to 413 / 507) after clearing this job's reservation.
    """
    if estimated_bytes <= 0:
        return

    # Stat temp sizes outside the lock; re-check under lock with the snapshot.
    written_snap = _snapshot_active_written()
    scratch_written = _snapshot_active_scratch_written()
    quota = jobs_quota_bytes()
    committed_bytes, excluded_active_dirs = (
        _jobs_store_committed_snapshot()
        if counts_toward_jobs_quota and quota > 0
        else (0, {})
    )

    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.est_bytes = estimated_bytes
        job.est_volume = volume
        job.est_counts_jobs_quota = bool(counts_toward_jobs_quota)
        # This job has not written yet at reserve time.
        written_snap[job_id] = written_snap.get(job_id, 0)

        # Jobs-store quota is a logical cap on the eventual stored outputs. Bytes
        # already written to temp still belong to that output and MUST remain in
        # the total. Only free-space admission below uses remaining bytes.
        # If an active job completed while the filesystem snapshot was being
        # taken, put its captured directory back into committed usage.
        for jid, size in excluded_active_dirs.items():
            live = JOBS.get(jid)
            if live is None or live.status not in ("setup", "running"):
                committed_bytes += size
        quota_total = committed_bytes + sum(
            max(0, int(j.est_bytes or 0))
            for j in JOBS.values()
            if j.status in ("setup", "running")
            and getattr(j, "est_counts_jobs_quota", True)
        )
        if quota > 0 and counts_toward_jobs_quota and quota_total > quota:
            job.est_bytes = 0
            job.est_volume = ""
            job.est_counts_jobs_quota = True
            others = quota_total - estimated_bytes
            raise QuotaExceeded(
                f"This export (~{estimated_bytes // (1024**2)} MB) plus "
                f"{max(0, others) // (1024**2)} MB still reserved by "
                f"in-flight exports exceeds the jobs quota ({quota // (1024**2)} MB). "
                "Wait for a running export to finish or raise XINCHAO_JOBS_QUOTA_MB."
            )

        # Free space: all in-flight work on the same volume, remaining est only.
        if free_bytes is not None:
            output_remaining = (
                _active_remaining_bytes_locked(written_snap, volume=volume)
                if volume
                else _active_remaining_bytes_locked(written_snap)
            )
            scratch_remaining = (
                _active_scratch_remaining_locked(scratch_written, volume=volume)
                if volume
                else _active_scratch_remaining_locked(scratch_written)
            )
            volume_total = output_remaining + scratch_remaining
            volume_total += _external_remaining_bytes_locked(volume if volume else None)
            if volume_total > max(0, free_bytes):
                job.est_bytes = 0
                job.est_volume = ""
                job.est_counts_jobs_quota = True
                raise InsufficientSpace(
                    f"This export plus remaining in-flight exports on the same volume "
                    f"(~{volume_total // (1024**2)} MB still needed) "
                    f"exceeds free space ({free_bytes // (1024**2)} MB). "
                    "Free some disk or wait for a running export to finish."
                )


def reserve_export_scratch(
    job_id: str,
    estimated_bytes: int,
    free_bytes: int | None,
    volume: str,
) -> None:
    """Atomically reserve cross-volume input-copy scratch on the work volume.

    Output and scratch reservations share the same admission total when they
    land on the same filesystem. Written bytes are subtracted because current
    disk free already reflects them.
    """
    if estimated_bytes <= 0:
        return
    output_written = _snapshot_active_written()
    scratch_written = _snapshot_active_scratch_written()
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.est_scratch_bytes = max(0, int(estimated_bytes))
        job.scratch_volume = volume
        scratch_written[job_id] = scratch_written.get(job_id, 0)
        if free_bytes is None:
            return
        total = _active_remaining_bytes_locked(output_written, volume=volume)
        total += _active_scratch_remaining_locked(scratch_written, volume=volume)
        total += _external_remaining_bytes_locked(volume)
        if total > max(0, free_bytes):
            job.est_scratch_bytes = 0
            job.scratch_volume = ""
            raise InsufficientSpace(
                f"Input snapshots plus remaining exports on the work volume "
                f"(~{total // (1024**2)} MB still needed) exceed free space "
                f"({free_bytes // (1024**2)} MB). Free disk space or move the "
                "work directory before exporting."
            )


def cleanup_job_dirs() -> int:
    """Enforce TTL + size quota on finished job output dirs under
    work/{exports,proxies,separate,tts} (LRU by mtime), mirroring the asset-store
    hygiene. Skips dirs of jobs still running and dirs inside the grace window.
    Returns how many dirs were removed. Persistent dirs (models, hf-cache,
    voices, assets, jobs.db) are never touched."""
    s = get_settings()
    work = os.path.abspath(s.work_dir)
    protected = _running_job_dirs()

    entries: list[tuple[str, float, int]] = []
    for sub in ("exports", "proxies", "separate", "tts"):
        top = os.path.join(work, sub)
        if not os.path.isdir(top):
            continue
        for e in os.scandir(top):
            if not e.is_dir():
                continue
            p = os.path.abspath(e.path)
            if p in protected:
                continue
            try:
                mtime = e.stat().st_mtime
            except OSError:
                continue
            entries.append((p, mtime, _dir_size(p)))

    now = time.time()
    removed = 0

    def drop(path: str, mtime: float) -> bool:
        # Grace: never evict a brand-new finished job (client may still download).
        if now - mtime < JOB_DIR_GRACE_SEC:
            return False
        safe_rmtree_jobdir(path)
        jid = os.path.basename(path)
        with _JOBS_LOCK:
            JOBS.pop(jid, None)
        delete_job_row(jid)
        return True

    # TTL pass — finished job dirs older than the configured age.
    if s.jobs_ttl_days > 0:
        cutoff = now - s.jobs_ttl_days * 86400
        kept: list[tuple[str, float, int]] = []
        for p, mtime, size in entries:
            if mtime < cutoff and drop(p, mtime):
                removed += 1
            else:
                kept.append((p, mtime, size))
        entries = kept

    # Quota pass — evict oldest until the total is back under the cap.
    if s.jobs_quota_mb > 0:
        quota = s.jobs_quota_mb * 1024 * 1024
        total = sum(sz for _p, _m, sz in entries)
        if total > quota:
            for p, mtime, size in sorted(entries, key=lambda e: e[1]):
                if total <= quota:
                    break
                if drop(p, mtime):
                    total -= size
                    removed += 1

    if removed:
        log.info("Job-dir cleanup: evicted %d finished job dir(s)", removed)
    return removed


def _prune() -> None:
    """Drop the oldest finished jobs (and their output dirs) past MAX_JOBS."""
    # Pick + evict the victims under the lock; do the filesystem/DB work outside.
    victims: list[tuple[str, str]] = []
    with _JOBS_LOCK:
        if len(JOBS) <= MAX_JOBS:
            return
        for jid in list(JOBS.keys()):
            if len(JOBS) <= MAX_JOBS:
                break
            job = JOBS[jid]
            if job.status in ("running", "setup"):
                continue
            victims.append((jid, os.path.dirname(job.out_path) if job.out_path else ""))
            del JOBS[jid]
    for jid, out_dir in victims:
        if out_dir:
            safe_rmtree_jobdir(out_dir)
        delete_job_row(jid)


def create_job(
    duration: float,
    out_path: str,
    kind: str = "export",
    *,
    status: str = "running",
    job_id: str | None = None,
    job_dir: str = "",
    temp_path: str = "",
    reserved_out: bool = False,
    external_reservation_id: str = "",
    cleanup_paths: list[str] | None = None,
    leased_paths: list[str] | None = None,
) -> Job:
    """Create a complete first job row.

    Export setup uses ``status='setup'`` until queue succeeds. Filesystem
    ownership may be supplied here so the *first* durable row is sufficient for
    restart cleanup; persisting an empty row and patching these fields later
    leaves an unrecoverable crash window during Browser-to-Hybrid transfer.
    """
    _prune()
    job = Job(
        id=job_id or uuid.uuid4().hex[:12],
        duration=max(0.01, duration),
        out_path=out_path,
        kind=kind,
        status=status,
        job_dir=job_dir,
        temp_path=temp_path,
        reserved_out=reserved_out,
        external_reservation_id=external_reservation_id,
        cleanup_paths=list(cleanup_paths or []),
        leased_paths=list(leased_paths or []),
    )
    job.save(strict=True)
    with _JOBS_LOCK:
        JOBS[job.id] = job
    return job


def persisted_job_status(job_id: str, kind: str = "export") -> str | None:
    """Return the durable status without requiring the in-memory restore pass."""
    if not job_id:
        return None
    with _db() as c:
        row = c.execute(
            "SELECT status FROM jobs WHERE id=? AND kind=? LIMIT 1",
            (job_id, kind),
        ).fetchone()
    return str(row[0]) if row is not None else None


def load_persisted_job(job_id: str, kind: str = "export") -> Job | None:
    """Load one durable job during the short startup window before RAM restore."""
    if not job_id:
        return None
    with _db() as c:
        row = c.execute(
            "SELECT * FROM jobs WHERE id=? AND kind=? LIMIT 1",
            (job_id, kind),
        ).fetchone()
    if row is None:
        return None
    return Job(
        id=str(row["id"]),
        duration=float(row["duration"] or 0.01),
        out_path=str(row["out_path"] or ""),
        status=str(row["status"]),
        pct=float(row["pct"] or 0.0),
        error=row["error"],
        kind=str(row["kind"]),
    )


def fail_job_setup(job: Job, error: str) -> None:
    """Terminalize a job that never reached the worker (no ghost running)."""
    from .integrity import cleanup_job_fs

    job.status = "error"
    job.error = (error or "setup failed")[:1500]
    cleanup_job_fs(job, success=False)
    # Drop scratch job dir under work_dir/exports/<id> when present.
    if job.job_dir:
        safe_rmtree_jobdir(job.job_dir)
        job.job_dir = ""
    job.save()


def get_job(job_id: str) -> Optional[Job]:
    return JOBS.get(job_id)


def _kill_proc_tree(proc: subprocess.Popen) -> None:
    """Kill ffmpeg AND any children. On Windows a bare terminate() can leave a
    wedged encoder holding the GPU/file; taskkill /T /F takes the whole tree."""
    if _KILL_USES_WINDOWS:
        # The shared implementation snapshots descendants and has a native
        # TerminateProcess fallback. ``taskkill`` can return Access denied under
        # restricted desktop tokens while still exiting with no exception.
        from ..process_runner import kill_process_tree

        kill_process_tree(proc)
        return

    # run_job starts a fresh session, so the Python chunk supervisor and its
    # current FFmpeg child share one process group. The group can outlive its
    # leader: waiting only for `proc` is therefore insufficient.
    pgid = proc.pid
    try:
        os.killpg(pgid, signal.SIGTERM)
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=3)
    except Exception:  # noqa: BLE001
        pass
    try:
        os.killpg(pgid, 0)
    except (ProcessLookupError, PermissionError):
        return
    except OSError:
        return
    try:
        os.killpg(pgid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass


def cancel_job(job_id: str) -> bool:
    job = JOBS.get(job_id)
    if not job:
        return False
    with job._lifecycle_lock:
        if job.status not in ("running", "setup"):
            return False
        # _proc may be None if the job is still queued behind the resource
        # coordinator; mark cancelled + wake the waiter so it never takes a
        # permit. If already running, kill the whole process tree.
        job.status = "cancelled"
        cancel_ev = getattr(job, "_cancel_event", None)
        if cancel_ev is not None:
            cancel_ev.set()
        if job._proc:
            try:
                _kill_proc_tree(job._proc)
            finally:
                job._proc = None
        from .integrity import cleanup_job_fs
        cleanup_job_fs(job, success=False)
        job.save()
        return True


def cancel_active_jobs() -> int:
    """Cancel every queued/running export or proxy during process shutdown.

    Take only a structural snapshot under ``_JOBS_LOCK``; ``cancel_job`` owns
    each job's lifecycle lock and may perform process-tree/FS cleanup, so doing
    that work while holding the registry lock would create a shutdown deadlock.
    """
    with _JOBS_LOCK:
        job_ids = [
            job_id
            for job_id, job in JOBS.items()
            if job.status in ("setup", "running")
        ]
    return sum(1 for job_id in job_ids if cancel_job(job_id))


def preempt_proxies() -> int:
    """Cancel every running/queued preview-proxy job. Called when an export
    starts: the user is actively waiting on the export, while proxies are a
    background nicety — without this, an export queued behind a long proxy at
    the heavy-job semaphore sits at 0% for minutes. The frontend's proxy
    backfill simply regenerates the proxy later. Returns how many were cancelled."""
    n = 0
    for jid, job in list(JOBS.items()):
        if job.kind == "proxy" and job.status == "running":
            if cancel_job(jid):
                n += 1
    if n:
        log.info("Export preempted %d background proxy job(s)", n)
    return n


def run_job(
    job: Job,
    cmd: list[str],
    cwd: str,
    *,
    inject_progress_args: bool = True,
    resource_kind: ResourceKind = ResourceKind.HW_ENCODER,
) -> None:
    """Spawn a background thread that runs ffmpeg and updates job.pct."""
    # Chunked export uses a Python supervisor which already emits a synthetic
    # FFmpeg progress stream, so only direct ffmpeg commands receive these args.
    full = (
        [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]]
        if inject_progress_args else list(cmd)
    )

    def worker() -> None:
        # Unified coordinator: serialise against TTS/ASR and other heavy
        # jobs. cancel_event wakes the FIFO waiter without leaking a permit.
        cancel_ev = getattr(job, "_cancel_event", None) or threading.Event()
        job._cancel_event = cancel_ev  # type: ignore[attr-defined]
        try:
            with resource_guard(
                resource_kind,
                cancel_event=cancel_ev,
                owner=f"export:{job.id}:{job.kind}",
            ) as permit:
                # Cancelled while queued behind another job → never start ffmpeg.
                if job.status == "cancelled":
                    from .integrity import cleanup_job_fs
                    cleanup_job_fs(job, success=False)
                    job.save()
                    return
                # Leave setup → running only when the worker actually holds the permit.
                if job.status == "setup":
                    job.status = "running"
                    job.save()
                job.started_at = time.time()  # ffmpeg starts now → anchor ETA here
                popen_kwargs = {
                    "cwd": cwd,
                    "stdout": subprocess.PIPE,
                    "stderr": subprocess.PIPE,
                    "text": True,
                    "bufsize": 1,
                }
                if os.name != "nt":
                    popen_kwargs["start_new_session"] = True
                proc = subprocess.Popen(full, **popen_kwargs)
                job._proc = proc
                # Cancel could have raced in after the queue check but before _proc
                # was set (so cancel_job couldn't kill it) — re-check and kill now.
                # Must tree-kill + wait + clear handle; bare terminate() leaves
                # children holding the GPU/file while the coordinator permit drops.
                if job.status == "cancelled":
                    try:
                        _kill_proc_tree(proc)
                    finally:
                        job._proc = None
                        from .integrity import cleanup_job_fs
                        cleanup_job_fs(job, success=False)
                        job.save()
                    return
                assert proc.stdout is not None and proc.stderr is not None

                # Drain stderr concurrently — otherwise a full stderr pipe buffer
                # blocks ffmpeg while we only read stdout (classic deadlock on long
                # renders). Keep only the tail for error reporting.
                err_tail: list[str] = []

                def drain_err() -> None:
                    for line in proc.stderr:  # type: ignore[union-attr]
                        err_tail.append(line)
                        if len(err_tail) > 50:
                            del err_tail[0]

                err_thread = threading.Thread(target=drain_err, daemon=True)
                err_thread.start()

                last_saved_pct = 0.0
                code = -1
                try:
                    for line in iter_process_lines(
                        proc,
                        proc.stdout,
                        hard_timeout_sec=max(1800.0, job.duration * 50.0 + 600.0),
                        idle_timeout_sec=180.0,
                        kill=_kill_proc_tree,
                        cancel_check=lambda: job.status == "cancelled",
                    ):
                        m = _OUT_TIME_US.search(line)
                        secs = None
                        if m:
                            secs = int(m.group(1)) / 1_000_000
                        else:
                            m2 = _OUT_TIME.search(line)
                            if m2:
                                secs = (
                                    int(m2.group(1)) * 3600
                                    + int(m2.group(2)) * 60
                                    + float(m2.group(3))
                                )
                        if secs is not None:
                            job.pct = max(0.0, min(99.0, secs / job.duration * 100))
                            # Persist progress at ~1% granularity (not every line) so a
                            # restart shows roughly where the job was, without hammering
                            # the DB from the progress pipe.
                            if job.pct - last_saved_pct >= 1.0:
                                last_saved_pct = job.pct
                                job.save()
                    code = proc.wait()
                    err_thread.join(timeout=2)
                finally:
                    # Always reap the process tree if still alive (cancel mid-read,
                    # exception, or normal exit that left zombies on Windows).
                    if proc.poll() is None:
                        _kill_proc_tree(proc)
                    job._proc = None

                # Rendering is complete: release scarce GPU/heavy capacity before
                # probes, filesystem publish, cleanup, or DB persistence.
                # Some unit-test guards deliberately yield no permit object.
                if permit is not None:
                    permit.release()
                # Artifact probing can take tens of seconds on network disks. Do
                # not hold the cancellation lifecycle lock while probing.
                artifact = None
                if code == 0 and job.diag.get("validateArtifact") and job.status != "cancelled":
                    from .artifact import validate_export_artifact

                    artifact = validate_export_artifact(
                        job.temp_path or job.out_path,
                        expected_duration=job.duration,
                        expect_audio=bool(job.diag.get("expectAudio")),
                    )

                with job._lifecycle_lock:
                    if job.status == "cancelled":
                        from .integrity import cleanup_job_fs
                        cleanup_job_fs(job, success=False)
                        job.save()
                        return
                    if code == 0:
                        # Publish + terminal transition are one lifecycle commit.
                        # Cancel either wins before this scope, or observes done.
                        from .integrity import cleanup_job_fs, publish_atomic
                        try:
                            if artifact is not None:
                                job.diag = {**job.diag, "artifact": artifact}
                            if (
                                job.temp_path
                                and job.out_path
                                and os.path.abspath(job.temp_path) != os.path.abspath(job.out_path)
                            ):
                                publish_atomic(job.temp_path, job.out_path)
                                job.temp_path = ""
                            job.pct = 100.0
                            job.status = "done"
                            wall = max(0.001, time.time() - job.started_at)
                            job.diag = {
                                **job.diag,
                                "renderSec": round(wall, 1),
                                "speedX": round(job.duration / wall, 2),
                            }
                            cleanup_job_fs(job, success=True)
                        except Exception as pub_exc:  # noqa: BLE001
                            job.status = "error"
                            job.error = f"artifact/publish failed: {pub_exc}"[:1500]
                            cleanup_job_fs(job, success=False)
                    else:
                        from .integrity import cleanup_job_fs
                        job.status = "error"
                        job.error = ("".join(err_tail))[-1500:] or f"ffmpeg exited {code}"
                        cleanup_job_fs(job, success=False)
                    job.save()
                # Enforce the job-dir size quota/TTL now that the store just grew —
                # mirrors cleanup_assets() after each upload, so a long-running app
                # session can't blow past jobs_quota_mb between restarts. Skips
                # running jobs and the just-finished one (newest survives the quota).
                try:
                    cleanup_job_dirs()
                except Exception:  # noqa: BLE001
                    pass
        except AcquireCancelledError:
            # Waiter cancelled before grant — permit never held.
            from .integrity import cleanup_job_fs
            if job.status != "cancelled":
                job.status = "cancelled"
            cleanup_job_fs(job, success=False)
            job.save()
        except Exception as e:  # noqa: BLE001
            from .integrity import cleanup_job_fs
            if job.status != "cancelled":
                job.status = "error"
                job.error = str(e)[:1500]
            cleanup_job_fs(job, success=False)
            job.save()

    threading.Thread(target=worker, daemon=True).start()


# persist_job / delete_job_row / load_rows are also used by separate.py —
# one shared jobs.db covers every heavy-job kind.
