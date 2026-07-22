"""Content-addressed cache for independently decodable export chunks."""
from __future__ import annotations

import functools
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from ..config import get_settings

_CACHE_SCHEMA = 1
_PRUNE_LOCK = threading.Lock()
_CONTENT_ID = re.compile(r"^[0-9a-f]{64}$")


@functools.lru_cache
def _ffmpeg_identity() -> str:
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return (result.stdout or result.stderr).splitlines()[0].strip()
    except Exception:
        return "ffmpeg-unknown"


def _asset_signatures(
    spec: dict,
    asset_paths: dict[str, str],
) -> list[dict]:
    used = sorted({
        str(clip.get("assetId"))
        for clip in spec.get("clips", [])
        if clip.get("assetId")
    })
    original_sources = {
        str(clip.get("assetId")): str(clip.get("sourcePath"))
        for clip in spec.get("clips", [])
        if clip.get("assetId") and clip.get("sourcePath")
    }
    signatures: list[dict] = []
    for asset_id in used:
        path = original_sources.get(asset_id) or asset_paths.get(asset_id, "")
        if _CONTENT_ID.fullmatch(asset_id):
            signatures.append({"id": asset_id})
            continue
        try:
            stat = os.stat(path)
            signatures.append({
                "id": asset_id,
                "path": os.path.normcase(os.path.abspath(path)),
                "size": stat.st_size,
                "mtimeNs": stat.st_mtime_ns,
            })
        except OSError:
            signatures.append({"id": asset_id, "path": path, "missing": True})
    return signatures


def chunk_cache_key(
    kind: str,
    cache_spec: dict,
    asset_paths: dict[str, str],
    *,
    encoder: str,
) -> str:
    payload = {
        "schema": _CACHE_SCHEMA,
        "kind": kind,
        "encoder": encoder,
        "ffmpeg": _ffmpeg_identity(),
        "spec": cache_spec,
        "assets": _asset_signatures(cache_spec, asset_paths),
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def chunk_cache_path(kind: str, key: str, suffix: str) -> str:
    root = os.path.join(get_settings().work_dir, "export-chunk-cache")
    safe_kind = "".join(ch for ch in kind if ch.isalnum() or ch in "-_") or "chunk"
    return os.path.join(root, safe_kind, key[:2], f"{key}{suffix}")


def prune_chunk_cache() -> None:
    settings = get_settings()
    quota = max(0, int(settings.export_chunk_cache_mb)) * 1024**2
    ttl_days = max(0, int(settings.export_chunk_cache_ttl_days))
    root = Path(settings.work_dir) / "export-chunk-cache"
    if not root.exists() or (quota <= 0 and ttl_days <= 0):
        return
    if not _PRUNE_LOCK.acquire(blocking=False):
        return
    try:
        now = time.time()
        ttl = ttl_days * 86400
        entries: list[tuple[float, int, Path]] = []
        total = 0
        for path in root.rglob("*"):
            if not path.is_file() or path.name.endswith((".json", ".tmp")):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            touched = max(stat.st_atime, stat.st_mtime)
            if ttl > 0 and now - touched > ttl:
                _remove_entry(path)
                continue
            total += stat.st_size
            entries.append((touched, stat.st_size, path))
        if quota > 0 and total > quota:
            for _touched, size, path in sorted(entries):
                _remove_entry(path)
                total -= size
                if total <= quota:
                    break
    finally:
        _PRUNE_LOCK.release()


def _remove_entry(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return
    try:
        Path(f"{path}.json").unlink(missing_ok=True)
    except OSError:
        pass
