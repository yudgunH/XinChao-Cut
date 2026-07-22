/// <reference types="@webgpu/types" />
/**
 * WebGPU compositor for the preview's MEDIA layer (video + image clips).
 *
 * This is the GPU half of the hybrid preview renderer: it composites the decoded
 * video/image frames — with per-clip transform (contain-fit, scale, rotation,
 * flip), crop, opacity and colour adjust (brightness/contrast/saturation) — onto
 * an offscreen WebGPU canvas. PreviewCanvas then blits that canvas onto its 2D
 * canvas and draws text / fx / selection overlays on top in Canvas 2D as before.
 *
 * Why GPU for just this layer: per-frame compositing of full-resolution video
 * with `ctx.filter` colour adjust is the dominant cost while scrubbing/playing.
 * Moving it to a fragment shader removes the slow CSS-filter path and the
 * repeated large drawImage, while text (crisp vector, cheap on 2D) and the
 * mature interaction code stay untouched.
 *
 * The geometry here is a faithful port of PreviewCanvas's `drawMedia` /
 * `getMediaRectFromSize`, and the colour maths mirror `adjustToFilter`'s CSS
 * `brightness()→contrast()→saturate()` order, so the GPU output matches the 2D
 * fallback pixel-for-pixel within rounding.
 *
 * EVERYTHING degrades gracefully: `create()` returns null when WebGPU is
 * unavailable (older WebView2/WKWebView, disabled flag, no adapter), and a lost
 * device makes `render()` return false — the caller then falls back to Canvas 2D.
 */

import { requestHighPerformanceGpuAdapter } from './gpu-adapter'

export interface GpuRect {
  x: number
  y: number
  w: number
  h: number
}

/** One media clip to composite, in canvas pixels (the COMP frame W×H). */
export interface GpuMediaDraw {
  /** Stable key for the per-source texture cache (the asset id). */
  assetId: string
  /** Optional override for the texture-cache key. Defaults to `assetId`. Pass a
   *  per-clip key (e.g. clip id) when the SAME asset can appear in multiple draws
   *  in one render with different frames (PiP/duplicate) — otherwise both draws
   *  share one texture and the second clip shows the first clip's frame. */
  cacheKey?: string
  /** Frame source uploaded to a texture each render. */
  source:
    | HTMLVideoElement
    | HTMLImageElement
    | HTMLCanvasElement
    | OffscreenCanvas
    | VideoFrame
    | ImageBitmap
  /** Intrinsic source dimensions (videoWidth/Height or naturalWidth/Height). */
  sourceW: number
  sourceH: number
  /** Destination rect (axis-aligned, pre-rotation), centre = anchor. */
  rect: GpuRect
  /** Clockwise rotation about the rect centre, radians (matches ctx.rotate). */
  rotationRad: number
  flipH: boolean
  flipV: boolean
  /** Crop as normalised source UVs (0..1). Full frame = {0,0,1,1}. */
  uv: { u0: number; v0: number; u1: number; v1: number }
  /** 0..1 clip opacity. */
  opacity: number
  /** CSS-filter multipliers (1 = neutral): brightness, contrast, saturation. */
  adjust: { b: number; c: number; s: number }
  /** Token for the current pixels. The compositor re-uploads the texture only
   *  when this changes — images pass a constant (upload once), videos pass
   *  currentTime (upload on each new decoded frame / seek). Avoids a full-frame
   *  copyExternalImageToTexture on every render. */
  frameVersion: number
  /** Blurred cover-scaled background duplicate behind the contained clip
   *  (ClipCanvasFill mode 'blur'). Rendered fully on the GPU: cover-fit the
   *  cropped source into a ~480px offscreen target, separable Gaussian blur
   *  (2 passes), then composite darkened (×0.82) behind the media quad — the
   *  same downsample-blur-upscale trick the ffmpeg path uses, so this layer no
   *  longer forces the whole media stack onto the slow Canvas-2D path. */
  blurFill?: {
    /** Gaussian σ in CANVAS px — already scaled by frameH/BLUR_REF_HEIGHT. */
    sigma: number
    /** Extra cover-scale multiplier so blurred edges bleed past the frame. */
    extraScale: number
    /** canvasFill.opacity × clip opacity. */
    opacity: number
  }
}

const FLOATS_PER_DRAW = 20 // 5 × vec4<f32>
const BYTES_PER_DRAW = FLOATS_PER_DRAW * 4

const SHADER = /* wgsl */ `
struct U {
  geom0: vec4<f32>,   // centerX, centerY, halfW, halfH
  geom1: vec4<f32>,   // cosR, sinR, flipX, flipY
  uv:    vec4<f32>,   // u0, v0, u1, v1
  canvas:vec4<f32>,   // cw, ch, _, _
  color: vec4<f32>,   // b, c, s, opacity
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5,  0.5), vec2<f32>(0.5,  0.5),
  );
  let c = corners[vi];
  let w = u.geom0.z * 2.0;
  let h = u.geom0.w * 2.0;
  // size + flip (mirror geometry → mirrors the sampled image, like ctx.scale)
  let local = vec2<f32>(c.x * w * u.geom1.z, c.y * h * u.geom1.w);
  // rotate clockwise in the y-down canvas space
  let cr = u.geom1.x;
  let sr = u.geom1.y;
  let world = vec2<f32>(
    u.geom0.x + local.x * cr - local.y * sr,
    u.geom0.y + local.x * sr + local.y * cr,
  );
  var out: VOut;
  out.pos = vec4<f32>(
    world.x / u.canvas.x * 2.0 - 1.0,
    1.0 - world.y / u.canvas.y * 2.0,
    0.0, 1.0,
  );
  out.uv = vec2<f32>(
    mix(u.uv.x, u.uv.z, c.x + 0.5),
    mix(u.uv.y, u.uv.w, c.y + 0.5),
  );
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let col = textureSample(tex, samp, in.uv);
  var rgb = col.rgb * u.color.x;                      // brightness
  rgb = (rgb - vec3<f32>(0.5)) * u.color.y + vec3<f32>(0.5);  // contrast
  let luma = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3<f32>(luma), rgb, u.color.z);          // saturation
  rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb, col.a * u.color.w);
}
`

// Separable Gaussian blur (one direction per pass). textureSampleLevel (not
// textureSample) so the loop passes WGSL uniformity analysis on every backend.
const BLUR_SHADER = /* wgsl */ `
struct BU { p: vec4<f32> };  // stepX, stepY, radius, sigma
@group(0) @binding(0) var<uniform> bu: BU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>(1.0,  1.0),
  );
  let c = corners[vi];
  var out: VOut;
  out.pos = vec4<f32>(c, 0.0, 1.0);
  out.uv = vec2<f32>((c.x + 1.0) * 0.5, (1.0 - c.y) * 0.5);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let radius = bu.p.z;
  let sigma = max(bu.p.w, 0.001);
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var i = -radius; i <= radius; i += 1.0) {
    let w = exp(-(i * i) / (2.0 * sigma * sigma));
    acc += textureSampleLevel(tex, samp, in.uv + vec2<f32>(bu.p.x, bu.p.y) * i, 0.0) * w;
    wsum += w;
  }
  return acc / wsum;
}
`

// Downsampled blur targets: blur at ~this long edge, upscale in the main pass
// (the upscale itself smooths — same trade the ffmpeg path makes).
const BLUR_TARGET_EDGE = 480
// Cap σ at the small resolution: keeps the tap loop ≤ ~145 samples; when the
// requested σ exceeds it we shrink the target further, preserving the LOOK
// (σ relative to image size) at less cost.
const BLUR_SIGMA_MAX = 24

interface CachedTexture {
  texture: GPUTexture
  /** Cached view so we don't allocate a new one every frame. */
  view: GPUTextureView
  w: number
  h: number
  /** Last uploaded GpuMediaDraw.frameVersion (NaN = nothing uploaded yet). */
  version: number
}

function sourceStillLoading(source: GpuMediaDraw['source']): boolean {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.readyState < 2 // HAVE_CURRENT_DATA
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return !source.complete
  }
  return false
}

interface BlurRT {
  texture: GPUTexture
  view: GPUTextureView
}

interface BlurTargets {
  rt0: BlurRT
  rt1: BlurRT
  w: number
  h: number
}

export class GpuCompositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private device: GPUDevice
  private context: GPUCanvasContext
  private format: GPUTextureFormat
  private pipeline: GPURenderPipeline
  private sampler: GPUSampler
  private layout: GPUBindGroupLayout
  private module: GPUShaderModule
  private textures = new Map<string, CachedTexture>()
  private uniformPool: GPUBuffer[] = []
  // Bind group cached per draw-slot. The uniform buffer for a slot is stable
  // (uniformPool[i]); only the texture view changes, so we rebuild a slot's bind
  // group only when the view it was built from changes. Steady-state playback
  // (same clips active) reuses every bind group → no per-frame allocations.
  private bindSlots: ({ view: GPUTextureView; bind: GPUBindGroup } | undefined)[] = []
  private scratch = new Float32Array(FLOATS_PER_DRAW)
  private lost = false
  private consecutiveFailures = 0
  private uploadWarned = false
  // ── Blur-fill machinery (created lazily — only projects with a blurred
  // letterbox background pay the pipeline compile). rtPipeline renders the main
  // shader into an rgba8unorm offscreen target (cover pass); blurPipeline is
  // the separable Gaussian. Pre-pass uniforms/bind groups have their own pool —
  // they're few (3 per blur clip) and their textures are stable per slot.
  private rtPipeline: GPURenderPipeline | null = null
  private blurPipeline: GPURenderPipeline | null = null
  private blurTargets: (BlurTargets | undefined)[] = []
  private preUniformPool: GPUBuffer[] = []
  private preBindSlots: ({ view: GPUTextureView; bind: GPUBindGroup } | undefined)[] = []

  private constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    pipeline: GPURenderPipeline,
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
    module: GPUShaderModule,
  ) {
    this.canvas = canvas
    this.device = device
    this.context = context
    this.format = format
    this.pipeline = pipeline
    this.layout = layout
    this.sampler = sampler
    this.module = module
    void device.lost.then((info) => {
      // 'destroyed' = we called destroy() on purpose; anything else is a real
      // loss → mark dead so the caller falls back to Canvas 2D.
      if (info.reason !== 'destroyed') this.lost = true
    })
  }

  /** Try to stand up a compositor at the given size. Returns null when WebGPU
   * isn't usable — the caller must fall back to Canvas 2D. */
  static async create(width: number, height: number): Promise<GpuCompositor | null> {
    let device: GPUDevice | null = null
    try {
      const requested = await requestHighPerformanceGpuAdapter()
      if (!requested || requested.info.isFallbackAdapter) return null
      const { adapter } = requested
      device = await adapter.requestDevice()
      if (!device) return null

      const w = Math.max(1, Math.round(width))
      const h = Math.max(1, Math.round(height))
      // Use OffscreenCanvas in Web Workers (document not available).
      const canvas: HTMLCanvasElement | OffscreenCanvas =
        typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width: w, height: h })
          : new OffscreenCanvas(w, h)
      const context = canvas.getContext('webgpu')
      if (!context) {
        device.destroy()
        return null
      }

      const format = navigator.gpu.getPreferredCanvasFormat()
      // 'opaque' → the canvas carries the cleared black background, so blitting it
      // onto the 2D canvas reproduces the frame's black letterbox exactly.
      context.configure({ device, format, alphaMode: 'opaque' })

      const module = device.createShaderModule({ code: SHADER })
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      })
      const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-strip' },
      })
      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
      return new GpuCompositor(canvas, device, context, format, pipeline, layout, sampler, module)
    } catch {
      try { device?.destroy() } catch { /* already lost */ }
      return null
    }
  }

  get isLost(): boolean {
    return this.lost
  }

  resize(width: number, height: number): boolean {
    if (this.lost) return false
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (this.canvas.width === w && this.canvas.height === h) return true
    try {
      this.canvas.width = w
      this.canvas.height = h
      // Re-configure so the swapchain matches the new size.
      this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' })
      return true
    } catch {
      this.lost = true
      return false
    }
  }

  private ensureTexture(draw: GpuMediaDraw): CachedTexture | null {
    const w = Math.max(1, Math.round(draw.sourceW))
    const h = Math.max(1, Math.round(draw.sourceH))
    const key = draw.cacheKey ?? draw.assetId
    let cached = this.textures.get(key)
    if (!cached || cached.w !== w || cached.h !== h) {
      cached?.texture.destroy()
      const texture = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      })
      cached = { texture, view: texture.createView(), w, h, version: Number.NaN }
      this.textures.set(key, cached)
      // A recreated texture invalidates any bind group that referenced its old
      // view; drop the slot cache so they rebuild against the new view.
      this.bindSlots = []
    }
    // Re-upload only when the pixels changed (see GpuMediaDraw.frameVersion).
    if (cached.version !== draw.frameVersion) {
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: draw.source, flipY: false },
          { texture: cached.texture },
          [w, h],
        )
        cached.version = draw.frameVersion
      } catch (e) {
        // Two causes: (1) a not-yet-decoded video frame (transient — retry next
        // render, version stays stale); (2) a cross-origin / tainted source
        // (permanent SecurityError — the element has no crossOrigin and the URL
        // is e.g. a Tauri asset:// path). Either way skip this draw; the caller
        // falls back to Canvas 2D, which can display a tainted video fine.
        if (!this.uploadWarned) {
          this.uploadWarned = true
          console.warn(
            '[gpu-compositor] copyExternalImageToTexture failed — falling back to Canvas 2D for this source (likely a cross-origin/tainted video):',
            e,
          )
        }
        return null
      }
    }
    return cached
  }

  private uniformBuffer(i: number): GPUBuffer {
    let buf = this.uniformPool[i]
    if (!buf) {
      buf = this.device.createBuffer({
        size: BYTES_PER_DRAW,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.uniformPool[i] = buf
    }
    return buf
  }

  private preUniformBuffer(i: number): GPUBuffer {
    let buf = this.preUniformPool[i]
    if (!buf) {
      buf = this.device.createBuffer({
        size: BYTES_PER_DRAW, // shared size: main-shader struct is the largest user
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.preUniformPool[i] = buf
    }
    return buf
  }

  private ensureBlurPipelines(): boolean {
    if (this.rtPipeline && this.blurPipeline) return true
    try {
      const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
      // Cover pass: the MAIN shader (same geometry/colour maths) into rgba8unorm.
      this.rtPipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: this.module, entryPoint: 'vs' },
        fragment: { module: this.module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      })
      const blurModule = this.device.createShaderModule({ code: BLUR_SHADER })
      this.blurPipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: blurModule, entryPoint: 'vs' },
        fragment: { module: blurModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      })
      return true
    } catch {
      this.rtPipeline = null
      this.blurPipeline = null
      return false
    }
  }

  /** Ping-pong offscreen targets for blur slot `slot`, sized so the blur runs at
   *  ≤ BLUR_TARGET_EDGE / σ ≤ BLUR_SIGMA_MAX. Returns σ scaled to that size. */
  private ensureBlurTargets(
    slot: number, cw: number, ch: number, sigma: number,
  ): (BlurTargets & { sigmaSmall: number }) | null {
    let ds = Math.min(1, BLUR_TARGET_EDGE / Math.max(1, cw, ch))
    let sigmaSmall = Math.max(0.001, sigma * ds)
    if (sigmaSmall > BLUR_SIGMA_MAX) {
      ds *= BLUR_SIGMA_MAX / sigmaSmall
      sigmaSmall = BLUR_SIGMA_MAX
    }
    const w = Math.max(2, Math.round(cw * ds))
    const h = Math.max(2, Math.round(ch * ds))
    let t = this.blurTargets[slot]
    if (!t || t.w !== w || t.h !== h) {
      t?.rt0.texture.destroy()
      t?.rt1.texture.destroy()
      const mk = (): BlurRT => {
        const texture = this.device.createTexture({
          size: [w, h],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        return { texture, view: texture.createView() }
      }
      t = { rt0: mk(), rt1: mk(), w, h }
      this.blurTargets[slot] = t
      // The bg draw's bind group references rt0's view — force rebuilds.
      this.bindSlots = []
      this.preBindSlots = []
    }
    return { ...t, sigmaSmall }
  }

  /** Bind group for a pre-pass slot, rebuilt only when its texture view changed. */
  private preBind(i: number, buf: GPUBuffer, view: GPUTextureView): GPUBindGroup {
    let entry = this.preBindSlots[i]
    if (!entry || entry.view !== view) {
      entry = {
        view,
        bind: this.device.createBindGroup({
          layout: this.layout,
          entries: [
            { binding: 0, resource: { buffer: buf } },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: view },
          ],
        }),
      }
      this.preBindSlots[i] = entry
    }
    return entry.bind
  }

  /** Composite the draws onto the offscreen canvas.
   *  - 'ok'    → at least one draw rendered; caller blits the GPU canvas.
   *  - 'empty' → draws were requested but none could be uploaded (tainted source
   *              or frame not decoded yet); caller falls back to the 2D media loop.
   *  - 'lost'  → device lost; caller switches to Canvas 2D permanently. */
  render(draws: GpuMediaDraw[]): 'ok' | 'empty' | 'lost' {
    if (this.lost) return 'lost'
    const cw = this.canvas.width
    const ch = this.canvas.height
    try {
      // Resolve each draw's texture + uniform up front (texture uploads queue
      // before the pass; bind groups reference them in the pass). A draw with a
      // blurFill contributes: 3 pre-passes (cover → blur H → blur V into a small
      // offscreen target) + a full-frame background quad drawn just before its
      // media quad in the main pass — same z-order as the 2D renderer.
      const ready: GPUBindGroup[] = []
      interface PrePass { bind: GPUBindGroup; target: GPUTextureView; pipeline: GPURenderPipeline }
      const prePasses: PrePass[] = []
      let slot = 0
      let preSlot = 0
      let blurSlot = 0
      const pushMain = (data: Float32Array, view: GPUTextureView) => {
        const u = this.uniformBuffer(slot)
        this.device.queue.writeBuffer(u, 0, data)
        // Reuse this slot's bind group unless the texture view changed.
        let entry = this.bindSlots[slot]
        if (!entry || entry.view !== view) {
          entry = {
            view,
            bind: this.device.createBindGroup({
              layout: this.layout,
              entries: [
                { binding: 0, resource: { buffer: u } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: view },
              ],
            }),
          }
          this.bindSlots[slot] = entry
        }
        ready.push(entry.bind)
        slot++
      }
      const pushPre = (
        data: Float32Array, sampled: GPUTextureView, target: GPUTextureView,
        pipeline: GPURenderPipeline,
      ) => {
        const u = this.preUniformBuffer(preSlot)
        this.device.queue.writeBuffer(u, 0, data)
        prePasses.push({ bind: this.preBind(preSlot, u, sampled), target, pipeline })
        preSlot++
      }

      for (const d of draws) {
        const cached = this.ensureTexture(d)
        if (!cached) continue

        const bf = d.blurFill
        if (bf && this.ensureBlurPipelines()) {
          const bt = this.ensureBlurTargets(blurSlot, cw, ch, bf.sigma)
          if (bt) {
            blurSlot++
            // Cover pass: cropped source cover-scaled (+extra bleed) into rt0,
            // clip adjust applied here (linear ops commute with the blur).
            pushPre(this.coverUniform(d, bf.extraScale, bt.w, bt.h), cached.view, bt.rt0.view, this.rtPipeline!)
            // Separable Gaussian: H (rt0→rt1) then V (rt1→rt0).
            pushPre(this.blurUniform(1 / bt.w, 0, bt.sigmaSmall), bt.rt0.view, bt.rt1.view, this.blurPipeline!)
            pushPre(this.blurUniform(0, 1 / bt.h, bt.sigmaSmall), bt.rt1.view, bt.rt0.view, this.blurPipeline!)
            // Full-frame background quad: darkened ×0.82 (the 2D path's
            // brightness(0.82)) at the fill's opacity, under the media quad.
            pushMain(this.bgUniform(bf.opacity, cw, ch), bt.rt0.view)
          }
        }

        this.writeUniform(d, cw, ch)
        pushMain(this.scratch, cached.view)
      }

      // Blur targets are indexed by the number of blur layers in this frame.
      // Release high-water slots as soon as the playhead leaves a heavy scene.
      if (this.blurTargets.length > blurSlot) {
        for (let i = blurSlot; i < this.blurTargets.length; i++) {
          this.blurTargets[i]?.rt0.texture.destroy()
          this.blurTargets[i]?.rt1.texture.destroy()
        }
        this.blurTargets.length = blurSlot
        this.bindSlots = []
        this.preBindSlots = []
      }

      // Nothing uploaded (all sources tainted / not yet decoded). Skip the pass
      // and tell the caller to use Canvas 2D for this frame.
      if (ready.length === 0) {
        if (draws.length === 0 || draws.some((draw) => sourceStillLoading(draw.source))) {
          this.consecutiveFailures = 0
          return 'empty'
        }
        this.consecutiveFailures++
        if (this.consecutiveFailures >= 30) {
          this.lost = true
          return 'lost'
        }
        return 'empty'
      }

      const encoder = this.device.createCommandEncoder()
      for (const p of prePasses) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: p.target, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
          ],
        })
        pass.setPipeline(p.pipeline)
        pass.setBindGroup(0, p.bind)
        pass.draw(4)
        pass.end()
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      pass.setPipeline(this.pipeline)
      for (const bind of ready) {
        pass.setBindGroup(0, bind)
        pass.draw(4)
      }
      pass.end()
      this.device.queue.submit([encoder.finish()])
      this.consecutiveFailures = 0
      return 'ok'
    } catch {
      // A transient error mid-frame: fall back to 2D this frame, but only treat
      // repeated allocation/submit failures as permanent too. Otherwise an OOM
      // before device.lost resolves retries createTexture every frame forever.
      this.consecutiveFailures++
      if (this.lost || this.consecutiveFailures >= 3) {
        this.lost = true
        return 'lost'
      }
      return 'empty'
    }
  }

  /**
   * Wait until the commands that produced the current canvas image have
   * completed.  Browser export uses this fence before constructing a
   * `VideoFrame` directly from the WebGPU canvas.  Without it Chromium can
   * hand the hardware encoder a not-yet-presented surface; that was the root
   * cause of the earlier zero-copy experiment stalling at 100% on some GPUs.
   */
  async waitForPresentedFrame(): Promise<boolean> {
    if (this.lost) return false
    try {
      await this.device.queue.onSubmittedWorkDone()
      return !this.lost
    } catch {
      this.lost = true
      return false
    }
  }

  /**
   * Detach the current worker-canvas image as an immutable encoder input.
   *
   * For a WebGPU OffscreenCanvas, transferToImageBitmap() replaces the drawing
   * buffer and hands the completed image to the caller. That gives WebCodecs a
   * stable per-frame surface while allowing the next render to start on a fresh
   * buffer; unlike waitForPresentedFrame(), it does not deliberately drain the
   * whole GPU queue before every encoder submission. Main-thread canvases and
   * WebViews without this integration return null so export keeps the proven
   * queue-fenced canvas path.
   */
  transferPresentedFrame(): ImageBitmap | null {
    if (
      this.lost ||
      typeof OffscreenCanvas === 'undefined' ||
      !(this.canvas instanceof OffscreenCanvas)
    ) return null
    if (typeof this.canvas.transferToImageBitmap !== 'function') return null
    try {
      return this.canvas.transferToImageBitmap()
    } catch {
      return null
    }
  }

  /** Uniform for the cover pass: cropped source cover-fitted (+bleed) into the
   *  small target, clip colour-adjust applied, no rotation/flip (matches the 2D
   *  drawCanvasFill, which ignores both). */
  private coverUniform(d: GpuMediaDraw, extraScale: number, tw: number, th: number): Float32Array {
    const cropW = Math.max(1e-3, (d.uv.u1 - d.uv.u0) * d.sourceW)
    const cropH = Math.max(1e-3, (d.uv.v1 - d.uv.v0) * d.sourceH)
    const cover = Math.max(tw / cropW, th / cropH) * Math.max(1, extraScale)
    const dw = cropW * cover
    const dh = cropH * cover
    const s = new Float32Array(FLOATS_PER_DRAW)
    s[0] = tw / 2
    s[1] = th / 2
    s[2] = dw / 2
    s[3] = dh / 2
    s[4] = 1 // cos 0
    s[5] = 0 // sin 0
    s[6] = 1 // no flip
    s[7] = 1
    s[8] = d.uv.u0
    s[9] = d.uv.v0
    s[10] = d.uv.u1
    s[11] = d.uv.v1
    s[12] = tw
    s[13] = th
    s[16] = d.adjust.b
    s[17] = d.adjust.c
    s[18] = d.adjust.s
    s[19] = 1
    return s
  }

  /** Uniform for one Gaussian pass (BU struct: stepX, stepY, radius, sigma). */
  private blurUniform(stepX: number, stepY: number, sigma: number): Float32Array {
    const s = new Float32Array(FLOATS_PER_DRAW)
    s[0] = stepX
    s[1] = stepY
    s[2] = Math.max(0, Math.ceil(sigma * 3))
    s[3] = sigma
    return s
  }

  /** Uniform for the full-frame blurred-background quad in the main pass. */
  private bgUniform(opacity: number, cw: number, ch: number): Float32Array {
    const s = new Float32Array(FLOATS_PER_DRAW)
    s[0] = cw / 2
    s[1] = ch / 2
    s[2] = cw / 2
    s[3] = ch / 2
    s[4] = 1
    s[5] = 0
    s[6] = 1
    s[7] = 1
    s[8] = 0
    s[9] = 0
    s[10] = 1
    s[11] = 1
    s[12] = cw
    s[13] = ch
    s[16] = 0.82 // the 2D path's brightness(0.82) darken
    s[17] = 1
    s[18] = 1
    s[19] = Math.max(0, Math.min(1, opacity))
    return s
  }

  private writeUniform(d: GpuMediaDraw, cw: number, ch: number): void {
    const s = this.scratch
    const cx = d.rect.x + d.rect.w / 2
    const cy = d.rect.y + d.rect.h / 2
    // geom0
    s[0] = cx
    s[1] = cy
    s[2] = d.rect.w / 2
    s[3] = d.rect.h / 2
    // geom1
    s[4] = Math.cos(d.rotationRad)
    s[5] = Math.sin(d.rotationRad)
    s[6] = d.flipH ? -1 : 1
    s[7] = d.flipV ? -1 : 1
    // uv
    s[8] = d.uv.u0
    s[9] = d.uv.v0
    s[10] = d.uv.u1
    s[11] = d.uv.v1
    // canvas
    s[12] = cw
    s[13] = ch
    s[14] = 0
    s[15] = 0
    // color
    s[16] = d.adjust.b
    s[17] = d.adjust.c
    s[18] = d.adjust.s
    s[19] = d.opacity
  }

  /** Bound VRAM to sources active in the current render horizon. */
  retainTextures(activeKeys: ReadonlySet<string>): void {
    let invalidated = false
    for (const [key, cached] of this.textures) {
      if (activeKeys.has(key)) continue
      cached.texture.destroy()
      this.textures.delete(key)
      invalidated = true
    }
    if (invalidated) {
      this.bindSlots = []
      this.preBindSlots = []
    }
  }

  /** Drop a cached texture (asset removed / source element rebuilt). */
  evictTexture(assetId: string): void {
    const cached = this.textures.get(assetId)
    if (cached) {
      cached.texture.destroy()
      this.textures.delete(assetId)
      // Its view is now dead — invalidate the bind-group slot caches so nothing
      // references the destroyed view (the cover pre-pass samples it too).
      this.bindSlots = []
      this.preBindSlots = []
    }
  }

  destroy(): void {
    for (const { texture } of this.textures.values()) texture.destroy()
    this.textures.clear()
    this.bindSlots = []
    this.preBindSlots = []
    for (const t of this.blurTargets) {
      t?.rt0.texture.destroy()
      t?.rt1.texture.destroy()
    }
    this.blurTargets = []
    for (const b of this.uniformPool) b.destroy()
    this.uniformPool = []
    for (const b of this.preUniformPool) b.destroy()
    this.preUniformPool = []
    try {
      this.device.destroy()
    } catch {
      /* already gone */
    }
  }
}
