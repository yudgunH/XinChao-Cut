import { describe, expect, it } from 'vitest'

import {
  classifyExportWorkload,
  loadExportThroughputProfile,
  recordExportThroughput,
  type StorageLike,
} from './performance-profile'

function memoryStorage(): StorageLike {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('export throughput profile', () => {
  it('records measured realtime speed by engine and resolution bucket', () => {
    const storage = memoryStorage()
    recordExportThroughput('browser', 1080, 30, 120, 240, storage)
    recordExportThroughput('server', 1080, 30, 120, 30, storage)

    expect(loadExportThroughputProfile(1080, 30, storage)).toEqual({
      browserSpeedX: 0.5,
      serverSpeedX: 4,
    })
  })

  it('ignores tiny calibration runs', () => {
    const storage = memoryStorage()
    recordExportThroughput('browser', 1080, 30, 2, 1, storage)
    expect(loadExportThroughputProfile(1080, 30, storage)).toEqual({
      browserSpeedX: undefined,
      serverSpeedX: undefined,
    })
  })

  it('keeps simple and composited measurements separate', () => {
    const storage = memoryStorage()
    const simple = { workload: 'simple', qualityProfile: 'balanced' } as const
    const composited = { workload: 'composited', qualityProfile: 'balanced' } as const
    recordExportThroughput('server', 1080, 30, 120, 20, storage, simple)
    recordExportThroughput('server', 1080, 30, 120, 120, storage, composited)

    expect(loadExportThroughputProfile(1080, 30, storage, simple).serverSpeedX).toBe(6)
    expect(loadExportThroughputProfile(1080, 30, storage, composited).serverSpeedX).toBe(1)
  })

  it('reuses a compatible machine measurement when only the workload bucket changes', () => {
    const storage = memoryStorage()
    const dense = {
      workload: 'dense', qualityProfile: 'balanced',
      videoCodec: 'h264', dynamicRange: 'sdr',
    } as const
    const composited = { ...dense, workload: 'composited' } as const
    recordExportThroughput('browser', 1080, 30, 230, 30, storage, dense)

    expect(loadExportThroughputProfile(1080, 30, storage, composited).browserSpeedX)
      .toBeCloseTo(230 / 30)
  })

  it('classifies the render cost shape', () => {
    const track = [
      { id: 'v', kind: 'video' },
      { id: 'text', kind: 'text' },
    ] as never
    const base = {
      id: 'c', assetId: 'a', trackId: 'v', kind: 'video',
      startSec: 0, inPointSec: 0, outPointSec: 10, speed: 1,
      opacity: 1, volume: 1, effects: [], adjust: {}, transform: {},
    }
    expect(classifyExportWorkload([base] as never, track)).toBe('simple')
    expect(classifyExportWorkload([
      base,
      { ...base, id: 'caption', assetId: null, trackId: 'text' },
    ] as never, track)).toBe('captioned')
    expect(classifyExportWorkload([
      { ...base, effects: [{ type: 'fade-in', params: {} }] },
    ] as never, track)).toBe('composited')
  })
})
