"""Shared AI-provider configuration (the "AI settings" framework).

The editor caption-translation task has its own provider, base URL, API key,
and model. A missing saved override falls back to environment/backend/.env.

Resolution order per task:
  1. In-app config saved via POST /ai-config → <work_dir>/ai-config.json, tasks.<task>
  2. Environment / backend/.env keys (GEMINI_API_KEY, OPENAI_API_KEY, …) — back-compat,
     shared across any task that has no saved override.

The backend makes the actual provider calls, so API keys live here (server
side), never in the browser. GET /ai-config never returns key material, only
`hasKey` per task.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import get_settings

router = APIRouter(tags=["ai-config"])

PROVIDERS = ("gemini", "openai", "anthropic", "openrouter", "custom")

# Independent editor AI tasks. More can be added without changing the storage shape.
TASKS = ("translate",)

# Defaults the user can override. `custom` = any OpenAI-compatible endpoint
# (OpenRouter, a local LLM server, etc.) — base URL required, key optional.
DEFAULT_MODEL = {
    "gemini": "gemini-2.0-flash",
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-latest",
    "openrouter": "google/gemini-2.5-flash",
    "custom": "",
}
DEFAULT_BASE = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "custom": "",
}


def _config_path() -> str:
    return os.path.join(os.path.abspath(get_settings().work_dir), "ai-config.json")


def _valid_entry(provider: str, base_url: str, api_key: str) -> bool:
    if provider not in PROVIDERS:
        return False
    # A cloud provider needs a key; a custom/local endpoint just needs a base URL.
    if (api_key or "").strip():
        return True
    return provider == "custom" and bool((base_url or "").strip())


def _migrate_legacy(raw: dict) -> dict:
    """Old shape: one shared {provider,baseUrl,apiKey,model} + per-task `models`
    (name overrides only). Convert to {tasks: {task: {provider,baseUrl,apiKey,model}}}
    so every task that used to share the one connection keeps working identically."""
    if "tasks" in raw:
        return raw
    provider = raw.get("provider")
    if not provider:
        return {"tasks": {}}
    base_url = raw.get("baseUrl", "")
    api_key = raw.get("apiKey", "")
    default_model = raw.get("model", "")
    models = raw.get("models") or {}
    tasks = {
        t: {
            "provider": provider,
            "baseUrl": base_url,
            "apiKey": api_key,
            "model": (models.get(t) or default_model),
        }
        for t in TASKS
    }
    return {"tasks": tasks}


def _load_raw() -> dict:
    try:
        with open(_config_path(), encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:  # noqa: BLE001
        return {"tasks": {}}
    return _migrate_legacy(raw) if isinstance(raw, dict) else {"tasks": {}}


def _write_raw(raw: dict) -> None:
    path = _config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f)
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    # 0600 so another user on a shared box can't read plaintext API keys.
    # Windows only honours the write bit here — still better than the default.
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


_CONFIG_LOCK = threading.RLock()


def save_config(incoming_tasks: dict[str, dict]) -> dict:
    """Merge `incoming_tasks` (task → {provider,baseUrl,apiKey,model}) into the
    saved file. An entry with an empty provider CLEARS that task's override
    (falls back to env). An entry with a blank apiKey keeps the previously
    stored key for that task IF the provider is unchanged — editing the model /
    base URL shouldn't force re-typing the secret (GET never returns it)."""
    with _CONFIG_LOCK:
        raw = _load_raw()
        tasks = dict(raw.get("tasks") or {})
        for task, body in incoming_tasks.items():
            provider = (body.get("provider") or "").strip()
            if not provider:
                tasks.pop(task, None)
                continue
            api_key = (body.get("apiKey") or "").strip()
            if not api_key:
                old = tasks.get(task) or {}
                if old.get("provider") == provider:
                    api_key = old.get("apiKey", "")
            tasks[task] = {
                "provider": provider,
                "baseUrl": (body.get("baseUrl") or "").strip(),
                "apiKey": api_key,
                "model": (body.get("model") or "").strip(),
            }
        cfg = {"tasks": tasks}
        _write_raw(cfg)
        return cfg


def _effective_entry_for_save(task: str, body: TaskConfigBody) -> dict:
    """Return the entry as it will exist after save_config(), including the
    preserved secret when the UI submits a blank apiKey for the same provider."""
    provider = body.provider.strip()
    if not provider:
        return {"provider": "", "baseUrl": "", "apiKey": "", "model": ""}
    api_key = body.apiKey.strip()
    if not api_key:
        old = (_load_raw().get("tasks") or {}).get(task) or {}
        if old.get("provider") == provider:
            api_key = old.get("apiKey", "")
    return {
        "provider": provider,
        "baseUrl": body.baseUrl.strip(),
        "apiKey": api_key,
        "model": body.model.strip(),
    }


def clear_task(task: str) -> None:
    with _CONFIG_LOCK:
        raw = _load_raw()
        (raw.get("tasks") or {}).pop(task, None)
        _write_raw(raw)


def clear_all() -> None:
    with _CONFIG_LOCK:
        try:
            os.remove(_config_path())
        except OSError:
            pass


def _env(name: str) -> str | None:
    """Read from process env, falling back to backend/.env (unprefixed keys)."""
    v = os.environ.get(name)
    if v:
        return v.strip() or None
    try:
        envfile = Path(__file__).resolve().parents[2] / ".env"  # routers → app → backend
        if envfile.is_file():
            for line in envfile.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, val = line.partition("=")
                if k.strip() == name:
                    return val.strip().strip('"').strip("'") or None
    except Exception:  # noqa: BLE001
        pass
    return None


_TASK_ENV = {"translate": "TRANSLATE"}


def _model_env(provider_prefix: str, task: str) -> str | None:
    """Pick a model env var for this task on this provider: the task-specific
    override first, then the historic _TRANSLATE_MODEL fallback (kept so users
    who only ever set the old var keep the same behaviour)."""
    task_key = _TASK_ENV.get(task)
    if task_key:
        v = _env(f"{provider_prefix}_{task_key}_MODEL")
        if v:
            return v
    return _env(f"{provider_prefix}_TRANSLATE_MODEL")


def _env_resolve(task: str) -> tuple[str, str | None, str, str] | None:
    """Shared env-var fallback — used by any task with no saved override.
    Provider preference: Gemini → OpenAI → Anthropic → OpenRouter. Model picks
    the task-specific override first."""
    key = _env("GEMINI_API_KEY") or _env("GOOGLE_API_KEY")
    if key:
        return "gemini", None, key, _model_env("GEMINI", task) or DEFAULT_MODEL["gemini"]
    key = _env("OPENAI_API_KEY")
    if key:
        return "openai", DEFAULT_BASE["openai"], key, _model_env("OPENAI", task) or DEFAULT_MODEL["openai"]
    key = _env("ANTHROPIC_API_KEY")
    if key:
        return "anthropic", None, key, _model_env("ANTHROPIC", task) or DEFAULT_MODEL["anthropic"]
    key = _env("OPENROUTER_API_KEY")
    if key:
        base = (_env("OPENROUTER_BASE_URL") or DEFAULT_BASE["openrouter"]).rstrip("/")
        return "openrouter", base, key, _model_env("OPENROUTER", task) or DEFAULT_MODEL["openrouter"]
    return None


def resolve(task: str) -> tuple[str, str | None, str, str] | None:
    """(provider, base_url, api_key, model) for this task's OWN connection if
    configured, else the shared env fallback, else None."""
    task_cfg = (_load_raw().get("tasks") or {}).get(task) or {}
    provider = (task_cfg.get("provider") or "").strip()
    if provider and _valid_entry(provider, task_cfg.get("baseUrl", ""), task_cfg.get("apiKey", "")):
        base = (task_cfg.get("baseUrl") or "").strip() or DEFAULT_BASE.get(provider) or None
        model = (task_cfg.get("model") or "").strip() or DEFAULT_MODEL.get(provider, "")
        return provider, base, task_cfg.get("apiKey", ""), model
    return _env_resolve(task)


def _task_status(task: str) -> dict:
    task_cfg = (_load_raw().get("tasks") or {}).get(task) or {}
    provider = (task_cfg.get("provider") or "").strip()
    if provider and _valid_entry(provider, task_cfg.get("baseUrl", ""), task_cfg.get("apiKey", "")):
        return {
            "provider": provider,
            "baseUrl": (task_cfg.get("baseUrl") or "").strip(),
            "model": (task_cfg.get("model") or "").strip() or DEFAULT_MODEL.get(provider, ""),
            "hasKey": bool(task_cfg.get("apiKey")),
            "source": "config",
        }
    r = _env_resolve(task)
    if r:
        return {"provider": r[0], "baseUrl": r[1] or "", "model": r[3], "hasKey": bool(r[2]), "source": "env"}
    return {"provider": "", "baseUrl": "", "model": "", "hasKey": False, "source": "none"}


def _summary() -> dict:
    return {
        "providers": list(PROVIDERS),
        "tasks": list(TASKS),
        "defaultModels": DEFAULT_MODEL,
        "defaultBase": DEFAULT_BASE,
        "taskConfigs": {t: _task_status(t) for t in TASKS},
    }


class TaskConfigBody(BaseModel):
    provider: str = ""
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""


class AiConfigBody(BaseModel):
    tasks: dict[str, TaskConfigBody] = {}


@router.get("/ai-config")
def get_ai_config() -> dict:
    return _summary()


@router.post("/ai-config")
def set_ai_config(body: AiConfigBody) -> dict:
    for task, entry in body.tasks.items():
        if task not in TASKS:
            raise HTTPException(status_code=422, detail=f"Unknown task: {task}")
        effective = _effective_entry_for_save(task, entry)
        provider = effective["provider"]
        if provider and not _valid_entry(provider, effective["baseUrl"], effective["apiKey"]):
            raise HTTPException(
                status_code=422,
                detail=f"{task}: cần API key (hoặc với 'custom' thì cần base URL).",
            )
    save_config({t: e.model_dump() for t, e in body.tasks.items()})
    return _summary()


@router.post("/ai-config/test/{task}")
def test_task_config(task: str) -> dict:
    """Verify one configured task can reach its provider/model. This is a small
    text-only round-trip that catches bad keys, base URLs, and model ids."""
    if task not in TASKS:
        raise HTTPException(status_code=422, detail=f"Unknown task: {task}")
    resolved = resolve(task)
    if not resolved:
        return {"ok": False, "task": task, "provider": None, "error": "No API key configured"}
    provider, base_url, key, model = resolved
    try:
        from .translate import _build_prompt, _call_llm, _parse_translations

        reply = _call_llm(
            provider,
            base_url,
            key,
            model,
            _build_prompt([f"Connection test for {task}."], "Vietnamese", "English"),
        )
        sample = _parse_translations(reply, 1)[0]
        return {"ok": True, "task": task, "provider": provider, "model": model, "sample": sample}
    except HTTPException as e:
        return {"ok": False, "task": task, "provider": provider, "model": model, "error": str(e.detail)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "task": task, "provider": provider, "model": model, "error": str(e)[:300]}


@router.delete("/ai-config/{task}")
def delete_task_config(task: str) -> dict:
    if task not in TASKS:
        raise HTTPException(status_code=422, detail=f"Unknown task: {task}")
    clear_task(task)
    return _summary()


@router.delete("/ai-config")
def delete_all_config() -> dict:
    clear_all()
    return _summary()
