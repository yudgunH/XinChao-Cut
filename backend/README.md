# XinChao-Cut Backend

Optional Python/FastAPI backend that adds server-side power to the (otherwise
100% in-browser) editor:

- **FFmpeg media** — fast `probe`, `thumbnails` (timeline strip) and `waveform`
  generation, instead of slow in-browser video seeks.
- **WhisperX transcription** — higher-quality auto-captions with word-level
  forced alignment + VAD (much better than the in-browser Whisper, especially
  for long or non-English audio).
- **Demucs separation** — split a clip's audio into `vocals` + `no_vocals`
  (music) stems.
- **Proxy generation** — transcode large (>1080p) sources to a light 1080p
  H.264 proxy for smooth preview scrubbing (the original is still used for export).
- **Native FFmpeg export** — render the timeline server-side (hardware H.264).

The frontend works **with or without** this backend. It only routes work here
when `VITE_BACKEND_URL` is set and `/health` responds; otherwise it falls back
to the in-browser path.

## Requirements

- Python 3.10+
- `ffmpeg` and `ffprobe` on your PATH (needed for the media endpoints).
- For transcription: WhisperX (pulls in PyTorch). CPU works; an NVIDIA GPU is
  much faster.

## Run (local dev)

```bash
cd backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt          # omit whisperx line if you only want FFmpeg
cp .env.example .env                      # optional, tweak settings

uvicorn app.main:app --reload --port 8000
```

Check it: open http://127.0.0.1:8000/health — `capabilities` shows whether
`media` (ffmpeg) and `transcribe` (whisperx) are available.

### GPU notes

WhisperX needs a CUDA build of PyTorch for GPU. Install it before `whisperx`,
then set in `.env`:

```
XINCHAO_WHISPER_DEVICE=cuda
XINCHAO_WHISPER_COMPUTE_TYPE=float16
XINCHAO_WHISPER_MODEL=large-v3
```

## Point the frontend at it

In the repo root, create/edit `.env` (or `.env.local`):

```
VITE_BACKEND_URL=http://127.0.0.1:8000
```

Restart `npm run dev`. The app now uses the backend for captions + media
processing when it's up, and silently falls back to in-browser when it's not.

## Endpoints

| Method | Path                    | Body                          | Returns |
|--------|-------------------------|-------------------------------|---------|
| GET    | `/health`               | —                             | status + capabilities |
| POST   | `/media/probe`          | `file`                        | duration/width/height/fps/hasAudio |
| POST   | `/media/thumbnails`     | `file`, `count`, `width`      | `{ frames: dataURL[] }` |
| POST   | `/media/waveform`       | `file`, `maxPeaks`            | `{ peaks: number[] }` |
| POST   | `/transcribe`           | `file`, `language`, `model`   | `{ language, cues: [...] }` |
| POST   | `/assets/check`         | `{ hashes[] }` (json)         | `{ missing[] }` |
| POST   | `/assets/upload`        | `file`, `hash`                | `{ assetId }` |
| POST   | `/export`               | `ExportSpec` (json)           | `{ jobId }` |
| GET    | `/export/{id}`          | —                             | `{ status, pct, error }` |
| POST   | `/export/{id}/cancel`   | —                             | `{ ok }` |
| GET    | `/export/{id}/download` | —                             | mp4 file |
| POST   | `/media/proxy`          | `file`, `height`              | `{ jobId }` |
| GET    | `/media/proxy/{id}`     | —                             | `{ status, pct, error }` |
| GET    | `/media/proxy/{id}/download` | —                        | mp4 proxy |
| POST   | `/separate`             | `file`                        | `{ jobId }` |
| GET    | `/separate/{id}`        | —                             | `{ status, pct, stems }` |
| POST   | `/separate/{id}/cancel` | —                             | `{ ok }` |
| GET    | `/separate/{id}/download/{stem}` | `stem`=vocals\|music | wav file |

## Server-side export

`/export` turns the timeline JSON into a single **native FFmpeg** command
(trim/speed/scale/transform/opacity/fade/colour per clip, overlay by track,
audio mix, captions burned via ASS, hardware H.264 when available). It's faster
than the in-browser WebCodecs path on one machine, at the cost of some fidelity
vs the canvas preview (caption reveal animations / effects are approximated).
The frontend uploads media once (content-addressed by hash) before exporting.

## Not yet implemented (future)

- Auto-reframe, background removal (chroma/rembg), subtitle translation, TTS voiceover.
