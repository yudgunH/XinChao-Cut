"""Tests for the export output-folder helpers (name sanitisation + path guard)."""
from __future__ import annotations

import os

import pytest
from fastapi import HTTPException

from app.routers import export as ex
from app.config import get_settings


def test_safe_basename_sanitises_and_adds_ext():
    assert ex._safe_basename("My Video") == "My Video.mp4"
    assert ex._safe_basename('a/b:c*?') == "a_b_c__.mp4"
    assert ex._safe_basename("clip.mp4") == "clip.mp4"      # no double extension
    assert ex._safe_basename(None) == "export.mp4"
    assert ex._safe_basename("   ") == "export.mp4"


def test_resolve_output_path_creates_dir(tmp_path):
    target = tmp_path / "Exports" / "sub"
    out = ex._resolve_output_path(str(target), "v")
    assert out == os.path.join(str(target), "v.mp4")
    assert target.is_dir()


def test_resolve_output_path_rejects_relative():
    with pytest.raises(HTTPException):
        ex._resolve_output_path("relative/dir", "v")


def test_resolve_output_path_refuses_work_dir():
    work = get_settings().work_dir
    with pytest.raises(HTTPException):
        ex._resolve_output_path(os.path.join(work, "exports"), "v")


def test_resolve_output_path_auto_increments(tmp_path):
    d = str(tmp_path)
    p1 = ex._resolve_output_path(d, "2406")
    assert os.path.basename(p1) == "2406.mp4"
    open(p1, "w").close()                       # simulate the first export existing
    p2 = ex._resolve_output_path(d, "2406")
    assert os.path.basename(p2) == "2406(1).mp4"
    open(p2, "w").close()
    p3 = ex._resolve_output_path(d, "2406")
    assert os.path.basename(p3) == "2406(2).mp4"
