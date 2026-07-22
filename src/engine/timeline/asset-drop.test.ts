import { beforeEach, describe, expect, it } from 'vitest'

import type { MediaAsset } from '@engine/media'
import { makeDefaultTimeline } from '@engine/timeline'
import { useProjectStore } from '@store/project-store'
import { useReplaceStore } from '@store/replace-store'
import { useTimelineStore } from '@store/timeline-store'

import { placeAssetIdsOnTimeline } from './asset-drop'

const video = (id: string, durationSec = 20): MediaAsset => ({
  id,
  projectId: 'project-1',
  kind: 'video',
  name: `${id}.mp4`,
  mimeType: 'video/mp4',
  sizeBytes: 1,
  durationSec,
  storageKey: '',
  sourcePath: `C:\\media\\${id}.mp4`,
  createdAt: 1,
})

const audio = (id: string): MediaAsset => ({
  ...video(id),
  kind: 'audio',
  name: `${id}.mp3`,
  mimeType: 'audio/mp3',
})

describe('path-backed/native asset timeline placement', () => {
  beforeEach(() => {
    useProjectStore.setState({ id: 'project-1', assets: [] })
    useTimelineStore.setState({
      timeline: makeDefaultTimeline(),
      selectedClipIds: [],
    })
    useReplaceStore.setState({ request: null })
  })

  it('inserts compatible imported assets at the captured drop second', () => {
    useProjectStore.setState({ assets: [video('v')] })

    expect(placeAssetIdsOnTimeline(['v'], { trackId: 'v1', startSec: 12.5 })).toBe(true)

    expect(useTimelineStore.getState().timeline.clips).toEqual([
      expect.objectContaining({ assetId: 'v', trackId: 'v1', startSec: 12.5 }),
    ])
  })

  it('keeps an incompatible asset in Media instead of inserting it on the wrong track', () => {
    useProjectStore.setState({ assets: [audio('a')] })

    expect(placeAssetIdsOnTimeline(['a'], { trackId: 'v1', startSec: 2 })).toBe(false)
    expect(useTimelineStore.getState().timeline.clips).toHaveLength(0)
  })

  it('preserves the single-asset replace flow when dropped over a clip', () => {
    const original = video('original', 10)
    const replacement = video('replacement', 30)
    useProjectStore.setState({ assets: [original, replacement] })
    useTimelineStore.getState().insertClip({
      trackId: 'v1',
      assetId: original.id,
      startSec: 4,
      durationSec: 10,
    })
    const originalClip = useTimelineStore.getState().timeline.clips[0]!

    expect(
      placeAssetIdsOnTimeline(['replacement'], { trackId: 'v1', startSec: 6 }),
    ).toBe(true)
    expect(useReplaceStore.getState().request).toEqual({
      clipId: originalClip.id,
      assetId: replacement.id,
    })
    expect(useTimelineStore.getState().timeline.clips).toHaveLength(1)
  })
})
