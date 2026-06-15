"""Tests for the /export Pydantic request schema + endpoint guards (TASK-14)."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.routers.export import ExportSpec


def _spec(**over):
    base = {
        "width": 1920, "height": 1080, "fps": 30,
        "durationSec": 5.0, "videoBitrateKbps": 8000,
        "tracks": [{"id": "v1", "kind": "video", "muted": False}],
        "clips": [{
            "id": "c1", "assetId": "abc", "trackId": "v1", "kind": "video",
            "startSec": 0.0, "inPointSec": 0.0, "outPointSec": 5.0, "speed": 1.0,
            "opacity": 1.0, "transform": {"scale": 1.2}, "effects": [{"type": "fade-in"}],
        }],
    }
    base.update(over)
    return base


def test_valid_spec_preserves_nested_extras():
    """extra='allow' must keep transform/effects/opacity for build_command."""
    d = ExportSpec(**_spec()).model_dump()
    clip = d["clips"][0]
    assert clip["transform"] == {"scale": 1.2}
    assert clip["effects"] == [{"type": "fade-in"}]
    assert clip["opacity"] == 1.0
    assert clip["assetId"] == "abc"


@pytest.mark.parametrize("over", [
    {"clips": []},                 # empty timeline
    {"durationSec": 0},            # non-positive duration
    {"durationSec": -1},
    {"width": 0},                  # non-positive dims
    {"width": 99999},              # absurd dims
    {"fps": 0},
    {"clips": [{"id": "c1", "trackId": "v1", "kind": "video", "speed": 0}]},  # speed must be > 0
    {"clips": [{"trackId": "v1", "kind": "video"}]},  # missing required clip id
])
def test_invalid_specs_rejected(over):
    with pytest.raises(ValidationError):
        ExportSpec(**_spec(**over))


def test_defaults_applied():
    s = ExportSpec(
        width=1280, height=720, durationSec=3,
        clips=[{"id": "c", "trackId": "t", "kind": "video"}],
    )
    assert s.fps == 30
    assert s.videoBitrateKbps == 8000
    assert s.tracks == []
