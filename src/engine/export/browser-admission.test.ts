import { describe, expect, it } from 'vitest'
import type { Clip, Track } from '@engine/timeline'
import {
  MAX_BROWSER_IN_MEMORY_OUTPUT_BYTES,
  assertBrowserStorageHeadroom,
  assertSafeInMemoryBrowserOutput,
  estimateBrowserOutputBytes,
  measureBrowserVideoLoad,
} from './browser-admission'

const tracks: Track[] = [{
  id: 'v', kind: 'video', name: 'Video', muted: false, hidden: false, locked: false,
}]

function clip(id: string, startSec: number, inPointSec = 0): Clip {
  return {
    id, trackId: 'v', assetId: id,
    startSec, inPointSec, outPointSec: inPointSec + 1, speed: 1,
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    opacity: 1, volume: 1, muted: false, effects: [],
  }
}

describe('browser export admission', () => {
  it('does not count adjacent clips as concurrent', () => {
    expect(measureBrowserVideoLoad([clip('a', 0), clip('b', 1)], tracks)).toEqual({
      maxMappings: 1,
      atSec: 0,
      peakTextureBytes: 1920 * 1080 * 4,
    })
  })

  it('counts distinct simultaneous source mappings', () => {
    const clips = Array.from({ length: 14 }, (_, i) => clip(`c${i}`, 0, i))
    expect(measureBrowserVideoLoad(clips, tracks).maxMappings).toBe(14)
  })

  it('estimates peak source texture bytes from real asset dimensions', () => {
    const clips = [clip('a', 0), clip('b', 0)]
    const assets = [
      { id: 'a', width: 7680, height: 4320 },
      { id: 'b', width: 3840, height: 2160 },
    ]
    expect(measureBrowserVideoLoad(clips, tracks, assets).peakTextureBytes)
      .toBe((7680 * 4320 + 3840 * 2160) * 4)
  })

  it('estimates muxed output and blocks a large ArrayBuffer fallback', () => {
    const bytes = estimateBrowserOutputBytes(3600, 8000, true)
    expect(bytes).toBeGreaterThan(MAX_BROWSER_IN_MEMORY_OUTPUT_BYTES)
    expect(() => assertSafeInMemoryBrowserOutput(bytes)).toThrow(/OPFS/)
    expect(() => assertSafeInMemoryBrowserOutput(10 * 1024 * 1024)).not.toThrow()
  })

  it('blocks OPFS export when quota headroom is below the safety margin', () => {
    const snapshot = {
      usageBytes: 900,
      quotaBytes: 1000,
      availableBytes: 100,
      persisted: false,
    }
    expect(() => assertBrowserStorageHeadroom(snapshot, 90, 1.2)).toThrow(/storage/)
    expect(() => assertBrowserStorageHeadroom(snapshot, 80, 1.2)).not.toThrow()
  })
})
