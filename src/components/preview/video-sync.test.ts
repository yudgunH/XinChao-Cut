import { describe, expect, it } from 'vitest'

import { decideVideoSync, leadCompensatedSeekTarget } from './video-sync'

describe('video preview drift correction', () => {
  it('rate-corrects one-frame drift and hard-seeks larger divergence', () => {
    expect(decideVideoSync(1, 1.01)).toEqual({ hardSeek: false, rateCorrection: 1 })
    expect(decideVideoSync(1, 1.04)).toMatchObject({ hardSeek: false })
    expect(decideVideoSync(1, 1.04).rateCorrection).toBeGreaterThan(1)
    expect(decideVideoSync(1.08, 1).rateCorrection).toBeLessThan(1)
    expect(decideVideoSync(1, 1.2)).toEqual({ hardSeek: true, rateCorrection: 1 })
  })

  it('normalizes drift by playbackRate so fast spans get real time to land a seek', () => {
    // 0.4s of SOURCE drift at 4x is only 100ms of wall time — must NOT hard-seek
    // (a re-seek would abort a ~100ms in-flight seek forever at high speed)...
    expect(decideVideoSync(1, 1.4, 4)).toMatchObject({ hardSeek: false })
    expect(decideVideoSync(1, 1.4, 4).rateCorrection).toBeGreaterThan(1)
    // ...while the same wall drift at 1x still hard-seeks (unchanged behaviour).
    expect(decideVideoSync(1, 1.4, 1)).toEqual({ hardSeek: true, rateCorrection: 1 })
    // 1s of source drift at 4x is 250ms wall — over the bar, genuinely off target.
    expect(decideVideoSync(1, 2, 4)).toEqual({ hardSeek: true, rateCorrection: 1 })
    // Slow spans tighten in source time: 0.15s source at 0.5x = 300ms wall.
    expect(decideVideoSync(1, 1.15, 0.5)).toEqual({ hardSeek: true, rateCorrection: 1 })
  })

  it('closes wall drift at the same pace regardless of authored speed', () => {
    // Correction multiplies the clip speed, so (correction − 1) is the wall
    // closure rate. Equal wall drift ⇒ equal correction at any rate.
    const at1x = decideVideoSync(1, 1.05, 1).rateCorrection
    const at4x = decideVideoSync(1, 1.2, 4).rateCorrection // 0.05s wall drift too
    expect(at4x).toBeCloseTo(at1x, 10)
  })
})

describe('lead-compensated hard-seek target', () => {
  it('leads by measured seek latency scaled to the playback rate', () => {
    // 200ms measured latency at 4x → land 0.8 source-sec ahead of "now".
    expect(leadCompensatedSeekTarget(10, 4, 0.2, 100)).toBeCloseTo(10.8)
    // Same latency at 1x → 0.2 source-sec of lead.
    expect(leadCompensatedSeekTarget(10, 1, 0.2, 100)).toBeCloseTo(10.2)
  })

  it('clamps the latency estimate to a sane band', () => {
    expect(leadCompensatedSeekTarget(10, 1, 5, 100)).toBeCloseTo(10.6) // cap 0.6s
    expect(leadCompensatedSeekTarget(10, 1, 0, 100)).toBeCloseTo(10.05) // floor 50ms
  })

  it('never aims past the clip source out-point or behind the transport', () => {
    expect(leadCompensatedSeekTarget(10, 4, 0.5, 10.5)).toBeCloseTo(10.5)
    expect(leadCompensatedSeekTarget(10, 4, 0.5, 9)).toBeCloseTo(10) // degenerate window
  })
})
