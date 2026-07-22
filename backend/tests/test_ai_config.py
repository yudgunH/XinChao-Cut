import json

import pytest
from fastapi import HTTPException

from app.routers import ai_config


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    path = tmp_path / "ai-config.json"
    monkeypatch.setattr(ai_config, "_config_path", lambda: str(path))
    ai_config.clear_all()
    yield path
    ai_config.clear_all()


def test_translate_connection_round_trip():
    ai_config.save_config({
        "translate": {
            "provider": "openrouter",
            "baseUrl": "",
            "apiKey": "sk-test",
            "model": "test-model",
        }
    })
    assert ai_config.resolve("translate") == (
        "openrouter",
        "https://openrouter.ai/api/v1",
        "sk-test",
        "test-model",
    )


def test_summary_never_leaks_api_key():
    ai_config.save_config({
        "translate": {
            "provider": "openrouter",
            "apiKey": "sk-secret",
            "model": "test-model",
        }
    })
    summary = ai_config.get_ai_config()
    assert "sk-secret" not in json.dumps(summary)
    assert summary["tasks"] == ["translate"]
    assert summary["taskConfigs"]["translate"]["hasKey"] is True


def test_unknown_task_is_rejected():
    with pytest.raises(HTTPException) as caught:
        ai_config.set_ai_config(ai_config.AiConfigBody(tasks={
            "unknown": ai_config.TaskConfigBody(provider="openrouter", apiKey="x"),
        }))
    assert caught.value.status_code == 422


def test_blank_key_preserves_saved_key_for_same_provider():
    ai_config.save_config({
        "translate": {
            "provider": "openrouter",
            "apiKey": "sk-original",
            "model": "model-1",
        }
    })
    ai_config.set_ai_config(ai_config.AiConfigBody(tasks={
        "translate": ai_config.TaskConfigBody(provider="openrouter", model="model-2"),
    }))
    assert ai_config.resolve("translate")[-2:] == ("sk-original", "model-2")


def test_clear_translate_config():
    ai_config.save_config({
        "translate": {
            "provider": "custom",
            "baseUrl": "http://localhost:1234/v1",
            "apiKey": "",
            "model": "local-model",
        }
    })
    ai_config.clear_task("translate")
    assert ai_config.resolve("translate") is None
