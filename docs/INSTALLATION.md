# Cài đặt XinChao-Cut

Tài liệu này dành cho bản desktop Windows và contributor chạy từ source.

## 1. Bản desktop Windows

### Yêu cầu

- Windows 10/11 64-bit.
- Python 3.11 64-bit, có trong `PATH`.
- RAM tối thiểu 8 GB; 16 GB trở lên phù hợp hơn cho AI.
- GPU NVIDIA là tùy chọn. CPU vẫn chạy được nhưng tạo phụ đề, tách giọng và TTS sẽ chậm hơn.
- Một ổ đĩa còn đủ chỗ cho virtual environment, cache và model.

FFmpeg được bộ cài backend tải bản đã ghim và kiểm tra checksum; không cần cài FFmpeg hệ thống.

### Cài ứng dụng và model

1. Tải `.exe` từ trang [Releases](https://github.com/yudgunH/XinChao-Cut/releases) và cài cho tài khoản hiện tại.
2. Mở ứng dụng. Trên thanh trên cùng, bấm trạng thái backend rồi chọn **Quản lý model**.
3. Chọn **Nơi lưu model và dữ liệu** trước khi tải. Thư mục này chứa cache model, voice clone, asset backend và job export.
4. Chọn các gói:

   - **Core + FFmpeg**: luôn cài; không chứa model AI.
   - **WhisperX**: phụ đề đa ngôn ngữ. Chọn Tiny, Small hoặc Large v3.
   - **FunASR**: tối ưu luồng phụ đề tiếng Trung.
   - **Demucs**: tách vocals và nhạc nền.
   - **OmniVoice**: Voice Studio và clone voice.

5. Chọn một trong hai cách tải:

   - **Tải model ngay**: mất thời gian hơn nhưng có thể dùng offline sau khi hoàn tất.
   - **Tải ở lần dùng đầu**: cài ban đầu nhanh hơn; từng model chỉ tải khi mở tính năng tương ứng.

6. Bấm **Cài / cập nhật gói đã chọn** và giữ ứng dụng mở cho đến khi log báo hoàn tất.

Model Manager chỉ thêm hoặc cập nhật gói đã chọn; nó không tự xóa model/voice đã có. Cách này tránh mất dữ liệu khi người dùng tạm bỏ chọn một tính năng.

### Vị trí dữ liệu

- Runtime, Python environment, FFmpeg và log mặc định: `%LOCALAPPDATA%\XinChao-Cut`.
- Model, voice, asset và job mặc định: `%LOCALAPPDATA%\XinChao-Cut\work`.
- Nếu đổi thư mục dữ liệu trong ứng dụng, runtime vẫn ở thư mục trên nhưng dữ liệu lớn chuyển sang thư mục đã chọn.
- Log backend: `%LOCALAPPDATA%\XinChao-Cut\backend.log`.

Sau khi đổi thư mục dữ liệu, hãy khởi động lại backend. Dữ liệu cũ không tự di chuyển; người dùng chủ động chép nếu cần giữ cache/voice cũ.

## 2. Cài chọn lọc bằng PowerShell

Chạy từ thư mục repository hoặc backend đã được đóng gói:

```powershell
# Chỉ Core + FFmpeg
backend\setup.bat -Components core

# Core + phụ đề Small + Voice Studio; model tải khi dùng lần đầu
backend\setup.bat -Components core,caption,tts -WhisperModel small

# Thêm tiếng Trung và Demucs, đồng thời tải model ngay
backend\setup.bat -Components core,caption,funasr,audio,tts -WhisperModel large-v3 -DownloadModels

# Chỉ xem kế hoạch, không thay đổi file
backend\setup.bat -Components core,caption -WhisperModel tiny -PlanOnly
```

Tên component hợp lệ: `core`, `caption`, `funasr`, `audio`, `tts`.

Trên Windows, cách dễ nhất để cài thêm model về sau là mở ứng dụng, bấm biểu tượng trạng thái backend rồi chọn **Quản lý model**. Giao diện này có thể chạy lại nhiều lần; nó chỉ thêm/cập nhật gói đã chọn và không xóa model hoặc voice hiện có.

Muốn tự động hóa hoặc cài trên máy không mở được giao diện, gọi thẳng script backend:

```powershell
backend\setup.bat -Components core,caption,tts -WhisperModel small -DownloadModels
```

Có thể đặt `XINCHAO_AI_DIR` để đổi nơi chứa runtime trước khi chạy setup. Dữ liệu lớn có thể đổi trong ứng dụng hoặc bằng file một dòng `%XINCHAO_AI_DIR%\data-dir.txt`.

## 3. Chạy dev từ source

### 3.1. Chuẩn bị chung

Cài các công cụ sau rồi mở terminal PowerShell mới:

- Git.
- Node.js 20 LTS trở lên và npm.
- Python 3.11 64-bit nếu phát triển backend/AI.
- FFmpeg + ffprobe trong `PATH` nếu chạy backend bằng `.venv` dev.
- Rust stable, Microsoft C++ Build Tools và WebView2 nếu chạy Tauri desktop dev.

Kiểm tra:

```powershell
git --version
node --version
npm --version
py -3.11 --version
ffmpeg -version
cargo --version
```

Tại repository root, có thể chạy toàn bộ bước cài frontend và Core/FFmpeg bằng:

```powershell
.\setup.bat
```

`setup.bat` không tải model AI. Sau khi ứng dụng mở, dùng **Trạng thái backend → Quản lý model** để chỉ cài những tính năng cần thiết.

### 3.2. Chế độ A — chỉ frontend trong browser

Dùng chế độ này khi sửa UI, timeline, preview hoặc browser export và không cần FastAPI:

```powershell
npm run dev
```

Mở `http://localhost:5173`. Không tạo `.env.local`, hoặc để `VITE_BACKEND_URL` trống. Backend status sẽ hiện offline nhưng editor cơ bản vẫn hoạt động; caption dùng Whisper Tiny trong browser và export dùng WebCodecs.

### 3.3. Chế độ B — Tauri desktop + backend hot reload

Đây là chế độ khuyên dùng khi sửa endpoint, FFmpeg, caption, separation hoặc TTS.

Tạo môi trường backend một lần:

```powershell
cd backend
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements-core.txt
copy .env.example .env
cd ..
```

Chỉ cài thêm tier đang phát triển:

```powershell
# WhisperX
backend\.venv\Scripts\python -m pip install -r backend\requirements-caption.txt

# FunASR tiếng Trung
backend\.venv\Scripts\python -m pip install -r backend\requirements-funasr.txt

# Demucs
backend\.venv\Scripts\python -m pip install -r backend\requirements-audio.txt
```

Tạo `.env.local` ở repository root:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
```

Chạy bằng hai terminal:

```powershell
# Terminal 1
cd backend
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

```powershell
# Terminal 2, tại repository root
npm run tauri dev
```

Hoặc sau khi Python runtime và `node_modules` đã tồn tại, chạy một lệnh:

```powershell
.\start.bat
```

`start.bat` mở hai cửa sổ: Uvicorn backend và `npm run tauri dev`. Nó không tự mở bản web trong browser nữa. Script ưu tiên runtime `%LOCALAPPDATA%\XinChao-Cut\venv` do `setup.bat` hoặc Model Manager tạo, rồi mới fallback về `backend\.venv` của checkout cũ. Tauri được báo dùng backend dev bên ngoài để không khởi động trùng backend staged trên cổng 8000.

Kiểm tra backend tại `http://127.0.0.1:8000/health` và Swagger tại `http://127.0.0.1:8000/docs`. Khi sửa `.py`, Uvicorn tự reload; khi sửa React/TypeScript, Vite HMR cập nhật trực tiếp cửa sổ desktop.

`backend/.env` phải dùng prefix `XINCHAO_`. Các API key dịch LLM như `OPENAI_API_KEY` hoặc `GEMINI_API_KEY` không có prefix. Không commit `.env` hay `.env.local`.

### 3.4. OmniVoice trong dev

OmniVoice phải ở môi trường riêng vì dependency xung đột với WhisperX/Demucs:

```powershell
cd backend
py -3.11 -m venv .venv-omnivoice
.venv-omnivoice\Scripts\python -m pip install pip==25.3
.venv-omnivoice\Scripts\python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
.venv-omnivoice\Scripts\python -m pip install -r requirements-tts.txt
```

Trong `backend/.env`, trỏ worker vào interpreter này nếu auto-detect không thành công:

```env
XINCHAO_OMNIVOICE_PYTHON=G:\GitHub\XinChao-Cut\backend\.venv-omnivoice\Scripts\python.exe
```

### 3.5. Chế độ C — Tauri desktop dev

Để kiểm tra native file dialog, drag/drop đường dẫn, asset protocol, Model Manager và hành vi desktop:

```powershell
npm run tauri dev
```

Nếu dùng backend `.venv` hot reload, hãy chạy backend ở terminal riêng như chế độ B và giữ `.env.local`.

Muốn thử đúng luồng Model Manager gần giống bản đóng gói:

```powershell
npm run backend:stage
npm run tauri dev
```

Sau đó mở trạng thái backend → **Quản lý model**. Luồng này cài runtime vào `%LOCALAPPDATA%\XinChao-Cut`; backend staged không hot reload theo source. Khi sửa Python, phải stage và khởi động lại, nên không dùng nó thay cho chế độ B trong quá trình code backend liên tục.

### 3.6. Kiểm tra trước khi gửi thay đổi

```powershell
npm run typecheck
npm run lint
npm test -- --run
npm run build
python -m pytest backend -q
cd src-tauri
cargo fmt --all -- --check
cargo check
```

Xem cấu hình backend nâng cao trong [backend/README.md](../backend/README.md).

## 4. Build bộ cài NSIS

Yêu cầu thêm Rust toolchain và WebView2 build prerequisites của Tauri.

```powershell
npm ci
npm run backend:stage
npm run tauri build
```

Tauri cũng tự chạy `backend:stage` trước frontend build. Thư mục `src-tauri/backend-bundle` là output sinh tự động và chỉ chứa runtime cần phân phối.

## 5. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| Không tìm thấy Python | Cài Python 3.11 64-bit, bật PATH, đóng/mở lại ứng dụng |
| Backend vẫn offline | Mở Model Manager, cài Core, xem `backend.log`, rồi bấm kiểm tra lại |
| Lần đầu dùng đứng ở tải model | Kiểm tra mạng và dung lượng ổ; thử chọn tải model ngay để xem log rõ hơn |
| GPU không được dùng | Cập nhật driver NVIDIA; mở GPU diagnostics; CPU fallback vẫn hoạt động |
| FunASR không xuất hiện | Cài gói FunASR trong Model Manager rồi khởi động lại backend |
| Voice Studio báo chưa sẵn sàng | Cài OmniVoice; môi trường TTS tách biệt nên có thể mất nhiều thời gian |
| Ổ hệ thống sắp đầy | Đổi thư mục dữ liệu trước khi tải model; xóa cache cũ chỉ khi chắc không cần |

Không gửi API key, file voice clone hoặc toàn bộ log công khai nếu chưa kiểm tra dữ liệu nhạy cảm.
