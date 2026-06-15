# 03 — Cấu trúc thư mục

## 1. Nguyên tắc

- **Feature-first ở UI, layer-first ở engine**: UI gom theo panel (timeline, preview…), engine tách theo trách nhiệm thuần (compose, audio, export…)
- **Engine không import từ `components/` hay `store/`** — engine là pure
- **Một thư mục, một mục đích**. Nếu file không thuộc về thư mục nào rõ ràng → suy nghĩ lại trước khi tạo `utils/misc.ts`
- **Đặt tên thư mục số ít** (`component/timeline`), không nhất quán giữa số nhiều/số ít
- Index barrel file (`index.ts`) **chỉ** dùng cho public API của module (engine/store), không dùng cho components React

## 2. Cây thư mục

```
XinChao-Cut/
├── docs/                          # Tài liệu thiết kế (file này)
├── public/                        # Static assets phục vụ trực tiếp
│   ├── ffmpeg-core.wasm
│   └── fonts/
├── src/
│   ├── app/                       # Entry point, providers, router
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── providers.tsx
│   │   └── globals.css
│   │
│   ├── components/                # UI components (feature-grouped)
│   │   ├── top-bar/
│   │   │   ├── TopBar.tsx
│   │   │   ├── ProjectName.tsx
│   │   │   ├── ExportButton.tsx
│   │   │   └── SaveStatus.tsx
│   │   ├── media-panel/
│   │   │   ├── MediaPanel.tsx
│   │   │   ├── MediaGrid.tsx
│   │   │   ├── MediaCard.tsx
│   │   │   └── DropZone.tsx
│   │   ├── preview/
│   │   │   ├── Preview.tsx
│   │   │   ├── PreviewCanvas.tsx
│   │   │   └── PlaybackControls.tsx
│   │   ├── timeline/
│   │   │   ├── Timeline.tsx
│   │   │   ├── TimelineRuler.tsx
│   │   │   ├── TimelineTrack.tsx
│   │   │   ├── TimelineClip.tsx
│   │   │   ├── Playhead.tsx
│   │   │   ├── TrackHeader.tsx
│   │   │   └── hooks/
│   │   │       ├── useTimelineDrag.ts
│   │   │       ├── useTimelineZoom.ts
│   │   │       └── useSnap.ts
│   │   ├── properties/
│   │   │   ├── PropertiesPanel.tsx
│   │   │   ├── ClipProperties.tsx
│   │   │   ├── TextProperties.tsx
│   │   │   └── controls/
│   │   │       ├── SliderInput.tsx
│   │   │       ├── ColorPicker.tsx
│   │   │       └── NumericInput.tsx
│   │   └── shared/                # Component dùng chung ≥ 2 nơi
│   │       ├── Button.tsx
│   │       ├── Tooltip.tsx
│   │       ├── Modal.tsx
│   │       ├── Icon.tsx
│   │       └── Slider.tsx
│   │
│   ├── store/                     # Zustand stores (thin layer trên engine)
│   │   ├── project-store.ts
│   │   ├── timeline-store.ts
│   │   ├── playback-store.ts
│   │   ├── ui-store.ts
│   │   ├── history-store.ts
│   │   └── index.ts
│   │
│   ├── engine/                    # Pure logic, no DOM, no React
│   │   ├── media/
│   │   │   ├── media-manager.ts
│   │   │   ├── asset-loader.ts
│   │   │   ├── thumbnail.ts
│   │   │   ├── waveform.ts
│   │   │   ├── proxy.ts
│   │   │   └── types.ts
│   │   ├── timeline/
│   │   │   ├── timeline-engine.ts
│   │   │   ├── commands.ts          # Command pattern
│   │   │   ├── operations.ts        # insert, split, trim, …
│   │   │   ├── ripple.ts
│   │   │   └── types.ts
│   │   ├── composition/
│   │   │   ├── compositor.ts
│   │   │   ├── frame-cache.ts
│   │   │   ├── decoder-pool.ts
│   │   │   ├── shaders/
│   │   │   │   ├── blend.glsl
│   │   │   │   ├── color-correction.glsl
│   │   │   │   └── transitions.glsl
│   │   │   ├── webgl-renderer.ts
│   │   │   ├── webgpu-renderer.ts
│   │   │   └── types.ts
│   │   ├── audio/
│   │   │   ├── audio-engine.ts
│   │   │   ├── mixer.ts
│   │   │   ├── effects.ts
│   │   │   └── types.ts
│   │   ├── export/
│   │   │   ├── exporter.ts
│   │   │   ├── webcodecs-encoder.ts
│   │   │   ├── ffmpeg-encoder.ts
│   │   │   ├── muxer.ts
│   │   │   └── types.ts
│   │   ├── persistence/
│   │   │   ├── project-serializer.ts
│   │   │   ├── indexed-db.ts
│   │   │   ├── opfs.ts
│   │   │   └── auto-save.ts
│   │   └── core/                    # Primitives engine dùng chung
│   │       ├── time.ts              # Frame/timecode conversion
│   │       ├── geometry.ts
│   │       ├── color.ts
│   │       ├── result.ts            # Result<T, E> type
│   │       └── id.ts                # nanoid wrapper
│   │
│   ├── workers/                   # Web Worker entries
│   │   ├── decode.worker.ts
│   │   ├── thumbnail.worker.ts
│   │   ├── waveform.worker.ts
│   │   ├── export.worker.ts
│   │   ├── proxy.worker.ts
│   │   └── pool.ts                  # Worker pool manager (Comlink)
│   │
│   ├── hooks/                     # React hooks tổng quát (không gắn feature)
│   │   ├── useHotkey.ts
│   │   ├── useResizeObserver.ts
│   │   ├── useDebounce.ts
│   │   ├── useRaf.ts
│   │   └── useDropFile.ts
│   │
│   ├── lib/                       # Wrapper bên thứ 3, helper không thuộc engine
│   │   ├── ffmpeg.ts
│   │   ├── dexie-db.ts
│   │   └── comlink.ts
│   │
│   ├── styles/
│   │   ├── tokens.css               # CSS variables
│   │   └── reset.css
│   │
│   └── types/                     # Global types, không thuộc module
│       ├── env.d.ts
│       └── global.d.ts
│
├── tests/
│   ├── unit/                      # Engine unit tests
│   ├── integration/
│   └── fixtures/                  # Sample media files
│
├── scripts/                       # Build/dev scripts
├── .github/
│   └── workflows/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── package.json
└── README.md
```

## 3. Quy tắc đặt tên

| Loại | Quy ước | Ví dụ |
|---|---|---|
| File component React | `PascalCase.tsx` | `TimelineClip.tsx` |
| File logic / hook / store | `kebab-case.ts` | `timeline-store.ts`, `use-hotkey.ts` |
| Hook export | `useCamelCase` | `useTimelineDrag` |
| Type / Interface | `PascalCase`, không prefix `I` | `Clip`, `MediaAsset` |
| Constant | `SCREAMING_SNAKE_CASE` | `MAX_TRACKS = 20` |
| CSS variable | `--kebab-case` | `--bg-1` |
| Worker file | `*.worker.ts` | `decode.worker.ts` |
| Test file | `*.test.ts` cạnh source | `compositor.test.ts` |

## 4. Import alias (vite/tsconfig)

```ts
{
  "@app/*":        "src/app/*",
  "@components/*": "src/components/*",
  "@engine/*":     "src/engine/*",
  "@store/*":      "src/store/*",
  "@workers/*":    "src/workers/*",
  "@hooks/*":      "src/hooks/*",
  "@lib/*":        "src/lib/*",
  "@types/*":      "src/types/*"
}
```

Cấm import bằng đường dẫn tương đối quá 2 cấp (`../../../`). Lên alias.

## 5. Public API của module

Mỗi thư mục trong `engine/` có `index.ts` re-export những gì module ngoài được dùng. Internal file không có barrel.

Ví dụ `engine/timeline/index.ts`:
```ts
export { TimelineEngine } from './timeline-engine'
export type { Clip, Track, TimelineState } from './types'
export { InsertClipCommand, SplitClipCommand } from './commands'
// KHÔNG export: ripple.ts internals, operations.ts
```

## 6. Giới hạn

- File **> 300 dòng** → cảnh báo, > 500 dòng → bắt buộc tách
- Thư mục **> 10 file** → cân nhắc tách subfolder
- Không có file `utils.ts` chung. Helper phải thuộc về module cụ thể hoặc `engine/core/`
- Không có `constants.ts` global. Const sống cạnh nơi dùng, hoặc export từ module liên quan
