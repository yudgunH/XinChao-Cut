# 01 — Kiến trúc hệ thống hiện tại

Tài liệu này mô tả code đang chạy ở phiên bản `0.1.4`. Khi tài liệu và source khác nhau, `package.json`, `src/`, `src-tauri/` và `backend/app/` là nguồn sự thật.

## 1. Phạm vi sản phẩm

XinChao-Cut gồm:

- màn hình Home quản lý nhiều project;
- editor timeline nhiều track cho video, audio, text và hiệu ứng;
- preview trực tiếp trong WebView/browser;
- export bằng WebCodecs trong renderer hoặc FFmpeg ở backend cục bộ;
- phụ đề, dịch/correction, tách vocals và Voice Studio;
- bản desktop Windows đóng gói bằng Tauri 2 và NSIS.

Backend và các gói AI là tùy chọn đối với editor chạy trong browser. Bản desktop cần Core + FFmpeg để dùng đầy đủ media tools và server export.

## 2. Sơ đồ runtime

```text
React UI
  ├─ Home / First-run setup
  └─ Editor: panels · preview · timeline · properties · export
          │
          ▼
Zustand stores + React hooks
          │
          ▼
TypeScript engines
  media · timeline · composition · audio · subtitle · export · persistence
     │                         │
     │                         ├─ Browser APIs: WebCodecs, Web Audio,
     │                         │  Canvas/WebGL/WebGPU, IndexedDB, OPFS
     │                         │
     └─ HTTP localhost ────────┴─ FastAPI backend
                                  FFmpeg · WhisperX · FunASR · Demucs · OmniVoice

Tauri 2 shell
  ├─ native file dialog/drag-drop and scoped asset access
  ├─ first-run setup and backend process lifecycle
  └─ packaged backend resources + NSIS installer
```

## 3. Frontend

### UI và state

- `src/app/App.tsx` chuyển giữa Home và Editor, đồng thời mount first-run setup.
- `src/app/Editor.tsx` kết nối panel, preview, timeline, properties và các hook nền.
- `src/store/` chứa Zustand stores cho project, timeline, playback, UI, shortcut và trạng thái job.
- Undo/redo của timeline nằm trong timeline/history state; project autosave không lưu selection hoặc zoom.

### Engine

`src/engine/` gom logic theo trách nhiệm:

- `media`: import, probe, thumbnail, waveform, proxy và normalization;
- `timeline`: kiểu dữ liệu, split/trim/ripple/snap/group/compound và active-clip index;
- `composition`, `preview`, `text`: dựng frame và text/caption;
- `audio`: decode, playback scheduling, denoise preview, separation/TTS runners;
- `subtitle`: import/export subtitle và orchestration transcription;
- `export`: browser export, server export, parity/admission checks và output handling;
- `persistence`: snapshot, IndexedDB repository và OPFS helpers.

Engine có thể dùng browser API nhưng không nên phụ thuộc vào React component. Side effect dài hạn được sở hữu bởi hook/store hoặc runner có cleanup/cancel rõ ràng.

## 4. Media và persistence

### Desktop

Media được chọn qua Tauri giữ `sourcePath` và stream trực tiếp từ file gốc; ứng dụng không sao chép toàn bộ video vào OPFS. Proxy hoặc bản normalize phát sinh vẫn có thể được lưu trong OPFS.

### Browser

Browser không có đường dẫn native bền vững, vì vậy media được ghi transactionally vào OPFS và metadata lưu trong IndexedDB/Dexie.

### Project

- Project snapshot và header được lưu trong IndexedDB.
- Autosave debounce 3 giây và serialize/coalesce các lần ghi cùng project.
- Backup theo project bảo vệ trước snapshot lỗi hoặc ghi đè ngoài thứ tự.
- App desktop cố flush autosave khi đóng; Rust có timeout đóng cửa sổ để tránh treo WebView.

File media gốc không được nhúng vào snapshot project. Di chuyển hoặc xóa file desktop có thể làm project mất liên kết media.

## 5. Preview và playback

- Playback dùng `requestAnimationFrame` kết hợp Web Audio clock.
- Active-clip index tránh quét toàn bộ timeline ở mỗi frame.
- Video reader/pool tái sử dụng decoder và giới hạn reset khi seek.
- Composition chọn đường GPU khi phù hợp và có fallback an toàn cho môi trường không hỗ trợ.
- Proxy mode gồm `off`, `smart` và `always`; `smart` tự tạo proxy cho nguồn cao hơn 1080p khi backend media khả dụng.

## 6. Export

### Browser

Browser export dùng renderer giống preview, WebCodecs và muxer phía client. Output tạm được ghi có kiểm soát thay vì giữ toàn bộ file lớn trong RAM. Codec và dung lượng storage được kiểm tra trước khi chạy.

### Server

Server export gửi spec timeline và media tới FastAPI. Với media desktop, backend có thể dùng `sourcePath`; browser upload theo content hash. FFmpeg chạy job có progress, cancel, quota, scratch cleanup và cache chunk.

### Hybrid

Khi hình ảnh phải đi qua browser để giữ parity nhưng audio quá lớn cho bộ nhớ renderer, ứng dụng có thể chuẩn bị audio bằng backend rồi mux trong luồng browser. Engine advisor quyết định theo capability, parity và memory estimate; không phải mọi project đều dùng cùng một đường export.

## 7. Backend cục bộ

FastAPI bind mặc định ở `127.0.0.1:8000`. Core cung cấp health, media và export; các tier tùy chọn thêm:

| Tier      | Capability                                |
| --------- | ----------------------------------------- |
| `caption` | WhisperX transcription                    |
| `funasr`  | ASR tiếng Trung                           |
| `audio`   | Demucs separation                         |
| `tts`     | OmniVoice trong virtual environment riêng |

Model không nằm trong installer. Setup có thể tải trước hoặc để tải ở lần dùng đầu.

## 8. Tauri và tiến trình backend

- Backend sạch được stage vào `src-tauri/backend-bundle` trước production build.
- Runtime Python/FFmpeg nằm ngoài thư mục cài app tại `%LOCALAPPDATA%\XinChao-Cut`.
- Tauri tự khởi động `run-backend.bat`, giữ child process và dừng process tree khi app thoát.
- Đường dẫn Windows dạng `\\?\...` được chuẩn hóa trước khi giao cho PowerShell hoặc `cmd.exe`.
- `XINCHAO_EXTERNAL_BACKEND=1` ngăn Tauri khởi động backend thứ hai trong dev hot reload.

## 9. Network và quyền riêng tư

- Editor, media tools cục bộ và local model không gửi media tới dịch vụ XinChao-Cut.
- Tải runtime/model kết nối tới nguồn phân phối tương ứng.
- Dịch/correction qua Gemini, OpenAI, Anthropic hoặc OpenRouter chỉ xảy ra khi người dùng cấu hình provider; phần text của tác vụ được gửi ra ngoài.
- Backend không có authentication và chỉ nên bind localhost nếu không có reverse proxy bảo vệ.

## 10. Nguồn sự thật khi cập nhật tài liệu

| Nội dung               | Source cần kiểm tra                                                    |
| ---------------------- | ---------------------------------------------------------------------- |
| Phiên bản và scripts   | `package.json`, `src-tauri/tauri.conf.json`                            |
| UI và shortcut         | `src/components/`, `src/store/shortcut-store.ts`                       |
| Data model/persistence | `src/engine/`, `src/lib/dexie-db.ts`                                   |
| Backend API            | `backend/app/main.py`, `backend/app/routers/`                          |
| Setup/runtime          | `backend/setup.ps1`, `backend/run-backend.bat`, `src-tauri/src/lib.rs` |
| Đóng gói               | `scripts/stage-backend.ps1`, `src-tauri/tauri.conf.json`               |
