from __future__ import annotations

import json

from app.routers import transcribe


def test_checkpoint_writes_determinate_progress(monkeypatch, tmp_path):
    path = tmp_path / "progress.json"
    monkeypatch.setenv("XINCHAO_ASR_PROGRESS_FILE", str(path))

    transcribe._checkpoint("asr-before")

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["stage"] == "asr-before"
    assert payload["pct"] == 22
    assert payload["estimated"] is False


def test_long_asr_estimate_is_marked_and_capped(tmp_path):
    path = tmp_path / "progress.json"
    transcribe._write_progress_file(str(path), "asr-before", 22)

    transcribe._advance_asr_estimate(str(path), 10_000, "small", 10_000)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["stage"] == "asr-estimate"
    assert payload["pct"] == 76
    assert payload["estimated"] is True


def test_idle_eviction_releases_expired_models(monkeypatch):
    model = object()
    monkeypatch.setattr(transcribe, "_asr_model", model)
    monkeypatch.setattr(transcribe, "_asr_key", ("small", "auto", "cuda", "float16"))
    monkeypatch.setattr(transcribe, "_last_used", 100.0)
    monkeypatch.setattr(transcribe, "_align_cache", {"zh": object()})
    empty_calls: list[bool] = []
    monkeypatch.setattr(transcribe, "_empty_cuda_cache", lambda: empty_calls.append(True))

    assert transcribe._evict_idle_models_if_due(now=219.0) is False
    assert transcribe._asr_model is model
    assert transcribe._evict_idle_models_if_due(now=221.0) is True
    assert transcribe._asr_model is None
    assert transcribe._asr_key is None
    assert transcribe._align_cache == {}
    assert empty_calls == [True]
