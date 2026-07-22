"""Content-addressed asset store so the frontend uploads each media file once."""
from __future__ import annotations

import asyncio
import glob
import hashlib
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import get_settings
from ..utils import resolve_source_path
from ..export.job import (
    InsufficientSpace,
    release_external_output,
    reserve_external_output,
    update_external_output_written,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/assets", tags=["assets"])

# Content hashes MUST be hex — anything else in a `glob.glob(f"{hash}.*")` gets
# interpreted as a shell-style wildcard: `hash="*"` would match the first stored
# asset on disk (returning a stranger's file). SHA-256 hex is 64 chars; the
# Keep legacy opaque hex ids readable, but new uploads must use the exact
# 64-character digest produced by frontend hashBlob so content can be verified.
_HASH_RE = re.compile(r"^[0-9a-fA-F]{16,128}$")
_UPLOAD_HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_CONTENT_HASH_CHUNK = 64 * 1024 * 1024

# Just-uploaded assets must survive the post-upload cleanup_assets() call even
# when the new file alone pushes the store over quota (upload_max was larger
# than assets_quota historically → success then instant LRU delete → 404).
ASSET_GRACE_SEC = 15 * 60


class _AdoptCancelled(Exception):
    pass


def _assets_dir() -> str:
    # Absolute so paths stay valid when ffmpeg runs with cwd=<job dir>.
    d = os.path.abspath(os.path.join(get_settings().work_dir, "assets"))
    os.makedirs(d, exist_ok=True)
    return d


def asset_path(hash_: str) -> str | None:
    """Return the stored file for a content hash, or None.

    Touches the file's mtime on a hit so the asset counts as recently used —
    this is the access signal the LRU quota in `cleanup_assets()` evicts by, so
    media referenced by the active project stays warm and survives eviction.

    `.tmp` matches are filtered out defensively: current uploads write to a
    `.upload-<uuid>.tmp` sibling outside the `<hash>.*` glob, but an older
    build's `<hash>.mp4.tmp` scratch that a user still has on disk from a
    previous crash would otherwise resolve here and serve a partial file.
    """
    if not hash_ or not _HASH_RE.match(hash_):
        return None
    matches = [
        p for p in glob.glob(os.path.join(_assets_dir(), f"{hash_}.*"))
        if not p.endswith(".tmp")
    ]
    if not matches:
        return None
    try:
        os.utime(matches[0], None)
    except OSError:
        pass
    return matches[0]


def asset_upload_byte_limit() -> int:
    """Effective max bytes for a single upload: min(upload_max, assets_quota).

    A single file larger than the store quota can never be retained — reject it
    up front instead of accepting then LRU-deleting it on cleanup_assets().
    0 means unlimited (both caps disabled).
    """
    s = get_settings()
    caps: list[int] = []
    if s.upload_max_bytes and s.upload_max_bytes > 0:
        caps.append(int(s.upload_max_bytes))
    if s.assets_quota_mb and s.assets_quota_mb > 0:
        caps.append(int(s.assets_quota_mb) * 1024 * 1024)
    return min(caps) if caps else 0


def content_hash_path(path: str) -> str:
    """Hash a local file with the same bounded scheme as frontend ``hashBlob``.

    Files up to 64 MiB use ordinary SHA-256. Larger files hash independent
    64 MiB chunks, then hash the concatenated chunk digests. Peak memory stays
    at the 8 MiB I/O block rather than materialising the full media file.
    """
    size = max(0, os.path.getsize(path))
    if size <= _CONTENT_HASH_CHUNK:
        digest = hashlib.sha256()
        with open(path, "rb") as source:
            while data := source.read(8 * 1024 * 1024):
                digest.update(data)
        return digest.hexdigest()

    part_digests: list[bytes] = []
    with open(path, "rb") as source:
        while True:
            part = hashlib.sha256()
            remaining = _CONTENT_HASH_CHUNK
            read_any = False
            while remaining > 0:
                data = source.read(min(8 * 1024 * 1024, remaining))
                if not data:
                    break
                read_any = True
                part.update(data)
                remaining -= len(data)
            if not read_any:
                break
            part_digests.append(part.digest())
            if remaining > 0:
                break
    return hashlib.sha256(b"".join(part_digests)).hexdigest()


def cleanup_assets() -> None:
    """Enforce TTL + size quota on the asset store (LRU by mtime).

    Called at startup and after each upload. TTL drops anything untouched past
    the configured age; the quota then evicts oldest-first until the total is
    back under the cap. Never touches a file that was used recently (its mtime
    was refreshed by `asset_path`).

    S11 / F13: never deletes a path with an active export **lease** (job still
    queued or running may hardlink/read the asset).

    Grace: files newer than ASSET_GRACE_SEC are never evicted so a just-uploaded
    asset cannot be deleted by the cleanup that runs at the end of /upload.
    """
    from ..export.integrity import is_path_leased

    s = get_settings()
    d = _assets_dir()
    try:
        entries = [
            (p, st.st_mtime, st.st_size)
            for name in os.listdir(d)
            if os.path.isfile(p := os.path.join(d, name))
            and not name.startswith(".upload-")
            and not name.endswith(".tmp")
            for st in (os.stat(p),)
        ]
    except OSError:
        return

    now = time.time()
    removed = 0

    def _safe_remove(p: str, mtime: float) -> bool:
        if is_path_leased(p):
            return False
        # Grace period for brand-new uploads (and any path still being finalized).
        if now - mtime < ASSET_GRACE_SEC:
            return False
        try:
            os.remove(p)
            return True
        except OSError:
            return False

    # TTL pass — drop assets untouched for longer than the configured age.
    if s.assets_ttl_days > 0:
        cutoff = now - s.assets_ttl_days * 86400
        kept: list[tuple[str, float, int]] = []
        for p, mtime, size in entries:
            if mtime < cutoff and _safe_remove(p, mtime):
                removed += 1
            else:
                kept.append((p, mtime, size))
        entries = kept

    # Quota pass — evict oldest (lowest mtime) until under the cap.
    if s.assets_quota_mb > 0:
        quota = s.assets_quota_mb * 1024 * 1024
        total = sum(sz for _p, _m, sz in entries)
        if total > quota:
            for p, mtime, size in sorted(entries, key=lambda e: e[1]):
                if total <= quota:
                    break
                if _safe_remove(p, mtime):
                    total -= size
                    removed += 1

    if removed:
        log.info("Asset store cleanup: evicted %d file(s)", removed)


class CheckBody(BaseModel):
    hashes: list[str]


class AdoptPathBody(BaseModel):
    sourcePath: str
    filename: str | None = None


@router.post("/check")
async def assets_check(body: CheckBody) -> dict:
    """Given content hashes, return which ones the server doesn't have yet."""
    missing = [h for h in body.hashes if asset_path(h) is None]
    return {"missing": missing}


@router.get("/{hash_}")
def assets_get(hash_: str) -> FileResponse:
    """Serve a stored asset by content hash (HTTP Range handled by FileResponse).

    Recovery path: a client whose LOCAL media row for a source is gone (cleared
    browser storage, moved machine, restored project) can re-fetch the file the
    server still holds by hash — e.g. reopening a project needs the source
    video locally to build the editor project. `asset_path` validates the hex
    hash (rejects path-traversal / glob wildcards) and refreshes LRU mtime.
    """
    path = asset_path(hash_)
    if path is None:
        raise HTTPException(status_code=404, detail="Asset không tồn tại trên server")
    return FileResponse(path)


@router.get("/{hash_}/info")
def assets_info(hash_: str) -> dict:
    """Resolve a stored asset for the colocated desktop shell.

    Projects persist the server content hash, while the browser-side media
    row can disappear after a reload/storage cleanup. Returning the already-
    owned backend path lets Tauri register it in a new Editor project without
    downloading/copying a multi-GB source into OPFS again.
    """
    path = asset_path(hash_)
    if path is None:
        raise HTTPException(status_code=404, detail="Asset không tồn tại trên server")
    return {
        "path": os.path.abspath(path),
        "name": os.path.basename(path),
        "sizeBytes": max(0, os.path.getsize(path)),
    }


@router.post("/adopt-path")
async def assets_adopt_path(body: AdoptPathBody, request: Request) -> dict:
    """Import a desktop-local source without sending its bytes through JS.

    The file is streamed once into an isolated scratch while calculating the
    same <=64 MiB SHA-256 / >64 MiB two-level hash used by `hashBlob`. Peak RAM
    stays one 8 MiB block. Publish is atomic, quota-reserved, and a disconnected
    client removes the scratch instead of leaving a multi-GB orphan.
    """
    source = resolve_source_path(body.sourcePath)
    size = max(0, os.path.getsize(source))
    cap = asset_upload_byte_limit()
    if cap and size > cap:
        raise HTTPException(
            status_code=413,
            detail=(
                f"File too large for the asset store ({size} bytes; limit {cap} bytes). "
                "Raise XINCHAO_ASSETS_QUOTA_MB / XINCHAO_UPLOAD_MAX_BYTES if needed."
            ),
        )

    asset_dir = _assets_dir()
    try:
        free_bytes = os.statvfs(asset_dir).f_bavail * os.statvfs(asset_dir).f_frsize
    except (AttributeError, OSError):
        try:
            import shutil
            free_bytes = shutil.disk_usage(asset_dir).free
        except OSError:
            free_bytes = None
    reservation_id = f"asset-adopt-{uuid.uuid4().hex}"
    try:
        volume = f"dev:{os.stat(asset_dir).st_dev}"
        reserve_external_output(
            reservation_id,
            size + 128 * 1024 * 1024,
            free_bytes,
            volume,
        )
    except (InsufficientSpace, ValueError) as exc:
        raise HTTPException(status_code=507, detail=str(exc)) from None

    tmp = os.path.join(asset_dir, f".adopt-{uuid.uuid4().hex}.tmp")
    hash_chunk = 64 * 1024 * 1024
    io_chunk = 8 * 1024 * 1024
    is_large = size > hash_chunk
    cancel_copy = threading.Event()

    def _copy_and_hash() -> tuple[str, int]:
        whole_hasher = hashlib.sha256()
        part_hasher = hashlib.sha256()
        part_remaining = hash_chunk
        part_digests: list[bytes] = []
        written = 0
        with open(source, "rb") as src, open(tmp, "wb") as out:
            while True:
                if cancel_copy.is_set():
                    raise _AdoptCancelled
                read_size = min(io_chunk, part_remaining) if is_large else io_chunk
                data = src.read(read_size)
                if not data:
                    break
                if is_large:
                    part_hasher.update(data)
                    part_remaining -= len(data)
                    if part_remaining == 0:
                        part_digests.append(part_hasher.digest())
                        part_hasher = hashlib.sha256()
                        part_remaining = hash_chunk
                else:
                    whole_hasher.update(data)
                out.write(data)
                written += len(data)
                update_external_output_written(reservation_id, written)
            out.flush()
            os.fsync(out.fileno())
        if cancel_copy.is_set():
            raise _AdoptCancelled
        if written != size:
            raise OSError(f"Source changed while importing ({size} -> {written} bytes)")
        if is_large:
            if part_remaining != hash_chunk:
                part_digests.append(part_hasher.digest())
            return hashlib.sha256(b"".join(part_digests)).hexdigest(), written
        return whole_hasher.hexdigest(), written

    async def _watch_disconnect() -> None:
        while not cancel_copy.is_set():
            if await request.is_disconnected():
                cancel_copy.set()
                return
            await asyncio.sleep(0.25)

    disconnect_watcher = asyncio.create_task(_watch_disconnect())
    try:
        try:
            hash_, _written = await asyncio.to_thread(_copy_and_hash)
        except _AdoptCancelled:
            raise HTTPException(
                status_code=499, detail="Client cancelled local asset import"
            ) from None

        existing = asset_path(hash_)
        if existing:
            os.remove(tmp)
            return {"assetId": hash_, "hash": hash_, "deduplicated": True}
        # The validated source path is authoritative. Never derive a filesystem
        # suffix from client display text (which may contain separators or an
        # unrelated extension).
        ext = Path(source).suffix or ".bin"
        dest = os.path.join(asset_dir, f"{hash_}{ext}")
        os.replace(tmp, dest)
        from ..export.integrity import lease_paths, release_paths

        leased = lease_paths([dest])
        try:
            cleanup_assets()
        finally:
            release_paths(leased)
        return {"assetId": hash_, "hash": hash_, "deduplicated": False}
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        # A failure after publish but before response must not delete the valid
        # content-addressed asset; cleanup/TTL owns published files.
        raise
    finally:
        cancel_copy.set()
        disconnect_watcher.cancel()
        try:
            await disconnect_watcher
        except asyncio.CancelledError:
            pass
        release_external_output(reservation_id)


@router.post("/upload")
def assets_upload(
    request: Request,
    file: UploadFile = File(...),
    hash: str = Form(...),
) -> dict:
    if not hash or not _UPLOAD_HASH_RE.fullmatch(hash):
        raise HTTPException(status_code=400, detail="Invalid hash")
    existing = asset_path(hash)
    if existing:
        return {"assetId": hash}

    cap = asset_upload_byte_limit()
    # Preflight from Content-Length when present (multipart overhead is small
    # vs multi-GB media). Fail clearly before streaming 6GB that the quota
    # would immediately discard.
    if cap > 0:
        cl = request.headers.get("content-length")
        if cl:
            try:
                # Multipart framing adds a few KB — only reject when clearly over.
                if int(cl) > cap + (1 << 20):
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"File too large for the asset store "
                            f"(limit {cap} bytes / ~{cap // (1024**3)} GB). "
                            f"Raise XINCHAO_ASSETS_QUOTA_MB / XINCHAO_UPLOAD_MAX_BYTES if needed."
                        ),
                    )
            except ValueError:
                pass

    ext = Path(file.filename or "").suffix or ".bin"
    dest = os.path.join(_assets_dir(), f"{hash}{ext}")
    reservation_id = f"asset-upload-{uuid.uuid4().hex}"
    reported = max(0, int(getattr(file, "size", 0) or 0))
    if reported <= 0:
        try:
            reported = max(0, int(request.headers.get("content-length") or 0))
        except ValueError:
            reported = 0
    expected = reported or cap
    if expected > 0:
        asset_dir = _assets_dir()
        try:
            free_bytes = os.statvfs(asset_dir).f_bavail * os.statvfs(asset_dir).f_frsize
        except (AttributeError, OSError):
            try:
                import shutil
                free_bytes = shutil.disk_usage(asset_dir).free
            except OSError:
                free_bytes = None
        try:
            volume = f"dev:{os.stat(asset_dir).st_dev}"
            reserve_external_output(
                reservation_id,
                expected + 128 * 1024 * 1024,
                free_bytes,
                volume,
            )
        except (InsufficientSpace, ValueError) as e:
            raise HTTPException(status_code=507, detail=str(e)) from None
    # Write to a scratch sibling and atomic-rename on success. Any failure —
    # 413, disk full, permission denied, antivirus lock, process kill — leaves
    # the scratch behind while `dest` itself never appears half-written.
    #
    # Scratch name deliberately does NOT start with the hash: `asset_path()`
    # globs `<hash>.*` and would otherwise pick up an abandoned `<hash>.mp4.tmp`
    # as a valid asset after a crash. Prefixing with `.upload-` + a random uuid
    # keeps every in-flight upload isolated (two concurrent uploads of the same
    # hash never share a tmp) and safely outside the glob pattern.
    tmp = os.path.join(_assets_dir(), f".upload-{uuid.uuid4().hex}.tmp")
    written = 0
    whole_hasher = hashlib.sha256()
    part_hasher = hashlib.sha256()
    part_remaining = _CONTENT_HASH_CHUNK
    part_digests: list[bytes] = []
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = file.file.read(1 << 20)  # 1 MiB
                if not chunk:
                    break
                written += len(chunk)
                if cap and written > cap:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Upload exceeds store limit ({cap} bytes). "
                            f"A single file cannot exceed the asset quota / upload cap."
                        ),
                    )
                if whole_hasher is not None:
                    whole_hasher.update(chunk)
                offset = 0
                while offset < len(chunk):
                    take = min(part_remaining, len(chunk) - offset)
                    part_hasher.update(chunk[offset:offset + take])
                    offset += take
                    part_remaining -= take
                    if part_remaining == 0:
                        part_digests.append(part_hasher.digest())
                        part_hasher = hashlib.sha256()
                        part_remaining = _CONTENT_HASH_CHUNK
                if written > _CONTENT_HASH_CHUNK:
                    # The plain whole-file digest is no longer a possible
                    # result; release its state and continue with chunk hashes.
                    whole_hasher = None
                out.write(chunk)
                update_external_output_written(reservation_id, written)
        if written <= _CONTENT_HASH_CHUNK:
            assert whole_hasher is not None
            actual_hash = whole_hasher.hexdigest()
        else:
            if part_remaining != _CONTENT_HASH_CHUNK:
                part_digests.append(part_hasher.digest())
            actual_hash = hashlib.sha256(b"".join(part_digests)).hexdigest()
        if actual_hash != hash.lower():
            raise HTTPException(
                status_code=422,
                detail="Uploaded asset content hash does not match the requested asset id",
            )
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    finally:
        release_external_output(reservation_id)

    # Soft lease for the grace window so concurrent cleanup paths (export
    # integrity + this post-upload pass) skip the brand-new file.
    from ..export.integrity import lease_paths, release_paths

    leased = lease_paths([dest])
    try:
        cleanup_assets()
    finally:
        # Lease is only for this cleanup pass; mtime grace still protects longer.
        release_paths(leased)
    return {"assetId": hash}
