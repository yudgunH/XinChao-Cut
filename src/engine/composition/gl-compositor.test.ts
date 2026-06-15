import { describe, it, expect } from 'vitest'

import {
  layerDrawSize,
  layerQuadMatrix,
  mat3Multiply,
  transformPoint,
  type GLLayer,
} from './gl-compositor'

function layer(over: Partial<GLLayer> = {}): GLLayer {
  return {
    srcWidth: 100, srcHeight: 100,
    scale: 1, scaleX: 1, scaleY: 1,
    x: 0.5, y: 0.5, rotationDeg: 0, opacity: 1,
    brightness: 0, contrast: 0, saturation: 0,
    ...over,
  }
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as Parameters<typeof mat3Multiply>[0]

describe('mat3Multiply', () => {
  it('identity is neutral', () => {
    const m = [2, 3, 0, 4, 5, 0, 6, 7, 1] as Parameters<typeof mat3Multiply>[0]
    expect(mat3Multiply(IDENTITY, m)).toEqual(m)
    expect(mat3Multiply(m, IDENTITY)).toEqual(m)
  })
})

describe('layerDrawSize (contain-fit parity with fitDrawCtx)', () => {
  it('fits a square source into a wide frame by height', () => {
    const { dw, dh } = layerDrawSize(layer(), 1000, 500)
    expect(dw).toBe(500)
    expect(dh).toBe(500)
  })

  it('applies scale and per-axis scales multiplicatively', () => {
    const { dw, dh } = layerDrawSize(layer({ scale: 0.5, scaleX: 2 }), 1000, 500)
    expect(dw).toBe(500) // 100 * 5(fit) * 0.5 * 2
    expect(dh).toBe(250)
  })

  it('clamps non-positive axis scales to the canvas minimum', () => {
    const { dw } = layerDrawSize(layer({ scaleX: 0 }), 1000, 500)
    expect(dw).toBeCloseTo(500 * 0.05)
  })
})

describe('layerQuadMatrix', () => {
  const clip = (m: ReturnType<typeof layerQuadMatrix>, x: number, y: number) =>
    transformPoint(m, x, y)

  it('centres an identity layer (clip coords, y up)', () => {
    // 100x100 source in 1000x500 → 500x500 box centred at (500,250).
    const m = layerQuadMatrix(layer(), 1000, 500)
    const tl = clip(m, 0, 0) // pixel (250, 0)
    expect(tl.x).toBeCloseTo(-0.5)
    expect(tl.y).toBeCloseTo(1)
    const br = clip(m, 1, 1) // pixel (750, 500)
    expect(br.x).toBeCloseTo(0.5)
    expect(br.y).toBeCloseTo(-1)
  })

  it('rotates 90° clockwise around the layer centre (canvas parity)', () => {
    // 200x100 in 400x400 → 400x200 box at centre; corner (0,0) is local
    // (-200,-100); CW 90° maps it to (100,-200) → pixel (300, 0) → clip (.5, 1).
    const m = layerQuadMatrix(
      layer({ srcWidth: 200, srcHeight: 100, rotationDeg: 90 }),
      400,
      400,
    )
    const tl = clip(m, 0, 0)
    expect(tl.x).toBeCloseTo(0.5)
    expect(tl.y).toBeCloseTo(1)
    // And the box is now portrait: corner (1,0) → local (200,-100) → CW 90° →
    // (100, 200) → pixel (300, 400) → clip (0.5, -1).
    const tr = clip(m, 1, 0)
    expect(tr.x).toBeCloseTo(0.5)
    expect(tr.y).toBeCloseTo(-1)
  })

  it('moves with the anchor', () => {
    // Anchor x=0.25 in an 800-wide frame puts the centre at pixel x=200.
    const m = layerQuadMatrix(layer({ x: 0.25, scale: 0.5 }), 800, 600)
    const tl = clip(m, 0, 0)
    const br = clip(m, 1, 1)
    const centerClipX = (tl.x + br.x) / 2
    expect(centerClipX).toBeCloseTo(2 * (0.25 * 800) / 800 - 1) // -0.5
  })

  it('rotation preserves the centre point', () => {
    const a = layerQuadMatrix(layer({ rotationDeg: 0 }), 640, 480)
    const b = layerQuadMatrix(layer({ rotationDeg: 137 }), 640, 480)
    const ca = clip(a, 0.5, 0.5)
    const cb = clip(b, 0.5, 0.5)
    expect(cb.x).toBeCloseTo(ca.x)
    expect(cb.y).toBeCloseTo(ca.y)
  })
})
