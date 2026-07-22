import { describe, expect, it } from 'vitest'

import type { MediaAsset } from '@engine/media'
import {
  assetNeedsWaveform,
  pickWaveformBackfillBatch,
  WAVEFORM_BACKFILL_CONCURRENCY,
} from './useWaveformBackfill'

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'a1', projectId: 'p1', kind: 'audio', name: 'voice.mp3',
    mimeType: 'audio/mpeg', sizeBytes: 1, durationSec: 2,
    storageKey: '', createdAt: 1, ...overrides,
  }
}

describe('timeline waveform backfill policy', () => {
  it('backfills a referenced timeline-only narration asset', () => {
    expect(assetNeedsWaveform(asset({ timelineOnly: true }), new Set(['a1']))).toBe(true)
  })

  it('skips detached timeline-only rows and completed/silent waveforms', () => {
    expect(assetNeedsWaveform(asset({ timelineOnly: true }), new Set())).toBe(false)
    expect(assetNeedsWaveform(asset({ timelineOnly: true, waveformPeaks: [0] }), new Set(['a1']))).toBe(false)
    expect(assetNeedsWaveform(asset({ timelineOnly: true, waveformPeaks: [0.2, 0.5] }), new Set(['a1']))).toBe(false)
  })

  it('keeps normal library assets eligible without a timeline reference', () => {
    expect(assetNeedsWaveform(asset(), new Set())).toBe(true)
  })

  it('starts a bounded concurrent batch and prioritises referenced narration', () => {
    const assets = [
      asset({ id: 'original', kind: 'video', name: 'original.mp4' }),
      ...Array.from({ length: 6 }, (_, index) =>
        asset({ id: `tts-${index}`, timelineOnly: true, name: `tts-${index}.mp3` }),
      ),
    ]
    const referenced = new Set(assets.map((item) => item.id))
    const batch = pickWaveformBackfillBatch(assets, referenced, () => false)

    expect(batch).toHaveLength(WAVEFORM_BACKFILL_CONCURRENCY)
    expect(batch.every((item) => item.timelineOnly)).toBe(true)
  })

  it('does not select an asset that already has an in-flight waveform job', () => {
    const assets = [
      asset({ id: 'tts-1', timelineOnly: true }),
      asset({ id: 'tts-2', timelineOnly: true }),
    ]
    const batch = pickWaveformBackfillBatch(
      assets,
      new Set(['tts-1', 'tts-2']),
      (id) => id === 'tts-1',
    )

    expect(batch.map((item) => item.id)).toEqual(['tts-2'])
  })
})
