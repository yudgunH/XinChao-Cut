import { describe, expect, it } from 'vitest'

import {
  EXPORT_BENCH_INSTRUCTIONS,
  aggregateExportPerfWindows,
  compareGoldenPixels,
  evaluateExportBenchBudget,
  getExportBenchSupport,
  parseExportPerfLine,
} from './export-bench'

describe('export benchmark harness', () => {
  it('parses and aggregates the exporter perf log without separate instrumentation', () => {
    const first = parseExportPerfLine(
      '[export perf] fps=200.0 decode=1.0ms draw=2.0ms encode+bp=2.0ms (submit=0.1 drain=1.8 sink=0.1 yield=0.0 maxQ=13) path=gpu zeroCopy=active worker=false churn(creates=2 transient=0 release=1 handoffs=1 degraded=0 seekResets=0 decoderInits=2)',
      300,
    )
    const final = parseExportPerfLine(
      '[export perf] final fps=100.0 decode=3.0ms draw=4.0ms encode+bp=3.0ms path=gpu zeroCopy=active worker=false seekFallbackAssets=1',
      150,
    )
    expect(first).not.toBeNull()
    expect(final).not.toBeNull()
    const aggregate = aggregateExportPerfWindows([first!, final!])
    expect(aggregate.frames).toBe(450)
    expect(aggregate.fps).toBeCloseTo(150)
    expect(aggregate.decodeMsPerFrame).toBeCloseTo(5 / 3)
    expect(aggregate.seekFallbackAssets).toBe(1)
  })

  it('parses the authoritative total perf line and its explicit frame count', () => {
    const total = parseExportPerfLine(
      '[export perf total] fps=113.5 frames=6809 decode=6.2ms draw=0.4ms encode+bp=2.2ms path=gpu zeroCopy=active worker=true',
      0,
    )
    expect(total).toMatchObject({
      final: true,
      frames: 6809,
      fps: 113.5,
      decodeMsPerFrame: 6.2,
      drawMsPerFrame: 0.4,
      encodeAndBackpressureMsPerFrame: 2.2,
      path: 'gpu',
      zeroCopy: 'active',
      worker: true,
    })
  })

  it('enforces the 99% pixel gate at a 3/255 per-channel threshold', () => {
    const expected = new Uint8ClampedArray(10 * 10 * 4)
    const actual = expected.slice()
    actual[0] = 20
    actual[1] = 20
    actual[2] = 20
    const onePercentMismatch = compareGoldenPixels(expected, actual, 10, 10)
    expect(onePercentMismatch.pass).toBe(true)
    actual[4] = 20
    actual[5] = 20
    actual[6] = 20
    const twoPercentMismatch = compareGoldenPixels(expected, actual, 10, 10)
    expect(twoPercentMismatch.pass).toBe(false)
    expect(twoPercentMismatch.mismatchedPixelPercent).toBeCloseTo(2)
    expect(twoPercentMismatch.largestMismatchRegion.x).toBe(0)
    expect(twoPercentMismatch.largestMismatchRegion.y).toBe(0)
  })

  it('warns below 80% of the RTX 3070 Ti baseline', () => {
    expect(evaluateExportBenchBudget(184, 'auto').pass).toBe(true)
    expect(evaluateExportBenchBudget(183.9, 'auto').pass).toBe(false)
    expect(evaluateExportBenchBudget(1, 'off').applicable).toBe(false)
    const cutBudget = evaluateExportBenchBudget(53.53, 'auto', 30)
    expect(cutBudget).toMatchObject({
      applicable: true,
      baselineFps: 66.9,
      pass: true,
    })
    expect(cutBudget.minimumFps).toBeCloseTo(53.52, 5)
    expect(evaluateExportBenchBudget(53.51, 'auto', 30).pass).toBe(false)
    expect(evaluateExportBenchBudget(1, 'auto', 12).applicable).toBe(false)
  })

  it('skips in browser-less vitest and prints in-app instructions', () => {
    const support = getExportBenchSupport()
    if (!support.supported) {
      // eslint-disable-next-line no-console
      console.info(`[export bench] SKIP: ${support.reason}. ${EXPORT_BENCH_INSTRUCTIONS}`)
    }
    expect(support.supported).toBe(false)
  })
})
