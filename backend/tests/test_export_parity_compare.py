from __future__ import annotations

import importlib.util
from pathlib import Path

from PIL import Image


_SCRIPT = Path(__file__).parents[1] / "scripts" / "compare_export_parity.py"
_SPEC = importlib.util.spec_from_file_location("compare_export_parity", _SCRIPT)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_normalized_mae_identical_frames_are_zero():
    frame = Image.new("RGB", (2, 2), (10, 20, 30))
    assert _MODULE.normalized_mae(frame, frame.copy()) == 0


def test_normalized_mae_is_channel_normalized():
    black = Image.new("RGB", (1, 1), (0, 0, 0))
    white = Image.new("RGB", (1, 1), (255, 255, 255))
    red = Image.new("RGB", (1, 1), (255, 0, 0))
    assert _MODULE.normalized_mae(black, white) == 1
    assert _MODULE.normalized_mae(black, red) == 1 / 3
