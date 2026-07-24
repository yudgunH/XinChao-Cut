<div align="center">

<img src="public/logo.png" width="104" alt="XinChao-Cut" />

# XinChao-Cut

**An open-source multi-track video editor and local AI Voice Studio for Windows.**

[![Latest release](https://img.shields.io/github/v/release/yudgunH/XinChao-Cut?display_name=tag&sort=semver)](https://github.com/yudgunH/XinChao-Cut/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yudgunH/XinChao-Cut?style=flat)](https://github.com/yudgunH/XinChao-Cut/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4)
![React](https://img.shields.io/badge/React-18-61dafb)
![Tauri](https://img.shields.io/badge/Tauri-2-ffc131)

<img src="docs/screenshots/editor.png" alt="XinChao-Cut editor interface" width="48%" />
&nbsp;
<img src="docs/screenshots/export.png" alt="XinChao-Cut export dialog" width="48%" />

<br />

<a href="https://github.com/yudgunH/XinChao-Cut/releases/latest">Download the latest release</a>
·
<a href="https://github.com/yudgunH/XinChao-Cut/stargazers">Star the repository</a>
·
<a href="https://github.com/yudgunH">Created by Nguyễn Duy Hưng</a>

</div>

> If XinChao-Cut is useful to you, please star the repository and share it. Stars help an independent open-source project reach more creators.

XinChao-Cut combines a fast multi-track timeline, live preview, browser/WebCodecs export, and an optional local backend for FFmpeg and AI workflows. It is built for creators who want a practical desktop editor while keeping their projects and media on their own machine.

The open-source release includes **Editor** and **Voice Studio**. Internal Review, Dub/Dubbing, and Batch workspaces are intentionally not part of this repository.

## Highlights

- Multi-track video, audio, text, and effects timeline with split, trim, ripple, snapping, grouping, compound clips, and undo/redo.
- Direct preview manipulation for position, scale, crop, rotation, speed, opacity, volume, animation, and color.
- SRT, VTT, and ASS subtitle import/export.
- Caption generation with WhisperX or FunASR, including compound-media transcription.
- Voice Studio powered by OmniVoice for text-to-speech, previews, WAV export, and reusable voice clones.
- Vocal and music separation with Demucs.
- Browser/WebCodecs export or local FFmpeg export to MP4, MP3/WAV, and subtitle formats.
- Audio scheduling, waveform backfill, proxy media, and compound-clip waveform support for large projects.
- Local project, media, model, and output processing. Hosted LLM translation is optional and user-configured.
- Signed automatic updates through public GitHub Releases.

## Download for Windows

The packaged desktop build targets **Windows 10/11 64-bit**.

1. Install [Python 3.11 64-bit](https://www.python.org/downloads/release/python-3119/) and enable **Add python.exe to PATH**.
2. Download the installer from the [latest GitHub Release](https://github.com/yudgunH/XinChao-Cut/releases/latest).
3. Run the installer and open XinChao-Cut. The first-run setup wizard appears on Home.
4. Select **Install Core + FFmpeg**. The local backend starts automatically when setup finishes.
5. Install optional AI packages later from **Backend status → Model Manager**.

> **First setup time:** Core + FFmpeg normally takes about **10–15 minutes**, depending on your network and computer. Keep the app and setup screen open until the log reports `Setup done`. Optional AI models may take longer; later runs reuse the existing environment and FFmpeg installation.

### Optional AI packages

| Package | Purpose | Required |
| --- | --- | --- |
| Core + FFmpeg | Media inspection, proxies, waveforms, and server export | Required for the desktop backend |
| WhisperX | Multilingual captions and word-level timing | Optional |
| FunASR | Chinese ASR with VAD and punctuation | Optional |
| Demucs | Vocal and music separation | Optional |
| OmniVoice | Voice Studio and voice cloning | Optional |

AI environments and model weights can use substantial disk space. Choose the data drive in Model Manager before downloading large packages.

## Automatic updates

Installed desktop builds can check for signed updates from the public GitHub Releases feed:

1. Open **Version & updates** from the Home screen.
2. Click **Check for updates**.
3. Download and install the signed release when one is available.

Updates are published from the `v*` Git tags by [GitHub Actions](.github/workflows/release.yml). The signing key is kept in repository secrets and is never committed to this repository.

## Run from source

### Requirements

- Node.js 22 LTS and npm.
- Python 3.11 64-bit available in `PATH`.
- Rust stable, Microsoft C++ Build Tools, and WebView2 for the Tauri desktop build.
- Git and an internet connection for the initial setup.

### One-time setup

```powershell
git clone https://github.com/yudgunH/XinChao-Cut.git
cd XinChao-Cut
.\setup.bat
```

`setup.bat` safely installs the exact npm dependencies plus the Core backend and pinned FFmpeg. It deliberately does not download WhisperX, FunASR, Demucs, or OmniVoice.

Start the desktop development environment with:

```powershell
.\start.bat
```

`start.bat` opens the hot-reload backend and launches `npm run tauri dev`. Close those windows to stop the development environment.

For frontend-only work:

```powershell
npm run dev
```

Then open `http://localhost:5173`. Browser editing, browser Whisper Tiny, and browser export work without the local backend; FFmpeg and server-side AI features remain offline.

### Useful checks and builds

```powershell
npm run typecheck
npm run lint
npm test -- --run
npm run build
python -m pytest backend -q

# Stage the backend and build the desktop installer
npm run backend:stage
npm run tauri build
```

The staging step copies runtime files only. Tests, caches, virtual environments, model weights, and personal data are excluded.

## Basic workflow

### 1. Create a project and import media

Create a new project from Home, open the **Media** tab, then import or drag video, audio, and image files into the app. Drag media from the library onto the timeline.

Projects are saved automatically. Original media is referenced from its current location, so do not rename, move, or delete files that are still in use. For large videos, the **Smart** proxy mode can make preview playback lighter.

### 2. Edit on the timeline

- Drag clips to change their time or track; drag either edge to trim.
- Place the playhead and press `S` to split.
- Enable **Snap** to align with the playhead and clip edges.
- Enable **Link** to move or delete linked video, captions, and audio together.
- Use the magnetic main track to close gaps on the primary video track.
- Select a clip to edit transform, crop, speed, opacity, volume, animation, and color in Properties.
- Right-click a clip for context actions such as Replace, Crop & Rotate, Group, and Compound.

Use **Text**, **Effects**, **Transitions**, and **Filters** to add overlays and visual treatments. Hover a tile to preview supported effects.

### 3. Create captions

1. Open **Captions** and choose the engine, model, and language.
2. Use WhisperX for multilingual content or FunASR for Chinese source audio.
3. Run caption generation and keep the project open until it finishes.
4. Review names, numbers, spelling, and timing in Caption Studio.
5. Adjust font, color, background, position, animation, and safe-area placement.
6. During export, burn captions into the video or export SRT/VTT/ASS separately.

AI transcription can make mistakes, especially with background music, multiple speakers, or noisy audio. Review important captions before publishing.

### 4. Use Voice Studio

1. Install OmniVoice from **Model Manager**.
2. Open **Voice → Open Voice Studio**.
3. Choose an available voice or create a clone from a clean sample with one speaker.
4. Enter text, generate a preview, listen, and adjust the text or speed.
5. Export WAV or add the result to the media library and timeline.

You can also turn a caption track into a voiceover. Finish caption editing first, then review timing and every join in the generated audio. Only clone voices when you have the required permission and consent.

### 5. Separate vocals and music

Install Demucs, select an audio or video clip, then open **Properties → Audio** and run source separation. Preview, download, or place the resulting stems back on the timeline. Mute the original audio when using the separated stems to avoid doubled sound.

### 6. Translate captions with an LLM

Open **AI settings** from Home or the top bar. Configure the provider, URL, API key, and model for translation or correction. This feature uses the network and sends only the text being processed to the provider you choose; original media is not uploaded automatically.

### 7. Export

1. Check the beginning, middle, and end of the timeline and listen with headphones.
2. Click **Export** and choose MP4, MP3/WAV, and/or subtitle output.
3. Set the output folder, resolution, FPS, quality, codec, audio, and caption options.
4. Use **Server/FFmpeg** for desktop projects and large media, or **Browser/WebCodecs** when the backend is unavailable.
5. Keep the app and original media available until export completes.
6. Open the output file and verify it before clearing cache or source files.

## Keyboard shortcuts

Press `Shift+?` or the keyboard icon to view and customize shortcuts inside the app.

| Default shortcut | Action |
| --- | --- |
| `Space` | Play/pause |
| `←` / `→` | Move one frame backward/forward |
| `Home` / `End` | Go to the start/end of the timeline |
| `S` | Split the selected clip or clip under the playhead |
| `Q` / `W` | Trim the left/right edge to the playhead |
| `C` | Crop & Rotate |
| `Delete` | Delete the selected clip |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo/redo |
| `Ctrl+C/X/V/D` | Copy/cut/paste/duplicate |
| `Ctrl+G` / `Ctrl+Shift+G` | Group/ungroup |
| `Alt+G` / `Alt+Shift+G` | Create/break a compound clip |
| `Escape` | Deselect |

When a shortcut is reassigned, the previous binding is removed to avoid conflicts. Editing shortcuts are disabled while typing text.

## Data and privacy

- Runtime files, the Python environment, FFmpeg, and logs: `%LOCALAPPDATA%\XinChao-Cut`
- Models, voices, assets, and jobs: `%LOCALAPPDATA%\XinChao-Cut\work`
- Backend log: `%LOCALAPPDATA%\XinChao-Cut\backend.log`

You can change the large-data directory in Model Manager. Existing data is not moved automatically.

Local editing, local export, and local AI models do not require uploading media to an XinChao-Cut service. Model downloads contact their respective distribution hosts. Subtitle translation contacts a hosted LLM only after you configure a provider.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| `setup.bat` cannot find Python | Install Python 3.11 x64, enable `Add python.exe to PATH`, and open a new terminal |
| `npm ci` fails | Use Node.js 22 LTS, check the network, and run `setup.bat` again |
| Backend is offline | Open the backend status menu, choose **Start backend**, then click **Recheck** |
| Port 8000 is already in use | Close an old backend process and run `start.bat` again |
| A model download is slow | Check the network and free disk space; review the Model Manager log |
| An update is not detected | Confirm the app is an installed Windows build and click **Check for updates** again |

## Repository layout

```text
src/                 React editor and Voice Studio
src-tauri/            Tauri desktop shell and NSIS configuration
backend/app/          FastAPI, FFmpeg, and AI workers
backend/setup.ps1     Selective backend/model installer
scripts/              Build and staging tools
docs/                 Design and user documentation
```

## Contributing

Issues, ideas, documentation improvements, and pull requests are welcome. Please read [CONTRIBUTING.en.md](CONTRIBUTING.en.md), [SECURITY.en.md](SECURITY.en.md), and [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md) before contributing.

XinChao-Cut is created and maintained by [Nguyễn Duy Hưng](https://github.com/yudgunH). If the project helps your workflow, [star the repository](https://github.com/yudgunH/XinChao-Cut/stargazers) and share it with other creators.

Project code is licensed under [MIT](LICENSE). Third-party dependencies and model weights retain their own licenses; review the relevant model card before redistribution or commercial use.
