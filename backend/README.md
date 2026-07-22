# XinChao-Cut Backend

Local FastAPI backend for XinChao-Cut Editor and Voice Studio. It provides FFmpeg media/export operations plus optional local AI packages. The browser frontend remains usable without this service.

## Selective installer (Windows desktop)

The packaged app opens `setup.ps1` through Model Manager. The same installer can be run directly:

```powershell
# Core only: no optional AI packages or model weights
setup.bat -Components core

# Add captions and TTS, keep model downloads lazy
setup.bat -Components core,caption,tts -WhisperModel small

# Install every optional runtime and prefetch selected weights
setup.bat -Components core,caption,funasr,audio,tts -WhisperModel large-v3 -DownloadModels

# Validate a selection without changing files
setup.bat -Components core,caption -WhisperModel tiny -PlanOnly
```

The installer requires Python 3.11 64-bit. It creates the main environment and an isolated OmniVoice environment under `%LOCALAPPDATA%\XinChao-Cut` (or `XINCHAO_AI_DIR`), downloads a pinned/checksummed FFmpeg build, and records requirement hashes so unchanged tiers are skipped on later runs.

The first Core + FFmpeg setup normally takes about 10–15 minutes. Keep the setup process open until it prints `Setup done`; optional AI packages and model prefetch can take longer.

| Component | Requirements               | Capability                                     |
| --------- | -------------------------- | ---------------------------------------------- |
| `core`    | `requirements-core.txt`    | FastAPI, media, proxy, waveform, server export |
| `caption` | `requirements-caption.txt` | WhisperX transcription                         |
| `funasr`  | `requirements-funasr.txt`  | Chinese Paraformer/VAD/punctuation ASR         |
| `audio`   | `requirements-audio.txt`   | Demucs vocal/music separation                  |
| `tts`     | `requirements-tts.txt`     | OmniVoice TTS and voice cloning, isolated venv |

`requirements.txt` combines the caption + audio tiers. FunASR remains a separate tier, and the incompatible OmniVoice stack stays in its own environment. Model weights are never bundled in the application installer and retain the license from their model cards.

## Manual development setup

Use Python 3.11 for parity with the desktop installer:

```powershell
cd backend
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-core.txt

# Add only what you are developing:
.venv\Scripts\python -m pip install -r requirements-caption.txt
.venv\Scripts\python -m pip install -r requirements-funasr.txt
.venv\Scripts\python -m pip install -r requirements-audio.txt

.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

For Voice Studio, keep OmniVoice isolated:

```powershell
py -3.11 -m venv .venv-omnivoice
.venv-omnivoice\Scripts\python -m pip install pip==25.3
.venv-omnivoice\Scripts\python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
.venv-omnivoice\Scripts\python -m pip install -r requirements-tts.txt
```

Set the frontend root `.env.local` and restart Vite:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
```

Check `http://127.0.0.1:8000/health`. The `capabilities` object reports which optional modules are actually importable.

## Model prefetch

The setup script calls `scripts/prefetch_models.py` only with `-DownloadModels`. It can also be used manually inside the matching environment:

```powershell
.venv\Scripts\python scripts\prefetch_models.py --data-dir .work --whisper small --demucs --funasr
.venv-omnivoice\Scripts\python scripts\prefetch_models.py --data-dir .work --tts
```

Without prefetch, each feature downloads its weights on first use.

## Runtime directories

The desktop launcher uses:

- `%LOCALAPPDATA%\XinChao-Cut\venv`: main backend environment.
- `%LOCALAPPDATA%\XinChao-Cut\venv-omnivoice`: isolated TTS environment.
- `%LOCALAPPDATA%\XinChao-Cut\bin`: pinned FFmpeg/ffprobe.
- `%LOCALAPPDATA%\XinChao-Cut\backend.log`: rotated backend log.
- `%LOCALAPPDATA%\XinChao-Cut\work`: default models, voices, assets, jobs and temporary files.

The app writes a one-line `data-dir.txt` to move the last group to another drive. It also writes `whisper-model.txt`, which the launcher maps to `XINCHAO_WHISPER_MODEL`.

## Configuration

Backend settings live in `.env` or process environment variables. Important options:

| Variable                       | Default       | Meaning                                        |
| ------------------------------ | ------------- | ---------------------------------------------- |
| `XINCHAO_HOST`                 | `127.0.0.1`   | Bind address                                   |
| `XINCHAO_PORT`                 | `8000`        | Port                                           |
| `XINCHAO_WORK_DIR`             | `./.work`     | Models, assets, jobs and temp data             |
| `XINCHAO_WHISPER_DEVICE`       | `auto`        | `auto`, `cuda`, or `cpu`                       |
| `XINCHAO_WHISPER_COMPUTE_TYPE` | `auto`        | float16 on GPU, int8 on CPU when auto          |
| `XINCHAO_WHISPER_MODEL`        | `small`       | Whisper model used when a request omits it     |
| `XINCHAO_OMNIVOICE_PYTHON`     | auto-detected | Interpreter for the isolated TTS worker        |
| `XINCHAO_ASSETS_QUOTA_MB`      | `5000`        | Persistent asset-store quota; `0` disables     |
| `XINCHAO_ASSETS_TTL_DAYS`      | `30`          | Delete stale assets after N days; `0` disables |

Subtitle translation supports user-configured Gemini, OpenAI, Anthropic and OpenRouter connections. Do not commit API keys. This service has no network authentication and should stay bound to `127.0.0.1` unless an authenticated reverse proxy is added.

## Main endpoints

| Area         | Endpoints                                                                               |
| ------------ | --------------------------------------------------------------------------------------- |
| Health       | `GET /health`, `GET /metrics`                                                           |
| Media        | `/media/probe`, `/media/thumbnails`, `/media/waveform`, `/media/scenes`, `/media/proxy` |
| Assets       | `/assets/check`, `/assets/upload`                                                       |
| Captions     | `POST /transcribe`, `POST /translate`                                                   |
| Audio        | `POST /separate` and job status/download routes                                         |
| Voice Studio | `/tts`, `/tts/{id}`, `/tts/voices`                                                      |
| Export       | `POST /export` and job status/cancel/download routes                                    |

Interactive schemas are available at `http://127.0.0.1:8000/docs` in a development run.

## Tests

```powershell
python -m pip install -r backend/requirements-dev.txt
python -m pytest backend -q
```

## Troubleshooting

| Symptom                | Fix                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `media: false`         | Ensure the desktop Core setup completed or put FFmpeg on PATH for manual development |
| `transcribe: false`    | Install the caption tier and keep the pinned torch/torchaudio versions               |
| `funasr: false`        | Install `requirements-funasr.txt`, then restart the backend                          |
| `tts: false`           | Verify the isolated OmniVoice interpreter and `XINCHAO_OMNIVOICE_PYTHON`             |
| GPU is not used        | Update the NVIDIA driver and inspect `/health` runtime diagnostics                   |
| Frontend stays offline | Set root `.env.local`, verify `/health`, and inspect `backend.log`                   |
| Port 8000 is occupied  | Stop the conflicting process or change both backend and frontend URLs                |

See [../docs/INSTALLATION.md](../docs/INSTALLATION.md) for the desktop flow and [../docs/USAGE.md](../docs/USAGE.md) for the user guide.
