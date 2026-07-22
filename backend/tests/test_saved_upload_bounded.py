from __future__ import annotations

import io

import pytest
from fastapi import HTTPException, UploadFile

from app import utils


def _settings(monkeypatch, limit: int):
    real = utils.get_settings()
    fake = type(real)(**{**real.model_dump(), "upload_max_bytes": limit})
    monkeypatch.setattr(utils, "get_settings", lambda: fake)


def test_save_upload_bounded_publishes_complete_file(tmp_path, monkeypatch):
    _settings(monkeypatch, 1024)
    payload = b"complete-payload"
    upload = UploadFile(io.BytesIO(payload), filename="input.bin", size=len(payload))
    dest = tmp_path / "saved.bin"

    assert utils.save_upload_bounded(upload, dest) == len(payload)
    assert dest.read_bytes() == payload
    assert not list(tmp_path.glob("*.part-*"))


def test_save_upload_bounded_rejects_oversize_without_partial(tmp_path, monkeypatch):
    _settings(monkeypatch, 8)
    upload = UploadFile(io.BytesIO(b"0123456789"), filename="input.bin", size=None)
    dest = tmp_path / "saved.bin"

    with pytest.raises(HTTPException) as exc:
        utils.save_upload_bounded(upload, dest)

    assert exc.value.status_code == 413
    assert not dest.exists()
    assert not list(tmp_path.glob("*.part-*"))


def test_save_upload_bounded_honours_stricter_callsite_cap(tmp_path, monkeypatch):
    _settings(monkeypatch, 1024)
    upload = UploadFile(io.BytesIO(b"01234567890"), filename="voice.wav", size=11)
    dest = tmp_path / "voice.wav"

    with pytest.raises(HTTPException) as exc:
        utils.save_upload_bounded(upload, dest, max_bytes=10)

    assert exc.value.status_code == 413
    assert not dest.exists()
    assert not list(tmp_path.glob("*.part-*"))
