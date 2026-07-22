"""Build category-safe caption font subsets used by the packaged app.

Full source fonts stay in ``src/assets/fonts``. Vite references only the output
directory, so installers do not carry large CJK glyph tables in fonts catalogued
for Vietnamese text. Run after adding/updating a font.
"""
from __future__ import annotations

import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "src/engine/text/font-catalog.ts"
SOURCE = ROOT / "src/assets/fonts"
OUTPUT = ROOT / "src/assets/fonts-subset"

COMMON = (
    "U+0000-024F,"  # ASCII + Latin-1 + Latin Extended A/B
    "U+0300-036F,"  # combining marks used by decomposed Vietnamese text
    "U+1E00-1EFF,"  # Latin Extended Additional (Vietnamese precomposed glyphs)
    "U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+25A0-27BF,"  # symbols/dingbats
    "U+1F300-1FAFF"  # emoji/symbol glyphs when the source face provides them
)
UNICODES = {
    "vn": COMMON,
    "jp": COMMON
    + ",U+2E80-2FFF,U+3000-30FF,U+31F0-31FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF",
    "kr": COMMON
    + ",U+3000-303F,U+1100-11FF,U+3130-318F,U+A960-A97F,U+AC00-D7AF,U+D7B0-D7FF,U+FF00-FFEF",
}


def catalog_entries() -> list[tuple[str, str]]:
    text = CATALOG.read_text(encoding="utf-8")
    entries: list[tuple[str, str]] = []
    for block in re.findall(r"\{[^{}]*\}", text, flags=re.DOTALL):
        file_match = re.search(r"\bfile:\s*'([^']*)'", block)
        category_match = re.search(r"\bcat:\s*'(vn|jp|kr)'", block)
        if file_match and category_match and file_match.group(1):
            entries.append((file_match.group(1), category_match.group(1)))
    return entries


def subset_one(name: str, category: str) -> tuple[int, int]:
    source = SOURCE / name
    target = OUTPUT / name
    if not source.is_file():
        raise FileNotFoundError(f"Catalog font is missing: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.subset")
    temporary.unlink(missing_ok=True)
    args = [
        str(source),
        f"--output-file={temporary}",
        f"--unicodes={UNICODES[category]}",
        "--layout-features=*",
        "--glyph-names",
        "--symbol-cmap",
        "--legacy-cmap",
        "--notdef-glyph",
        "--notdef-outline",
        "--recommended-glyphs",
        "--name-IDs=*",
        "--name-languages=*",
        "--no-recalc-timestamp",
    ]
    subset.main(args)
    # A parse round-trip catches corrupt output before replacing a usable file.
    with TTFont(temporary, lazy=False) as font:
        if "cmap" not in font or "name" not in font:
            raise RuntimeError(f"Invalid subset generated for {name}")
    temporary.replace(target)
    return source.stat().st_size, target.stat().st_size


def main() -> None:
    entries = catalog_entries()
    if not entries:
        raise RuntimeError("No caption fonts found in catalog")
    before = after = 0
    for name, category in entries:
        source_size, target_size = subset_one(name, category)
        before += source_size
        after += target_size
        print(f"{category}: {name}: {source_size / 1e6:.2f} -> {target_size / 1e6:.2f} MB")
    print(f"TOTAL: {before / 1e6:.2f} -> {after / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
