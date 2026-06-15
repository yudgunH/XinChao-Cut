"""In-memory export job registry + background FFmpeg runner with progress.

Job state is mirrored into a small SQLite database (``{work_dir}/jobs.db``) so
it survives a backend restart: finished jobs keep answering status polls and
their outputs stay downloadable, while jobs that were running when the server
died are marked failed with an explanatory error (their ffmpeg/demucs child
process died with the server — re-running from scratch is the only resume).
Persistence is best-effort: a broken DB never blocks the actual job.
"""
from __future__ import annotations

import logging
import os
import re
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

log = logging.getLogger(__name__)

MAX_JOBS = 20  # keep at most this many finished jobs (older ones are pruned)

# Process-global gate: at most ONE heavy media job (export / proxy / separate)
# runs at a time. They all saturate CPU and/or GPU (ffmpeg filtergraph, NVENC,
# demucs inference); running two together just thrashes caches + VRAM and makes
# BOTH slower, so serialising finishes the first sooner at no loss in total
# throughput. A second job's worker blocks here until the first releases — its
# status stays "running" (pct 0) while queued, which the frontend shows as
# "starting". Transcription is deliberately NOT gated: it's a synchronous
# request with a hard timeout (queueing could blow it) and already serialises
# itself via transcribe.py's _busy guard.
HEAVY_JOB_SEMAPHORE = threading.BoundedSemaphore(1)

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


def init_and_sweep() -> None:
    """Startup pass over the persisted jobs.

    Any job still marked running belonged to the previous process — its child
    encoder died with it, so fail it with a clear message (polling clients see
    an actionable error instead of a 404). Then prune old rows past MAX_JOBS.
    """
    try:
        with _db() as c:
            c.execute(
                "UPDATE jobs SET status='error', error=?, updated_at=? WHERE status='running'",
                (_RESTART_MSG, time.time()),
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
    except Exception as e:  # noqa: BLE001
        log.warning("Job DB sweep failed: %s", e)


# ── In-memory registry (holds the live process handle) ──────────────────────


@dataclass
class Job:
    id: str
    duration: float
    out_path: str
    status: str = "running"          # running | done | error | cancelled
    pct: float = 0.0
    error: Optional[str] = None
    kind: str = "export"             # export | proxy
    _proc: Optional[subprocess.Popen] = field(default=None, repr=False)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "pct": round(self.pct, 1),
            "error": self.error,
        }

    def save(self) -> None:
        persist_job(
            id=self.id, kind=self.kind, status=self.status, pct=self.pct,
            error=self.error, duration=self.duration, out_path=self.out_path,
            keep_dir=os.path.dirname(self.out_path) if self.out_path else "",
        )


JOBS: dict[str, Job] = {}


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


def _prune() -> None:
    """Drop the oldest finished jobs (and their output dirs) past MAX_JOBS."""
    if len(JOBS) <= MAX_JOBS:
        return
    for jid in list(JOBS.keys()):
        if len(JOBS) <= MAX_JOBS:
            break
        job = JOBS[jid]
        if job.status == "running":
            continue
        if job.out_path:
            safe_rmtree_jobdir(os.path.dirname(job.out_path))
        del JOBS[jid]
        delete_job_row(jid)


def create_job(duration: float, out_path: str, kind: str = "export") -> Job:
    _prune()
    job = Job(id=uuid.uuid4().hex[:12], duration=max(0.01, duration),
              out_path=out_path, kind=kind)
    JOBS[job.id] = job
    job.save()
    return job


def get_job(job_id: str) -> Optional[Job]:
    return JOBS.get(job_id)


def cancel_job(job_id: str) -> bool:
    job = JOBS.get(job_id)
    if job and job.status == "running":
        # _proc may be None if the job is still queued behind the heavy-job
        # semaphore; mark it cancelled so its worker bails before starting
        # ffmpeg. If it's already running, terminate the process too.
        if job._proc:
            job._proc.terminate()
        job.status = "cancelled"
        job.save()
        return True
    return False


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


def run_job(job: Job, cmd: list[str], cwd: str) -> None:
    """Spawn a background thread that runs ffmpeg and updates job.pct."""
    # Insert progress reporting right after the binary.
    full = [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]]

    def worker() -> None:
        # Serialise against other heavy jobs (blocks here while one is running).
        HEAVY_JOB_SEMAPHORE.acquire()
        try:
            # Cancelled while queued behind another job → never start ffmpeg.
            if job.status == "cancelled":
                return
            proc = subprocess.Popen(
                full, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1,
            )
            job._proc = proc
            # Cancel could have raced in after the queue check but before _proc
            # was set (so cancel_job couldn't kill it) — re-check and kill now.
            if job.status == "cancelled":
                proc.terminate()
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
            for line in proc.stdout:
                m = _OUT_TIME_US.search(line)
                secs = None
                if m:
                    secs = int(m.group(1)) / 1_000_000
                else:
                    m2 = _OUT_TIME.search(line)
                    if m2:
                        secs = int(m2.group(1)) * 3600 + int(m2.group(2)) * 60 + float(m2.group(3))
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
            if job.status == "cancelled":
                return
            if code == 0:
                job.pct = 100.0
                job.status = "done"
            else:
                job.status = "error"
                job.error = ("".join(err_tail))[-1500:] or f"ffmpeg exited {code}"
            job.save()
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            job.error = str(e)[:1500]
            job.save()
        finally:
            HEAVY_JOB_SEMAPHORE.release()

    threading.Thread(target=worker, daemon=True).start()


# persist_job / delete_job_row / load_rows are also used by separate.py —
# one shared jobs.db covers every heavy-job kind.
