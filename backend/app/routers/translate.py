"""Caption translation endpoint (LLM-backed, context-aware).

Instead of a heavy local model, this calls a hosted LLM (Gemini / OpenAI /
Anthropic — whichever API key is configured). It sends a batch of caption lines
in one request and asks the model to translate them *together* (so it sees the
surrounding context of split-across-cues sentences) while returning EXACTLY one
translation per input line — preserving the cue count and therefore the timing.

No model download, no torch — just an HTTP call. Set one of these in the
environment or in backend/.env:
    GEMINI_API_KEY   (or GOOGLE_API_KEY)   → gemini-2.0-flash
    OPENAI_API_KEY                         → gpt-4o-mini
    ANTHROPIC_API_KEY                      → claude-3-5-haiku-latest
    OPENROUTER_API_KEY                     → google/gemini-2.5-flash (any OpenRouter model)
Provider preference when several are set: Gemini → OpenAI → Anthropic → OpenRouter.
Override the model per provider with <PROVIDER>_TRANSLATE_MODEL (e.g.
OPENROUTER_TRANSLATE_MODEL=google/gemini-2.5-flash).
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)
router = APIRouter(tags=["translate"])

# Lines per LLM request. Keeps each call well within output-token limits while
# still giving the model plenty of in-batch context.
_BATCH = 80
_HTTP_TIMEOUT = 120
_OPENROUTER_DEFAULT_MODEL = "google/gemini-2.5-flash"
_OPENROUTER_MODEL_ALIASES = {
    "google/gemini-2.0-flash-001": _OPENROUTER_DEFAULT_MODEL,
}

# UI language id → human name the LLM understands. Also the target list.
_LANG_NAMES: dict[str, str] = {
    "english": "English",
    "vietnamese": "Vietnamese",
    "japanese": "Japanese",
    "chinese": "Chinese (Simplified)",
    "korean": "Korean",
    "french": "French",
    "spanish": "Spanish",
    "german": "German",
    "russian": "Russian",
    "portuguese": "Portuguese",
    "italian": "Italian",
    "thai": "Thai",
    "indonesian": "Indonesian",
    "hindi": "Hindi",
    "arabic": "Arabic",
}


def _env(name: str) -> str | None:
    """Read a var from the process env, falling back to backend/.env (pydantic's
    XINCHAO_-prefixed settings don't expose unprefixed keys like OPENAI_API_KEY)."""
    v = os.environ.get(name)
    if v:
        return v.strip() or None
    try:
        # routers → app → backend
        envfile = Path(__file__).resolve().parents[2] / ".env"
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


def _select_provider() -> tuple[str, str, str] | None:
    """(provider, api_key, model) for the first configured provider, else None."""
    key = _env("GEMINI_API_KEY") or _env("GOOGLE_API_KEY")
    if key:
        return "gemini", key, _env("GEMINI_TRANSLATE_MODEL") or "gemini-2.0-flash"
    key = _env("OPENAI_API_KEY")
    if key:
        return "openai", key, _env("OPENAI_TRANSLATE_MODEL") or "gpt-4o-mini"
    key = _env("ANTHROPIC_API_KEY")
    if key:
        return "anthropic", key, _env("ANTHROPIC_TRANSLATE_MODEL") or "claude-3-5-haiku-latest"
    key = _env("OPENROUTER_API_KEY")
    if key:
        model = _env("OPENROUTER_TRANSLATE_MODEL") or _OPENROUTER_DEFAULT_MODEL
        return "openrouter", key, _OPENROUTER_MODEL_ALIASES.get(model, model)
    return None


def translate_available() -> bool:
    """True when at least one LLM provider key is configured."""
    return _select_provider() is not None


def _http_post(url: str, headers: dict, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise HTTPException(status_code=502, detail=f"Translation provider error {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach translation provider: {e.reason}")


def _build_prompt(lines: list[str], target_name: str, source_name: str | None) -> str:
    src = f"The source language is {source_name}. " if source_name else ""
    return (
        "You are a professional subtitle translator. "
        f"{src}Translate every line in the INPUT array into {target_name}.\n"
        "Rules:\n"
        f'- Return ONLY a JSON object: {{"translations": [...]}} with EXACTLY {len(lines)} '
        "strings, one per input line, in the same order.\n"
        "- The lines are consecutive subtitles forming continuous speech: use the full "
        "context across lines, but keep each line separate — do NOT merge, split, reorder, "
        "or add/remove lines.\n"
        "- Never return an empty string for a non-empty input line. If a line is already "
        "in the target language or has no translatable words, return it unchanged.\n"
        "- Keep each translation concise and natural for on-screen subtitles.\n"
        "- Preserve numbers and proper nouns. Output no commentary.\n"
        f"INPUT:\n{json.dumps(lines, ensure_ascii=False)}"
    )


def _call_llm(provider: str, key: str, model: str, prompt: str) -> str:
    if provider == "gemini":
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        out = _http_post(url, {}, {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
        })
        return out["candidates"][0]["content"]["parts"][0]["text"]
    if provider in ("openai", "openrouter"):
        if provider == "openrouter":
            base = (_env("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
            url = f"{base}/chat/completions"
        else:
            url = "https://api.openai.com/v1/chat/completions"
        headers = {"Authorization": f"Bearer {key}"}
        body: dict = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        }
        if provider == "openai":
            # OpenRouter routes to many models; not all accept response_format,
            # so only ask OpenAI directly for JSON mode (the prompt enforces it
            # either way and the parser tolerates plain/fenced JSON).
            body["response_format"] = {"type": "json_object"}
        else:
            headers["X-Title"] = "XinChao-Cut"
        out = _http_post(url, headers, body)
        return out["choices"][0]["message"]["content"]
    # anthropic
    out = _http_post(
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
        {
            "model": model,
            "max_tokens": 8192,
            "temperature": 0.2,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    return out["content"][0]["text"]


def _parse_translations(text: str, n: int) -> list[str]:
    """Pull the translations array out of the model's reply, tolerating code
    fences and an occasional bare array."""
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s[s.find("\n") + 1:] if "\n" in s else s
    try:
        data = json.loads(s)
    except Exception:
        start, end = s.find("{"), s.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(s[start:end + 1])
        else:
            raise HTTPException(status_code=502, detail="Translation provider returned non-JSON")
    arr = data.get("translations") if isinstance(data, dict) else data
    if not isinstance(arr, list):
        raise HTTPException(status_code=502, detail="Translation reply missing 'translations' array")
    # Pad/truncate to keep the cue count exact even if the model miscounts.
    arr = [str(x) for x in arr]
    if len(arr) < n:
        arr += [""] * (n - len(arr))
    return arr[:n]


def _missing_translation_indexes(translations: list[str]) -> list[int]:
    return [i for i, value in enumerate(translations) if not value.strip()]


def _source_snippet(text: str, max_len: int = 80) -> str:
    s = " ".join(text.split())
    return s[:max_len] + ("..." if len(s) > max_len else "")


def _translate_chunk(
    provider: str,
    key: str,
    model: str,
    lines: list[str],
    target_name: str,
    source_name: str | None,
    start_index: int = 0,
) -> list[str]:
    """Translate one batch, retrying missing lines instead of silently falling
    back to the source text. Some hosted LLMs occasionally return too few array
    items near the end of long caption batches; padding those with source text
    creates mixed-language subtitle tracks."""
    reply = _call_llm(provider, key, model, _build_prompt(lines, target_name, source_name))
    translations = _parse_translations(reply, len(lines))

    missing = _missing_translation_indexes(translations)
    if missing:
        retry_lines = [lines[i] for i in missing]
        retry_reply = _call_llm(
            provider,
            key,
            model,
            _build_prompt(retry_lines, target_name, source_name),
        )
        retry_translations = _parse_translations(retry_reply, len(retry_lines))
        for original_index, retry_value in zip(missing, retry_translations, strict=False):
            if retry_value.strip():
                translations[original_index] = retry_value

    missing = _missing_translation_indexes(translations)
    if missing:
        first = missing[0]
        raise HTTPException(
            status_code=502,
            detail=(
                f"Translation provider returned {len(missing)} empty/missing lines "
                f"(first: caption {start_index + first + 1}: \"{_source_snippet(lines[first])}\")"
            ),
        )

    return translations


class TranslateBody(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=5000)
    target: str
    source: str = "auto"


@router.post("/translate")
def translate(body: TranslateBody) -> dict:
    provider = _select_provider()
    if not provider:
        raise HTTPException(
            status_code=503,
            detail="No translation API key configured (set GEMINI_API_KEY / OPENAI_API_KEY / "
                   "ANTHROPIC_API_KEY / OPENROUTER_API_KEY in the environment or backend/.env)",
        )
    name, key, model = provider
    target_name = _LANG_NAMES.get(body.target.strip().lower())
    if not target_name:
        raise HTTPException(status_code=422, detail=f"Unsupported target language: {body.target}")
    source_name = _LANG_NAMES.get(body.source.strip().lower())

    translations: list[str] = []
    for i in range(0, len(body.texts), _BATCH):
        chunk = body.texts[i : i + _BATCH]
        translations.extend(
            _translate_chunk(name, key, model, chunk, target_name, source_name, i),
        )
    return {"translations": translations, "provider": name, "model": model}


@router.get("/translate/test")
def test_connection() -> dict:
    """Verify the configured provider/key actually works by translating one short
    line. Returns {ok, provider, model, sample} or {ok:false, error} (always 200
    so the UI can show the message cleanly)."""
    provider = _select_provider()
    if not provider:
        return {"ok": False, "provider": None, "error": "No API key configured"}
    name, key, model = provider
    try:
        reply = _call_llm(name, key, model, _build_prompt(["Hello, world."], "Vietnamese", "English"))
        sample = _parse_translations(reply, 1)[0]
        return {"ok": True, "provider": name, "model": model, "sample": sample}
    except HTTPException as e:
        return {"ok": False, "provider": name, "model": model, "error": str(e.detail)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "provider": name, "model": model, "error": str(e)[:300]}


@router.get("/translate/languages")
def languages() -> dict:
    return {"languages": sorted(_LANG_NAMES.keys())}
