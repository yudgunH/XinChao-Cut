# XinChao-Cut Backend

Optional local Python/FastAPI backend for the otherwise in-browser
XinChao-Cut editor. The frontend only uses this service when
`VITE_BACKEND_URL` is set and `/health` responds; otherwise it falls back to
the browser implementation.

## What It Adds

- **FFmpeg media processing** - probe metadata, generate thumbnail strips,
  waveforms, scene splits, and preview proxies.
- **Server-side export** - render timelines with native FFmpeg, including
  trim/speed/scale/transform/opacity/fade/audio mix and ASS captions.
- **WhisperX transcription** - higher-quality captions with word-level timing.
- **Demucs audio separation** - split audio into vocals and music stems.
- **LLM subtitle translation** - translate caption lines through Gemini,
  OpenAI, Anthropic, or OpenRouter when an API key is configured.

## Requirements

- Python 3.10-3.12.
- `ffmpeg` and `ffprobe` on `PATH` for media/proxy/export/scene endpoints.
- NVIDIA GPU + recent driver is optional, but recommended for WhisperX,
  Demucs, and NVENC export.
- Hosted LLM API key is optional, only needed for `/translate`.

## Install Tiers

Pick the smallest requirements file that provides the features you need:

| File | Includes | Notes |
|---|---|---|
| `requirements-core.txt` | FastAPI, FFmpeg-backed media, proxy, export | No torch or local AI |
| `requirements-caption.txt` | Core + WhisperX transcription | Pulls CUDA PyTorch wheels by default |
| `requirements-audio.txt` | Core + Demucs separation | Pulls CUDA PyTorch wheels by default |
| `requirements.txt` | Caption + audio tiers | Full backend |
| `requirements-dev.txt` | Pytest/dev tools | Install on top of any tier |

## Run Locally

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
# source .venv/bin/activate

# Pick one tier. Core is enough for media/proxy/export without AI.
pip install -r requirements-core.txt
# Or install everything:
# pip install -r requirements.txt

# Optional config file
cp .env.example .env
# Windows alternative:
# copy .env.example .env

uvicorn app.main:app --reload --port 8000
```

Check the service:

```text
http://127.0.0.1:8000/health
```

Example response:

```jsonc
{
  "status": "ok",
  "service": "xinchao-cut-backend",
  "capabilities": {
    "media": true,
    "transcribe": true,
    "export": true,
    "separate": true,
    "sceneSplit": true,
    "translate": false
  },
  "runtime": {
    "videoEncoder": "libx264",
    "cuda": { "available": false, "device": null }
  }
}
```

## Connect The Frontend

Create `.env.local` in the repo root, not inside `backend/`:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
```

Restart `npm run dev`. `.env`, `.env.local`, and `.work/` are gitignored.

## Configuration

Backend settings live in `backend/.env` or process environment variables.
`XINCHAO_` variables are loaded by `app.config`.

| Variable | Default | Meaning |
|---|---|---|
| `XINCHAO_HOST` | `127.0.0.1` | Server bind address |
| `XINCHAO_PORT` | `8000` | Server port |
| `XINCHAO_WORK_DIR` | `./.work` | Temporary uploads, generated files, jobs, assets, model cache |
| `XINCHAO_EXPORT_THREADS` | `0` | FFmpeg/x264 threads; `0` means all logical CPUs minus two |
| `XINCHAO_ASSETS_QUOTA_MB` | `5000` | Content-addressed asset store quota; `0` disables quota |
| `XINCHAO_ASSETS_TTL_DAYS` | `30` | Drop untouched assets after this many days; `0` disables TTL |
| `XINCHAO_WHISPER_DEVICE` | `auto` | `auto`, `cuda`, or `cpu` |
| `XINCHAO_WHISPER_COMPUTE_TYPE` | `auto` | `float16` on GPU, `int8` on CPU when `auto` |
| `XINCHAO_WHISPER_MODEL` | `small` | `tiny`, `base`, `small`, `medium`, `large-v3`, or `large-v3-turbo` |
| `XINCHAO_WHISPER_CACHE` | `./.work/models` | Whisper/model cache directory |

### Subtitle Translation

Translation uses hosted APIs and does not need torch. Set one provider key in
`backend/.env` or the process environment:

| Variable | Default model |
|---|---|
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-2.0-flash` |
| `OPENAI_API_KEY` | `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | `claude-3-5-haiku-latest` |
| `OPENROUTER_API_KEY` | `google/gemini-2.5-flash` |

Provider priority is Gemini, OpenAI, Anthropic, then OpenRouter. Optional model
overrides: `GEMINI_TRANSLATE_MODEL`, `OPENAI_TRANSLATE_MODEL`,
`ANTHROPIC_TRANSLATE_MODEL`, and `OPENROUTER_TRANSLATE_MODEL`.
`OPENROUTER_BASE_URL` can point OpenRouter calls at a compatible proxy.

Do not commit real API keys.

## GPU Notes

`requirements-caption.txt` and `requirements-audio.txt` use the PyTorch
`cu121` wheel index by default. That installs CUDA-enabled torch/torchaudio and
bundles the cuDNN version used by the pinned WhisperX stack.

For CPU-only installs, change the `--extra-index-url` line in the caption/audio
requirements files to:

```text
https://download.pytorch.org/whl/cpu
```

Then set:

```env
XINCHAO_WHISPER_DEVICE=cpu
XINCHAO_WHISPER_COMPUTE_TYPE=int8
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | - | Status, capabilities, runtime diagnostics |
| `POST` | `/media/probe` | `file`, `hash`, or `sourcePath` | Media metadata |
| `POST` | `/media/thumbnails` | `file`, `count`, `width`, optional `hash`/`sourcePath` | `{ frames }` |
| `POST` | `/media/waveform` | `file`, `maxPeaks`, optional `hash`/`sourcePath` | `{ peaks }` |
| `POST` | `/media/scenes` | `file`, threshold options, optional `hash`/`sourcePath` | `{ jobId }` |
| `GET` | `/media/scenes/{id}` | - | Scene job status and cuts |
| `POST` | `/media/scenes/{id}/cancel` | - | `{ ok }` |
| `POST` | `/media/proxy` | `file`, `height`, optional `hash`/`sourcePath` | `{ jobId }` |
| `GET` | `/media/proxy/{id}` | - | Proxy job status |
| `GET` | `/media/proxy/{id}/download` | - | MP4 proxy |
| `POST` | `/assets/check` | `{ hashes[] }` | `{ missing[] }` |
| `POST` | `/assets/upload` | `file`, `hash` | `{ assetId }` |
| `POST` | `/transcribe` | `file`, `language`, `model` | `{ language, cues }` |
| `POST` | `/translate` | `{ texts, target, source }` | `{ translations, provider, model }` |
| `GET` | `/translate/test` | - | Provider connectivity check |
| `GET` | `/translate/languages` | - | Supported language ids |
| `POST` | `/separate` | `file` or `sourcePath` | `{ jobId }` |
| `GET` | `/separate/{id}` | - | Separation job status |
| `POST` | `/separate/{id}/cancel` | - | `{ ok }` |
| `GET` | `/separate/{id}/download/{stem}` | `stem=vocals` or `stem=music` | WAV stem |
| `POST` | `/export` | `ExportSpec` JSON | `{ jobId }` |
| `GET` | `/export/{id}` | - | Export job status |
| `POST` | `/export/{id}/cancel` | - | `{ ok }` |
| `GET` | `/export/{id}/download` | - | Rendered MP4 |

## Operational Notes

- This backend has no built-in authentication. It is designed for local use on
  `127.0.0.1`. If you expose it to a network, put authentication, rate limits,
  and upload limits in front of it.
- Heavy jobs are serialized so export/proxy/separation do not compete for the
  same CPU/GPU resources.
- `.work/` stores temporary files, persistent assets, job state, and model
  cache. It can grow large; use the quota/TTL settings above for cleanup.
- Finished export/separation jobs are persisted in `jobs.db` so downloads can
  survive a backend restart while their output files still exist.

## Tests

Install dev dependencies on top of your selected tier:

```bash
cd backend
pip install -r requirements-dev.txt
```

Run backend tests from the repo root:

```bash
python -m pytest backend -q
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` reports `media: false` | Install `ffmpeg` and `ffprobe`, then open a new terminal so `PATH` refreshes |
| `/health` reports `transcribe: false` | Install `requirements-caption.txt`; keep the pinned torch/torchaudio versions |
| Whisper model download returns 401 | Ensure `HF_HUB_DISABLE_XET=1`; remove `hf-xet` with `pip uninstall hf-xet -y` |
| GPU is not used | Install the `cu121` torch build, set `XINCHAO_WHISPER_DEVICE=cuda`, and update the NVIDIA driver |
| `/translate` returns 503 | Set one supported provider key in `backend/.env` or the process environment |
| Frontend ignores backend | Set root `.env.local` with `VITE_BACKEND_URL`, restart `npm run dev`, then check `/health` |
| Port is already in use | Change `--port` or set `XINCHAO_PORT`, and update `VITE_BACKEND_URL` if needed |

For full app setup, see [../README.md](../README.md) or
[../README.en.md](../README.en.md).
