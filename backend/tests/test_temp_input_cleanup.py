from __future__ import annotations

import os
import time
from concurrent.futures import Future
from types import SimpleNamespace

from app import utils


def test_deferred_cleanup_waits_for_worker_future(tmp_path) -> None:
    media = tmp_path / "upload.mp4"
    media.write_bytes(b"still-in-use")
    future: Future[None] = Future()

    utils.register_temp_path(media)
    utils.defer_temp_cleanup(media, future)

    assert media.exists()
    future.set_result(None)
    assert not media.exists()


def test_stale_cleanup_preserves_active_input(monkeypatch, tmp_path) -> None:
    uploads = tmp_path / "uploads"
    scenes = tmp_path / "scenes"
    uploads.mkdir()
    scenes.mkdir()
    stale = uploads / "stale.mp4"
    active = scenes / "active.mp4"
    stale.write_bytes(b"stale")
    active.write_bytes(b"active")
    old = time.time() - 3600
    os.utime(stale, (old, old))
    os.utime(active, (old, old))
    monkeypatch.setattr(
        utils,
        "get_settings",
        lambda: SimpleNamespace(work_dir=str(tmp_path)),
    )
    utils.register_temp_path(active)

    try:
        assert utils.cleanup_stale_temp_files(max_age_sec=60) == 1
        assert not stale.exists()
        assert active.exists()
    finally:
        utils.cleanup_temp_path(active)
