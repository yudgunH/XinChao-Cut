from __future__ import annotations

import errno

import pytest

from app import utils


def _force_cross_volume(*_args, **_kwargs) -> None:
    raise OSError(errno.EXDEV, "cross-device link")


def test_cross_volume_copy_publishes_complete_file(monkeypatch, tmp_path) -> None:
    source = tmp_path / "source.mp4"
    target = tmp_path / "job" / "original.mp4"
    source.write_bytes(b"new-video" * 1024)
    target.parent.mkdir()
    target.write_bytes(b"previous-good-output")
    monkeypatch.setattr(utils.os, "link", _force_cross_volume)

    assert utils.link_or_copy(str(source), str(target)) == str(target.resolve())
    assert target.read_bytes() == source.read_bytes()
    assert not list(target.parent.glob("*.part-*"))


def test_cancelled_cross_volume_copy_keeps_previous_output(monkeypatch, tmp_path) -> None:
    source = tmp_path / "source.mp4"
    target = tmp_path / "job" / "original.mp4"
    source.write_bytes(b"new-video" * 1024)
    target.parent.mkdir()
    target.write_bytes(b"previous-good-output")
    monkeypatch.setattr(utils.os, "link", _force_cross_volume)

    with pytest.raises(utils.FileCopyCancelled):
        utils.link_or_copy(str(source), str(target), cancel_check=lambda: True)

    assert target.read_bytes() == b"previous-good-output"
    assert not list(target.parent.glob("*.part-*"))
