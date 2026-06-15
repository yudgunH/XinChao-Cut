"""Small shared helpers."""
from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, UploadFile


MEDIA_SOURCE_EXTENSIONS = {
    ".3gp", ".aac", ".aif", ".aiff", ".avi", ".avif", ".bmp", ".flac",
    ".flv", ".gif", ".jpeg", ".jpg", ".m2ts", ".m4a", ".m4v", ".mkv",
    ".mov", ".mp3", ".mp4", ".mpeg", ".mpg", ".mts", ".ogg", ".opus",
    ".png", ".tif", ".tiff", ".ts", ".wav", ".webm", ".webp", ".wma",
    ".wmv",
}


@contextmanager
def saved_upload(file: UploadFile):
    """Persist an UploadFile to a temp path for ffmpeg/whisperx, then clean up."""
    suffix = Path(file.filename or "upload").suffix or ".bin"
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as out:
            shutil.copyfileobj(file.file, out)
        yield tmp
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


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
