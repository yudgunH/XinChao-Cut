"""Runtime configuration, read from environment / .env."""
import os
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchor relative data paths here (the `backend/` dir = parent of `app/`) so they
# resolve the same no matter the process cwd. Running uvicorn from the repo root
# instead of backend/ used to spawn a duplicate `.work` at the root (data bloat).
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="XINCHAO_", extra="ignore")

    # Server
    host: str = "127.0.0.1"
    port: int = 8000

    # CORS — origins allowed to call this API: the Vite dev server (dev) and the
    # Tauri webview (packaged app). Tauri 2 serves the bundled frontend from
    # `tauri.localhost` (Windows) / `tauri://localhost` (macOS/Linux), so the
    # fetch to 127.0.0.1:8000 is cross-origin and must be allow-listed.
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]

    # Where temp uploads / generated files live.
    work_dir: str = "./.work"

    # Number of threads given to the FFmpeg filtergraph and x264 encoder.
    # 0 (default) = all logical CPUs minus two (renders are serialised by the
    # heavy-job semaphore, so only a little headroom is reserved for the UI).
    # Set to a positive integer to pin an exact count.
    export_threads: int = 0

    # Independent time chunks can render concurrently. Each stage receives a
    # divided FFmpeg thread budget so CPU fallback does not oversubscribe the
    # machine. Keep this small: decoders/encoders and storage are still shared.
    # 0 = adapt to logical CPUs and encoder session limits; positive = pin.
    export_chunk_parallelism: int = 0

    # Persistent content-addressed intermediate chunks. Unchanged timeline
    # windows can be hardlinked into later jobs instead of rendered again.
    export_chunk_cache_mb: int = 12000
    export_chunk_cache_ttl_days: int = 14
    # Long, edited server timelines are divided into reusable windows even when
    # they are below the decoder-count safety threshold. 0 disables this mode.
    export_chunk_cache_segment_sec: int = 300

    # Content-addressed asset store (.work/assets) hygiene. The store is
    # persistent (media is uploaded once, reused across exports), so without a
    # cap it grows forever. LRU-evicted by access time down to the quota; files
    # untouched for longer than the TTL are dropped first.
    assets_quota_mb: int = 5000   # total cap; 0 = unlimited
    assets_ttl_days: int = 30     # drop assets untouched this long; 0 = no TTL

    # Browser-safe normalized video cache (.work/normalized). Outputs are keyed
    # by the source content hash and shared across projects/imports. Keep this
    # separate from assets: originals and generated MP4s have independent LRU
    # lifetimes and quota pressure.
    normalized_quota_mb: int = 5000
    normalized_ttl_days: int = 30

    # Per-request upload cap for /assets/upload. Streams past this size fail with
    # 413 (partial file removed). 10 GB fits ordinary 4K raw sources; a bigger
    # source is very rare in an editor and safer as an explicit override.
    upload_max_bytes: int = 10 * 1024**3

    # Completed job output dirs (.work/{exports,proxies,separate,tts}) are kept so
    # results stay downloadable, but without a cap they accumulate forever
    # (exports hit several GB). Same TTL+quota LRU hygiene as the asset store.
    jobs_quota_mb: int = 8000     # total cap across job output dirs; 0 = unlimited
    jobs_ttl_days: int = 7        # drop finished job dirs older than this; 0 = no TTL

    # --- GPU VRAM admission control (gpu_guard) ---
    # Before loading a CUDA model (WhisperX/OmniVoice/Demucs) the backend waits
    # until the card has enough FREE VRAM (device-wide, counting other processes)
    # so it never loads into a nearly-full GPU and thrashes shared memory — which
    # froze the whole machine for 10-30 min. On timeout, callers degrade to CPU
    # (captions/separate) or report "GPU busy" (TTS) instead of hanging.
    gpu_guard_enabled: bool = True
    # Never start a GPU load unless at least this much VRAM is free (headroom
    # floor, applied on top of each workload's own estimate).
    gpu_min_free_mb: int = 1200
    # How long to wait for VRAM to free up before degrading/erroring.
    gpu_wait_timeout_sec: int = 60
    # Poll interval while waiting.
    gpu_wait_poll_sec: float = 1.0

    # --- Transcription (WhisperX) ---
    # device: "auto" picks CUDA when a GPU + CUDA-enabled torch are present,
    # else falls back to CPU. Force with "cuda" / "cpu" if needed.
    whisper_device: str = "auto"
    # compute_type: "auto" → float16 on GPU, int8 on CPU. Override with
    # "float16" / "int8" / "int8_float16" / "float32".
    whisper_compute_type: str = "auto"
    # Default model size: tiny|base|small|medium|large-v3 (and *-v3-turbo).
    whisper_model: str = "small"
    # Cache dir for downloaded models. Relative names nest UNDER work_dir (see
    # model_post_init) so relocating work_dir (packaged build → %LOCALAPPDATA%)
    # moves the model cache with it. Absolute override is honoured as-is.
    whisper_cache: str = "models"

    # --- Chinese ASR (FunASR, optional) ---
    # ModelScope cache for FunASR's Paraformer/VAD/punc weights. Exported as
    # MODELSCOPE_CACHE before the model loads (see asr/funasr_worker.py) so the
    # ~1GB of weights nests under work_dir alongside WhisperX/OmniVoice instead
    # of the C: drive's ~/.cache/modelscope. Relative nests under work_dir.
    funasr_cache: str = "modelscope"

    # --- Text-to-speech (OmniVoice, isolated venv + subprocess) ---
    # Python interpreter that has `omnivoice` installed. OmniVoice's deps
    # (transformers>=5, numpy 2, torch>=2.4) conflict with the WhisperX/Demucs
    # tier, so it lives in a SEPARATE venv and is invoked as a subprocess.
    # Empty → auto: $XINCHAO_OMNIVOICE_PYTHON, then ./.venv-omnivoice/Scripts/python.exe.
    omnivoice_python: str = ""
    # HF_HOME for the OmniVoice worker → keeps the multi-GB model inside the
    # work dir (off the C: drive) instead of the user's global ~/.cache.
    # Relative → nests under work_dir (see model_post_init).
    tts_hf_home: str = "hf-cache"
    # Where saved cloned-voice prompts ({id}.pt) + voices.json live. Relative →
    # nests under work_dir, so it relocates with the rest of the data.
    tts_voices_dir: str = "voices"
    # Default voice-design preset (see routers/tts.py PRESETS).
    tts_default_voice: str = "narrator-f"

    def model_post_init(self, __context) -> None:
        # work_dir is the single root for ALL runtime data. A relative value
        # resolves against BACKEND_ROOT (so `./.work` lands in backend/.work no
        # matter the cwd); an absolute one (e.g. XINCHAO_WORK_DIR=%LOCALAPPDATA%\
        # XinChao-Cut\work in the packaged launcher) is honoured as-is. Relocating
        # work_dir moves the whole data tree — that's what makes the packaged app
        # upgradeable without touching the user's models/voices/music.
        work = self.work_dir
        if work and not os.path.isabs(work):
            work = os.path.normpath(os.path.join(BACKEND_ROOT, work))
        object.__setattr__(self, "work_dir", work)

        # The model cache / HF cache / voices dir are SUB-dirs of work_dir. A
        # relative value nests under work_dir (so they relocate together); an
        # absolute override points wherever the user pinned it.
        for field in ("whisper_cache", "tts_hf_home", "tts_voices_dir", "funasr_cache"):
            val = getattr(self, field)
            if not val:
                continue
            resolved = val if os.path.isabs(val) else os.path.join(work, val)
            object.__setattr__(self, field, os.path.normpath(resolved))


@lru_cache
def get_settings() -> Settings:
    return Settings()
