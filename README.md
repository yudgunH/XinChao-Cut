<div align="center">

<img src="public/logo.png" width="104" alt="XinChao-Cut" />

# XinChao-Cut

**Trình dựng video đa track và Voice Studio mã nguồn mở, chạy cục bộ trên Windows.**

[English](README.en.md) · [Cài đặt nâng cao](docs/INSTALLATION.md) · [Tài liệu thiết kế](docs/01-system-design.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4)
![React](https://img.shields.io/badge/React-18-61dafb)
![Tauri](https://img.shields.io/badge/Tauri-2-ffc131)

<img src="docs/screenshots/editor.png" alt="Giao diện XinChao-Cut" width="48%" />
&nbsp;
<img src="docs/screenshots/export.png" alt="Hộp thoại export" width="48%" />

</div>

> Repository mã nguồn mở này gồm **Editor** và **Voice Studio**. Các workspace nội bộ Review, Dub/Dubbing và Batch không nằm trong bản phát hành này.

XinChao-Cut kết hợp timeline nhiều track, preview trực tiếp và export bằng WebCodecs/FFmpeg. Bản desktop bổ sung backend cục bộ cho proxy, waveform, tạo phụ đề, tách vocals và tổng hợp giọng nói. Bộ cài không nhúng model AI: bạn chỉ tải đúng tính năng cần dùng từ giao diện **Quản lý model**.

## Mục lục

- [Tính năng chính](#tính-năng-chính)
- [Cài bản desktop](#cài-bản-desktop)
- [Chạy từ mã nguồn](#chạy-từ-mã-nguồn)
- [Cài thêm model trên giao diện](#cài-thêm-model-trên-giao-diện)
- [Hướng dẫn sử dụng](#hướng-dẫn-sử-dụng)
- [Phím tắt](#phím-tắt)
- [Dữ liệu và quyền riêng tư](#dữ-liệu-và-quyền-riêng-tư)
- [Xử lý lỗi thường gặp](#xử-lý-lỗi-thường-gặp)
- [Phát triển và đóng gói](#phát-triển-và-đóng-gói)

## Tính năng chính

- Timeline nhiều track video, audio, text và hiệu ứng; split, trim, ripple, snap, group, compound, undo/redo.
- Preview trực tiếp; di chuyển, scale, crop, rotate, tốc độ, opacity, âm lượng và chỉnh màu.
- Nhập/xuất SRT, VTT, ASS; tạo phụ đề bằng WhisperX hoặc FunASR tiếng Trung.
- Tách vocals và nhạc nền bằng Demucs.
- Voice Studio dùng OmniVoice: tạo giọng nói, nghe thử, tải WAV và quản lý voice clone.
- Export MP4, MP3/WAV và subtitle bằng trình duyệt hoặc FFmpeg cục bộ.
- Dự án, media, model và output được xử lý cục bộ; dịch qua LLM là kết nối mạng tùy chọn.

## Cài bản desktop

Bản phát hành hiện tại dành cho **Windows 10/11 64-bit**.

1. Cài [Python 3.11 64-bit](https://www.python.org/downloads/release/python-3119/) và chọn **Add python.exe to PATH**.
2. Tải file cài đặt `.exe` tại [GitHub Releases](https://github.com/yudgunH/XinChao-Cut/releases).
3. Chạy bộ cài và mở XinChao-Cut. Wizard thiết lập lần đầu sẽ tự xuất hiện ngay tại Home.
4. Bấm **Cài Core + FFmpeg**; backend sẽ tự khởi động khi hoàn tất.
5. Model AI là tùy chọn và có thể cài sau từ **Trạng thái backend → Quản lý model**.

FFmpeg được tải ở phiên bản đã ghim và kiểm tra checksum; không cần cài FFmpeg hệ thống. GPU NVIDIA là tùy chọn, nhưng các tác vụ AI sẽ chậm hơn đáng kể nếu chỉ chạy CPU.

## Chạy từ mã nguồn

### Yêu cầu

- Node.js 22 LTS và npm.
- Python 3.11 64-bit trong `PATH`.
- Rust stable, Microsoft C++ Build Tools và WebView2 để chạy Tauri desktop.
- Git và kết nối mạng ở lần cài đầu.

### Setup một lần

```powershell
git clone https://github.com/yudgunH/XinChao-Cut.git
cd XinChao-Cut
.\setup.bat
```

`setup.bat` thực hiện hai việc có thể chạy lặp lại an toàn:

1. `npm ci` để cài dependency đúng theo `package-lock.json`.
2. Cài Core backend và FFmpeg vào `%LOCALAPPDATA%\XinChao-Cut`.

Script cố ý không tải WhisperX, FunASR, Demucs hoặc OmniVoice. Khởi chạy desktop bằng:

```powershell
.\start.bat
```

`start.bat` mở một cửa sổ backend hot reload và một cửa sổ Tauri. Đóng hai cửa sổ đó để dừng môi trường dev.

Nếu chỉ sửa giao diện và không cần backend:

```powershell
npm run dev
```

Sau đó mở `http://localhost:5173`. Editor cơ bản, Whisper Tiny trong browser và browser export vẫn dùng được; tính năng FFmpeg/AI phía server sẽ offline.

## Cài thêm model trên giao diện

Đúng: sau setup cơ bản, toàn bộ model tùy chọn có thể cài ngay trong ứng dụng.

1. Mở XinChao-Cut desktop.
2. Bấm chấm trạng thái **backend** trên thanh trên cùng.
3. Chọn **Quản lý model**.
4. Chọn **Nơi lưu model và dữ liệu** trước khi tải nếu ổ C không còn nhiều chỗ.
5. Chọn gói và model Whisper mong muốn.
6. Bật **Tải model ngay trong lúc cài** nếu cần dùng offline; tắt mục này để model tự tải ở lần dùng đầu.
7. Bấm **Cài / cập nhật gói đã chọn** và giữ ứng dụng mở đến khi log báo hoàn tất.

| Gói | Chức năng | Gợi ý |
|---|---|---|
| Core + FFmpeg | Đọc media, proxy, waveform, export server | Bắt buộc cho backend desktop |
| WhisperX | Phụ đề đa ngôn ngữ, timing theo từ | `Small` cân bằng; `Large v3` chính xác hơn nhưng nặng |
| FunASR | Phụ đề tiếng Trung với VAD/punctuation | Chỉ cài khi xử lý tiếng Trung |
| Demucs | Tách vocals và nhạc nền | Tác vụ nặng, GPU giúp tăng tốc |
| OmniVoice | Voice Studio và clone voice | Dùng môi trường Python riêng |

Model Manager chỉ thêm hoặc cập nhật gói đã chọn. Bỏ dấu chọn không xóa model, cache hay voice đã có.

## Hướng dẫn sử dụng

### 1. Tạo dự án và nhập media

1. Ở màn hình Home, tạo project mới hoặc mở project gần đây.
2. Mở tab **Media**, bấm Import hoặc kéo video, audio, ảnh vào cửa sổ.
3. Kéo asset từ thư viện xuống timeline.
4. Chờ thumbnail, waveform hoặc proxy hoàn tất nếu file lớn.

Ứng dụng tự lưu project. File media gốc vẫn được tham chiếu từ máy, vì vậy không nên đổi tên, di chuyển hoặc xóa file đang dùng. Với video lớn, chế độ proxy **Smart** giúp preview nhẹ hơn và có thể đổi trong menu trạng thái backend.

### 2. Dựng trên timeline

- Kéo clip để đổi thời điểm hoặc track; kéo hai mép để trim.
- Đặt playhead rồi nhấn `S` để cắt clip.
- Bật **Snap** để bám vào playhead/mép clip; bật **Link** để video đi cùng audio/caption liên kết.
- Dùng magnetic main track khi muốn track chính tự đóng khoảng trống.
- Chọn clip để chỉnh transform, crop, speed, opacity, volume, animation và màu ở Properties.
- Nhấn chuột phải để mở Replace, Crop & Rotate, Group hoặc Compound theo ngữ cảnh.

Tab **Text** thêm text preset. Tab **Effects/Transitions/Filters** áp chuyển động, chuyển cảnh và màu; đưa chuột lên tile để xem trước nếu hiệu ứng hỗ trợ preview.

### 3. Tạo và chỉnh phụ đề

1. Mở tab **Captions** và chọn engine, model, ngôn ngữ.
2. Dùng WhisperX cho đa ngôn ngữ; dùng FunASR khi nguồn là tiếng Trung.
3. Chạy tạo caption và giữ project hiện tại mở cho đến khi hoàn tất.
4. Rà lại tên riêng, con số, chính tả và timing trong Caption Studio.
5. Chỉnh font, màu, nền, vị trí, animation; kiểm tra safe area trên preview.
6. Khi export, chọn burn-in để ghim chữ vào hình hoặc xuất SRT/VTT/ASS riêng.

Có thể import subtitle có sẵn. AI luôn có khả năng nghe nhầm, đặc biệt ở đoạn có nhạc nền, nhiều người nói hoặc âm thanh kém.

### 4. Voice Studio

1. Cài OmniVoice trong **Quản lý model**.
2. Mở tab **Voice** → **Mở Voice Studio**.
3. Chọn voice có sẵn hoặc tạo voice clone từ mẫu âm thanh sạch, một người nói.
4. Nhập từng câu, tạo thử, nghe preview rồi chỉnh text/speed.
5. Tải WAV hoặc đưa kết quả vào thư viện và timeline.

Bạn cũng có thể đọc toàn bộ caption thành voiceover. Nên sửa xong caption trước, sau đó nghe lại từng điểm nối và chỉnh timing. Chỉ clone giọng khi có quyền và sự đồng ý phù hợp.

### 5. Tách vocals và nhạc nền

Cài Demucs, chọn clip audio/video rồi mở **Properties → Audio** và chạy tách nguồn. Các stem kết quả có thể preview, tải hoặc đưa lại vào timeline. Khi dùng stem mới, hãy mute audio gốc để tránh hai lớp âm thanh phát chồng nhau.

### 6. Dịch phụ đề bằng LLM

Mở **Cấu hình AI** từ Home hoặc thanh trên cùng, cấu hình riêng provider, URL, API key và model cho tác vụ dịch/correction. Tính năng này dùng mạng và gửi phần text cần xử lý tới provider đã chọn; media gốc không tự động được gửi đi.

### 7. Export

1. Kiểm tra đầu, giữa và cuối timeline; nghe lại audio bằng tai nghe.
2. Bấm **Export**, chọn MP4, MP3/WAV và/hoặc subtitle.
3. Đặt thư mục output, resolution, FPS, quality, codec, audio và caption.
4. Dùng engine ứng dụng đề xuất: **Server/FFmpeg** cho desktop/project lớn, **Browser/WebCodecs** khi không có backend.
5. Giữ ứng dụng và media gốc cho đến khi progress hoàn tất.
6. Mở file output để kiểm tra trước khi xóa cache hoặc source.

## Phím tắt

Nhấn `Shift+?` hoặc biểu tượng bàn phím để xem và đổi shortcut ngay trong ứng dụng.

| Phím mặc định | Tác vụ |
|---|---|
| `Space` | Play/pause |
| `←` / `→` | Lùi/tiến một frame |
| `Home` / `End` | Tới đầu/cuối timeline |
| `S` | Split clip đã chọn hoặc clip dưới playhead |
| `Q` / `W` | Trim mép trái/phải tới playhead |
| `C` | Crop & Rotate |
| `Delete` | Xóa clip đã chọn |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo/redo |
| `Ctrl+C/X/V/D` | Copy/cut/paste/duplicate |
| `Ctrl+G` / `Ctrl+Shift+G` | Group/ungroup |
| `Alt+G` / `Alt+Shift+G` | Tạo/phá compound clip |
| `Escape` | Bỏ chọn |

Khi gán một tổ hợp đã tồn tại, shortcut cũ sẽ tự được gỡ để tránh xung đột. Shortcut dựng phim bị vô hiệu khi đang nhập text.

## Dữ liệu và quyền riêng tư

- Runtime, Python environment, FFmpeg và log: `%LOCALAPPDATA%\XinChao-Cut`.
- Model, voice, asset và job mặc định: `%LOCALAPPDATA%\XinChao-Cut\work`.
- Log backend: `%LOCALAPPDATA%\XinChao-Cut\backend.log`.
- Có thể đổi thư mục dữ liệu lớn trong **Quản lý model**; dữ liệu cũ không tự di chuyển.

Editor, export cục bộ và model local không yêu cầu tải media lên dịch vụ XinChao-Cut. Việc tải model kết nối tới nguồn phân phối của model. Chỉ tính năng LLM do người dùng cấu hình mới gửi text tới provider bên ngoài.

## Xử lý lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `setup.bat` không thấy Python | Cài đúng Python 3.11 x64, bật `Add python.exe to PATH`, mở terminal mới |
| `npm ci` lỗi | Dùng Node.js 22 LTS, kiểm tra mạng, chạy lại `setup.bat` |
| Backend offline | Mở menu trạng thái → **Khởi động backend** → **Recheck** |
| Cổng 8000 đang được dùng | Đóng cửa sổ/process backend cũ rồi chạy lại `start.bat` |
| Model tải rất lâu | Kiểm tra mạng và dung lượng; xem log trong Model Manager; có thể để tải ở lần dùng đầu |
| CUDA/GPU không nhận | Cập nhật NVIDIA driver; ứng dụng vẫn có thể fallback CPU cho tác vụ hỗ trợ |
| Export thất bại | Kiểm tra ổ trống, media bị di chuyển, tên output và log backend; thử engine được đề xuất |
| Project mất media | Đặt lại file gốc đúng vị trí hoặc dùng Replace để trỏ tới file mới |

Khi báo lỗi, gửi phiên bản ứng dụng, Windows, CPU/GPU, các bước tái hiện và đoạn log liên quan sau khi xóa API key/đường dẫn nhạy cảm.

## Phát triển và đóng gói

Các lệnh kiểm tra chính:

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

Build bộ cài NSIS:

```powershell
npm ci
npm run tauri build
```

Tauri tự stage backend trước khi build. `src-tauri/backend-bundle`, `dist`, `node_modules`, virtual environment, cache, model và dữ liệu cá nhân đều là output cục bộ, không được commit.

```text
src/                 React editor và Voice Studio
src-tauri/           Tauri desktop shell, quyền native và NSIS
backend/app/         FastAPI, FFmpeg, export và worker AI
backend/setup.ps1    Installer Core/model được Model Manager gọi
scripts/             Công cụ build và staging
docs/                Tài liệu cài đặt, sử dụng và thiết kế
```

Mã nguồn dùng giấy phép [MIT](LICENSE). Dependency và trọng số model bên thứ ba có giấy phép riêng; hãy đọc model card trước khi phân phối hoặc sử dụng thương mại.

[Đóng góp](CONTRIBUTING.md) · [Bảo mật](SECURITY.md) · [Quy tắc cộng đồng](CODE_OF_CONDUCT.md)
