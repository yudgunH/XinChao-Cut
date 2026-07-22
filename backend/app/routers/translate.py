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
from typing import Callable

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from .ai_config import resolve as _select_provider

log = logging.getLogger(__name__)
router = APIRouter(tags=["translate"])

# Lines per LLM request. Keeps each call well within output-token limits while
# still giving the model plenty of in-batch context.
_BATCH = 80
# Split timeouts: connect stays short; read covers one batch-sized generation.
# The old 300s read ceiling let ONE stalled provider call silently eat ~6.4
# minutes of wall clock (connect+write+read+margin) — and the adapt/polish
# passes swallow per-batch failures, so consecutive stalls looked like the
# whole translation "doing nothing" for 15+ minutes. A 25-cue batch that hasn't
# produced its JSON in 2 minutes is dead in practice; fail it and move on.
# Override with XINCHAO_TRANSLATE_READ_TIMEOUT for genuinely slow custom proxies.
def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


_CONNECT_TIMEOUT = 10.0
_READ_TIMEOUT = _env_float("XINCHAO_TRANSLATE_READ_TIMEOUT", 120.0)
_WRITE_TIMEOUT = 60.0
_POOL_TIMEOUT = 10.0
# Provider output is untrusted. Normal caption/global-audit JSON is far below
# this; bounding the streamed body prevents a broken custom endpoint from
# buffering hundreds of MB (or more) before ``resp.json()`` gets a chance to
# reject it.
_MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024
# Back-compat alias used in tests / log messages (read phase dominates).
_HTTP_TIMEOUT = int(_READ_TIMEOUT)

CancelCheck = Callable[[], bool]

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


def translate_available() -> bool:
    """True when an LLM provider is configured (in-app config or env key)."""
    return _select_provider("translate") is not None


def _is_timeout_exc(exc: BaseException) -> bool:
    """True for httpx / socket timeouts."""
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
        return True
    return "timed out" in str(exc).lower() or "timeout" in str(exc).lower()


def _http_timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=_CONNECT_TIMEOUT,
        read=_READ_TIMEOUT,
        write=_WRITE_TIMEOUT,
        pool=_POOL_TIMEOUT,
    )


def _http_post(
    url: str,
    headers: dict,
    body: dict,
    *,
    cancel_check: CancelCheck | None = None,
) -> dict:
    """POST JSON with split connect/read timeouts, cancel, and 429/5xx retry."""
    from app.llm_call import (
        LlmCancelled,
        LlmTimeout,
        call_with_retry,
        is_retryable_http_status,
        run_cancellable,
    )

    def _once() -> dict:
        client = httpx.Client(timeout=_http_timeout())
        try:
            def _call() -> dict:
                with client.stream(
                    "POST",
                    url,
                    headers={"Content-Type": "application/json", **headers},
                    json=body,
                ) as resp:
                    if resp.status_code >= 400:
                        # Error pages can also be unbounded. Keep only enough
                        # text for diagnostics and construct a small replayable
                        # response for the retry classifier/final error path.
                        error_body = bytearray()
                        for chunk in resp.iter_bytes():
                            error_body.extend(chunk[: max(0, 500 - len(error_body))])
                            if len(error_body) >= 500:
                                break
                        safe_response = httpx.Response(
                            resp.status_code,
                            request=resp.request,
                            content=bytes(error_body),
                        )
                        detail = safe_response.text[:500]
                        if is_retryable_http_status(resp.status_code):
                            raise httpx.HTTPStatusError(
                                f"HTTP {resp.status_code}",
                                request=resp.request,
                                response=safe_response,
                            )
                        raise HTTPException(
                            status_code=502,
                            detail=f"Translation provider error {resp.status_code}: {detail}",
                        )

                    content_length = resp.headers.get("content-length")
                    try:
                        declared_size = int(content_length) if content_length else None
                    except ValueError:
                        declared_size = None
                    if (
                        declared_size is not None
                        and declared_size > _MAX_PROVIDER_RESPONSE_BYTES
                    ):
                        raise HTTPException(
                            status_code=502,
                            detail="Translation provider response exceeds the 16 MiB safety limit",
                        )

                    payload = bytearray()
                    for chunk in resp.iter_bytes():
                        if len(payload) + len(chunk) > _MAX_PROVIDER_RESPONSE_BYTES:
                            raise HTTPException(
                                status_code=502,
                                detail="Translation provider response exceeds the 16 MiB safety limit",
                            )
                        payload.extend(chunk)
                    try:
                        parsed = json.loads(payload)
                    except (json.JSONDecodeError, UnicodeDecodeError) as e:
                        preview = bytes(payload[:300]).decode("utf-8", errors="replace")
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                f"Translation provider returned non-JSON: {e}; "
                                f"body={preview!r}"
                            ),
                        ) from e
                    if not isinstance(parsed, dict):
                        raise HTTPException(
                            status_code=502,
                            detail="Translation provider returned a non-object JSON response",
                        )
                    return parsed

            return run_cancellable(
                _call,
                cancel_check=cancel_check,
                on_cancel=client.close,
                timeout_sec=_CONNECT_TIMEOUT + _WRITE_TIMEOUT + _READ_TIMEOUT + 15.0,
                label="translate",
            )
        finally:
            if not client.is_closed:
                client.close()

    def _retryable_provider_response(exc: BaseException) -> bool:
        # A 429/5xx response proves that the provider rejected/failed this
        # attempt and is safe to retry. A read/write/wall timeout is ambiguous:
        # the provider may already be generating (and billing) the answer. With
        # a 300s read timeout, retrying those three times also made one request
        # appear hung for roughly fifteen minutes.
        return isinstance(exc, httpx.HTTPStatusError) and is_retryable_http_status(
            exc.response.status_code
        )

    try:
        return call_with_retry(
            _once,
            cancel_check=cancel_check,
            is_retryable=_retryable_provider_response,
            label="translate",
        )
    except LlmCancelled as e:
        raise HTTPException(status_code=499, detail=f"Translation cancelled: {e}") from None
    except LlmTimeout:
        log.warning("Translation provider timed out after %ss (%s)", _HTTP_TIMEOUT, url)
        raise HTTPException(
            status_code=502,
            detail=f"Translation provider timed out after {_HTTP_TIMEOUT}s",
        ) from None
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        code = e.response.status_code if e.response is not None else "?"
        detail = (e.response.text[:500] if e.response is not None else str(e))
        raise HTTPException(
            status_code=502,
            detail=f"Translation provider error {code}: {detail}",
        ) from None
    except httpx.TimeoutException:
        log.warning("Translation provider timed out after %ss (%s)", _HTTP_TIMEOUT, url)
        raise HTTPException(
            status_code=502,
            detail=f"Translation provider timed out after {_HTTP_TIMEOUT}s",
        ) from None
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach translation provider: {e}",
        ) from None
    except Exception as e:  # noqa: BLE001 — any transport failure → HTTPException
        if _is_timeout_exc(e):
            log.warning("Translation provider timed out after %ss (%s)", _HTTP_TIMEOUT, url)
            raise HTTPException(
                status_code=502,
                detail=f"Translation provider timed out after {_HTTP_TIMEOUT}s",
            ) from None
        raise HTTPException(
            status_code=502,
            detail=f"Translation provider request failed: {type(e).__name__}: {e}",
        ) from None


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


def _message_text(content) -> str:
    """Coerce chat/completions `message.content` (str or list of parts) to text.

    Some OpenAI-compatible proxies return content as a list of
    ``{"type":"text","text":"..."}`` parts; callers that do ``.strip()`` would
    then AttributeError into an opaque 500.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                t = p.get("text") or p.get("content") or ""
                if t:
                    parts.append(str(t))
        return "".join(parts)
    return str(content)


def _call_llm(
    provider: str,
    base_url: str | None,
    key: str,
    model: str,
    prompt: str,
    *,
    cancel_check: CancelCheck | None = None,
) -> str:
    if provider == "gemini":
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        out = _http_post(
            url,
            {},
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.2,
                    "responseMimeType": "application/json",
                },
            },
            cancel_check=cancel_check,
        )
        try:
            return _message_text(out["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError, TypeError) as e:
            raise HTTPException(
                status_code=502,
                detail=f"Gemini reply missing text: {type(e).__name__}: {e}; body={str(out)[:400]}",
            ) from e
    if provider in ("openai", "openrouter", "custom"):
        # OpenAI-compatible chat API: OpenAI, OpenRouter, or any custom/local base.
        base = (base_url or "https://api.openai.com/v1").rstrip("/")
        url = f"{base}/chat/completions"
        headers: dict = {}
        if key:  # a local/custom endpoint may need no auth
            headers["Authorization"] = f"Bearer {key}"
        body: dict = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
            # Some OpenAI-compatible proxies default to JSONL/SSE streaming when
            # this is omitted, which makes json.loads() fail with "Extra data".
            "stream": False,
        }
        if provider == "openai":
            # Only OpenAI proper reliably accepts response_format; others route to
            # many models that may reject it (the prompt enforces JSON anyway and
            # the parser tolerates plain/fenced JSON).
            body["response_format"] = {"type": "json_object"}
        if provider == "openrouter":
            headers["X-Title"] = "XinChao-Cut"
        out = _http_post(url, headers, body, cancel_check=cancel_check)
        try:
            return _message_text(out["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as e:
            raise HTTPException(
                status_code=502,
                detail=f"Chat reply missing content: {type(e).__name__}: {e}; body={str(out)[:400]}",
            ) from e
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
        cancel_check=cancel_check,
    )
    try:
        return _message_text(out["content"])
    except (KeyError, IndexError, TypeError) as e:
        raise HTTPException(
            status_code=502,
            detail=f"Anthropic reply missing text: {type(e).__name__}: {e}; body={str(out)[:400]}",
        ) from e


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
    # The prompt contract requires strings. Coercing JSON null/object/array with
    # ``str()`` used to produce literal captions such as "None" or "{'x': 1}"
    # and prevented the missing-line recovery below from retrying them.
    arr = [value if isinstance(value, str) else "" for value in arr]
    if len(arr) < n:
        arr += [""] * (n - len(arr))
    return arr[:n]


def _build_caption_correction_prompt(
    cues: list[dict[str, str]],
    language_name: str,
    instructions: str | None = None,
    context_before: list[str] | None = None,
    context_after: list[str] | None = None,
) -> str:
    extra = (
        f"\nUser preferences (follow only when they do not conflict with the rules):\n{instructions.strip()}"
        if instructions and instructions.strip()
        else ""
    )
    context = ""
    if context_before or context_after:
        context = (
            "\nRead-only neighbouring context (do not return entries for these lines):\n"
            f"BEFORE: {json.dumps(context_before or [], ensure_ascii=False)}\n"
            f"AFTER: {json.dumps(context_after or [], ensure_ascii=False)}\n"
        )
    return (
        "You are a meticulous professional subtitle editor. Correct the consecutive "
        f"subtitle cues below in {language_name}; DO NOT translate them into another language.\n"
        "Rules:\n"
        "- Fix spelling, grammar, punctuation, capitalization, duplicated fragments, and "
        "high-confidence ASR/homophone errors using neighbouring cues as context.\n"
        "- Preserve the original meaning, tone, slang, speaker point of view, names, numbers, "
        "and level of formality. Do not invent facts, sanitize speech, or rewrite for style.\n"
        "- Return every input id exactly once. Never merge, split, reorder, add, or remove cues.\n"
        "- Keep each result concise enough for an on-screen subtitle. If uncertain, retain the "
        "original wording rather than guessing.\n"
        '- Return ONLY JSON: {"corrections":{"cue-id":"corrected text",...}}. No commentary.'
        f"{extra}{context}\nINPUT TO CORRECT:\n{json.dumps(cues, ensure_ascii=False)}"
    )


def _parse_caption_corrections(text: str, expected_ids: list[str]) -> dict[str, str]:
    """Parse an id-keyed reply and fail closed if any cue is missing/empty."""
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s[s.find("\n") + 1 :] if "\n" in s else s
    try:
        data = json.loads(s)
    except Exception:
        start, end = s.find("{"), s.rfind("}")
        if start < 0 or end <= start:
            raise HTTPException(status_code=502, detail="Caption correction provider returned non-JSON")
        try:
            data = json.loads(s[start : end + 1])
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail="Caption correction provider returned invalid JSON"
            ) from exc

    raw = data.get("corrections") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        raise HTTPException(
            status_code=502, detail="Caption correction reply missing 'corrections' object"
        )
    corrections = {str(key): str(value).strip() for key, value in raw.items()}
    missing = [cue_id for cue_id in expected_ids if not corrections.get(cue_id, "").strip()]
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"Caption correction reply missing {len(missing)} cue(s); first id: {missing[0]}",
        )
    return {cue_id: corrections[cue_id] for cue_id in expected_ids}


def _correct_caption_chunk(
    provider: str,
    base_url: str | None,
    key: str,
    model: str,
    cues: list[dict[str, str]],
    language_name: str,
    instructions: str | None,
    context_before: list[str] | None,
    context_after: list[str] | None,
    *,
    cancel_check: CancelCheck | None = None,
) -> dict[str, str]:
    reply = _call_llm(
        provider,
        base_url,
        key,
        model,
        _build_caption_correction_prompt(
            cues, language_name, instructions, context_before, context_after
        ),
        cancel_check=cancel_check,
    )
    return _parse_caption_corrections(reply, [cue["id"] for cue in cues])


def _missing_translation_indexes(translations: list[str]) -> list[int]:
    return [i for i, value in enumerate(translations) if not value.strip()]


def _source_snippet(text: str, max_len: int = 80) -> str:
    s = " ".join(text.split())
    return s[:max_len] + ("..." if len(s) > max_len else "")


def _translate_chunk(
    provider: str,
    base_url: str | None,
    key: str,
    model: str,
    lines: list[str],
    target_name: str,
    source_name: str | None,
    start_index: int = 0,
    *,
    cancel_check: CancelCheck | None = None,
) -> list[str]:
    """Translate one batch, retrying missing lines instead of silently falling
    back to the source text. Some hosted LLMs occasionally return too few array
    items near the end of long caption batches; padding those with source text
    creates mixed-language subtitle tracks."""
    reply = _call_llm(
        provider,
        base_url,
        key,
        model,
        _build_prompt(lines, target_name, source_name),
        cancel_check=cancel_check,
    )
    translations = _parse_translations(reply, len(lines))

    missing = _missing_translation_indexes(translations)
    if missing:
        retry_lines = [lines[i] for i in missing]
        retry_reply = _call_llm(
            provider,
            base_url,
            key,
            model,
            _build_prompt(retry_lines, target_name, source_name),
            cancel_check=cancel_check,
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


# Per-item + total-char caps so a request that slips past the item-count limit
# can't still hand a million-character caption to the LLM (costly + likely to
# time out; combined with the missing HTTP auth surface this is a DoS lever).
_MAX_ITEM_CHARS = 2000
_MAX_TOTAL_CHARS = 200_000


class TranslateBody(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=5000)
    target: str
    source: str = "auto"

    @field_validator("texts")
    @classmethod
    def _check_lengths(cls, v: list[str]) -> list[str]:
        for i, item in enumerate(v):
            if len(item) > _MAX_ITEM_CHARS:
                raise ValueError(f"texts[{i}] exceeds {_MAX_ITEM_CHARS} chars")
        total = sum(len(item) for item in v)
        if total > _MAX_TOTAL_CHARS:
            raise ValueError(f"total texts length {total} exceeds {_MAX_TOTAL_CHARS}")
        return v


class CaptionCorrectionCue(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=_MAX_ITEM_CHARS)


class CorrectCaptionsBody(BaseModel):
    cues: list[CaptionCorrectionCue] = Field(min_length=1, max_length=100)
    language: str = Field(default="auto", min_length=1, max_length=80)
    instructions: str | None = Field(default=None, max_length=2000)
    context_before: list[str] = Field(default_factory=list, max_length=6)
    context_after: list[str] = Field(default_factory=list, max_length=6)

    @field_validator("cues")
    @classmethod
    def _check_cues(cls, cues: list[CaptionCorrectionCue]) -> list[CaptionCorrectionCue]:
        ids = [cue.id for cue in cues]
        if len(ids) != len(set(ids)):
            raise ValueError("cue ids must be unique")
        total = sum(len(cue.content) for cue in cues)
        if total > _MAX_TOTAL_CHARS:
            raise ValueError(f"total cue content length {total} exceeds {_MAX_TOTAL_CHARS}")
        return cues

    @field_validator("context_before", "context_after")
    @classmethod
    def _check_context(cls, lines: list[str]) -> list[str]:
        if any(len(line) > _MAX_ITEM_CHARS for line in lines):
            raise ValueError(f"context line exceeds {_MAX_ITEM_CHARS} chars")
        return lines


@router.post("/captions/correct")
async def correct_captions(body: CorrectCaptionsBody, request: Request) -> dict:
    """Optional, explicit AI proofreading. Timing and cue count never change."""
    provider = _select_provider("translate")
    if not provider:
        raise HTTPException(
            status_code=503,
            detail="No AI provider configured for Translate (open Settings > AI).",
        )
    name, base_url, key, model = provider
    language_key = body.language.strip().lower()
    language_name = (
        "the language already used by each cue (auto-detect from context)"
        if language_key == "auto"
        else _LANG_NAMES.get(language_key, body.language.strip())
    )
    cues = [{"id": cue.id, "content": cue.content.strip()} for cue in body.cues]

    import asyncio
    import threading

    stop = threading.Event()

    async def _watch_disconnect() -> None:
        try:
            while not stop.is_set():
                if await request.is_disconnected():
                    stop.set()
                    return
                await asyncio.sleep(0.2)
        except Exception:  # noqa: BLE001
            stop.set()

    watcher = asyncio.create_task(_watch_disconnect())
    try:
        corrections = await asyncio.to_thread(
            _correct_caption_chunk,
            name,
            base_url,
            key,
            model,
            cues,
            language_name,
            body.instructions,
            body.context_before,
            body.context_after,
            cancel_check=stop.is_set,
        )
        if stop.is_set():
            raise HTTPException(status_code=499, detail="Client disconnected")
        return {"corrections": corrections, "provider": name, "model": model}
    finally:
        stop.set()
        watcher.cancel()
        try:
            await watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


@router.post("/translate")
async def translate(body: TranslateBody, request: Request) -> dict:
    provider = _select_provider("translate")
    if not provider:
        raise HTTPException(
            status_code=503,
            detail="No translation API key configured (set GEMINI_API_KEY / OPENAI_API_KEY / "
                   "ANTHROPIC_API_KEY / OPENROUTER_API_KEY in the environment or backend/.env)",
        )
    name, base_url, key, model = provider
    target_name = _LANG_NAMES.get(body.target.strip().lower())
    if not target_name:
        raise HTTPException(status_code=422, detail=f"Unsupported target language: {body.target}")
    source_name = _LANG_NAMES.get(body.source.strip().lower())

    # Bridge async disconnect into the sync httpx worker: when the UI aborts,
    # close the provider socket instead of leaving a hung request until timeout.
    import asyncio
    import threading

    stop = threading.Event()

    async def _watch_disconnect() -> None:
        try:
            while not stop.is_set():
                if await request.is_disconnected():
                    stop.set()
                    return
                await asyncio.sleep(0.2)
        except Exception:  # noqa: BLE001
            stop.set()

    watcher = asyncio.create_task(_watch_disconnect())
    cancel_check: CancelCheck = stop.is_set
    try:
        translations: list[str] = []
        for i in range(0, len(body.texts), _BATCH):
            if stop.is_set():
                raise HTTPException(status_code=499, detail="Client disconnected")
            chunk = body.texts[i : i + _BATCH]
            chunk_out = await asyncio.to_thread(
                _translate_chunk,
                name,
                base_url,
                key,
                model,
                chunk,
                target_name,
                source_name,
                i,
                cancel_check=cancel_check,
            )
            translations.extend(chunk_out)
        return {"translations": translations, "provider": name, "model": model}
    finally:
        stop.set()
        watcher.cancel()
        try:
            await watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


@router.get("/translate/test")
def test_connection() -> dict:
    """Verify the configured provider/key actually works by translating one short
    line. Returns {ok, provider, model, sample} or {ok:false, error} (always 200
    so the UI can show the message cleanly)."""
    provider = _select_provider("translate")
    if not provider:
        return {"ok": False, "provider": None, "error": "No API key configured"}
    name, base_url, key, model = provider
    try:
        reply = _call_llm(name, base_url, key, model, _build_prompt(["Hello, world."], "Vietnamese", "English"))
        sample = _parse_translations(reply, 1)[0]
        return {"ok": True, "provider": name, "model": model, "sample": sample}
    except HTTPException as e:
        return {"ok": False, "provider": name, "model": model, "error": str(e.detail)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "provider": name, "model": model, "error": str(e)[:300]}


@router.get("/translate/languages")
def languages() -> dict:
    return {"languages": sorted(_LANG_NAMES.keys())}
