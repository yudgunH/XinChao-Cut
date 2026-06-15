# 01 — Thiết kế hệ thống (System Design)

## 1. Mục tiêu

Xây dựng ứng dụng chỉnh sửa video web-based clone các tính năng cơ bản của CapCut:
- Multi-track timeline (video, audio, text, effect)
- Import/preview/edit/export video MP4
- Chạy mượt trên máy người dùng phổ thông (8GB RAM, iGPU)
- Có thể đóng gói Electron/Tauri sau MVP

## 2. Stack công nghệ

| Lớp | Lựa chọn | Lý do |
|---|---|---|
| Build | Vite | Dev server nhanh, hỗ trợ COOP/COEP cho SharedArrayBuffer |
| UI | React 18 + TypeScript (strict) | Concurrent rendering, ecosystem rộng |
| Styling | Tailwind CSS + CSS variables | Dark theme dễ token hóa |
| State | Zustand + Immer | Nhẹ, không boilerplate, selector tránh re-render |
| Codec | ffmpeg.wasm (multi-thread, SIMD) | Encode/decode browser-side |
| Render | WebGL2 (fallback Canvas2D), WebGPU (khi khả dụng) | Composition GPU-accelerated |
| Audio | Web Audio API + AudioWorklet | Mixing low-latency |
| Storage | IndexedDB (Dexie) + OPFS | Lưu project + media cache |
| Workers | Web Worker + Comlink | Offload heavy CPU khỏi main thread |

## 3. Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────────────┐
│                      UI Layer (React)                       │
│   MediaPanel · Preview · Timeline · Properties · TopBar    │
└──────────────────────────┬──────────────────────────────────┘
                           │  selectors / actions
┌──────────────────────────▼──────────────────────────────────┐
│                  State Layer (Zustand stores)               │
│   projectStore · timelineStore · playbackStore · uiStore   │
└──────────────────────────┬──────────────────────────────────┘
                           │  commands / events
┌──────────────────────────▼──────────────────────────────────┐
│                    Engine Layer (TS, framework-agnostic)    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Media    │ │ Timeline │ │ Compose  │ │ Audio    │       │
│  │ Manager  │ │ Engine   │ │ Engine   │ │ Engine   │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │            │            │             │            │
│  ┌────▼────────────▼────────────▼─────────────▼─────┐      │
│  │            Worker Pool (Comlink)                  │      │
│  │  decode · thumbnail · waveform · export · proxy   │      │
│  └────────────────────────┬──────────────────────────┘      │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│            Platform (Browser APIs / WASM)                    │
│   WebCodecs · WebGL/WebGPU · ffmpeg.wasm · IndexedDB · OPFS │
└──────────────────────────────────────────────────────────────┘
```

Quy tắc phụ thuộc: **UI → State → Engine → Platform**. Tuyệt đối không ngược chiều.

## 4. Các module cốt lõi

### 4.1 Media Manager
- Nhận file từ user (drag-drop / picker)
- Sinh `MediaAsset`: id, type, duration, dimensions, sampleRate, thumbnails[], waveform
- Lưu file gốc vào OPFS, metadata vào IndexedDB
- Tạo **proxy** (480p H.264) cho preview nếu file gốc > 1080p

### 4.2 Timeline Engine
- Mô hình dữ liệu thuần (pure functions, không phụ thuộc DOM)
- Cấu trúc:
  ```
  Project
    └─ Tracks[]
         └─ Clips[] { assetId, inPoint, outPoint, startOnTimeline, effects[], transitions[] }
  ```
- Operations: insert, split, trim, ripple-delete, move, group, replace
- Mọi mutation đi qua **command pattern** → undo/redo stack

### 4.3 Composition Engine
- Đầu vào: thời gian `t` trên timeline → render 1 frame
- Resolve clips active tại `t`, sort theo z-order (track index)
- Render pass:
  1. Decode frame (WebCodecs VideoDecoder, cache LRU)
  2. Upload texture lên GPU
  3. Apply filter shader (brightness/contrast/blur…)
  4. Composite blend các track
  5. Render text/overlay
- Output: `ImageBitmap` cho preview, hoặc `VideoFrame` cho encoder

### 4.4 Audio Engine
- Mỗi audio clip → `AudioBufferSourceNode` + `GainNode` + `BiquadFilterNode`
- Master bus → `AnalyserNode` (visualizer) → `destination`
- Khi export: render offline qua `OfflineAudioContext`

### 4.5 Export Engine
- Chiến lược 2 nhánh:
  - **WebCodecs path** (Chrome/Edge có hỗ trợ): `VideoEncoder` (H.264/HEVC hardware-accelerated)
  - **Fallback**: ffmpeg.wasm encode CPU
- Pipeline: Compose frame → encode chunk → mux MP4 (mp4-muxer lib)
- Audio: render offline → encode AAC → mux cùng video
- Chạy trong Web Worker, progress qua `postMessage`

### 4.6 Project State (persistence)
- Auto-save mỗi 5s vào IndexedDB (debounced)
- Project file JSON serialize: timeline + asset references (không nhúng binary)
- Export project .xinchaoproj (zip: project.json + media/)

## 5. Luồng dữ liệu (data flow)

### Khi user drop file:
```
File → MediaManager.import()
  → OPFS write → IndexedDB metadata
  → Worker: generate thumbnail + waveform + proxy
  → projectStore.addAsset() → UI cập nhật MediaPanel
```

### Khi user kéo clip vào timeline:
```
UI drag end → timelineStore.dispatch(InsertClipCommand)
  → command push vào undo stack
  → Composition Engine invalidate frame cache tại range bị ảnh hưởng
  → Preview re-render frame hiện tại
```

### Playback loop:
```
playbackStore.play() → requestAnimationFrame loop:
  t = audioContext.currentTime - startOffset
  CompositionEngine.renderFrame(t) → canvas
  Audio nodes tự phát theo schedule
```

### Export:
```
User click Export → spawn ExportWorker
  for each frame t in [0, duration] step 1/fps:
    frame = CompositionEngine.renderFrame(t)
    encoder.encode(frame)
  audio = OfflineAudioContext.render()
  muxer.finalize() → Blob MP4 → download
```

## 6. State stores (Zustand)

| Store | Trách nhiệm | Persist |
|---|---|---|
| `projectStore` | assets, project metadata, save status | IndexedDB |
| `timelineStore` | tracks, clips, selection, zoom, playhead | IndexedDB (debounced) |
| `playbackStore` | isPlaying, currentTime, loop, volume | sessionStorage |
| `uiStore` | panel sizes, active tool, modal state | localStorage |
| `historyStore` | undo/redo stack | memory only |

## 7. Threading model

- **Main thread**: chỉ UI + state + render preview frame (≤ 16ms budget)
- **Worker pool** (size = `navigator.hardwareConcurrency - 1`, tối thiểu 2):
  - decode-worker (1-2 instance, VideoDecoder)
  - util-worker (thumbnail, waveform, proxy generation)
  - export-worker (dedicated, chạy khi export)
- Giao tiếp qua Comlink (proxy object), tránh JSON serialize lớn → dùng Transferable (`ArrayBuffer`, `ImageBitmap`, `VideoFrame`)

## 8. Error handling & resilience

- Mọi engine operation trả `Result<T, EngineError>` (không throw qua boundary)
- Worker crash → restart tự động, mark asset failed
- Out-of-memory: triggered bởi memory monitor → tự giảm proxy quality, evict cache
- Project corruption: backup snapshot last-known-good mỗi 60s

## 9. Telemetry (local-only, không gửi server)

- FPS preview rolling average
- Memory usage (`performance.memory` nếu khả dụng)
- Worker queue depth
- Cache hit rate
- Hiển thị trong dev overlay (toggle Ctrl+Shift+D)

## 10. Phạm vi không gồm trong MVP

- Cloud sync, multi-user collab
- AI features (auto-captions, background removal)
- Mobile UI
- Plugin system
