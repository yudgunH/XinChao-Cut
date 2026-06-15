"""Tests for media endpoints reusing the asset store by hash (TASK-18)."""
from __future__ import annotations

import io
import os

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from app.routers import media as M


def _upload(data: bytes, name="clip.mp4") -> UploadFile:
    return UploadFile(
        filename=name,
        file=io.BytesIO(data),
        headers=Headers({"content-type": "video/mp4"}),
    )


def test_source_prefers_stored_asset_over_upload(monkeypatch):
    monkeypatch.setattr(M, "asset_path", lambda h: "/stored/abc.mp4" if h == "abc" else None)
    # Even with a file present, a resolvable hash wins (no re-upload).
    with M._source_media(_upload(b"data"), "abc") as path:
        assert path == "/stored/abc.mp4"


def test_source_falls_back_to_upload_when_hash_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(M, "asset_path", lambda h: None)
    with M._source_media(_upload(b"hello world"), "") as path:
        # saved_upload wrote the bytes to a real temp file we can read.
        assert path.endswith(".mp4")
        with open(path, "rb") as f:
            assert f.read() == b"hello world"


def test_source_falls_back_when_hash_unknown(monkeypatch):
    monkeypatch.setattr(M, "asset_path", lambda h: None)  # hash not on server
    with M._source_media(_upload(b"x"), "missinghash") as path:
        assert path  # used the upload instead of failing


def test_source_uses_absolute_source_path(monkeypatch, tmp_path):
    monkeypatch.setattr(M, "asset_path", lambda h: None)
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"media")
    with M._source_media(None, "", str(source)) as path:
        assert path == os.path.abspath(str(source))


def test_source_stored_hash_wins_over_source_path(monkeypatch, tmp_path):
    monkeypatch.setattr(M, "asset_path", lambda h: "/stored/abc.mp4" if h == "abc" else None)
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"media")
    with M._source_media(None, "abc", str(source)) as path:
        assert path == "/stored/abc.mp4"


def test_source_rejects_relative_source_path(monkeypatch):
    monkeypatch.setattr(M, "asset_path", lambda h: None)
    with pytest.raises(HTTPException) as ei:
        with M._source_media(None, "", "clip.mp4"):
            pass
    assert ei.value.status_code == 422


def test_source_rejects_unsupported_source_extension(monkeypatch, tmp_path):
    monkeypatch.setattr(M, "asset_path", lambda h: None)
    source = tmp_path / "notes.txt"
    source.write_text("not media")
    with pytest.raises(HTTPException) as ei:
        with M._source_media(None, "", str(source)):
            pass
    assert ei.value.status_code == 422


def test_source_raises_when_neither_file_nor_hash(monkeypatch):
    monkeypatch.setattr(M, "asset_path", lambda h: None)
    with pytest.raises(HTTPException) as ei:
        with M._source_media(None, ""):
            pass
    assert ei.value.status_code == 422


def test_source_raises_when_hash_unresolved_and_no_file(monkeypatch):
    monkeypatch.setattr(M, "asset_path", lambda h: None)
    with pytest.raises(HTTPException) as ei:
        with M._source_media(None, "abc"):
            pass
    assert ei.value.status_code == 422
