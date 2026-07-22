import { describe, expect, it } from 'vitest'

import {
  adviseExportEngine,
  shouldApplyEngineRecommendation,
  type ExportEngineAdviceInput,
} from './engine-advisor'

const gib = 1024 ** 3

describe('manual engine ownership', () => {
  it('keeps a valid manual choice when async advice changes', () => {
    expect(shouldApplyEngineRecommendation(true, 'browser', {
      browserAllowed: true,
      serverAllowed: true,
    })).toBe(false)
  })

  it('overrides a manual choice only when it becomes unsafe', () => {
    expect(shouldApplyEngineRecommendation(true, 'browser', {
      browserAllowed: false,
      serverAllowed: true,
    })).toBe(true)
  })
})

function input(overrides: Partial<ExportEngineAdviceInput> = {}): ExportEngineAdviceInput {
  return {
    durationSec: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    estimatedOutputBytes: 100 * 1024 ** 2,
    videoLoad: { maxMappings: 1, atSec: 0, peakTextureBytes: 1920 * 1080 * 4 },
    audioRoute: { action: 'browser', estimate: {} as never },
    browserStorage: { quotaBytes: gib, usageBytes: 0, availableBytes: gib, persisted: true },
    directOutput: false,
    serverAvailable: true,
    serverParityGaps: [],
    exactParity: true,
    serverEncoder: 'h264_nvenc',
    throughput: { browserSpeedX: 1, serverSpeedX: 2 },
    ...overrides,
  }
}

describe('adviseExportEngine', () => {
  it('keeps complex exact-parity timelines in the browser', () => {
    const advice = adviseExportEngine(input({ serverParityGaps: ['captions'] }))
    expect(advice.recommended).toBe('browser')
    expect(advice.serverAllowed).toBe(false)
    expect(advice.reasons.join(' ')).toContain('pixel-identically')
  })

  it('routes long simple timelines to the server', () => {
    const advice = adviseExportEngine(input({ durationSec: 7200, estimatedOutputBytes: 3 * gib }))
    expect(advice.recommended).toBe('server')
  })

  it('keeps short timelines in Browser despite a stale server speed advantage', () => {
    const advice = adviseExportEngine(input({
      durationSec: 69,
      throughput: { browserSpeedX: 1, serverSpeedX: 2 },
    }))
    expect(advice.recommended).toBe('browser')
    expect(advice.browserAllowed).toBe(true)
  })

  it('does not estimate libaom AV1 as a hardware encoder', () => {
    const software = adviseExportEngine(input({
      serverEncoder: 'libaom-av1',
      throughput: undefined,
    }))
    const hardware = adviseExportEngine(input({
      serverEncoder: 'av1_nvenc',
      throughput: undefined,
    }))
    expect(software.serverEstimateSec).toBeGreaterThan(hardware.serverEstimateSec!)
    expect(software.serverEstimateSec).toBeGreaterThan(software.browserEstimateSec)
  })

  it('identifies direct browser output as the parity path without OPFS', () => {
    const advice = adviseExportEngine(input({
      directOutput: true,
      serverParityGaps: ['effects'],
      browserStorage: { quotaBytes: 1, usageBytes: 1, availableBytes: 0, persisted: false },
    }))
    expect(advice.recommended).toBe('browser')
    expect(advice.mode).toBe('browser-direct')
    expect(advice.browserAllowed).toBe(true)
  })

  it('blocks browser storage output when quota is insufficient', () => {
    const advice = adviseExportEngine(input({
      serverAvailable: false,
      estimatedOutputBytes: 2 * gib,
      browserStorage: { quotaBytes: gib, usageBytes: gib, availableBytes: 0, persisted: false },
    }))
    expect(advice.browserAllowed).toBe(false)
    expect(advice.blockedReason).toBeTruthy()
  })

  it('warns when decoder and texture budgets are exceeded', () => {
    const advice = adviseExportEngine(input({
      serverParityGaps: ['captions'],
      videoLoad: { maxMappings: 8, atSec: 10, peakTextureBytes: 400 * 1024 ** 2 },
    }))
    expect(advice.warnings).toHaveLength(2)
  })

  it('does not pretend browser is safe when audio admission requires server', () => {
    const advice = adviseExportEngine(input({
      audioRoute: { action: 'server', estimate: {} as never, reason: 'audio peak' },
      serverParityGaps: ['captions'],
    }))
    expect(advice.browserAllowed).toBe(false)
    expect(advice.serverAllowed).toBe(false)
    expect(advice.blockedReason).toBeTruthy()
  })

  it('allows exact-parity browser rendering when Hybrid handles oversized audio', () => {
    const advice = adviseExportEngine(input({
      audioRoute: { action: 'server', estimate: {} as never, reason: 'audio peak' },
      directOutput: true,
      hybridAudioAvailable: true,
      serverParityGaps: ['captions'],
    }))
    expect(advice.browserAllowed).toBe(true)
    expect(advice.serverAllowed).toBe(false)
    expect(advice.recommended).toBe('browser')
    expect(advice.blockedReason).toBeUndefined()
    expect(advice.headline).toContain('Hybrid')
  })

  it('does not label an under-budget Browser Direct export as Hybrid', () => {
    const advice = adviseExportEngine(input({
      directOutput: true,
      hybridAudioAvailable: true,
      audioRoute: { action: 'browser', estimate: { overBudget: false } as never },
      serverParityGaps: ['captions'],
    }))
    expect(advice.recommended).toBe('browser')
    expect(advice.headline).toContain('Browser Direct')
    expect(advice.headline).not.toContain('Hybrid')
  })
})
