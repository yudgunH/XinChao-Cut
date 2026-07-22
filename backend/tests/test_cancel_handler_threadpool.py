"""Blocking process-tree cancellation must run in FastAPI's sync threadpool."""
from __future__ import annotations

import inspect

from app.routers import export, media, separate


def test_blocking_cancel_handlers_are_synchronous():
    assert not inspect.iscoroutinefunction(export.export_cancel)
    assert not inspect.iscoroutinefunction(separate.separation_cancel)
    assert not inspect.iscoroutinefunction(media.media_scenes_cancel)
