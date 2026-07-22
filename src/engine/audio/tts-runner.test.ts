import { describe, it, expect } from 'vitest'

import { planCaptionVoice } from './tts-runner'

/** Build items from [startSec, captionDur, voiceDur] triples. */
function items(rows: [number, number, number][]) {
  return rows.map(([start, capDur, voiceDur]) => ({
    captionStartSec: start,
    captionEndSec: start + capDur,
    voiceDurationSec: voiceDur,
  }))
}

describe('planCaptionVoice', () => {
  it('timeline mode keeps each clip at its caption start', () => {
    const starts = planCaptionVoice(items([[0, 2, 3], [5, 2, 3], [9, 2, 3]]), 'timeline')
    expect(starts).toEqual([0, 5, 9])
  })

  it('sequential lays a continuous run back-to-back (no gaps absorbed)', () => {
    // Captions are contiguous (gap 0) but voice is longer → clips pack tight.
    const starts = planCaptionVoice(items([[0, 2, 3], [2, 2, 3], [4, 2, 3]]), 'sequential')
    expect(starts).toEqual([0, 3, 6])
  })

  it('sequential splits on a long caption gap, re-anchoring at the real time', () => {
    // A,B contiguous; big 6s pause before C; C,D contiguous. gapSplit = 2.
    const starts = planCaptionVoice(
      items([[0, 2, 3], [2, 2, 3], [10, 2, 3], [12, 2, 3]]),
      'sequential',
    )
    // cluster1: A@0, B@3 ; pause preserved ; cluster2 re-anchored at C.start=10: C@10, D@13
    expect(starts).toEqual([0, 3, 10, 13])
  })

  it('sequential never overlaps prior voice even when it overruns the next caption', () => {
    // Long gap before C (start 5), but cluster1 voice runs to 8 (> 5) → C starts at 8.
    const starts = planCaptionVoice(items([[0, 1, 4], [1, 1, 4], [5, 1, 4]]), 'sequential')
    // A@0 (→4), B@4 (→8); gap 5-2=3 > 2 → split, but max(5, cursor 8) = 8
    expect(starts).toEqual([0, 4, 8])
  })

  it('respects a custom gap threshold', () => {
    // gap of 3s: with threshold 5 it is absorbed (seamless), not split.
    const starts = planCaptionVoice(items([[0, 2, 3], [5, 2, 3]]), 'sequential', 5)
    expect(starts).toEqual([0, 3]) // B packed after A, gap NOT preserved
  })
})
