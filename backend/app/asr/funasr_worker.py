"""FunASR transcription in its own process
and app/tts_worker.py).

Why a subprocess: under VRAM pressure FunASR (paraformer + fsmn-vad + ct-punc)
can die with a NATIVE crash — no Python traceback, the process just vanishes.
Run in-process it took the whole uvicorn backend down with it (seen 2026-07-10:
an ASR request killed the server mid-inference). Isolated here, the worst case
is a failed job; the parent (asr/funasr_runtime.py) retries once on CPU. Exiting
also returns ALL of the model's VRAM to the OS — no resident cache to manage.

    python -m funasr_worker_entry <audio_path> <language|-> <auto|cpu> <out_json>

The result is written to <out_json> — NOT stdout, which funasr/modelscope/jieba
spray with progress bars and logs:

    {"status": "done", "segments": [{start, end, text, speaker_id}, ...]}
    {"status": "error", "error": "..."}

Exit code 0 only when the result file was written with status "done".
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict

# Seconds of audio per inference batch. The old in-process default (300) made
# activation peaks that overflowed 8GB cards sitting next to other GPU users;
# 60 keeps the peak modest at a negligible throughput cost.
BATCH_SIZE_S = 60


def _write_json(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _point_modelscope_cache_at_work_dir() -> None:
    """Point ModelScope's download cache at `funasr_cache` (nested under work_dir)
    so FunASR's ~1GB of weights land alongside WhisperX/OmniVoice models instead
    of the C: drive's ~/.cache/modelscope — and relocate with work_dir in the
    packaged build (→ %LOCALAPPDATA%). Set before AutoModel triggers a download;
    an explicit MODELSCOPE_CACHE already in the env wins (manual override)."""
    from app.config import get_settings

    if os.environ.get("MODELSCOPE_CACHE"):
        return
    cache = get_settings().funasr_cache
    if not cache:
        return
    os.makedirs(cache, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = cache


def _resolve_device(device_mode: str) -> str:
    """`cpu` stays cpu (parent's VRAM gate said the card is full); `auto` picks
    cuda when a CUDA torch + GPU exist, else cpu."""
    if device_mode == "cpu":
        return "cpu"
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001 — torch absent/broken → CPU
        return "cpu"


def _is_cuda_failure(exc: BaseException) -> bool:
    """CUDA-shaped failures (OOM / cuBLAS / cuDNN / device asserts) are worth a
    CPU retry in this same process; anything else (bad audio path, codec, …)
    would fail on CPU too — don't waste a model reload on it."""
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(mark in text for mark in ("out of memory", "cuda", "cudnn", "cublas"))


def _transcribe(audio_path: str, language: str | None, device: str):
    from app.asr.funasr_provider import FunASRProvider

    provider = FunASRProvider(device=device)
    try:
        return provider.transcribe(audio_path, language=language, batch_size_s=BATCH_SIZE_S)
    finally:
        provider.release()


def run(audio_path: str, language: str | None, device_mode: str, out_path: str) -> int:
    device = _resolve_device(device_mode)
    _point_modelscope_cache_at_work_dir()
    try:
        segments = _transcribe(audio_path, language, device)
    except Exception as e:  # noqa: BLE001
        if device == "cuda" and _is_cuda_failure(e):
            # Catchable CUDA failure (a native abort never reaches here — the
            # parent handles that case by retrying the whole worker on CPU).
            print(f"FunASR CUDA attempt failed ({e}) — retrying on CPU", file=sys.stderr, flush=True)
            try:
                segments = _transcribe(audio_path, language, "cpu")
            except Exception as e2:  # noqa: BLE001
                _write_json(out_path, {"status": "error", "error": str(e2)[:1500]})
                return 1
        else:
            _write_json(out_path, {"status": "error", "error": str(e)[:1500]})
            return 1
    _write_json(out_path, {"status": "done", "segments": [asdict(s) for s in segments]})
    return 0


def main() -> int:
    if len(sys.argv) < 5:
        sys.stderr.write("usage: funasr_worker <audio_path> <language|-> <auto|cpu> <out_json>\n")
        return 2
    audio_path = sys.argv[1]
    language = None if sys.argv[2] == "-" else sys.argv[2]
    device_mode = sys.argv[3]
    out_path = sys.argv[4]
    return run(audio_path, language, device_mode, out_path)


if __name__ == "__main__":
    raise SystemExit(main())
