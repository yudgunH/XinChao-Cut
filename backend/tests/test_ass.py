"""Tests for ASS caption generation — focus on style sharing (the per-cue style
explosion that OOM'd libass on long captioned exports)."""
from __future__ import annotations

import re

from app.export.ass import build_ass


def _cue(i: float, **td):
    base = {"content": f"line {int(i)}", "fontSize": 54, "color": "#ffffff"}
    base.update(td)
    return {"startSec": i, "durationSec": 1.0, "textData": base}


def _count(ass: str, prefix: str) -> int:
    return sum(1 for line in ass.splitlines() if line.startswith(prefix))


def test_identical_cues_share_one_style():
    # 200 cues that look the same → ONE style, but all 200 events kept.
    cues = [_cue(i * 1.5) for i in range(200)]
    ass = build_ass(1920, 1080, cues)
    assert _count(ass, "Style:") == 1
    assert _count(ass, "Dialogue:") == 200


def test_distinct_looks_get_distinct_styles():
    cues = [
        _cue(0, color="#ffffff"),
        _cue(2, color="#ff0000"),               # different colour
        _cue(4, hasBackground=True),            # opaque box
        _cue(6, color="#ffffff"),               # same as the first → shared
    ]
    ass = build_ass(1920, 1080, cues)
    assert _count(ass, "Style:") == 3
    assert _count(ass, "Dialogue:") == 4


def test_every_event_references_a_defined_style():
    cues = [_cue(0, color="#ffffff"), _cue(2, color="#00ff00", hasBackground=True)]
    ass = build_ass(1280, 720, cues)
    defined = set(re.findall(r"^Style: ([^,]+),", ass, re.MULTILINE))
    used = set(re.findall(r"^Dialogue: \d+,[^,]+,[^,]+,([^,]+),", ass, re.MULTILINE))
    assert used and used <= defined
