"""Download only the model weights explicitly selected by the user."""
from __future__ import annotations

import argparse
import os
from pathlib import Path


WHISPER_MODELS = {"tiny", "small", "large-v3"}


def prefetch_whisper(model: str, data_dir: Path) -> None:
    if model not in WHISPER_MODELS:
        raise ValueError(f"Unsupported Whisper model: {model}")
    from faster_whisper.utils import download_model

    cache = data_dir / "models"
    cache.mkdir(parents=True, exist_ok=True)
    path = download_model(model, cache_dir=str(cache))
    print(f"[model] Whisper {model}: {path}", flush=True)


def prefetch_demucs(data_dir: Path) -> None:
    os.environ["TORCH_HOME"] = str(data_dir / "torch-cache")
    from demucs.pretrained import get_model

    get_model("htdemucs")
    print("[model] Demucs htdemucs: ready", flush=True)


def prefetch_funasr(data_dir: Path) -> None:
    cache = data_dir / "modelscope"
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = str(cache)
    from funasr import AutoModel

    model = AutoModel(
        model="paraformer-zh",
        vad_model="fsmn-vad",
        punc_model="ct-punc",
        device="cpu",
        hub="ms",
        disable_update=True,
    )
    del model
    print("[model] FunASR Paraformer + VAD + punctuation: ready", flush=True)


def prefetch_tts(data_dir: Path) -> None:
    hf_home = data_dir / "hf-cache"
    hf_home.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(hf_home)
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from huggingface_hub import snapshot_download

    path = snapshot_download("k2-fsa/OmniVoice")
    print(f"[model] OmniVoice: {path}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--whisper", choices=sorted(WHISPER_MODELS))
    parser.add_argument("--demucs", action="store_true")
    parser.add_argument("--funasr", action="store_true")
    parser.add_argument("--tts", action="store_true")
    args = parser.parse_args()
    data_dir = Path(args.data_dir).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    if args.whisper:
        prefetch_whisper(args.whisper, data_dir)
    if args.demucs:
        prefetch_demucs(data_dir)
    if args.funasr:
        prefetch_funasr(data_dir)
    if args.tts:
        prefetch_tts(data_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
