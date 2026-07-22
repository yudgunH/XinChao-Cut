# 03 — Cấu trúc repository hiện tại

Không dùng cây thư mục trong tài liệu này để suy đoán file chưa tồn tại. Khi cần vị trí chính xác, chạy `rg --files` hoặc xem source.

## 1. Cây cấp cao

```text
XinChao-Cut/
├── public/                  Static asset được Vite copy nguyên trạng
├── src/                     React/TypeScript editor và Voice Studio
├── src-tauri/               Tauri 2 shell, icon, quyền native và NSIS
├── backend/                 FastAPI, FFmpeg, AI workers và installer
├── scripts/                 Staging/build/font scripts
├── docs/                    Thiết kế, cài đặt và hướng dẫn sử dụng
├── .github/workflows/       CI
├── setup.bat                Setup source: npm + Core/FFmpeg
├── start.bat                Backend hot reload + Tauri dev
├── package.json             Frontend scripts/dependencies
└── README.md                Tài liệu bắt đầu chính
```

## 2. Frontend `src/`

```text
src/
├── app/          Entry point, Home/Editor composition và global CSS
├── assets/       Asset được import qua module graph
├── components/   UI theo feature/panel
├── engine/       Media, timeline, render, audio, subtitle, export, persistence
├── hooks/        Lifecycle/orchestration dùng lại ở React
├── lib/          DB, project session, ownership và helper cross-feature
├── store/        Zustand stores
├── styles/       Token/style bổ sung
├── types/        Declaration và type dùng chung
└── workers/      Worker entry/pool cho tác vụ browser
```

### `components/`

Các nhóm đang có:

- `home`
- `media-panel`
- `preview`
- `timeline`
- `properties`
- `export`
- `settings`
- `shortcuts`
- `top-bar`
- `shared`

Component lớn được tách theo ranh giới hành vi khi việc tách giúp lifecycle hoặc test rõ hơn; không áp dụng giới hạn dòng cứng máy móc.

### `engine/`

Các module hiện có:

- `audio`
- `backend`
- `composition`
- `core`
- `export`
- `media`
- `persistence`
- `preview`
- `subtitle`
- `text`
- `timeline`

Một số module có `index.ts` làm public surface, nhưng không bắt buộc mọi thư mục phải có barrel. Tránh thêm barrel chỉ để rút ngắn một import nếu nó tạo vòng phụ thuộc.

### Test frontend

Test Vitest đặt cạnh source dưới dạng `*.test.ts` hoặc `*.test.tsx`. Repo không có cây `tests/unit` giả lập riêng.

## 3. Backend `backend/`

```text
backend/
├── app/
│   ├── main.py              FastAPI app/lifespan/health
│   ├── config.py            Settings `XINCHAO_*`
│   ├── routers/             Media, assets, export, AI config và AI jobs
│   └── export/              FFmpeg graph, chunk runner/cache và output gate
├── scripts/                 Prefetch model và helper runtime
├── tests/                   Pytest
├── requirements-*.txt       Tier Core/Caption/FunASR/Audio/TTS/Dev
├── setup.ps1 / setup.bat    Installer chọn lọc
└── run-backend.bat          Launcher production
```

OmniVoice dùng virtual environment riêng. Không nhập dependency TTS trực tiếp vào main environment nếu chưa xử lý xung đột version.

## 4. Tauri `src-tauri/`

```text
src-tauri/
├── src/lib.rs               Commands, backend lifecycle, native media access
├── src/main.rs              Desktop entry point
├── capabilities/            Permission/capability config
├── icons/                   Icon nguồn và icon nền tảng
├── tauri.conf.json          Window, CSP, resources và NSIS
└── backend-bundle/          Output staging, không commit
```

`backend-bundle` được sinh bởi `npm run backend:stage`. Không sửa trực tiếp file trong đó vì lần stage kế tiếp sẽ ghi đè.

## 5. Đặt tên và import

| Loại                | Quy ước hiện tại           | Ví dụ                   |
| ------------------- | -------------------------- | ----------------------- |
| React component     | `PascalCase.tsx`           | `TimelineClip.tsx`      |
| Store/engine helper | thường `kebab-case.ts`     | `timeline-store.ts`     |
| React hook          | `useCamelCase.ts`          | `useAutoSave.ts`        |
| Worker              | `*.worker.ts`              | `transcribe.worker.ts`  |
| Test                | `*.test.ts(x)` cạnh source | `reader-pool.test.ts`   |
| Python test         | `test_*.py`                | `test_export_output.py` |

Alias TypeScript được cấu hình trong `tsconfig.app.json` và `vite.config.ts`:

```text
@app/* @components/* @engine/* @store/*
@workers/* @hooks/* @lib/* @types/*
```

Dùng relative import trong nội bộ một module khi quan hệ gần; dùng alias khi import xuyên feature/layer. Tránh đường dẫn `../../../` khó đọc.

## 6. File sinh tự động và dữ liệu cục bộ

Các path sau không phải source và không được commit:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `src-tauri/backend-bundle/`
- `*.tsbuildinfo`
- Python virtual environments và `__pycache__`
- `%LOCALAPPDATA%\XinChao-Cut` runtime/models/log của người dùng
- `release/` local artifact nếu dùng quy trình đóng gói thủ công

Trước khi xóa dữ liệu runtime của người dùng, phải phân biệt rõ nó với build cache trong repository.

## 7. Thêm file mới ở đâu

- UI gắn với một panel: đặt trong feature tương ứng dưới `components/`.
- Logic timeline/media/export có thể test độc lập: đặt trong `engine/` tương ứng.
- Lifecycle kết nối React với engine/store: đặt trong `hooks/` hoặc cạnh component nếu chỉ dùng một nơi.
- Data/project ownership dùng xuyên feature: cân nhắc `lib/`.
- Endpoint/backend job: router mỏng trong `backend/app/routers`, logic nặng tách sang module phù hợp.
- Helper chỉ dùng một module: để cạnh module, không tạo `utils.ts` toàn cục.
