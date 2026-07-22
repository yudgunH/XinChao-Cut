"""Killable subprocess entry for the editor's WhisperX transcription."""
from __future__ import annotations

import json
import os
import sys


def run_whisperx(
    path: str,
    model_size: str,
    language: str | None,
    out_path: str,
    device_mode: str = "auto",
) -> int:
    try:
        if device_mode == "cpu":
            from app.config import get_settings

            settings = get_settings()
            object.__setattr__(settings, "whisper_device", "cpu")
            object.__setattr__(settings, "whisper_compute_type", "int8")

        from app.routers.transcribe import _run_transcription

        result = _run_transcription(path, model_size, language)
        tmp = out_path + f".{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"status": "done", "result": result}, handle, ensure_ascii=False)
        os.replace(tmp, out_path)
        return 0
    except Exception as exc:  # noqa: BLE001
        try:
            with open(out_path, "w", encoding="utf-8") as handle:
                json.dump({"status": "error", "error": str(exc)[:2000]}, handle)
        except OSError:
            pass
        sys.stderr.write(f"WhisperX worker failed: {type(exc).__name__}: {exc}\n")
        return 1


def main() -> int:
    if len(sys.argv) < 6 or sys.argv[1] != "--whisperx":
        sys.stderr.write(
            "usage: whisper_worker_entry --whisperx <path> <model> <lang|-> [device] <out_json>\n"
        )
        return 2
    if len(sys.argv) >= 7:
        path, model_size, raw_language, device_mode, out_path = sys.argv[2:7]
    else:
        path, model_size, raw_language, out_path = sys.argv[2:6]
        device_mode = "auto"
    language = None if raw_language == "-" else raw_language
    return run_whisperx(path, model_size, language, out_path, device_mode)


if __name__ == "__main__":
    raise SystemExit(main())
