import { describe, expect, it } from 'vitest'

import type { Clip, Track } from '@engine/timeline'
import {
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_ESTIMATED_BYTES,
  estimateHistorySnapshotBytes,
  trimHistoryHead,
  trimHistoryTail,
  type HistoryBudgetSnapshot,
} from './history-budget'

const track = { id: 'text', kind: 'text', name: 'Captions', muted: false, locked: false } as Track

function snapshot(clipCount: number, marker: number): HistoryBudgetSnapshot & { marker: number } {
  const clips = Array.from({ length: clipCount }, (_, index) => ({
    id: `caption-${index}`,
    assetId: null,
    trackId: 'text',
    startSec: index,
    inPointSec: 0,
    outPointSec: 1,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
    textData: {
      content: `caption ${index} with several words`,
      fontSize: 42,
      color: '#fff',
      fontFamily: 'Inter',
      fontWeight: 'bold',
      align: 'center',
      x: 0.5,
      y: 0.8,
      hasBackground: false,
      backgroundColor: '#000',
    },
    effects: [],
  })) as Clip[]
  return { clips, tracks: [track], compounds: {}, marker }
}

describe('adaptive history budget', () => {
  it('bounds 10k-caption snapshots by estimated bytes and retains newest state', () => {
    const large = snapshot(10_000, 0)
    const entries = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, marker) => ({
      ...large,
      marker,
    }))
    const past = trimHistoryTail(entries)
    const future = trimHistoryHead([...entries].reverse())

    expect(past.length).toBeLessThan(MAX_HISTORY_ENTRIES)
    expect(past.at(-1)?.marker).toBe(MAX_HISTORY_ENTRIES - 1)
    expect(future[0]?.marker).toBe(MAX_HISTORY_ENTRIES - 1)
    expect(past.reduce((sum, item) => sum + estimateHistorySnapshotBytes(item), 0))
      .toBeLessThanOrEqual(MAX_HISTORY_ESTIMATED_BYTES)
  })

  it('preserves the full entry count for small timelines', () => {
    const small = snapshot(10, 0)
    const entries = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, marker) => ({
      ...small,
      marker,
    }))
    expect(trimHistoryTail(entries)).toHaveLength(MAX_HISTORY_ENTRIES)
  })
})
