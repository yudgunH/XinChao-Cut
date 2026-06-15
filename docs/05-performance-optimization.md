# 05 — Tối ưu hiệu năng: render, export, GPU, tài nguyên

Mục tiêu hiệu năng:
- **Preview**: 30 fps tối thiểu trên iGPU, 60 fps trên dGPU, với 1080p timeline ≤ 4 track active
- **Export 1080p30, 60s**: ≤ 30 giây trên máy có GPU (hardware encode), ≤ 3 phút trên CPU-only
- **Memory peak**: ≤ 1.5GB cho project 5 phút 1080p
- **Idle CPU**: ≤ 5% khi không play/edit

## 1. Render pipeline (preview)

### 1.1 Tổng quan
```
Playhead t ─┐
            ▼
   Tìm clip active   ─► Frame Cache (LRU)  ─Hit─►  GPU texture
        │                    │ Miss
        │                    ▼
        │             Decoder Pool (WebCodecs)
        │                    │
        │                    ▼
        │             Decoded VideoFrame ──► Cache + Upload texture
        ▼
   GL render passes:
     1. Per-clip transform + filter (fragment shader)
     2. Composite blend các track theo z-order
     3. Overlay text/sticker
     4. Output → Preview canvas
```

### 1.2 Frame cache
- **LRU per-asset**, capacity = `min(memory_budget / frame_size, 240 frames)`
- Frame_size ước lượng: `width × height × 4 bytes`. 1080p = ~8MB → 240 frames ~ 1.9GB → giới hạn theo budget thực
- Cache key: `(assetId, frameIndex)` ở **input space**, không phải timeline space → reuse khi clip trim/move
- Eviction policy: LRU + ưu tiên giữ frame gần playhead (±2s)
- Cache nội dung là `ImageBitmap` (GPU-friendly) chứ không phải `VideoFrame` thô (giữ `VideoFrame` lock pool decoder)

### 1.3 Decoder pool
- Dùng **WebCodecs `VideoDecoder`** trước (hardware accelerated), fallback ffmpeg.wasm cho codec không support
- Pool size: `min(navigator.hardwareConcurrency, 4)` decoder instance
- Mỗi decoder bám 1 asset trong session, tránh re-init (init H.264 tốn ~50ms)
- **Preroll**: khi user seek/play, decoder bắt đầu từ keyframe trước playhead → forward decode đến playhead. Hiển thị frame approx (frame keyframe gần nhất) trong khi chờ decode chính xác để tránh blank
- **Speculative decode**: khi đang play, decode trước 1s frames vào cache (`requestIdleCallback` hoặc low-priority worker)

### 1.4 Proxy media
- Trigger tự động khi: resolution > 1080p **hoặc** codec nặng (HEVC trên hệ không hỗ trợ HW decode) **hoặc** > 60fps
- Proxy = H.264 480p (chiều ngắn), giữ aspect, fps gốc (hoặc 30 nếu nguồn > 60)
- Sinh trong background worker, lưu OPFS
- Preview tự switch sang proxy. Export tự dùng nguồn gốc
- User toggle được "force original quality" cho moment cần xem chuẩn màu

## 2. GPU acceleration

### 2.1 Renderer chiến lược
- **WebGPU** nếu khả dụng (`navigator.gpu`): compute shader cho effect, render pipeline cho compose
- **WebGL2** fallback: đủ cho mọi effect MVP
- **Canvas 2D** chỉ làm safety net (compose chậm nhưng đảm bảo chạy)

### 2.2 Shader nguyên tắc
- Mỗi clip qua 1 fragment shader (không phải 1 shader per effect chained → tốn fillrate)
- Tích hợp effect vào **uber-shader** với uniform flag (brightness, contrast, saturation, hue, blur radius). Branchless càng tốt.
- Transition giữa 2 clip = 1 shader có `progress` uniform, blend texture A & B
- Text: render vào offscreen canvas → upload texture (cache lại nếu text/style không đổi)

### 2.3 Texture management
- **Texture pool** với size class (256, 512, 1024, 2048): tránh allocate/destroy mỗi frame
- Reuse texture cho frame mới của cùng asset
- Mipmap chỉ generate khi clip scale < 0.5x
- Format: RGBA8 cho output, sample input ở native format
- **NEVER** đọc texture về CPU trong loop (gl.readPixels block GPU pipeline). Chỉ readback khi export frame.

### 2.4 GPU memory budget
- Theo dõi qua `WEBGL_lose_context` events + ước lượng (textures × size)
- Soft cap: 512MB GPU. Vượt → giảm preview resolution xuống 0.5x tự động, hiện badge "Low GPU memory"

## 3. Audio pipeline

- Mỗi audio clip → `AudioBufferSourceNode` schedule sẵn với `start(when, offset, duration)`
- **Không decode lại** khi seek — schedule lại với offset mới
- Effect (EQ, compressor) chuỗi `BiquadFilterNode`, `DynamicsCompressorNode` — native code, low overhead
- Heavy DSP (noise reduction) → `AudioWorkletProcessor` trong worker thread

## 4. Threading & concurrency

### 4.1 Worker phân chia
| Worker | Số instance | Nhiệm vụ |
|---|---|---|
| decode | 2-4 | VideoDecoder, output VideoFrame |
| thumbnail | 1 | Sinh thumbnail strip cho clip |
| waveform | 1 | Decode audio → peaks |
| proxy | 1 | ffmpeg transcode background |
| export | 1 (chỉ khi export) | Toàn bộ encode pipeline |

### 4.2 Communication
- **Transferable objects** bắt buộc: `ArrayBuffer`, `ImageBitmap`, `VideoFrame`, `OffscreenCanvas`
- Cấm `postMessage` object lớn không transferable (serialize cost cao)
- Comlink wrap cho ergonomics, nhưng để ý: Comlink proxy không transfer được nguyên thủy — dùng `Comlink.transfer(obj, [transferList])`

### 4.3 OffscreenCanvas
- Preview canvas convert sang OffscreenCanvas → render trên worker thread
- Lợi: main thread không bị block bởi compose, scroll/UI luôn mượt
- Caveat: input event vẫn ở main thread, cần sync state qua SharedArrayBuffer cho seek nhanh

### 4.4 SharedArrayBuffer
- Cần COOP/COEP headers (Vite dev server config sẵn)
- Dùng cho:
  - Playback time (atomic write từ audio thread, đọc từ render worker)
  - Frame index hiện tại
  - Pause flag
- Atomic operations (`Atomics.store`, `Atomics.load`) tránh race

## 5. Memory management

### 5.1 Budget (tham chiếu 1080p project)
| Loại | Giới hạn |
|---|---|
| Frame cache | 1GB |
| Texture pool GPU | 512MB |
| Audio buffers | 200MB |
| Thumbnails strips | 100MB |
| Project state + DOM | 100MB |
| **Tổng soft cap** | **~1.9GB** |

### 5.2 Theo dõi & phản ứng
```ts
// pseudo
setInterval(() => {
  const mem = performance.memory?.usedJSHeapSize ?? estimate()
  if (mem > SOFT_CAP) frameCache.evictPercent(20)
  if (mem > HARD_CAP) {
    proxyManager.forceProxyOnAll()
    notify('Low memory — switched to proxy preview')
  }
}, 2000)
```

### 5.3 Leak prevention
- Mỗi `VideoFrame.close()` được gọi sau khi upload texture
- `ImageBitmap.close()` sau khi không cần
- WebGL texture `gl.deleteTexture` khi evict
- Worker `terminate()` khi project close
- Event listener cleanup trong `useEffect` return
- AbortController hủy fetch/decode khi component unmount

### 5.4 Object pool
- Pool cho object tạo trong hot path: matrix transform, color array, frame metadata
- Tránh GC pressure khi play 60fps

## 6. Export pipeline

### 6.1 Encoder chọn
```
if (VideoEncoder.isConfigSupported({ codec: 'avc1.640028', ... }).then(s => s.supported)
    && hardwareAcceleration === 'prefer-hardware'):
   → WebCodecs VideoEncoder (HW)
else:
   → ffmpeg.wasm libx264 (CPU, multi-thread + SIMD)
```

### 6.2 Pipeline song song
```
Frame producer (compositor) ──► [bounded queue, size 8] ──► Encoder
                                                            │
Audio producer (OfflineAudioContext) ─► PCM ──► AAC encoder
                                                            ▼
                                                       MP4 Muxer
                                                            │
                                                            ▼
                                                       Output Blob
```

- **Bounded queue** giữa producer/consumer tránh OOM khi encoder chậm hơn render
- Producer pause khi queue đầy, resume khi có slot
- Audio render offline 1 lần (nhanh hơn realtime nhiều)

### 6.3 Tối ưu encode
- WebCodecs `latencyMode: 'realtime'` cho preview, `'quality'` cho export
- Bitrate adaptive theo resolution:
  - 720p30: 5 Mbps
  - 1080p30: 8 Mbps
  - 1080p60: 12 Mbps
  - 4K30: 35 Mbps
- Keyframe interval = fps × 2 (2s)
- Two-pass chỉ khi user bật (chậm gấp đôi)

### 6.4 GPU export path
- Composite frame **vẫn ở GPU texture** → copy trực tiếp vào VideoEncoder qua `new VideoFrame(canvas)` hoặc `VideoFrame(GPUTexture)` (Chrome flag)
- Tránh readback CPU rồi upload lại

### 6.5 Progress & cancel
- Báo progress theo frame encoded
- Cancel: abort signal → encoder.close() → muxer.cleanup() → xóa partial file

## 7. Idle behavior & throttling

- Khi không play, không edit: render loop **dừng hẳn** (không `requestAnimationFrame` rỗng)
- Preview chỉ re-render khi:
  - Playhead di chuyển
  - Clip thay đổi (insert/trim/move/effect)
  - Resize canvas
- Tab background (`document.hidden`): pause playback, hủy speculative decode, giảm cache eviction
- Throttle scroll/zoom timeline updates qua `requestAnimationFrame` (1 update per frame)

## 8. CPU throttling thông minh

- Detect thiết bị yếu qua heuristic:
  - `navigator.hardwareConcurrency ≤ 4`
  - `navigator.deviceMemory ≤ 4`
  - FPS preview rolling avg < 24 trong 5s
- Khi yếu: tự bật proxy, giảm preview resolution xuống 720p, tắt blur/heavy shader trong preview (giữ cho export)

## 9. Measurement & profiling

### 9.1 Dev overlay (Ctrl+Shift+D)
Hiển thị realtime:
- FPS preview
- Frame budget breakdown: decode / upload / shader / composite
- Cache hit rate
- Memory usage (JS heap + estimated texture)
- Worker queue depth per pool
- Last 100 frame timing histogram

### 9.2 Profile mode
- Chrome DevTools Performance + custom marks (`performance.mark`/`measure`)
- Marks chính:
  - `render-frame-start` / `render-frame-end`
  - `decode-start` / `decode-end`
  - `upload-texture`
  - `shader-pass-{n}`
- Build dev mode include những marks này, prod strip qua dead-code-elimination (`if (DEV)` block)

### 9.3 Regression CI
- Benchmark fixture: 30s project, 3 track, 1 transition
- CI render full timeline 100 frames, đo p50 / p95 frame time
- Fail PR nếu p95 tăng > 15% so với baseline

## 10. Network / asset loading (cho future cloud version)

Chưa áp dụng MVP (local-only), nhưng giữ chỗ:
- Range request cho seek mid-file
- HTTP/2 multiplexing
- Adaptive bitrate dựa trên throughput
- Service Worker cache cho asset đã preview

## 11. Tóm tắt nguyên tắc vàng

1. **GPU làm việc nặng**. CPU chỉ điều phối.
2. **Cache aggressive nhưng có giới hạn**. Đo đạc, không đoán.
3. **Workers cho mọi thứ CPU > 5ms**.
4. **Transferable, không serialize**.
5. **Pure functions engine** → dễ test, dễ song song.
6. **Stop rendering khi không cần**. Idle là free performance.
7. **Đo trước khi tối ưu**. Profile-driven, không premature.
8. **Soft cap > Hard cap > Crash**. Hệ thống tự xuống cấp graceful.
