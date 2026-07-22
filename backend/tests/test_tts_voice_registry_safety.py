from __future__ import annotations

import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from app.config import get_settings
from app.routers import tts


@pytest.fixture()
def voice_root(tmp_path, monkeypatch):
    root = tmp_path / "voices"
    monkeypatch.setenv("XINCHAO_TTS_VOICES_DIR", str(root))
    get_settings.cache_clear()
    root.mkdir()
    yield root
    get_settings.cache_clear()


def test_corrupt_registry_shape_fails_closed(voice_root):
    (voice_root / "voices.json").write_text("[]", encoding="utf-8")
    assert tts._load_registry() == {}


def test_registry_cannot_serve_or_delete_paths_outside_voice_root(
    voice_root, tmp_path,
):
    outside = tmp_path / "do-not-delete.pt"
    outside.write_bytes(b"secret")
    registry = {
        "voice_bad": {
            "name": "bad",
            "promptPath": str(outside),
            "previewPath": str(tmp_path / "do-not-delete.preview.wav"),
        }
    }
    (voice_root / "voices.json").write_text(json.dumps(registry), encoding="utf-8")

    assert tts.known_voice("voice_bad") is False
    with pytest.raises(HTTPException) as exc:
        tts.voice_preview("voice_bad")
    assert exc.value.status_code == 404

    assert tts.delete_voice("voice_bad") == {"ok": True}
    assert outside.read_bytes() == b"secret"
    assert tts._load_registry() == {}


def test_busy_create_voice_rolls_back_uploaded_and_reference_files(
    voice_root, monkeypatch,
):
    class BusySemaphore:
        @staticmethod
        def acquire(*, timeout):  # noqa: ARG004
            return False

        @staticmethod
        def release():
            raise AssertionError("unacquired semaphore must not be released")

    def fake_prep(_raw: str, ref_wav: str) -> bool:
        with open(ref_wav, "wb") as handle:
            handle.write(b"wav")
        return True

    monkeypatch.setattr(tts, "_omnivoice_python", lambda: "python")
    monkeypatch.setattr(tts, "tts_available", lambda: True)
    monkeypatch.setattr(tts, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(tts, "_prep_reference", fake_prep)
    monkeypatch.setattr(tts, "HEAVY_JOB_SEMAPHORE", BusySemaphore())

    upload = UploadFile(filename="sample.wav", file=io.BytesIO(b"source"))
    with pytest.raises(HTTPException) as exc:
        tts.create_voice(
            name="Test",
            gender="unknown",
            language="unknown",
            refText="hello",
            ref=upload,
        )
    assert exc.value.status_code == 503
    assert list(voice_root.iterdir()) == []


def test_reference_normalization_exception_removes_partial_files(
    voice_root, monkeypatch,
):
    def broken_prep(_raw: str, ref_wav: str) -> bool:
        with open(ref_wav, "wb") as handle:
            handle.write(b"partial")
        raise OSError("decoder failed")

    monkeypatch.setattr(tts, "_omnivoice_python", lambda: "python")
    monkeypatch.setattr(tts, "tts_available", lambda: True)
    monkeypatch.setattr(tts, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(tts, "_prep_reference", broken_prep)
    upload = UploadFile(filename="sample.wav", file=io.BytesIO(b"source"))

    with pytest.raises(OSError, match="decoder failed"):
        tts.create_voice(
            name="Test",
            gender="unknown",
            language="unknown",
            refText="hello",
            ref=upload,
        )
    assert list(voice_root.iterdir()) == []


def test_atomic_publish_preserves_previous_wav_when_copy_fails(
    tmp_path, monkeypatch,
):
    source = tmp_path / "source.wav"
    target = tmp_path / "preview.wav"
    source.write_bytes(b"complete")
    target.write_bytes(b"previous")

    def partial_then_fail(_source, temporary):
        with open(temporary, "wb") as handle:
            handle.write(b"partial")
        raise OSError("disk failed")

    monkeypatch.setattr(tts.shutil, "copyfile", partial_then_fail)
    with pytest.raises(OSError, match="disk failed"):
        tts._publish_copy_atomic(str(source), str(target))
    assert target.read_bytes() == b"previous"
    assert not list(tmp_path.glob("*.part"))


def test_preview_inflight_is_reserved_before_thread_start(monkeypatch):
    voice_id = "voice_race"
    observed: list[bool] = []

    class FakeThread:
        def __init__(self, *, target, daemon, name):  # noqa: ARG002
            self.target = target

        def start(self):
            with tts._PREVIEW_CACHE_LOCK:
                observed.append(voice_id in tts._PREVIEW_CACHE_INFLIGHT)

    monkeypatch.setattr(tts.threading, "Thread", FakeThread)
    try:
        tts._start_voice_preview_cache_job(voice_id, "prompt.pt", "preview.wav")
        assert observed == [True]
    finally:
        with tts._PREVIEW_CACHE_LOCK:
            tts._PREVIEW_CACHE_INFLIGHT.discard(voice_id)
