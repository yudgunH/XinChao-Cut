"""Small shared helpers."""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .config import get_settings


MEDIA_SOURCE_EXTENSIONS = {
    ".3gp", ".aac", ".aif", ".aiff", ".avi", ".avif", ".bmp", ".flac",
    ".flv", ".gif", ".jpeg", ".jpg", ".m2ts", ".m4a", ".m4v", ".mkv",
    ".mov", ".mp3", ".mp4", ".mpeg", ".mpg", ".mts", ".ogg", ".opus",
    ".png", ".tif", ".tiff", ".ts", ".wav", ".webm", ".webp", ".wma",
    ".wmv",
}

_UPLOAD_CHUNK = 4 * 1024 * 1024
_UPLOAD_HEADROOM = 64 * 1024 * 1024
_UPLOAD_RESERVATION_LOCK = threading.Lock()
_UPLOAD_RESERVATIONS: dict[str, tuple[str, int]] = {}
_TEMP_PATH_LOCK = threading.Lock()
_ACTIVE_TEMP_PATHS: set[str] = set()
_STALE_TEMP_TTL_SEC = 24 * 3600


def register_temp_path(path: str | Path) -> str:
    value = os.path.abspath(os.fspath(path))
    with _TEMP_PATH_LOCK:
        _ACTIVE_TEMP_PATHS.add(value)
    return value


def cleanup_temp_path(path: str | Path) -> None:
    value = os.path.abspath(os.fspath(path))
    try:
        os.remove(value)
    except OSError:
        pass
    finally:
        with _TEMP_PATH_LOCK:
            _ACTIVE_TEMP_PATHS.discard(value)


def defer_temp_cleanup(path: str | Path, future) -> None:
    """Transfer a temp file to a worker future and delete it after true exit."""
    value = register_temp_path(path)
    future.add_done_callback(lambda _future: cleanup_temp_path(value))


def cleanup_stale_temp_files(*, max_age_sec: float = _STALE_TEMP_TTL_SEC) -> int:
    """Remove crashed request/scene inputs while preserving live leased paths."""
    work = os.path.abspath(get_settings().work_dir)
    cutoff = time.time() - max(0.0, max_age_sec)
    with _TEMP_PATH_LOCK:
        active = set(_ACTIVE_TEMP_PATHS)
    removed = 0
    for subdir in ("uploads", "scenes"):
        root = os.path.join(work, subdir)
        if not os.path.isdir(root):
            continue
        for entry in os.scandir(root):
            try:
                path = os.path.abspath(entry.path)
                if not entry.is_file() or path in active or entry.stat().st_mtime > cutoff:
                    continue
                os.remove(path)
                removed += 1
            except OSError:
                continue
    return removed


def _volume(path: str) -> str:
    return os.path.normcase(os.path.splitdrive(os.path.abspath(path))[0] or os.path.abspath(os.sep))


def save_upload_bounded(
    file: UploadFile,
    destination: str | Path,
    *,
    max_bytes: int | None = None,
) -> int:
    """Copy an UploadFile with a hard byte cap, free-space admission and atomic publish.

    Starlette normally provides ``UploadFile.size`` after multipart parsing. The
    streaming counter remains authoritative for older runtimes and forged sizes.
    Concurrent uploads reserve their expected bytes on the target volume so two
    individually-valid large files cannot jointly consume all free space.
    """
    dest = os.path.abspath(os.fspath(destination))
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    configured_limit = max(1, int(get_settings().upload_max_bytes))
    limit = (
        configured_limit
        if max_bytes is None
        else max(1, min(configured_limit, int(max_bytes)))
    )
    declared = getattr(file, "size", None)
    if declared is not None and int(declared) > limit:
        raise HTTPException(status_code=413, detail=f"Upload exceeds limit ({limit} bytes)")

    expected = max(0, int(declared)) if declared is not None else limit
    volume = _volume(dest)
    token = uuid.uuid4().hex
    with _UPLOAD_RESERVATION_LOCK:
        reserved = sum(size for vol, size in _UPLOAD_RESERVATIONS.values() if vol == volume)
        free = shutil.disk_usage(parent).free
        if expected + reserved + _UPLOAD_HEADROOM > free:
            raise HTTPException(status_code=507, detail="Not enough free space for this upload")
        _UPLOAD_RESERVATIONS[token] = (volume, expected)

    part = f"{dest}.part-{token}"
    written = 0
    try:
        with open(part, "xb") as out:
            while True:
                chunk = file.file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail=f"Upload exceeds limit ({limit} bytes)")
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        os.replace(part, dest)
        return written
    except HTTPException:
        raise
    except OSError as exc:
        if getattr(exc, "winerror", None) == 112 or getattr(exc, "errno", None) == 28:
            raise HTTPException(status_code=507, detail="Disk became full while saving upload") from exc
        raise
    finally:
        try:
            os.remove(part)
        except OSError:
            pass
        with _UPLOAD_RESERVATION_LOCK:
            _UPLOAD_RESERVATIONS.pop(token, None)


@contextmanager
def saved_upload(file: UploadFile):
    """Persist an UploadFile to a temp path for ffmpeg/whisperx, then clean up."""
    suffix = Path(file.filename or "upload").suffix or ".bin"
    base = os.path.abspath(os.path.join(get_settings().work_dir, "uploads"))
    os.makedirs(base, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=suffix, dir=base)
    os.close(fd)
    register_temp_path(tmp)
    try:
        save_upload_bounded(file, tmp)
        yield tmp
    finally:
        cleanup_temp_path(tmp)


@asynccontextmanager
async def async_saved_upload(file: UploadFile):
    """Async-endpoint variant: move the multi-GB copy off uvicorn's event loop."""
    suffix = Path(file.filename or "upload").suffix or ".bin"
    base = os.path.abspath(os.path.join(get_settings().work_dir, "uploads"))
    os.makedirs(base, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=suffix, dir=base)
    os.close(fd)
    register_temp_path(tmp)
    try:
        await asyncio.to_thread(save_upload_bounded, file, tmp)
        yield tmp
    finally:
        cleanup_temp_path(tmp)


async def create_async_saved_upload(file: UploadFile) -> str:
    """Create a leased upload whose cleanup can be transferred to a future."""
    suffix = Path(file.filename or "upload").suffix or ".bin"
    base = os.path.abspath(os.path.join(get_settings().work_dir, "uploads"))
    os.makedirs(base, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=suffix, dir=base)
    os.close(fd)
    register_temp_path(tmp)
    try:
        await asyncio.to_thread(save_upload_bounded, file, tmp)
        return tmp
    except BaseException:
        cleanup_temp_path(tmp)
        raise


class FileCopyCancelled(Exception):
    """A cooperative cancel interrupted a cross-volume materialisation."""


def link_or_copy(src: str, dst: str, *, cancel_check=None) -> str:
    """Materialise `src` at `dst` as cheaply as possible.

    A multi-GB source (a stored content-addressed asset, or a desktop file the
    user picked) doesn't need to be physically duplicated into a job dir: a hard
    link shares the same inode/extents, so it's instant and uses no extra disk.
    The link is read-only as far as the pipeline is concerned (it only ever reads
    the source and writes new files), and deleting the job dir just drops the
    link — the original (and its other links) stay intact.

    Falls back to a real copy when a hard link can't be made (different volume,
    filesystem without link support, Windows ACL refusal, …) so behaviour is
    never worse than before. Returns `dst`.
    """
    src = os.path.abspath(src)
    dst = os.path.abspath(dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    token = uuid.uuid4().hex
    part = f"{dst}.part-{token}"
    try:
        os.link(src, part)
        os.replace(part, dst)
        return dst
    except OSError:
        try:
            os.remove(part)
        except OSError:
            pass

    # Cross-volume/ACL fallback: reserve the destination volume and publish a
    # fully flushed sibling atomically.  A cancellation never exposes a partial
    # original.mp4 and never destroys a previous successful retry output.
    from .export.job import (
        release_external_output,
        reserve_external_output,
        update_external_output_written,
    )

    size = max(0, os.path.getsize(src))
    parent = os.path.dirname(dst)
    reservation_id = f"file-copy-{token}"
    reserve_external_output(
        reservation_id,
        max(1, size),
        shutil.disk_usage(parent).free,
        _volume(dst),
    )
    written = 0
    try:
        with open(src, "rb") as source, open(part, "xb") as target:
            while True:
                if cancel_check is not None and cancel_check():
                    raise FileCopyCancelled
                chunk = source.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                target.write(chunk)
                written += len(chunk)
                update_external_output_written(reservation_id, written)
            target.flush()
            os.fsync(target.fileno())
        if cancel_check is not None and cancel_check():
            raise FileCopyCancelled
        if written != size:
            raise OSError(f"Source changed while copying ({size} -> {written} bytes)")
        shutil.copystat(src, part)
        os.replace(part, dst)
        return dst
    finally:
        try:
            os.remove(part)
        except OSError:
            pass
        release_external_output(reservation_id)


def resolve_source_path(source_path: str) -> str:
    """Validate a desktop-imported media path before handing it to FFmpeg.

    The Tauri frontend already obtains this path from a file picker, but backend
    requests are still plain HTTP. Keep the accepted surface narrow: only
    absolute existing files with known media extensions are allowed.
    """
    raw = (source_path or "").strip()
    if not raw:
        raise HTTPException(status_code=422, detail="sourcePath is required")
    if not os.path.isabs(raw):
        raise HTTPException(status_code=422, detail="sourcePath must be an absolute file path")

    path = os.path.abspath(raw)
    if not os.path.isfile(path):
        raise HTTPException(status_code=422, detail="sourcePath does not point to a file")

    ext = Path(path).suffix.lower()
    if ext not in MEDIA_SOURCE_EXTENSIONS:
        raise HTTPException(status_code=422, detail="sourcePath must point to a supported media file")
    return path
