from __future__ import annotations

from pathlib import Path


SETUP = Path(__file__).resolve().parents[1] / "setup.ps1"


def test_setup_normalizes_tauri_extended_length_paths_before_join_path():
    script = SETUP.read_text(encoding="utf-8")

    assert "function ConvertFrom-ExtendedPath" in script
    assert "$Path.Substring(8)" in script
    assert "$Path.Substring(4)" in script
    assert "$ScriptPath = ConvertFrom-ExtendedPath" in script
    assert "$BackendDir = [IO.Path]::GetDirectoryName($ScriptPath)" in script
    assert 'Join-Path $BackendDir "requirements-core.txt"' in script
