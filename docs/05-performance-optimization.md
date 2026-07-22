# 05 — Hiệu năng và quản lý tài nguyên hiện tại

Hiệu năng video phụ thuộc codec, độ phân giải, số track, effect, GPU/driver và engine export. Repo không cam kết một số FPS/thời gian export cố định cho mọi máy; benchmark là regression signal trên môi trường đã đo.

## 1. Nguyên tắc

1. Không giữ toàn bộ media/output lớn trong RAM nếu có thể stream hoặc đọc theo range.
2. Mỗi tác vụ nền phải có ownership, cancel và cleanup.
3. Dùng index/cache/pool ở hot path, nhưng cache phải có budget và eviction.
4. Chọn Browser, Server hoặc Hybrid theo capability và parity, không ép một engine cho mọi project.
5. Đo bằng test/diagnostics trước khi tối ưu.

## 2. Preview

### Active clips và timeline lớn

`active-clip-index` giảm số clip phải kiểm tra tại mỗi frame. Timeline và thumbnail strip có virtualization để DOM work không tăng tuyến tính theo toàn bộ project đang nằm ngoài viewport.

### Video readers

Browser reader pool:

- tái sử dụng reader/decoder theo asset và offset;
- giới hạn reset khi hai clip cùng nguồn được đọc ở vị trí khác nhau;
- đóng `VideoFrame`, reader và object URL đúng lifecycle;
- dùng seek fallback khi WebCodecs không đọc chính xác nguồn.

### Composition

Preview chọn GPU compositor khi capability phù hợp và giữ fallback cho môi trường không có đường GPU tương ứng. Full-frame effect dùng buffer tái sử dụng thay vì cấp phát canvas mới liên tục.

### Proxy

Proxy mode:

| Mode     | Hành vi                               |
| -------- | ------------------------------------- |
| `off`    | Không tự tạo; vẫn có thể tạo thủ công |
| `smart`  | Tự proxy video cao hơn 1080p          |
| `always` | Tự proxy mọi video                    |

Proxy được tạo bằng backend FFmpeg, lưu trong OPFS và chỉ dùng cho preview. Export vẫn ưu tiên source gốc.

## 3. Audio

- Playback dùng Web Audio scheduling và index clip theo cửa sổ thời gian.
- Audio decode có guard về kích thước và timeout; file quá lớn được hướng sang backend khi workflow hỗ trợ.
- Browser export mix audio theo block/stream để giới hạn peak memory.
- Denoise preview dùng AudioWorklet; server export dùng FFmpeg filter tương ứng nhưng không giả định hai implementation luôn bit-identical.
- Separation/TTS là job backend; UI không giữ worker AI trực tiếp trong renderer.

## 4. Browser export

Browser path dùng renderer phía client và WebCodecs. Các lớp bảo vệ đang có:

- codec support preflight;
- storage quota/headroom check;
- browser audio peak-memory estimate;
- bounded frame/reader lifecycle;
- scratch output trong OPFS và cleanup khi cancel/fail;
- direct/zero-copy output khi môi trường desktop hỗ trợ, có self-test và fallback;
- retry có giới hạn cho transient network khi stream output qua backend save endpoint.

Browser renderer hiện là SDR 8-bit. Không quảng bá HDR browser export khi UI đã ép về SDR.

## 5. Server export

Backend FFmpeg path có:

- content-hash upload hoặc adopt `sourcePath` trên desktop;
- chunked export và cache chunk;
- parallelism được điều phối theo CPU/GPU/resource coordinator;
- progress, watchdog, cancel và process-tree cleanup;
- quota preflight cho assets/jobs/scratch;
- kiểm tra artifact cuối bằng ffprobe/integrity gate;
- lưu trạng thái job để status/download còn hoạt động sau restart khi có thể.

Server renderer không hỗ trợ pixel-identical mọi effect. `serverExportStrictGaps` chặn các timeline không đạt parity; người dùng chỉ nên bật approximate server mode khi chấp nhận khác preview.

## 6. Hybrid export

Hybrid không phải một compositor thứ ba. Hình ảnh vẫn render bằng browser để giữ parity, còn backend chuẩn bị audio khi browser memory không đủ. Kết quả audio được đưa lại vào Browser Direct/mux path mà không render lại video bằng server.

## 7. Media storage

### Desktop path-backed

Tauri giữ source path và đọc file theo range. Cách này tránh sao chép video nhiều GB vào OPFS. Backend cũng có thể dùng trực tiếp source path sau khi scope/ownership được xác nhận.

### Browser OPFS

Import browser dùng temp key → write theo chunk → probe → publish final key. Nếu fail/cancel, temp object được dọn; orphan sweep có grace/lease để không xóa nhầm blob đang dùng.

### Backend storage

Các quota/TTL chính được cấu hình bằng:

- `XINCHAO_ASSETS_QUOTA_MB`, `XINCHAO_ASSETS_TTL_DAYS`
- `XINCHAO_JOBS_QUOTA_MB`, `XINCHAO_JOBS_TTL_DAYS`
- `XINCHAO_EXPORT_CHUNK_CACHE_MB`, `XINCHAO_EXPORT_CHUNK_CACHE_TTL_DAYS`

Không thay đổi quota mà không kiểm tra preflight, cleanup và dữ liệu job đang hoạt động.

## 8. Cancel và ownership

Các runner media/AI/export theo dõi project/asset/job ownership. Khi người dùng đổi project, xóa asset hoặc đóng dialog:

- request/worker phù hợp được abort;
- backend job nhận cancel nếu đã tạo;
- kết quả đến muộn không được mutate project mới;
- scratch/proxy tạm được cleanup hoặc thu hồi bởi sweeper an toàn.

Đây là invariant hiệu năng lẫn tính đúng đắn: job mồ côi vừa tốn CPU/GPU vừa có thể ghi sai state.

## 9. Chẩn đoán

Menu backend status hiển thị FFmpeg build, encoder, CUDA/GPU capability và queue/runtime metrics. Export dialog hiển thị engine advice, ước lượng, progress và chẩn đoán encoder sau server export.

Các test/benchmark đáng chú ý:

- `active-clip-index.test.ts`
- `track-virtualization.test.ts`
- `reader-pool.test.ts`
- `audio-memory.test.ts`
- `audio-stream-mix.test.ts`
- `browser-admission.test.ts`
- `export/bench/export-bench.test.ts`
- backend tests cho chunk cache, quota, watchdog, artifact gate và persistence

Benchmark browser thật có thể chạy từ diagnostics/dev build; test Vitest browser-less chỉ kiểm tra harness và in hướng dẫn khi không có WebCodecs/WebView.

## 10. Checklist khi sửa hot path

- Có tạo Blob/ArrayBuffer/canvas/frame mới mỗi tick không?
- Resource có `close`, revoke, abort hoặc release ở mọi nhánh không?
- Project switch/cancel có chặn late result không?
- Cache có key đúng và giới hạn dung lượng/TTL không?
- Thay đổi có làm source path bị copy lại vào OPFS không?
- Browser/server parity gate có cần cập nhật không?
- Test có đo correctness trước benchmark không?
- Đã thử project lớn, media thiếu, backend restart và ổ gần đầy chưa?
