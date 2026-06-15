# 04 — Clean code rules

Các quy tắc bắt buộc tuân theo. Lint config sẽ enforce phần lớn — phần còn lại là kỷ luật khi review.

## 1. TypeScript

- `strict: true`. Không tắt từng flag riêng.
- **Cấm `any`**. Nếu thật sự không biết type → `unknown` + narrow.
- Cấm `// @ts-ignore`. Nếu cần né type, dùng `// @ts-expect-error <lý do>` và phải có lý do.
- Type chia 2 nhóm:
  - `interface` cho object có nhiều field, có khả năng mở rộng (props, model)
  - `type` cho union, alias, mapped, tuple
- **Không** dùng enum. Dùng const object + `as const`:
  ```ts
  export const TrackType = {
    Video: 'video',
    Audio: 'audio',
    Text:  'text',
  } as const
  export type TrackType = typeof TrackType[keyof typeof TrackType]
  ```
- Return type của function public phải khai báo tường minh. Internal helper có thể infer.

## 2. Hàm và module

- Hàm **làm một việc**. Tên hàm = động từ + danh từ: `splitClip`, `renderFrame`.
- Tham số ≥ 3 → gom thành object có tên field rõ ràng.
- **Không có hàm > 50 dòng**. Quá dài → tách helper.
- **Pure function** ưu tiên. Side-effect tập trung vào engine boundary, không rải rác.
- Cấm export default trừ component React (vì lazy-load cần). Mọi thứ khác named export.
- Engine functions trả `Result<T, E>` thay vì throw qua boundary:
  ```ts
  type Result<T, E = Error> =
    | { ok: true; value: T }
    | { ok: false; error: E }
  ```

## 3. React components

- **Function component + hooks only**. Không class component.
- Mỗi component nhận **props rõ ràng**, không spread `{...rest}` xuống DOM trừ khi đó là wrapper element.
- Props interface đặt cạnh component, hậu tố `Props`:
  ```tsx
  interface TimelineClipProps { clip: Clip; selected: boolean }
  export function TimelineClip({ clip, selected }: TimelineClipProps) { ... }
  ```
- **Một component < 150 dòng**. Quá → tách subcomponent hoặc kéo logic vào hook.
- Hook đặt cùng folder component nếu chỉ component đó dùng, lên `src/hooks/` nếu dùng chung.
- **Không truyền > 5 props**. Quá → cân nhắc context hoặc store selector.
- Cấm logic phức tạp trong JSX. Tính trước, gán biến, render.

## 4. State management

- **Chỉ component leaf đọc store**. Container component nhận data qua props từ leaf-level selector hook nếu cần.
- Selector phải narrow:
  ```ts
  // ❌
  const state = useTimelineStore()
  // ✅
  const clips = useTimelineStore(s => s.clips)
  ```
- Mutation engine state **bắt buộc qua command** (cho undo/redo). Không setState trực tiếp cho timeline.
- UI state (panel size, modal open) thì set trực tiếp được.

## 5. Engine code

- **Engine không import React, không chạm DOM**. Test được bằng vitest thuần.
- Engine không phụ thuộc Zustand. Store wrap engine, không ngược lại.
- Mỗi engine module có:
  - `types.ts` định nghĩa data model
  - `*-engine.ts` (hoặc tương đương) là façade public
  - Internal file private (không re-export qua barrel)
- Hàm engine không log ra console. Nếu cần debug → dùng logger có thể tắt:
  ```ts
  import { logger } from '@engine/core/logger'
  logger.debug('compose', { t, clipCount })
  ```

## 6. Side effects & async

- `async/await` always. Không `.then().catch()` chained > 1 cấp.
- **Mọi await phải có timeout hoặc abort**. Dùng `AbortSignal` xuyên suốt:
  ```ts
  async function loadAsset(url: string, signal: AbortSignal) { ... }
  ```
- Worker call qua Comlink phải có timeout fallback (mặc định 30s) để tránh treo UI.
- `useEffect` luôn có cleanup nếu khởi tạo subscription/listener.

## 7. Error handling

- Không nuốt lỗi (`catch {}`). Tối thiểu log.
- Lỗi user-facing phải có **error code** + **message dịch được**:
  ```ts
  class EngineError extends Error {
    constructor(public code: string, message: string) { super(message) }
  }
  ```
- Lỗi recoverable → trả Result. Lỗi catastrophic (worker crash, OOM) → bubble lên ErrorBoundary toàn app.
- Cấm `throw 'string'`. Luôn throw `Error` hoặc subclass.

## 8. Performance

- **Cấm `useState` cho dữ liệu derive được**. Dùng `useMemo` hoặc tính inline.
- Component render trong list (clip, track, asset card) **phải memo**: `React.memo` + props ổn định (`useCallback` cho handler).
- Animation/scrub loop dùng `requestAnimationFrame`, không `setInterval`.
- Cấm `JSON.parse(JSON.stringify(...))` cho deep clone (chậm + mất type). Dùng `structuredClone` hoặc immer.
- Tránh tạo function inline trong JSX cho component memo'd (hỏng memoization).

## 9. Comments

- **Mặc định không viết comment**. Tên biến/hàm tốt là tài liệu.
- Comment chỉ viết khi:
  - Workaround bug bên thứ 3 (link issue)
  - Invariant không hiển nhiên ("MUST hold lock before calling")
  - Trade-off thuật toán ("O(n) thay vì O(log n) vì n < 100")
- Không viết comment kể lại what code làm.
- Không TODO không có owner và ngày. Format: `// TODO(name, 2026-06-30): ...`. CI fail nếu TODO quá hạn.

## 10. Testing

- Engine: **unit test bắt buộc** cho mọi public function. Coverage ≥ 80% cho `engine/`.
- Store: test command flow (undo/redo, persistence)
- Component: test interaction quan trọng (timeline drag, hotkey). Không test markup.
- Test file đặt cạnh source: `compositor.ts` ↔ `compositor.test.ts`.
- Fixture media trong `tests/fixtures/`, **không** > 5MB mỗi file.

## 11. Git workflow

### Commit message (Conventional Commits)
```
feat(timeline): support ripple delete
fix(export): hang when audio track empty
perf(compositor): cache decoded frames in LRU
refactor(media): extract proxy generation to worker
docs(system): update architecture diagram
```

### Branch
- `main` luôn deployable
- Feature: `feat/<short-name>`
- Fix: `fix/<short-name>`
- Không commit thẳng main, mọi thay đổi qua PR

### PR rules
- < 400 dòng diff lý tưởng, > 800 dòng cần lý do
- Mô tả: What / Why / How tested
- Tự review trước khi assign reviewer
- CI phải xanh trước khi merge

## 12. Lint & format

- **ESLint** với cấu hình: `@typescript-eslint`, `react`, `react-hooks`, `import`
- **Prettier** format on save, không tranh cãi style
- Husky + lint-staged: pre-commit chạy `lint --fix` + `tsc --noEmit` + `vitest related`
- CI: lint + typecheck + test + build

## 13. Dependency hygiene

- Mỗi dependency mới phải có **lý do** ghi trong PR description
- Bundle size: tổng app < 5MB gzip (không tính ffmpeg.wasm)
- Tránh lib > 100KB cho việc nhỏ. Viết tay nếu < 50 dòng.
- Audit `npm audit` hàng tuần, update minor monthly, major có kế hoạch
- Cấm import từ `lodash` toàn bộ, dùng `lodash-es/<fn>` hoặc viết tay

## 14. Security & privacy

- Không gửi telemetry ra ngoài
- Không eval, không `new Function()`
- File user load chỉ ở local (OPFS/IndexedDB), không upload
- Sanitize text input trước khi render (textContent, không innerHTML)

## 15. Definition of done

Một task xong khi:
1. Code merge `main`
2. Test pass, coverage không giảm
3. Không có ESLint error / TS error
4. Manually verify trên dev build
5. Cập nhật docs nếu thay đổi public API hoặc kiến trúc
