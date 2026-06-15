# XinChao-Cut

*[English](README.en.md) · **Tiếng Việt***

Trình chỉnh sửa video đa track chạy **ngay trên trình duyệt**, kèm một **backend tùy chọn** (FastAPI + FFmpeg + WhisperX + Demucs) để tăng tốc và mở khóa các tính năng AI.

> Toàn bộ app hoạt động **không cần backend** — mọi thứ chạy trong trình duyệt (WebCodecs, Web Audio, OPFS). Khi bật backend, các tác vụ nặng (caption chất lượng cao, tách giọng, proxy, export FFmpeg) tự chuyển sang server; backend tắt thì app im lặng quay về đường in-browser.

## Tính năng chính

- **Timeline đa track** — video / audio / text / fx; cắt, trim, ripple, copy/paste/duplicate, undo/redo, snap (nam châm), linkage (🔗 kéo video kéo theo phụ đề & audio).
- **Preview canvas** — kéo/scale/xoay media & text trực tiếp, có safe-guide + snap.
- **Văn bản & phụ đề** — 12 preset chữ, auto-captions (WhisperX hoặc Whisper in-browser), import `.srt`/`.vtt`/`.ass`, animation hiện theo từng từ.
- **Âm thanh AI** (cần backend) — tách giọng & nhạc (Demucs), giảm noise nghe được real-time, tách/trộn audio.
- **Hiệu năng** — proxy 1080p cho video lớn để tua mượt, thumbnail/waveform sinh ở nền, tăng tốc GPU (CUDA/NVENC).
- **Xuất bản** — MP4 (H.264), MP3/WAV, SRT; chọn engine **Server** (FFmpeg) hoặc **Browser** (WebCodecs).

## Công nghệ

**Frontend:** React 18 · TypeScript · Vite · Zustand · Tailwind CSS · Canvas 2D · WebCodecs · Web Audio · OPFS · Dexie/IndexedDB · Web Workers.

**Backend (tùy chọn):** Python · FastAPI · FFmpeg/ffprobe · WhisperX · Demucs · PyTorch (CUDA).

---

## Yêu cầu hệ thống

| Thành phần | Bắt buộc | Ghi chú |
|---|---|---|
| **Node.js 18+** & npm | ✅ (frontend) | Khuyến nghị bản LTS (20/22). |
| **Trình duyệt Chromium** | ✅ | Chrome **94+** hoặc Edge — bắt buộc có **WebCodecs**. Firefox/Safari hiện chưa hỗ trợ đầy đủ. |
| **Python 3.10+** | ⛔ (chỉ khi dùng backend) | 3.10 – 3.12 đều chạy. |
| **FFmpeg + ffprobe** | ⛔ (chỉ backend) | Phải nằm trong **PATH**. |
| **NVIDIA GPU + CUDA** | ⛔ (tùy chọn) | Tăng tốc WhisperX/Demucs/NVENC. CPU vẫn chạy được, chỉ chậm hơn. |
| **RAM / ổ cứng** | — | Tối thiểu ~8 GB RAM. Các model AI (WhisperX `large-v3`, Demucs) tải về ~2–3 GB và cache lại. |

### Cài các phần mềm nền

<details>
<summary><b>Windows</b></summary>

```powershell
# Node.js (LTS) và FFmpeg qua winget
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg

# Python (nếu dùng backend)
winget install Python.Python.3.12
```

Sau khi cài, **mở terminal mới** rồi kiểm tra: `node -v`, `npm -v`, `ffmpeg -version`, `python --version`.
</details>

<details>
<summary><b>macOS (Homebrew)</b></summary>

```bash
brew install node ffmpeg
brew install python@3.12   # nếu dùng backend
```
</details>

<details>
<summary><b>Linux (Debian/Ubuntu)</b></summary>

```bash
# Node.js LTS qua nvm (khuyến nghị)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts

sudo apt update
sudo apt install -y ffmpeg python3 python3-venv python3-pip
```
</details>

---

## Cài đặt & chạy

### 1. Frontend (đủ để dùng cơ bản)

```bash
git clone https://github.com/yudgunH/XinChao-Cut.git
cd XinChao-Cut
npm install
npm run dev          # mở http://localhost:5173
```

Tới đây app đã chạy đầy đủ **100% trong trình duyệt** — import video, dựng timeline, caption (Whisper in-browser), export bằng WebCodecs. Phần backend bên dưới chỉ cần khi muốn nhanh hơn / có AI mạnh hơn.

### 2. Backend (tùy chọn — FFmpeg + AI)

Backend có **4 “tier”** cài đặt, chọn cái nhỏ nhất bạn cần để khỏi tải hàng GB wheel CUDA thừa:

| File requirements | Cài được gì | Nặng |
|---|---|---|
| `requirements-core.txt` | Media (probe/thumbnail/waveform), proxy, **export FFmpeg**. Không có AI. | nhẹ |
| `requirements-caption.txt` | Core **+ WhisperX** (caption chất lượng cao) | ~2 GB CUDA |
| `requirements-audio.txt` | Core **+ Demucs** (tách giọng/nhạc) | ~2 GB CUDA |
| `requirements.txt` | **Tất cả** (caption + audio) | ~2–3 GB |
| `requirements-dev.txt` | Thêm pytest để chạy test (cài chồng lên tier bất kỳ) | — |

```bash
cd backend
python -m venv .venv

# Kích hoạt venv:
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # macOS / Linux

# Chọn 1 tier (ví dụ chỉ cần media + export, không AI):
pip install -r requirements-core.txt
# …hoặc full:  pip install -r requirements.txt

cp .env.example .env              # (Windows: copy .env.example .env) — tùy chọn, để chỉnh cấu hình
uvicorn app.main:app --reload --port 8000
```

**Kiểm tra backend:** mở http://127.0.0.1:8000/health — trường `capabilities` cho biết tính năng nào sẵn sàng:

```jsonc
{
  "status": "ok",
  "capabilities": {
    "media": true,        // ffmpeg/ffprobe OK
    "transcribe": true,   // WhisperX OK (tier caption)
    "separate": true,     // Demucs OK (tier audio)
    "export": true        // export server-side OK
  }
}
```

> Nếu `media: false` → ffmpeg chưa có trong PATH. Nếu `transcribe: false` dù đã cài tier caption → xem [Khắc phục sự cố](#khắc-phục-sự-cố).

### 3. Nối frontend với backend

Tạo file `.env.local` ở **thư mục gốc repo**:

```
VITE_BACKEND_URL=http://127.0.0.1:8000
```

Khởi động lại `npm run dev`. Khi backend bật, app tự dùng nó cho caption + xử lý media; khi tắt, app im lặng quay về đường in-browser. (File `.env.local` đã được `.gitignore`, không commit lên repo.)

### 4. Bật tăng tốc GPU (NVIDIA / CUDA) — tùy chọn

Mặc định các tier `caption`/`audio` đã trỏ tới index `cu121`, tức **tự kéo bản PyTorch CUDA** (kèm sẵn cuDNN mà ctranslate2 cần — không phải cài cuDNN riêng). Chỉ cần card NVIDIA + driver mới. Sau đó bật trong `backend/.env`:

```
XINCHAO_WHISPER_DEVICE=cuda
XINCHAO_WHISPER_COMPUTE_TYPE=float16
XINCHAO_WHISPER_MODEL=large-v3
```

**Chỉ chạy CPU:** đổi dòng `--extra-index-url` trong `requirements-caption.txt` / `requirements-audio.txt` từ `.../whl/cu121` sang `.../whl/cpu`, và để `XINCHAO_WHISPER_DEVICE=cpu`, `XINCHAO_WHISPER_COMPUTE_TYPE=int8`.

### 5. Khởi động nhanh trên Windows

Có sẵn 2 script bấm-là-chạy ở thư mục gốc (giả định venv đã tạo ở `backend/.venv` và đã `npm install`):

- **`start.bat`** — mở backend + frontend trong 2 cửa sổ rồi tự bung trình duyệt.
- **`start-backend.bat`** — chỉ chạy backend.

---

## Tham chiếu cấu hình (biến môi trường)

### Frontend — `.env.local` (gốc repo)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `VITE_BACKEND_URL` | *(trống)* | URL backend. Bỏ trống = chạy hoàn toàn in-browser. |

### Backend — `backend/.env` (tiền tố `XINCHAO_`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `XINCHAO_HOST` | `127.0.0.1` | Địa chỉ bind của server. |
| `XINCHAO_PORT` | `8000` | Cổng. |
| `XINCHAO_WORK_DIR` | `./.work` | Nơi chứa upload tạm / file sinh ra. |
| `XINCHAO_EXPORT_THREADS` | `0` | Số thread cho FFmpeg/x264. `0` = tất cả CPU trừ 2. |
| `XINCHAO_ASSETS_QUOTA_MB` | `5000` | Trần dung lượng kho asset (LRU). `0` = không giới hạn. |
| `XINCHAO_ASSETS_TTL_DAYS` | `30` | Xóa asset không đụng tới quá số ngày này. `0` = không hết hạn. |
| `XINCHAO_WHISPER_DEVICE` | `auto` | `auto` / `cuda` / `cpu`. |
| `XINCHAO_WHISPER_COMPUTE_TYPE` | `auto` | `auto` → float16 trên GPU, int8 trên CPU. |
| `XINCHAO_WHISPER_MODEL` | `small` | `tiny`\|`base`\|`small`\|`medium`\|`large-v3`\|`large-v3-turbo`. |
| `XINCHAO_WHISPER_CACHE` | `./.work/models` | Thư mục cache model tải về. |

### Backend — dịch phụ đề bằng LLM (tùy chọn, **không** có tiền tố)

Điền **một** API key của nhà cung cấp bạn có. Endpoint dựng sẵn — chỉ cần key. Nếu set nhiều, thứ tự ưu tiên: **Gemini → OpenAI → Anthropic → OpenRouter**.

| Biến | Ý nghĩa |
|---|---|
| `GEMINI_API_KEY` | Google Gemini (mặc định `gemini-2.0-flash`). |
| `OPENAI_API_KEY` | OpenAI (`gpt-4o-mini`). |
| `ANTHROPIC_API_KEY` | Anthropic (`claude-3-5-haiku-latest`). |
| `OPENROUTER_API_KEY` | OpenRouter (`google/gemini-2.0-flash-001`). |
| `OPENROUTER_BASE_URL` | Base URL OpenRouter (đổi nếu dùng proxy). |
| `OPENROUTER_TRANSLATE_MODEL` | Ghi đè model OpenRouter. |

> ⚠️ Đừng commit `.env` / `.env.local` — cả hai đã nằm trong `.gitignore`. Đừng đưa API key vào repo.

---

## Cách sử dụng

1. **Import media** — bấm *Import media* ở panel trái hoặc kéo-thả file vào panel / preview / timeline.
2. **Dựng timeline** — kéo clip xuống track. Cắt: đưa playhead tới vị trí rồi `S`. Trim: kéo mép clip. Bật **Snap** để hít mép/playhead, bật **🔗** để video kéo theo phụ đề/audio.
3. **Phụ đề** — tab *Captions*: chọn model + ngôn ngữ → *Generate captions*, hoặc import `.srt/.vtt/.ass`. Chỉnh style một dòng sẽ áp cho toàn bộ phụ đề.
4. **Âm thanh** — chọn clip → *Properties → Audio*: chỉnh Volume, giảm noise, hoặc tách giọng & nhạc (cần backend).
5. **Hiệu ứng & màu** — *Properties → Animation* (Zoom/Fade), *Adjust* (Brightness/Contrast/Saturation), *Speed* (0.1–4×).
6. **Export** — bấm *Export*, đặt tên, chọn engine (Server/Browser), bật/tắt Video / Audio / Captions, rồi *Download*.

### Phím tắt

| Phím | Hành động |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Lùi / tiến 1 frame |
| `Home` / `End` | Về đầu / cuối timeline |
| `S` | Split (cắt) tại playhead |
| `Delete` | Xóa clip đang chọn |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Ctrl+D` | Duplicate |
| `Shift+?` | Bảng phím tắt |

---

## Khắc phục sự cố

| Triệu chứng | Nguyên nhân & cách xử lý |
|---|---|
| `/health` báo `media: false` | `ffmpeg`/`ffprobe` không có trong PATH. Cài lại rồi **mở terminal mới**. |
| `/health` báo `transcribe: false` dù đã cài tier caption | Thường do `torch`/`torchaudio` lệch phiên bản, hoặc lỡ cài `hf-xet`. Giữ đúng `torch==2.2.2`, `torchaudio==2.2.2`; gỡ hf-xet: `pip uninstall hf-xet -y`. |
| Lỗi 401 “Unauthorized” khi load model Whisper | `hf_xet` đang cố dùng CAS proxy `localhost:8080`. Đặt biến `HF_HUB_DISABLE_XET=1` trước khi chạy uvicorn (script `start.bat` đã làm sẵn). |
| App báo không export/caption được, panel backend xám | Backend chưa chạy hoặc `.env.local` thiếu `VITE_BACKEND_URL`. Mở `/health` để kiểm tra rồi restart `npm run dev`. |
| Trình duyệt báo lỗi WebCodecs / không phát được | Dùng Chrome 94+ hoặc Edge. Firefox/Safari chưa hỗ trợ đầy đủ. |
| GPU không được dùng (chạy chậm) | Cài bản torch `cu121` (không phải `cpu`), đặt `XINCHAO_WHISPER_DEVICE=cuda`, và đảm bảo driver NVIDIA mới. |
| Cổng 8000/5173 bị chiếm | Đổi `XINCHAO_PORT` / `--port`, hoặc chạy `vite --port <khác>` và cập nhật `VITE_BACKEND_URL`. |

---

## Lệnh npm

```bash
npm run dev         # dev server (Vite)
npm run build       # type-check + build production
npm run preview     # xem thử bản build
npm run typecheck   # chỉ kiểm tra type
npm run lint        # eslint
npm run test        # vitest
```

Chạy test backend (sau khi cài `requirements-dev.txt`):

```bash
cd backend && pytest
```

## Cấu trúc thư mục

```
XinChao-Cut/
├─ src/                # frontend (app shell, components, engine, hooks, store, workers)
│  └─ engine/          # lõi không phụ thuộc UI: timeline, media, audio, subtitle, export, backend
├─ backend/            # FastAPI + FFmpeg + WhisperX + Demucs (tùy chọn)
│  ├─ app/             # routers, export, cấu hình
│  └─ requirements*.txt# các tier cài đặt
├─ src-tauri/          # vỏ desktop Tauri (tùy chọn)
├─ docs/               # tài liệu thiết kế (hệ thống, UI, clean-code, hiệu năng)
└─ README.md
```

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md) và [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Báo lỗi bảo mật theo [SECURITY.md](SECURITY.md).

## Giấy phép

Phát hành theo giấy phép [MIT](LICENSE).

---

*XinChao-Cut là dự án học tập/cá nhân.*
