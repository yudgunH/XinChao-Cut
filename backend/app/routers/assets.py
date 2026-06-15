"""Content-addressed asset store so the frontend uploads each media file once."""
from __future__ import annotations

import glob
import logging
import os
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..config import get_settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/assets", tags=["assets"])


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
    """
    if not hash_ or "/" in hash_ or "\\" in hash_:
        return None
    matches = glob.glob(os.path.join(_assets_dir(), f"{hash_}.*"))
    if not matches:
        return None
    try:
        os.utime(matches[0], None)
    except OSError:
        pass
    return matches[0]


def cleanup_assets() -> None:
    """Enforce TTL + size quota on the asset store (LRU by mtime).

    Called at startup and after each upload. TTL drops anything untouched past
    the configured age; the quota then evicts oldest-first until the total is
    back under the cap. Never touches a file that was used recently (its mtime
    was refreshed by `asset_path`)."""
    s = get_settings()
    d = _assets_dir()
    try:
        entries = [
            (p, st.st_mtime, st.st_size)
            for name in os.listdir(d)
            if os.path.isfile(p := os.path.join(d, name))
            for st in (os.stat(p),)
        ]
    except OSError:
        return

    now = time.time()
    removed = 0

    # TTL pass — drop assets untouched for longer than the configured age.
    if s.assets_ttl_days > 0:
        cutoff = now - s.assets_ttl_days * 86400
        kept: list[tuple[str, float, int]] = []
        for p, mtime, size in entries:
            if mtime < cutoff:
                try:
                    os.remove(p)
                    removed += 1
                except OSError:
                    kept.append((p, mtime, size))
            else:
                kept.append((p, mtime, size))
        entries = kept

    # Quota pass — evict oldest (lowest mtime) until under the cap.
    if s.assets_quota_mb > 0:
        quota = s.assets_quota_mb * 1024 * 1024
        total = sum(sz for _p, _m, sz in entries)
        if total > quota:
            for p, _mtime, size in sorted(entries, key=lambda e: e[1]):
                if total <= quota:
                    break
                try:
                    os.remove(p)
                    total -= size
                    removed += 1
                except OSError:
                    pass

    if removed:
        log.info("Asset store cleanup: evicted %d file(s)", removed)


class CheckBody(BaseModel):
    hashes: list[str]


@router.post("/check")
async def assets_check(body: CheckBody) -> dict:
    """Given content hashes, return which ones the server doesn't have yet."""
    missing = [h for h in body.hashes if asset_path(h) is None]
    return {"missing": missing}


@router.post("/upload")
async def assets_upload(file: UploadFile = File(...), hash: str = Form(...)) -> dict:
    if not hash or "/" in hash or "\\" in hash:
        raise HTTPException(status_code=400, detail="Invalid hash")
    existing = asset_path(hash)
    if existing:
        return {"assetId": hash}
    ext = Path(file.filename or "").suffix or ".bin"
    dest = os.path.join(_assets_dir(), f"{hash}{ext}")
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)
    # Keep the store under its quota/TTL now that it grew.
    cleanup_assets()
    return {"assetId": hash}
