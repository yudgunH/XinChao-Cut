import { describe, expect, it } from 'vitest'

import type { Clip, Track } from '@engine/timeline'

import { snapshotToTimeline } from './snapshot'
import type { ProjectSnapshot } from './types'

const tracks: Track[] = [
  { id: 't1', kind: 'text', name: 'Text 1', muted: false, locked: false },
  { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false },
  { id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked: false },
  { id: 'a1', kind: 'audio', name: 'Audio 1', muted: false, locked: false },
]

function snapshot(clips: Clip[] = []): ProjectSnapshot {
  return {
    id: 'project-1',
    version: 1,
    name: 'Project',
    fps: 30,
    width: 1920,
    height: 1080,
    aspect: '16:9',
    tracks,
    clips,
    assetIds: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('snapshot timeline migration', () => {
  it('removes the unused second video track from the legacy default layout', () => {
    expect(snapshotToTimeline(snapshot()).tracks.map((track) => track.id))
      .toEqual(['t1', 'v1', 'a1'])
  })

  it('preserves the legacy second video track when it contains a clip', () => {
    const clip = {
      id: 'clip-1',
      trackId: 'v2',
      kind: 'video',
      startSec: 0,
      inPointSec: 0,
      outPointSec: 2,
    } as unknown as Clip

    expect(snapshotToTimeline(snapshot([clip])).tracks.map((track) => track.id))
      .toEqual(['t1', 'v2', 'v1', 'a1'])
  })
})
