import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.routers import translate


def test_translate_body_rejects_oversized_line():
    with pytest.raises(ValidationError):
        translate.TranslateBody(texts=["x" * (translate._MAX_ITEM_CHARS + 1)], target="en")


def test_translate_body_rejects_oversized_total():
    # Each line under the per-item cap but total exceeds the sum cap.
    long_line = "x" * translate._MAX_ITEM_CHARS
    n = (translate._MAX_TOTAL_CHARS // translate._MAX_ITEM_CHARS) + 1
    with pytest.raises(ValidationError):
        translate.TranslateBody(texts=[long_line] * n, target="en")


def test_translate_body_accepts_reasonable_batch():
    body = translate.TranslateBody(texts=["hello"] * 10, target="en")
    assert len(body.texts) == 10


@pytest.mark.parametrize(
    ("provider", "base_url"),
    [
        ("custom", "https://llm.example.invalid/v1"),
        ("openrouter", "https://openrouter.ai/api/v1"),
    ],
)
def test_openai_compatible_calls_disable_streaming(monkeypatch, provider, base_url):
    captured: dict = {}

    def fake_http_post(url: str, headers: dict, body: dict, **_kw) -> dict:
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = body
        return {"choices": [{"message": {"content": '{"translations":["xin chao"]}'}}]}

    monkeypatch.setattr(translate, "_http_post", fake_http_post)

    reply = translate._call_llm(
        provider,
        base_url,
        "sk-test",
        "xai/grok-4.5",
        "Translate hello",
    )

    assert reply == '{"translations":["xin chao"]}'
    assert captured["url"] == f"{base_url}/chat/completions"
    assert captured["body"]["stream"] is False


@pytest.mark.parametrize(
    ("provider", "response"),
    [
        (
            "gemini",
            {
                "candidates": [
                    {"content": {"parts": [{"text": '{"translations":'}, {"text": '["xin chao"]}'}]}}
                ]
            },
        ),
        (
            "anthropic",
            {"content": [{"type": "text", "text": '{"translations":'}, {"type": "text", "text": '["xin chao"]}'}]},
        ),
    ],
)
def test_provider_multiblock_text_is_not_truncated(monkeypatch, provider, response):
    monkeypatch.setattr(translate, "_http_post", lambda *_a, **_k: response)

    reply = translate._call_llm(
        provider,
        None,
        "key",
        "model",
        "Translate hello",
    )

    assert reply == '{"translations":["xin chao"]}'


def test_http_post_timeout_is_502(monkeypatch):
    """httpx/socket timeout must become HTTPException 502, not leak as 500."""
    import httpx

    calls = 0

    class _BoomClient:
        def __init__(self, *a, **k):
            pass

        def stream(self, *a, **k):
            nonlocal calls
            calls += 1
            raise httpx.ReadTimeout("The read operation timed out")

        def close(self):
            pass

        @property
        def is_closed(self):
            return True

    monkeypatch.setattr(httpx, "Client", _BoomClient)
    # No retry delay in unit tests
    monkeypatch.setattr(
        "app.llm_call.backoff_delay", lambda *a, **k: 0.0
    )
    with pytest.raises(HTTPException) as ei:
        translate._http_post("https://example.com/v1/chat", {}, {"model": "x"})
    assert ei.value.status_code == 502
    assert "timed out" in str(ei.value.detail).lower()
    assert calls == 1, "an ambiguous 300s read timeout must not be billed/retried"


def test_http_post_rejects_oversized_provider_response_before_buffering(monkeypatch):
    import httpx

    real_client = httpx.Client
    declared = translate._MAX_PROVIDER_RESPONSE_BYTES + 1

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": str(declared)},
            content=b"{}",
        )

    def client_factory(*_args, **kwargs):
        return real_client(
            timeout=kwargs.get("timeout"),
            transport=httpx.MockTransport(handler),
        )

    monkeypatch.setattr(httpx, "Client", client_factory)
    with pytest.raises(HTTPException) as exc:
        translate._http_post("https://example.com/v1/chat", {}, {"model": "x"})

    assert exc.value.status_code == 502
    assert "16 MiB" in str(exc.value.detail)


def test_translate_chunk_retries_missing_lines(monkeypatch):
    calls: list[str] = []

    def fake_call_llm(
        provider: str, base_url: str | None, key: str, model: str, prompt: str, **_kw
    ) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return '{"translations":["eins",""]}'
        return '{"translations":["zwei","drei"]}'

    monkeypatch.setattr(translate, "_call_llm", fake_call_llm)

    out = translate._translate_chunk(
        "openrouter",
        None,
        "key",
        "model",
        ["one", "two", "three"],
        "German",
        "English",
    )

    assert out == ["eins", "zwei", "drei"]
    assert len(calls) == 2


def test_translate_chunk_retries_non_string_provider_values(monkeypatch):
    calls = 0

    def fake_call_llm(
        provider: str, base_url: str | None, key: str, model: str, prompt: str, **_kw
    ) -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            return '{"translations":[null,{"unexpected":"object"},"three"]}'
        return '{"translations":["one","two"]}'

    monkeypatch.setattr(translate, "_call_llm", fake_call_llm)

    out = translate._translate_chunk(
        "openrouter",
        None,
        "key",
        "model",
        ["one", "two", "three"],
        "English",
        "English",
    )

    assert out == ["one", "two", "three"]
    assert calls == 2


def test_translate_chunk_raises_when_retry_still_missing(monkeypatch):
    def fake_call_llm(
        provider: str, base_url: str | None, key: str, model: str, prompt: str, **_kw
    ) -> str:
        return '{"translations":[""]}'

    monkeypatch.setattr(translate, "_call_llm", fake_call_llm)

    with pytest.raises(HTTPException) as exc:
        translate._translate_chunk(
            "openrouter",
            None,
            "key",
            "model",
            ["one"],
            "German",
            "English",
        )

    assert exc.value.status_code == 502
    assert "empty/missing" in exc.value.detail


def test_caption_correction_parser_preserves_ids_and_rejects_partial_reply():
    parsed = translate._parse_caption_corrections(
        '{"corrections":{"c2":"Bạn khỏe không?","c1":"Xin chào."}}',
        ["c1", "c2"],
    )
    assert list(parsed) == ["c1", "c2"]
    assert parsed["c1"] == "Xin chào."

    with pytest.raises(HTTPException) as exc:
        translate._parse_caption_corrections(
            '{"corrections":{"c1":"Xin chào."}}', ["c1", "c2"]
        )
    assert exc.value.status_code == 502
    assert "missing 1 cue" in str(exc.value.detail)


def test_caption_correction_body_rejects_duplicate_ids():
    with pytest.raises(ValidationError):
        translate.CorrectCaptionsBody(
            cues=[
                {"id": "same", "content": "first"},
                {"id": "same", "content": "second"},
            ],
            language="vietnamese",
        )


def test_caption_correction_prompt_is_proofreading_not_translation():
    prompt = translate._build_caption_correction_prompt(
        [{"id": "c1", "content": "toi khoe"}], "Vietnamese", "Tên riêng: Minh"
    )
    assert "DO NOT translate" in prompt
    assert "Never merge, split, reorder" in prompt
    assert "Tên riêng: Minh" in prompt


def test_caption_correction_endpoint_returns_id_keyed_atomic_result(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(
        translate,
        "_select_provider",
        lambda _task: ("custom", "http://local/v1", "", "proofreader"),
    )
    monkeypatch.setattr(
        translate,
        "_call_llm",
        lambda *_args, **_kwargs: (
            '{"corrections":{"c1":"Tôi khỏe.","c2":"Còn bạn?"}}'
        ),
    )
    app = FastAPI()
    app.include_router(translate.router)
    response = TestClient(app).post(
        "/captions/correct",
        json={
            "cues": [
                {"id": "c1", "content": "toi khoe"},
                {"id": "c2", "content": "con ban"},
            ],
            "language": "vietnamese",
            "context_before": ["Xin chào"],
        },
    )
    assert response.status_code == 200
    assert response.json()["corrections"] == {
        "c1": "Tôi khỏe.",
        "c2": "Còn bạn?",
    }
