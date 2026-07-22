"""Export job filesystem integrity (S11 / F13–F15).

Transaction pieces shared by ``routers.export`` and ``export.job``:

* **F13** — materialize inputs into ``job_dir/inputs`` (hardlink, else copy);
  refcount **leases** on source asset paths so ``cleanup_assets`` cannot delete
  inputs while a job is still queued/running.
* **F14** — reserve the final output path with ``O_CREAT | O_EXCL`` (no
  check-then-create race); render to a job-local temp and ``os.replace`` publish.
* **F15** — setup failures terminalize the job and release leases/temp/reservation
  so no ghost ``running`` row keeps a dead permit forever.

Windows notes:
* ``os.link`` works for hardlinks on NTFS same-volume (Py3.8+); cross-volume /
  non-NTFS / permission errors fall back to ``shutil.copy2``.
* Exclusive create uses ``O_CREAT | O_EXCL | O_WRONLY`` (+ ``O_BINARY`` on win).
* Locked destination files surface as ``OSError``; callers map to 400/422.
"""
from __future__ import annotations

import errno
import logging
import os
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable, Iterable

log = logging.getLogger(__name__)

# ── Asset leases (refcount) ──────────────────────────────────────────────────

_LEASE_LOCK = threading.Lock()
# abspath → outstanding lease count (running/queued export jobs holding the file)
_ASSET_LEASES: dict[str, int] = {}


def _norm(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def lease_paths(paths: Iterable[str]) -> list[str]:
    """Increment refcounts. Returns the normalized paths that were leased."""
    leased: list[str] = []
    with _LEASE_LOCK:
        for p in paths:
            if not p:
                continue
            key = _norm(p)
            _ASSET_LEASES[key] = _ASSET_LEASES.get(key, 0) + 1
            leased.append(key)
    return leased


def release_paths(paths: Iterable[str]) -> None:
    """Decrement refcounts (idempotent — never goes negative / never raises)."""
    with _LEASE_LOCK:
        for p in paths:
            if not p:
                continue
            key = _norm(p)
            n = _ASSET_LEASES.get(key, 0)
            if n <= 1:
                _ASSET_LEASES.pop(key, None)
            else:
                _ASSET_LEASES[key] = n - 1


def is_path_leased(path: str) -> bool:
    if not path:
        return False
    with _LEASE_LOCK:
        return _ASSET_LEASES.get(_norm(path), 0) > 0


def lease_count(path: str) -> int:
    if not path:
        return 0
    with _LEASE_LOCK:
        return int(_ASSET_LEASES.get(_norm(path), 0))


def reset_leases_for_tests() -> None:
    with _LEASE_LOCK:
        _ASSET_LEASES.clear()


# ── Materialize (hardlink → copy) ────────────────────────────────────────────

@dataclass
class MaterializeResult:
    local_path: str
    method: str  # "hardlink" | "copy" | "exists"


class MaterializeCancelled(RuntimeError):
    """Input snapshot copy was cancelled by the owning export job."""


def _copy_cancellable(
    src: str,
    dest: str,
    cancel_check: Callable[[], bool] | None,
) -> None:
    """Chunk-copy through a sibling temp so cancellation never leaves a partial dest."""
    tmp = dest + f".{os.getpid()}.{threading.get_ident()}.copying"
    try:
        with open(src, "rb") as inp, open(tmp, "wb") as out:
            while True:
                if cancel_check is not None and cancel_check():
                    raise MaterializeCancelled("export input copy cancelled")
                chunk = inp.read(8 * 1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        shutil.copystat(src, tmp)
        if cancel_check is not None and cancel_check():
            raise MaterializeCancelled("export input copy cancelled")
        os.replace(tmp, dest)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def materialize_input(
    src: str,
    dest: str,
    before_copy: Callable[[str, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> MaterializeResult:
    """Place ``src`` at ``dest`` via hardlink when safe, else full copy.

    Never follows a partial dest: if dest already exists with size>0, reuse it
    (idempotent retry). Empty/corrupt dest is replaced.
    """
    src = os.path.abspath(src)
    dest = os.path.abspath(dest)
    if not os.path.isfile(src):
        raise FileNotFoundError(f"export input missing: {src}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if cancel_check is not None and cancel_check():
        raise MaterializeCancelled("export input copy cancelled")

    if os.path.exists(dest):
        try:
            if os.path.getsize(dest) > 0:
                return MaterializeResult(dest, "exists")
        except OSError:
            pass
        try:
            os.remove(dest)
        except OSError:
            pass

    try:
        os.link(src, dest)
        return MaterializeResult(dest, "hardlink")
    except OSError as e:
        # Cross-volume, non-NTFS, privilege, or Windows "file exists" races.
        log.debug("hardlink %s → %s failed (%s); copying", src, dest, e)
        if before_copy is not None:
            before_copy(src, max(0, os.path.getsize(src)))
        _copy_cancellable(src, dest, cancel_check)
        return MaterializeResult(dest, "copy")


def materialize_assets(
    asset_paths: dict[str, str],
    job_dir: str,
    before_copy: Callable[[str, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[dict[str, str], list[str], list[MaterializeResult]]:
    """Copy/hardlink every asset into ``job_dir/inputs/<id><ext>``.

    Returns (local_map, source_paths_for_lease, results).
    """
    inputs_dir = os.path.join(job_dir, "inputs")
    os.makedirs(inputs_dir, exist_ok=True)
    local: dict[str, str] = {}
    sources: list[str] = []
    results: list[MaterializeResult] = []
    for aid, src in asset_paths.items():
        if cancel_check is not None and cancel_check():
            raise MaterializeCancelled("export input copy cancelled")
        src_abs = os.path.abspath(src)
        sources.append(src_abs)
        ext = os.path.splitext(src_abs)[1] or ".bin"
        # Content hash / id is already filesystem-safe hex for uploaded assets.
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in aid)[:80] or "asset"
        dest = os.path.join(inputs_dir, f"{safe}{ext}")
        res = materialize_input(
            src_abs,
            dest,
            before_copy=before_copy,
            cancel_check=cancel_check,
        )
        results.append(res)
        local[aid] = res.local_path
    return local, sources, results


# ── Atomic output reservation (F14) ──────────────────────────────────────────

_O_FLAGS = os.O_CREAT | os.O_EXCL | os.O_WRONLY
_MAX_NUMBERED_NAME_PROBES = 256
_MAX_RANDOM_NAME_PROBES = 16
if hasattr(os, "O_BINARY"):
    _O_FLAGS |= os.O_BINARY  # type: ignore[attr-defined]


def reserve_output_exclusive(directory: str, basename: str) -> str:
    """Create an exclusive empty file; return its path.

    Never uses exists-then-create alone. On collision increments ``(1)``, ``(2)``…
    like the legacy helper, but each attempt is ``O_EXCL``.
    """
    os.makedirs(directory, exist_ok=True)
    stem, ext = os.path.splitext(basename)
    for n in range(_MAX_NUMBERED_NAME_PROBES):
        name = basename if n == 0 else f"{stem}({n}){ext}"
        path = os.path.join(directory, name)
        try:
            fd = os.open(path, _O_FLAGS)
            try:
                os.close(fd)
            except OSError:
                pass
            return path
        except FileExistsError:
            continue
        except OSError as e:
            if getattr(e, "errno", None) == errno.EEXIST:
                continue
            # Permission, ENOSPC, read-only volume, overlong path, etc. cannot
            # be fixed by trying thousands of alternate names.
            raise
    for _ in range(_MAX_RANDOM_NAME_PROBES):
        path = os.path.join(directory, f"{stem}-{uuid.uuid4().hex[:8]}{ext}")
        try:
            fd = os.open(path, _O_FLAGS)
            try:
                os.close(fd)
            except OSError:
                pass
            return path
        except FileExistsError:
            continue
        except OSError as e:
            if getattr(e, "errno", None) == errno.EEXIST:
                continue
            raise
    raise FileExistsError(f"cannot reserve a unique output name under {directory}")


def publish_atomic(temp_path: str, final_path: str) -> None:
    """Atomically replace ``final_path`` with rendered ``temp_path``.

    Callers put the temp on the SAME volume as the final so this is a plain,
    atomic ``os.replace``. If a temp still lands cross-volume (EXDEV), fall back
    to copy → fsync → replace-into-place via a sibling temp on the final's
    volume, so a stray cross-device path degrades to non-atomic-but-correct
    instead of losing an hour-long render.
    """
    if not temp_path or not final_path:
        raise ValueError("publish_atomic requires temp and final paths")
    if not os.path.isfile(temp_path) or os.path.getsize(temp_path) <= 0:
        raise OSError(f"temp output missing or empty: {temp_path}")
    # final may be the exclusive reservation (0-byte); replace overwrites it.
    try:
        os.replace(temp_path, final_path)
        return
    except OSError as e:
        if getattr(e, "errno", None) != errno.EXDEV:
            raise
    # Cross-device: stage a sibling temp on the FINAL volume, fsync, then replace.
    sibling = f"{final_path}.copy-{uuid.uuid4().hex[:8]}.part"
    try:
        with open(temp_path, "rb") as src, open(sibling, "wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(sibling, final_path)
    except OSError:
        discard_file(sibling)
        raise
    else:
        discard_file(temp_path)


def discard_file(path: str | None) -> None:
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        log.debug("discard_file failed for %s", path, exc_info=True)


@dataclass
class JobFsState:
    """Filesystem side-state attached to an export Job (not always persisted)."""

    job_dir: str = ""
    temp_path: str = ""
    leased_paths: list[str] = field(default_factory=list)
    reserved_out: bool = False  # True if out_path was O_EXCL-created by us


def _drop_export_scratch(job) -> None:
    """Remove an export job's scratch (input snapshot + fonts) after a successful
    publish. External output → the whole job_dir is scratch; internal output
    (job_dir/out.mp4) → keep the final, drop only the scratch subdirs. Best-effort."""
    job_dir = getattr(job, "job_dir", None) or ""
    if not job_dir or not os.path.isdir(job_dir):
        return
    jd = os.path.abspath(job_dir)
    out = os.path.abspath(getattr(job, "out_path", None) or "")
    out_in_jobdir = bool(out) and os.path.dirname(out) == jd
    try:
        if out and not out_in_jobdir:
            # Output lives elsewhere → the entire job dir is disposable scratch.
            shutil.rmtree(jd, ignore_errors=True)
        else:
            # Internal final is job_dir/out.mp4. FFmpeg builder also writes ASS
            # and filter-complex scripts directly in job_dir, so remove every
            # controlled entry except that final (not only known subdirectories).
            for entry in os.scandir(jd):
                path = os.path.abspath(entry.path)
                if out and os.path.normcase(path) == os.path.normcase(out):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    discard_file(path)
    except OSError:
        log.debug("export scratch cleanup failed for %s", jd, exc_info=True)


def cleanup_job_fs(job, *, success: bool) -> None:
    """Release leases + temp; drop reservation when not successfully published.

    Idempotent — safe to call twice (cancel then fail, or double cleanup).
    """
    leased = list(getattr(job, "leased_paths", None) or [])
    if leased:
        release_paths(leased)
        try:
            job.leased_paths = []
        except Exception:  # noqa: BLE001
            pass

    temp = getattr(job, "temp_path", None) or ""
    discard_file(temp)
    try:
        job.temp_path = ""
    except Exception:  # noqa: BLE001
        pass

    # Hybrid Export's video-only browser stream lives beside the selected final
    # output, not under job_dir. It is job-owned after finalize and must be
    # removed on every terminal path (including restart recovery).
    cleanup_paths = list(getattr(job, "cleanup_paths", None) or [])
    for owned_path in cleanup_paths:
        discard_file(owned_path)
    try:
        job.cleanup_paths = []
    except Exception:  # noqa: BLE001
        pass

    reservation_id = getattr(job, "external_reservation_id", None) or ""
    if reservation_id:
        # Lazy import avoids the integrity <-> job module import cycle.
        try:
            from .job import release_external_output
            release_external_output(reservation_id)
        except Exception:  # noqa: BLE001
            log.debug(
                "hybrid external reservation release failed for %s",
                reservation_id,
                exc_info=True,
            )
        try:
            job.external_reservation_id = ""
        except Exception:  # noqa: BLE001
            pass

    if success:
        # Drop the input snapshot on success. materialize_assets copies/hardlinks
        # every source into job_dir/inputs — for an external or cross-volume
        # source that's a full copy of a multi-GB video that would otherwise sit
        # in the work dir until the 7-day / quota cleanup, filling the work disk
        # even though the output was saved elsewhere (#6). The downloadable final
        # is either external or job_dir/out.mp4 (kept); only scratch is removed.
        _drop_export_scratch(job)

    if not success:
        # Only remove the reserved final if we created it and never published.
        if getattr(job, "reserved_out", False) and getattr(job, "out_path", None):
            # Don't delete if publish succeeded (success=True). If failed, remove
            # the exclusive placeholder / partial so the name can be re-reserved.
            out = job.out_path
            try:
                # Published outputs are large; placeholders are 0-byte. If a
                # partial write landed on out_path without temp publish, still
                # remove on failure so we don't leave corrupt finals.
                if out and os.path.isfile(out):
                    # Never delete if path is inside another job's dir unexpectedly —
                    # reserved paths are either user export dir or this job's dir.
                    discard_file(out)
            except OSError:
                pass
        try:
            job.reserved_out = False
        except Exception:  # noqa: BLE001
            pass
        # Failed/cancelled renders have no downloadable final, so their copied
        # multi-GB input snapshot is pure garbage too. This must run on every
        # worker error/cancel path, not just setup failures or successful publish.
        _drop_export_scratch(job)
        job_dir = getattr(job, "job_dir", None) or ""
        if job_dir:
            try:
                os.rmdir(job_dir)  # remove only when scratch cleanup left it empty
            except OSError:
                pass
