/**
 * SPIKE (TASK-28): GPU compositor prototype for preview/export rendering.
 *
 * Technology decision — WebGL2, not WebGPU:
 *  - WebGL2 is available in effectively every browser this app supports;
 *    WebGPU needs Chrome 113+/Edge and still has driver-dependent quirks.
 *  - `texImage2D` from HTMLVideoElement / VideoFrame is a mature, fast upload
 *    path (the browser keeps it on the GPU for hardware-decoded video).
 *  - Nothing this compositor does (textured quads + per-pixel colour math)
 *    needs compute shaders; WebGPU would buy complexity, not capability.
 *
 * What it does per layer, all on the GPU:
 *  - contain-fit + scale/scaleX/scaleY + anchor + rotation (vertex matrix)
 *  - opacity and brightness/contrast/saturation (fragment shader) — the
 *    Canvas2D path pays for these with `ctx.filter`, which forks a software
 *    filter chain per draw and is the single slowest part of preview render.
 *
 * Deliberately NOT wired into PreviewCanvas/exporter yet: this module is the
 * spike artifact. Nothing imports it, so it adds zero bytes to the bundle.
 * Integration plan (follow-up): PreviewCanvas keeps Canvas2D for text and
 * uses this for video/image layers via drawLayer(), falling back wholesale
 * when `createGLCompositor` returns null.
 *
 * The matrix/geometry helpers are pure and unit-tested in node; the GL paths
 * are verified in-browser (pixel reads + micro-benchmark vs Canvas2D).
 */

/** Anything texImage2D accepts as a pixel source. */
export type GLLayerSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | VideoFrame

export interface GLLayer {
  /** Natural size of the source in pixels. */
  srcWidth: number
  srcHeight: number
  /** ClipTransform semantics (zoom effects pre-multiplied into `scale`). */
  scale: number
  scaleX: number
  scaleY: number
  /** Anchor as a fraction of the frame (0.5/0.5 = centred). */
  x: number
  y: number
  /** Clockwise degrees, rotating around the layer centre (canvas parity). */
  rotationDeg: number
  /** 0..1, multiplied into the layer's alpha. */
  opacity: number
  /** ColorAdjust values, -100..100 (CSS filter semantics, like the preview). */
  brightness: number
  contrast: number
  saturation: number
}

const MIN_AXIS_SCALE = 0.05

// ── Pure geometry (unit-tested) ─────────────────────────────────────────────

type Mat3 = [number, number, number, number, number, number, number, number, number]

/** Column-major 3x3 multiply: returns a·b (apply b first, then a). */
export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] =
        a[row]! * b[col * 3]! + a[3 + row]! * b[col * 3 + 1]! + a[6 + row]! * b[col * 3 + 2]!
    }
  }
  return out
}

/** Drawn size of a layer after contain-fit + transform (fitDrawCtx parity). */
export function layerDrawSize(
  layer: Pick<GLLayer, 'srcWidth' | 'srcHeight' | 'scale' | 'scaleX' | 'scaleY'>,
  frameW: number,
  frameH: number,
): { dw: number; dh: number } {
  const fit =
    Math.min(frameW / Math.max(1, layer.srcWidth), frameH / Math.max(1, layer.srcHeight)) *
    Math.max(MIN_AXIS_SCALE, layer.scale)
  return {
    dw: layer.srcWidth * fit * Math.max(MIN_AXIS_SCALE, layer.scaleX),
    dh: layer.srcHeight * fit * Math.max(MIN_AXIS_SCALE, layer.scaleY),
  }
}

/**
 * Full transform for a unit quad (0..1)² → clip space: contain-fit, axis
 * scales, clockwise rotation about the layer centre, anchor placement, and
 * the pixels→clip projection (with the Y flip, so pixel y=0 is clip +1).
 */
export function layerQuadMatrix(layer: GLLayer, frameW: number, frameH: number): Mat3 {
  const { dw, dh } = layerDrawSize(layer, frameW, frameH)
  const rad = (layer.rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = layer.x * frameW
  const cy = layer.y * frameH

  // pixel = T(cx,cy) · R(θ) · S(dw,dh) · T(-.5,-.5) · unit
  const centerQuad: Mat3 = [dw, 0, 0, 0, dh, 0, -dw / 2, -dh / 2, 1]
  // y-down pixel space → positive θ renders clockwise, same as ctx.rotate.
  const rot: Mat3 = [cos, sin, 0, -sin, cos, 0, 0, 0, 1]
  const place: Mat3 = [1, 0, 0, 0, 1, 0, cx, cy, 1]
  // pixels → clip: x' = 2x/W - 1, y' = 1 - 2y/H
  const proj: Mat3 = [2 / frameW, 0, 0, 0, -2 / frameH, 0, -1, 1, 1]

  return mat3Multiply(proj, mat3Multiply(place, mat3Multiply(rot, centerQuad)))
}

/** Apply a column-major mat3 to a point (helper for tests/verification). */
export function transformPoint(m: Mat3, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[3] * y + m[6],
    y: m[1] * x + m[4] * y + m[7],
  }
}

// ── WebGL2 renderer ─────────────────────────────────────────────────────────

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;     // unit quad corner (doubles as UV)
uniform mat3 u_matrix;
out vec2 v_uv;
void main() {
  vec3 p = u_matrix * vec3(a_pos, 1.0);
  v_uv = a_pos;
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec3 u_eq;                    // brightness/contrast/saturation mults
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  // CSS-filter parity with the Canvas2D preview (adjustToFilter):
  c.rgb *= u_eq.x;                                   // brightness(mult)
  c.rgb = (c.rgb - 0.5) * u_eq.y + 0.5;              // contrast(mult)
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = mix(vec3(l), c.rgb, u_eq.z);               // saturate(mult)
  float a = c.a * u_opacity;
  outColor = vec4(c.rgb * a, a);                     // premultiplied source-over
}`

export interface GLCompositor {
  /** Clear to opaque black and size the drawing buffer. */
  begin(width: number, height: number): void
  /** Composite one layer (call in bottom→top order). */
  drawLayer(source: GLLayerSource, layer: GLLayer): void
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  dispose(): void
}

/** Returns null when WebGL2 is unavailable (caller falls back to Canvas2D). */
export function createGLCompositor(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): GLCompositor | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true, // preview canvas is read back / displayed
  }) as WebGL2RenderingContext | null
  if (!gl) return null

  function compile(type: number, src: string): WebGLShader | null {
    const sh = gl!.createShader(type)
    if (!sh) return null
    gl!.shaderSource(sh, src)
    gl!.compileShader(sh)
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      gl!.deleteShader(sh)
      return null
    }
    return sh
  }

  const vs = compile(gl.VERTEX_SHADER, VERT)
  const fs = compile(gl.FRAGMENT_SHADER, FRAG)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  // Unit quad as a triangle strip; positions double as UVs.
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const uMatrix = gl.getUniformLocation(prog, 'u_matrix')
  const uOpacity = gl.getUniformLocation(prog, 'u_opacity')
  const uEq = gl.getUniformLocation(prog, 'u_eq')

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied source-over
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

  // One texture per source object, re-uploaded per draw (video frames change
  // every frame anyway; images re-upload cheap at preview cadence).
  const textures = new WeakMap<object, WebGLTexture>()

  function textureFor(source: GLLayerSource): WebGLTexture | null {
    let tex = textures.get(source) ?? null
    if (!tex) {
      tex = gl!.createTexture()
      if (!tex) return null
      textures.set(source, tex)
      gl!.bindTexture(gl!.TEXTURE_2D, tex)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    } else {
      gl!.bindTexture(gl!.TEXTURE_2D, tex)
    }
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source)
    return tex
  }

  return {
    canvas,
    begin(width, height) {
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },
    drawLayer(source, layer) {
      if (!textureFor(source)) return
      gl.uniformMatrix3fv(uMatrix, false, layerQuadMatrix(layer, canvas.width, canvas.height))
      gl.uniform1f(uOpacity, Math.max(0, Math.min(1, layer.opacity)))
      gl.uniform3f(
        uEq,
        1 + layer.brightness / 100,
        1 + layer.contrast / 100,
        1 + layer.saturation / 100,
      )
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.deleteBuffer(vbo)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      const ext = gl.getExtension('WEBGL_lose_context')
      ext?.loseContext()
    },
  }
}
