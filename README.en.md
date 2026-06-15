# XinChao-Cut

***English** · [Tiếng Việt](README.md)*

A multi-track video editor that runs **right in the browser**, with an **optional backend** (FastAPI + FFmpeg + WhisperX + Demucs) for speed and AI features.

> The whole app works **without a backend** — everything runs in the browser (WebCodecs, Web Audio, OPFS). When the backend is enabled, heavy tasks (high-quality captions, voice separation, proxy, FFmpeg export) are routed to the server; when it's off, the app silently falls back to the in-browser path.

## Key features

- **Multi-track timeline** — video / audio / text / fx; split, trim, ripple, copy/paste/duplicate, undo/redo, snapping, linkage (🔗 dragging a video carries its captions & audio along).
- **Preview canvas** — drag/scale/rotate media & text directly, with safe-guides + snapping.
- **Text & captions** — 12 text presets, auto-captions (WhisperX or in-browser Whisper), import `.srt`/`.vtt`/`.ass`, word-by-word reveal animation.
- **AI audio** (requires backend) — separate vocals & music (Demucs), real-time noise reduction preview, extract/mix audio.
- **Performance** — 1080p proxy for large videos for smooth scrubbing, thumbnails/waveforms generated in the background, GPU acceleration (CUDA/NVENC).
- **Export** — MP4 (H.264), MP3/WAV, SRT; choose the **Server** (FFmpeg) or **Browser** (WebCodecs) engine.

## Tech stack

**Frontend:** React 18 · TypeScript · Vite · Zustand · Tailwind CSS · Canvas 2D · WebCodecs · Web Audio · OPFS · Dexie/IndexedDB · Web Workers.

**Backend (optional):** Python · FastAPI · FFmpeg/ffprobe · WhisperX · Demucs · PyTorch (CUDA).

---

## System requirements

| Component | Required | Notes |
|---|---|---|
| **Node.js 18+** & npm | ✅ (frontend) | LTS (20/22) recommended. |
| **Chromium browser** | ✅ | Chrome **94+** or Edge — **WebCodecs** is required. Firefox/Safari aren't fully supported yet. |
| **Python 3.10+** | ⛔ (backend only) | 3.10 – 3.12 all work. |
| **FFmpeg + ffprobe** | ⛔ (backend only) | Must be on your **PATH**. |
| **NVIDIA GPU + CUDA** | ⛔ (optional) | Speeds up WhisperX/Demucs/NVENC. CPU works too, just slower. |
| **RAM / disk** | — | ~8 GB RAM minimum. AI models (WhisperX `large-v3`, Demucs) download ~2–3 GB and are cached. |

### Install the prerequisites

<details>
<summary><b>Windows</b></summary>

```powershell
# Node.js (LTS) and FFmpeg via winget
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg

# Python (if you want the backend)
winget install Python.Python.3.12
```

After installing, **open a new terminal** and verify: `node -v`, `npm -v`, `ffmpeg -version`, `python --version`.
</details>

<details>
<summary><b>macOS (Homebrew)</b></summary>

```bash
brew install node ffmpeg
brew install python@3.12   # if you want the backend
```
</details>

<details>
<summary><b>Linux (Debian/Ubuntu)</b></summary>

```bash
# Node.js LTS via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts

sudo apt update
sudo apt install -y ffmpeg python3 python3-venv python3-pip
```
</details>

---

## Install & run

### 1. Frontend (enough for basic use)

```bash
git clone https://github.com/yudgunH/XinChao-Cut.git
cd XinChao-Cut
npm install
npm run dev          # opens http://localhost:5173
```

At this point the app is fully usable **100% in the browser** — import video, build a timeline, caption (in-browser Whisper), export via WebCodecs. The backend below is only needed if you want it faster / with stronger AI.

### 2. Backend (optional — FFmpeg + AI)

The backend ships **4 install tiers**; pick the smallest one you need so you don't pull gigabytes of CUDA wheels you won't use:

| Requirements file | What you get | Size |
|---|---|---|
| `requirements-core.txt` | Media (probe/thumbnail/waveform), proxy, **FFmpeg export**. No AI. | light |
| `requirements-caption.txt` | Core **+ WhisperX** (high-quality captions) | ~2 GB CUDA |
| `requirements-audio.txt` | Core **+ Demucs** (vocal/music separation) | ~2 GB CUDA |
| `requirements.txt` | **Everything** (caption + audio) | ~2–3 GB |
| `requirements-dev.txt` | Adds pytest (install on top of any tier) | — |

```bash
cd backend
python -m venv .venv

# Activate the venv:
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # macOS / Linux

# Pick one tier (e.g. just media + export, no AI):
pip install -r requirements-core.txt
# …or full:  pip install -r requirements.txt

cp .env.example .env              # (Windows: copy .env.example .env) — optional, to tweak settings
uvicorn app.main:app --reload --port 8000
```

**Check the backend:** open http://127.0.0.1:8000/health — the `capabilities` field shows which features are ready:

```jsonc
{
  "status": "ok",
  "capabilities": {
    "media": true,        // ffmpeg/ffprobe OK
    "transcribe": true,   // WhisperX OK (caption tier)
    "separate": true,     // Demucs OK (audio tier)
    "export": true        // server-side export OK
  }
}
```

> If `media: false` → ffmpeg isn't on PATH. If `transcribe: false` despite installing the caption tier → see [Troubleshooting](#troubleshooting).

### 3. Point the frontend at the backend

Create a `.env.local` file in the **repo root**:

```
VITE_BACKEND_URL=http://127.0.0.1:8000
```

Restart `npm run dev`. When the backend is up, the app uses it for captions + media processing; when it's down, it silently falls back to the in-browser path. (`.env.local` is gitignored and never committed.)

### 4. Enable GPU acceleration (NVIDIA / CUDA) — optional

By default the `caption`/`audio` tiers point at the `cu121` index, i.e. they **pull the CUDA build of PyTorch** (which bundles the cuDNN that ctranslate2 needs — no separate cuDNN install). You just need an NVIDIA card + recent driver. Then enable it in `backend/.env`:

```
XINCHAO_WHISPER_DEVICE=cuda
XINCHAO_WHISPER_COMPUTE_TYPE=float16
XINCHAO_WHISPER_MODEL=large-v3
```

**CPU-only:** change the `--extra-index-url` line in `requirements-caption.txt` / `requirements-audio.txt` from `.../whl/cu121` to `.../whl/cpu`, and set `XINCHAO_WHISPER_DEVICE=cpu`, `XINCHAO_WHISPER_COMPUTE_TYPE=int8`.

### 5. One-click start on Windows

Two batch scripts in the repo root (assume the venv exists at `backend/.venv` and you've run `npm install`):

- **`start.bat`** — opens backend + frontend in two windows, then launches the browser.
- **`start-backend.bat`** — backend only.

---

## Configuration reference (environment variables)

### Frontend — `.env.local` (repo root)

| Variable | Default | Meaning |
|---|---|---|
| `VITE_BACKEND_URL` | *(empty)* | Backend URL. Leave empty to run fully in-browser. |

### Backend — `backend/.env` (`XINCHAO_` prefix)

| Variable | Default | Meaning |
|---|---|---|
| `XINCHAO_HOST` | `127.0.0.1` | Server bind address. |
| `XINCHAO_PORT` | `8000` | Port. |
| `XINCHAO_WORK_DIR` | `./.work` | Where temp uploads / generated files live. |
| `XINCHAO_EXPORT_THREADS` | `0` | Threads for FFmpeg/x264. `0` = all CPUs minus 2. |
| `XINCHAO_ASSETS_QUOTA_MB` | `5000` | Asset-store size cap (LRU-evicted). `0` = unlimited. |
| `XINCHAO_ASSETS_TTL_DAYS` | `30` | Drop assets untouched this long. `0` = no TTL. |
| `XINCHAO_WHISPER_DEVICE` | `auto` | `auto` / `cuda` / `cpu`. |
| `XINCHAO_WHISPER_COMPUTE_TYPE` | `auto` | `auto` → float16 on GPU, int8 on CPU. |
| `XINCHAO_WHISPER_MODEL` | `small` | `tiny`\|`base`\|`small`\|`medium`\|`large-v3`\|`large-v3-turbo`. |
| `XINCHAO_WHISPER_CACHE` | `./.work/models` | Cache dir for downloaded models. |

### Backend — caption translation via LLM (optional, **no** prefix)

Fill in **one** provider key. Endpoint URLs are built in — you only need the key. If several are set, priority is: **Gemini → OpenAI → Anthropic → OpenRouter**.

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Google Gemini (default `gemini-2.0-flash`). |
| `OPENAI_API_KEY` | OpenAI (`gpt-4o-mini`). |
| `ANTHROPIC_API_KEY` | Anthropic (`claude-3-5-haiku-latest`). |
| `OPENROUTER_API_KEY` | OpenRouter (`google/gemini-2.0-flash-001`). |
| `OPENROUTER_BASE_URL` | OpenRouter base URL (override for a proxy). |
| `OPENROUTER_TRANSLATE_MODEL` | Override the OpenRouter model. |

> ⚠️ Don't commit `.env` / `.env.local` — both are in `.gitignore`. Never put API keys in the repo.

---

## Usage

1. **Import media** — click *Import media* in the left panel, or drag-and-drop files onto the panel / preview / timeline.
2. **Build the timeline** — drag clips onto a track. Split: move the playhead, then press `S`. Trim: drag a clip edge. Toggle **Snap** to snap to edges/playhead, toggle **🔗** to make video carry captions/audio.
3. **Captions** — *Captions* tab: pick a model + language, then *Generate captions*, or import `.srt/.vtt/.ass`. Styling one line applies to all captions.
4. **Audio** — select a clip → *Properties → Audio*: adjust Volume, reduce noise, or separate vocals & music (requires backend).
5. **Effects & color** — *Properties → Animation* (Zoom/Fade), *Adjust* (Brightness/Contrast/Saturation), *Speed* (0.1–4×).
6. **Export** — click *Export*, set a name, choose the engine (Server/Browser), toggle Video / Audio / Captions, then *Download*.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Step back / forward 1 frame |
| `Home` / `End` | Jump to start / end of timeline |
| `S` | Split at playhead |
| `Delete` | Delete selected clip |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Ctrl+D` | Duplicate |
| `Shift+?` | Shortcut cheatsheet |

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `/health` reports `media: false` | `ffmpeg`/`ffprobe` not on PATH. Reinstall, then **open a new terminal**. |
| `/health` reports `transcribe: false` despite the caption tier | Usually a `torch`/`torchaudio` version mismatch, or `hf-xet` got installed. Keep `torch==2.2.2`, `torchaudio==2.2.2`; remove hf-xet: `pip uninstall hf-xet -y`. |
| 401 “Unauthorized” when loading Whisper models | `hf_xet` is trying to use a CAS proxy at `localhost:8080`. Set `HF_HUB_DISABLE_XET=1` before launching uvicorn (`start.bat` already does this). |
| App can't export/caption, backend panel greyed out | Backend not running or `.env.local` missing `VITE_BACKEND_URL`. Open `/health` to check, then restart `npm run dev`. |
| Browser WebCodecs errors / playback fails | Use Chrome 94+ or Edge. Firefox/Safari aren't fully supported. |
| GPU not used (runs slow) | Install the `cu121` torch build (not `cpu`), set `XINCHAO_WHISPER_DEVICE=cuda`, and make sure the NVIDIA driver is recent. |
| Port 8000/5173 already in use | Change `XINCHAO_PORT` / `--port`, or run `vite --port <other>` and update `VITE_BACKEND_URL`. |

---

## npm scripts

```bash
npm run dev         # dev server (Vite)
npm run build       # type-check + production build
npm run preview     # preview the build
npm run typecheck   # type-check only
npm run lint        # eslint
npm run test        # vitest
```

Run backend tests (after installing `requirements-dev.txt`):

```bash
cd backend && pytest
```

## Project structure

```
XinChao-Cut/
├─ src/                # frontend (app shell, components, engine, hooks, store, workers)
│  └─ engine/          # UI-agnostic core: timeline, media, audio, subtitle, export, backend
├─ backend/            # FastAPI + FFmpeg + WhisperX + Demucs (optional)
│  ├─ app/             # routers, export, config
│  └─ requirements*.txt# install tiers
├─ src-tauri/          # Tauri desktop shell (optional)
├─ docs/               # design docs (system, UI, clean-code, performance)
└─ README.md
```

## Contributing

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) and [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md). Report security issues per [SECURITY.en.md](SECURITY.en.md).

## License

Released under the [MIT](LICENSE) license.

---

*XinChao-Cut is a personal/learning project.*
