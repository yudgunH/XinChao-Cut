"""Runtime configuration, read from environment / .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="XINCHAO_", extra="ignore")

    # Server
    host: str = "127.0.0.1"
    port: int = 8000

    # CORS — the Vite dev server origins allowed to call this API.
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # Where temp uploads / generated files live.
    work_dir: str = "./.work"

    # Number of threads given to the FFmpeg filtergraph and x264 encoder.
    # 0 (default) = all logical CPUs minus two (renders are serialised by the
    # heavy-job semaphore, so only a little headroom is reserved for the UI).
    # Set to a positive integer to pin an exact count.
    export_threads: int = 0

    # Content-addressed asset store (.work/assets) hygiene. The store is
    # persistent (media is uploaded once, reused across exports), so without a
    # cap it grows forever. LRU-evicted by access time down to the quota; files
    # untouched for longer than the TTL are dropped first.
    assets_quota_mb: int = 5000   # total cap; 0 = unlimited
    assets_ttl_days: int = 30     # drop assets untouched this long; 0 = no TTL

    # --- Transcription (WhisperX) ---
    # device: "auto" picks CUDA when a GPU + CUDA-enabled torch are present,
    # else falls back to CPU. Force with "cuda" / "cpu" if needed.
    whisper_device: str = "auto"
    # compute_type: "auto" → float16 on GPU, int8 on CPU. Override with
    # "float16" / "int8" / "int8_float16" / "float32".
    whisper_compute_type: str = "auto"
    # Default model size: tiny|base|small|medium|large-v3 (and *-v3-turbo).
    whisper_model: str = "small"
    # Cache dir for downloaded models.
    whisper_cache: str = "./.work/models"


@lru_cache
def get_settings() -> Settings:
    return Settings()
