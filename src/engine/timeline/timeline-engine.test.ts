import { describe, expect, it } from 'vitest'

import { makeDefaultTracks, makeDefaultTimeline } from './timeline-engine'

describe('fresh timeline layout', () => {
  it('starts with exactly one track for text, video, and audio', () => {
    const tracks = makeDefaultTracks()

    expect(tracks.map((track) => track.kind)).toEqual(['text', 'video', 'audio'])
    expect(tracks.filter((track) => track.kind === 'video')).toHaveLength(1)
    expect(makeDefaultTimeline().tracks).toEqual(tracks)
  })
})
