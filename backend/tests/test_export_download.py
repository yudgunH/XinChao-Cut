"""GET /export/{job}/download must stream from disk with an attachment
Content-Disposition, so the client can download via a plain anchor instead of
fetch()+blob() (which materialised multi-GB MP4s in the renderer — P0).

The optional `filename` query keeps the user's chosen name across the
cross-origin download, where the anchor's `download` attribute is ignored.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routers import export as ex


@pytest.fixture
def done_job(tmp_path, monkeypatch):
    out = tmp_path / "render.mp4"
    out.write_bytes(b"fake mp4")
    job = SimpleNamespace(status="done", out_path=str(out))
    monkeypatch.setattr(ex, "get_job", lambda _jid: job)
    return job


def _disposition(**kwargs) -> str:
    resp = asyncio.run(ex.export_download("job-1", **kwargs))
    return resp.headers["content-disposition"]


def _has_name(cd: str, name: str) -> bool:
    """Starlette emits RFC 5987 `filename*=utf-8''<pct-encoded>` when the name
    isn't a bare token (e.g. it has a space), else a plain `filename="..."`."""
    from urllib.parse import quote

    return f'filename="{name}"' in cd or f"filename*=utf-8''{quote(name)}" in cd


def test_download_is_an_attachment_streamed_from_disk(done_job):
    resp = asyncio.run(ex.export_download("job-1"))
    # FileResponse streams the path; it never loads the file into memory here.
    assert resp.path == done_job.out_path
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.media_type == "video/mp4"


def test_download_honours_client_filename(done_job):
    assert _has_name(_disposition(filename="My Clip"), "My Clip.mp4")


def test_download_sanitises_path_separators_and_reserved_chars(done_job):
    cd = _disposition(filename="a/b:c*?")
    assert _has_name(cd, "a_b_c__.mp4")
    # No raw separator can survive into the header.
    assert "/" not in cd.split("filename")[1]


def test_download_defaults_and_avoids_double_extension(done_job):
    assert _has_name(_disposition(), "export.mp4")
    assert _has_name(_disposition(filename="   "), "export.mp4")
    assert _has_name(_disposition(filename="clip.mp4"), "clip.mp4")


def test_download_404_when_missing(monkeypatch):
    monkeypatch.setattr(ex, "get_job", lambda _jid: None)
    monkeypatch.setattr(ex, "load_persisted_job", lambda _jid: None)
    with pytest.raises(HTTPException) as e:
        asyncio.run(ex.export_download("nope"))
    assert e.value.status_code == 404


def test_download_409_when_not_done(tmp_path, monkeypatch):
    out = tmp_path / "render.mp4"
    out.write_bytes(b"x")
    monkeypatch.setattr(
        ex, "get_job", lambda _jid: SimpleNamespace(status="running", out_path=str(out))
    )
    with pytest.raises(HTTPException) as e:
        asyncio.run(ex.export_download("job-1"))
    assert e.value.status_code == 409


def test_status_falls_back_to_durable_db_before_ram_restore(monkeypatch):
    durable = SimpleNamespace(
        public=lambda: {"id": "job-1", "status": "done", "pct": 100.0}
    )
    monkeypatch.setattr(ex, "get_job", lambda _jid: None)
    monkeypatch.setattr(ex, "load_persisted_job", lambda _jid: durable)

    assert asyncio.run(ex.export_status("job-1"))["status"] == "done"


def test_download_falls_back_to_durable_db_before_ram_restore(tmp_path, monkeypatch):
    out = tmp_path / "persisted.mp4"
    out.write_bytes(b"mp4")
    monkeypatch.setattr(ex, "get_job", lambda _jid: None)
    monkeypatch.setattr(
        ex,
        "load_persisted_job",
        lambda _jid: SimpleNamespace(status="done", out_path=str(out)),
    )

    response = asyncio.run(ex.export_download("job-1"))
    assert response.path == str(out)
