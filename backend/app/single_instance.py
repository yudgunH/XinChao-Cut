"""Single-process guard for the backend.

Job state lives in per-process memory: `export.job.JOBS` holds the FFmpeg
`Popen` handles and cancel flags. Running the app in more than one process
therefore breaks in ways
that look like data corruption rather than a crash:

  * an export status/cancel request routed to process B returns 404, or cannot
    kill the FFmpeg child that process A actually spawned;
  * two processes can claim the same queued work and run it twice;
  * each process's startup recovery requeues `running` jobs that are still
    alive in a sibling process.

Making the queue genuinely multi-process safe needs atomic
`UPDATE ... RETURNING` claims, per-attempt leases with heartbeats, and an
out-of-process cancel channel. Until then, refuse to start a second process
instead of corrupting state silently.

The guard is an OS advisory lock on a file in the work dir. The kernel releases
it when the holding process dies, so a crash or `kill -9` never leaves a stale
lock behind (unlike a PID file).

Set ``XINCHAO_ALLOW_MULTI_PROCESS=1`` to bypass — only meaningful once the queue is
actually multi-process safe.
"""
from __future__ import annotations

import atexit
import logging
import os
import sys
from pathlib import Path

log = logging.getLogger(__name__)

_LOCK_FILENAME = "backend.lock"
_handle = None  # keep the fd alive for the process lifetime


class MultipleBackendProcesses(RuntimeError):
    """Raised at startup when another backend process already holds the lock."""


def _bypass() -> bool:
    return os.environ.get("XINCHAO_ALLOW_MULTI_PROCESS", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _lock_exclusive(fh) -> bool:
    """Try to take an exclusive, non-blocking lock. False when already held."""
    try:
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(fh) -> None:
    try:
        if sys.platform == "win32":
            import msvcrt

            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:  # noqa: BLE001 — process is going away anyway
        pass


def acquire(work_dir: str | os.PathLike[str]) -> None:
    """Claim the single-backend lock, or raise :class:`MultipleBackendProcesses`.

    Idempotent within a process: a second call is a no-op.
    """
    global _handle
    if _handle is not None:
        return
    if _bypass():
        log.warning(
            "XINCHAO_ALLOW_MULTI_PROCESS is set — skipping the single-process guard. "
            "Export cancel/status and job claims are NOT safe across processes."
        )
        return

    path = Path(work_dir)
    path.mkdir(parents=True, exist_ok=True)
    lock_path = path / _LOCK_FILENAME
    fh = open(lock_path, "a+b")
    # A byte must exist for msvcrt.locking to lock a region.
    if os.fstat(fh.fileno()).st_size == 0:
        fh.write(b"\0")
        fh.flush()
    fh.seek(0)

    if not _lock_exclusive(fh):
        fh.close()
        raise MultipleBackendProcesses(
            f"Another XinChao-Cut backend process already holds {lock_path}. "
            "Run exactly one backend process: job state (export handles, cancel "
            "flags, queue claims) is per-process, so a second worker duplicates "
            "jobs and breaks export cancel. If you launched with "
            "`uvicorn --workers N` or WEB_CONCURRENCY>1, drop it to 1."
        )

    _handle = fh
    atexit.register(release)
    log.info("Single-backend lock held: %s (pid %d)", lock_path, os.getpid())


def release() -> None:
    """Drop the lock (the OS also does this when the process exits)."""
    global _handle
    fh, _handle = _handle, None
    if fh is None:
        return
    _unlock(fh)
    try:
        fh.close()
    except OSError:
        pass


def is_held() -> bool:
    return _handle is not None
