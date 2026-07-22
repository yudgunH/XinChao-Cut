from __future__ import annotations

from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]


def test_core_requirements_cover_unconditional_http_client_import():
    """app.main always imports the translation router, which imports httpx."""
    requirements = (BACKEND / "requirements-core.txt").read_text(encoding="utf-8")
    assert "httpx==0.28.1" in requirements
