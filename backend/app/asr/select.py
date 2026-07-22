"""ASR provider selection: pick WhisperX vs FunASR by request + language.

Pure/stdlib so it is trivially unit-testable. The routing contract:
  - explicit provider ("whisperx" | "funasr") always wins
  - "auto" + Chinese (zh / zh-*) → FunASR
  - "auto" + everything else     → WhisperX
"""
from __future__ import annotations

WHISPERX = "whisperx"
FUNASR = "funasr"


def is_chinese(language: str | None) -> bool:
    """True for zh / zh-cn / zh-tw / … and the human name 'chinese'."""
    lang = (language or "").strip().lower()
    return lang.startswith("zh") or lang in ("chinese", "mandarin")


def select_asr_provider(provider: str | None, language: str | None) -> str:
    """Resolve a requested provider to a concrete engine ("whisperx"|"funasr")."""
    p = (provider or "auto").strip().lower()
    if p in (WHISPERX, FUNASR):
        return p
    # "auto" (and any unknown value) → language-driven default.
    return FUNASR if is_chinese(language) else WHISPERX
