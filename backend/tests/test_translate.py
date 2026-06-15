import pytest
from fastapi import HTTPException

from backend.app.routers import translate


def test_translate_chunk_retries_missing_lines(monkeypatch):
    calls: list[str] = []

    def fake_call_llm(provider: str, key: str, model: str, prompt: str) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return '{"translations":["eins",""]}'
        return '{"translations":["zwei","drei"]}'

    monkeypatch.setattr(translate, "_call_llm", fake_call_llm)

    out = translate._translate_chunk(
        "openrouter",
        "key",
        "model",
        ["one", "two", "three"],
        "German",
        "English",
    )

    assert out == ["eins", "zwei", "drei"]
    assert len(calls) == 2


def test_translate_chunk_raises_when_retry_still_missing(monkeypatch):
    def fake_call_llm(provider: str, key: str, model: str, prompt: str) -> str:
        return '{"translations":[""]}'

    monkeypatch.setattr(translate, "_call_llm", fake_call_llm)

    with pytest.raises(HTTPException) as exc:
        translate._translate_chunk(
            "openrouter",
            "key",
            "model",
            ["one"],
            "German",
            "English",
        )

    assert exc.value.status_code == 502
    assert "empty/missing" in exc.value.detail
