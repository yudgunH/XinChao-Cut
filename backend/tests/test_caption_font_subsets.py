"""Regression tests for generated caption-font subsets."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytest.importorskip("fontTools.ttLib", reason="fontTools required")
from fontTools.ttLib import TTFont  # noqa: E402


ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "src/engine/text/font-catalog.ts"
SOURCE = ROOT / "src/assets/fonts"
SUBSETS = ROOT / "src/assets/fonts-subset"
REPRESENTATIVE_CODEPOINTS = {
    "vn": "Aaăâđêôơưựỵ.,!?₫★😀",
    "jp": "Aaあア日本。、★😀",
    "kr": "Aa한글。、★😀",
}


def _catalog_entries() -> list[tuple[str, str]]:
    text = CATALOG.read_text(encoding="utf-8")
    entries: list[tuple[str, str]] = []
    for block in re.findall(r"\{[^{}]*\}", text, flags=re.DOTALL):
        file_match = re.search(r"\bfile:\s*'([^']*)'", block)
        category_match = re.search(r"\bcat:\s*'(vn|jp|kr)'", block)
        if file_match and category_match and file_match.group(1):
            entries.append((file_match.group(1), category_match.group(1)))
    return entries


def test_catalog_parser_survives_multiline_prettier_formatting() -> None:
    sample = """{\n  family: 'X',\n  file: 'x.ttf',\n  cat: 'vn',\n}"""
    file_match = re.search(r"\bfile:\s*'([^']*)'", sample)
    category_match = re.search(r"\bcat:\s*'(vn|jp|kr)'", sample)
    assert (file_match.group(1), category_match.group(1)) == ("x.ttf", "vn")


def _codepoints(path: Path) -> set[int]:
    with TTFont(path, lazy=False) as font:
        assert "name" in font
        assert "cmap" in font
        return set(font.getBestCmap() or {})


def test_every_catalog_font_has_valid_subset_with_representative_glyphs() -> None:
    entries = _catalog_entries()
    assert entries
    for filename, category in entries:
        source = SOURCE / filename
        subset = SUBSETS / filename
        assert source.is_file(), f"missing source font: {filename}"
        assert subset.is_file(), f"run npm run fonts:subset: {filename}"
        source_codepoints = _codepoints(source)
        subset_codepoints = _codepoints(subset)
        representative = {ord(char) for char in REPRESENTATIVE_CODEPOINTS[category]}
        # Subsetting cannot manufacture glyphs absent from a source font, but it
        # must preserve every requested representative glyph the source has.
        assert source_codepoints & representative <= subset_codepoints
        assert subset.stat().st_size <= source.stat().st_size


def test_packaged_font_budget() -> None:
    total = sum((SUBSETS / filename).stat().st_size for filename, _ in _catalog_entries())
    assert total <= 25 * 1024 * 1024
