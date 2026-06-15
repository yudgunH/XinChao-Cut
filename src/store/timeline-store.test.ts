import { describe, it, expect, beforeEach } from 'vitest'

import { makeDefaultAdjust, makeDefaultTransform, type Clip, type Track } from '@engine/timeline'

import { useTimelineStore } from './timeline-store'
import { useUIStore } from './ui-store'

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1', trackId: 'v1', assetId: 'a1', kind: 'video',
    startSec: 0, inPointSec: 0, outPointSec: 5, speed: 1,
    opacity: 1, volume: 1,
    adjust: makeDefaultAdjust(), transform: makeDefaultTransform(),
    effects: [],
    ...over,
  } as Clip
}

const tracks: Track[] = [{ id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false }]

beforeEach(() => {
  // Fresh timeline with one clip; replaceTimeline clears undo history.
  useTimelineStore.getState().replaceTimeline([clip()], tracks, 30, 5)
})

const st = () => useTimelineStore.getState()
const firstClip = () => st().timeline.clips[0]!

describe('history semantics for live setters (TASK: slider spam / undo gaps)', () => {
  it('live setters alone create NO undo step', () => {
    expect(st().canUndo).toBe(false)
    st().setClipOpacity('c1', 0.5)
    st().setClipOpacity('c1', 0.4)
    st().setClipVolume('c1', 0.2)
    st().setClipAdjust('c1', { brightness: 30 })
    st().setClipTransform('c1', { x: 0.3 })
    // Values applied…
    expect(firstClip().opacity).toBeCloseTo(0.4)
    expect(firstClip().adjust.brightness).toBe(30)
    expect(firstClip().transform.x).toBeCloseTo(0.3)
    // …but no history was pushed by the live setters themselves.
    expect(st().canUndo).toBe(false)
  })

  it('a whole slider drag collapses into ONE undo step', () => {
    st().beginHistoryStep() // pointer-down
    st().setClipOpacity('c1', 0.8)
    st().setClipOpacity('c1', 0.5)
    st().setClipOpacity('c1', 0.2) // drag end
    expect(st().canUndo).toBe(true)
    expect(firstClip().opacity).toBeCloseTo(0.2)
    st().undo()
    // One undo reverts the entire drag back to the pre-drag value.
    expect(firstClip().opacity).toBe(1)
    expect(st().canUndo).toBe(false)
  })

  it('transform drag is undoable when wrapped in beginHistoryStep', () => {
    st().beginHistoryStep()
    st().setClipTransform('c1', { x: 0.2 })
    st().setClipTransform('c1', { x: 0.7 })
    st().undo()
    expect(firstClip().transform.x).toBe(0.5) // default centre restored
  })

  it('text edits are undoable when wrapped in beginHistoryStep', () => {
    useTimelineStore.getState().replaceTimeline(
      [clip({ kind: 'text', textData: { content: 'hi' } } as unknown as Partial<Clip>)],
      tracks, 30, 5,
    )
    st().beginHistoryStep()
    st().setClipText('c1', { content: 'hello' })
    st().setClipText('c1', { content: 'hello world' })
    st().undo()
    expect(firstClip().textData?.content).toBe('hi')
  })

  it('two separate drags are two separate undo steps', () => {
    st().beginHistoryStep()
    st().setClipOpacity('c1', 0.5)
    st().beginHistoryStep()
    st().setClipVolume('c1', 0.3)
    st().undo() // undo the volume drag
    expect(firstClip().volume).toBe(1)
    expect(firstClip().opacity).toBeCloseTo(0.5) // opacity drag still applied
    st().undo() // undo the opacity drag
    expect(firstClip().opacity).toBe(1)
  })
})

describe('fx clips', () => {
  it('inserts a blur sticker on an fx track and selects it', () => {
    const id = st().insertBlurSticker(2, 5)
    const inserted = st().timeline.clips.find((c) => c.id === id)!
    const track = st().timeline.tracks.find((t) => t.id === inserted.trackId)!

    expect(track.kind).toBe('fx')
    expect(inserted.assetId).toBeNull()
    expect(inserted.startSec).toBe(2)
    expect(inserted.fxData).toMatchObject({ type: 'blur-sticker', blurPx: 18 })
    expect(st().selectedClipIds).toEqual([id])
  })
})

describe('magnetic main track', () => {
  const magTracks: Track[] = [
    { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false },
    { id: 't1', kind: 'text', name: 'T1', muted: false, locked: false },
  ]
  const startOf = (id: string) =>
    st().timeline.clips.find((c) => c.id === id)!.startSec

  beforeEach(() => {
    useUIStore.setState({ magneticMainTrack: true, linkEnabled: true })
  })

  it('insert: dropping a clip between two ripples the later one to make room', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'B', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'C', trackId: 'v1', startSec: 4, inPointSec: 0, outPointSec: 2 }),
      ],
      magTracks, 30, 6,
    )
    st().beginClipDrag(['C'])
    st().setClipDragDelta(-3) // 4 → 1, dropped between A and B
    st().setClipDragTargetTrack('v1')
    st().commitClipDrag()
    expect(startOf('A')).toBeCloseTo(0)
    expect(startOf('C')).toBeCloseTo(2) // inserted after A
    expect(startOf('B')).toBeCloseTo(4) // pushed right
  })

  it('linked caption rides a rippled (non-dragged) clip', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'B', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'C', trackId: 'v1', startSec: 4, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'capB', trackId: 't1', assetId: null, startSec: 2, inPointSec: 0, outPointSec: 2 }),
      ],
      magTracks, 30, 6,
    )
    st().beginClipDrag(['C'])
    st().setClipDragDelta(-3)
    st().setClipDragTargetTrack('v1')
    st().commitClipDrag()
    expect(startOf('B')).toBeCloseTo(4)
    expect(startOf('capB')).toBeCloseTo(4) // caption followed B's ripple
  })

  it('delete: gap closes and the surviving clip carries its caption', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'B', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'capB', trackId: 't1', assetId: null, startSec: 2, inPointSec: 0, outPointSec: 2 }),
      ],
      magTracks, 30, 4,
    )
    st().removeClips(['A'])
    expect(startOf('B')).toBeCloseTo(0)
    expect(startOf('capB')).toBeCloseTo(0)
  })

  it('uses the bottom-most video track as the magnetic main track', () => {
    st().replaceTimeline(
      [
        clip({ id: 'topA', trackId: 'v2', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'topB', trackId: 'v2', startSec: 4, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'mainA', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'mainB', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
      ],
      [
        { id: 'v2', kind: 'video', name: 'V2', muted: false, locked: false },
        { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false },
      ],
      30,
      6,
    )
    st().removeClips(['mainA'])
    expect(startOf('mainB')).toBeCloseTo(0)
    expect(startOf('topB')).toBeCloseTo(4)
  })

  it('re-resolves the magnetic main track after drag-created tracks are pruned', () => {
    st().replaceTimeline(
      [clip({ id: 'A', trackId: 'v1', startSec: 4, inPointSec: 0, outPointSec: 2 })],
      [{ id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false }],
      30,
      6,
    )
    st().beginClipDrag(['A'])
    st().setClipDragCreateKind('video')
    st().commitClipDrag()

    const videoTracks = st().timeline.tracks.filter((track) => track.kind === 'video')
    const moved = st().timeline.clips.find((c) => c.id === 'A')!
    expect(videoTracks).toHaveLength(1)
    expect(moved.trackId).toBe(videoTracks[0]!.id)
    expect(moved.startSec).toBeCloseTo(0)
  })

  it('live ripple preview matches the committed positions', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'B', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'C', trackId: 'v1', startSec: 4, inPointSec: 0, outPointSec: 2 }),
      ],
      magTracks, 30, 6,
    )
    st().beginClipDrag(['C'])
    st().setClipDragDelta(-3) // C drops at 1s (after A)
    // While dragging, B previews shifted right to open C's slot (A stays at 0).
    const preview = st().dragRipplePreview!
    expect(preview).toBeTruthy()
    expect(preview['B']).toBeCloseTo(4)
    expect(preview['A']).toBeUndefined() // A doesn't move
    // Committing lands B at the same place the preview promised.
    st().commitClipDrag()
    expect(startOf('B')).toBeCloseTo(4)
    expect(st().dragRipplePreview).toBeNull()
  })

  it('insertSubtitles newTrack: translated cues land on a fresh text track, not the original', () => {
    st().replaceTimeline(
      [clip({ id: 'cap1', trackId: 't1', startSec: 0, inPointSec: 0, outPointSec: 2,
        textData: { content: 'hi' } } as unknown as Partial<Clip>)],
      [{ id: 't1', kind: 'text', name: 'T1', muted: false, locked: false }], 30, 2,
    )
    const before = st().timeline.tracks.filter((t) => t.kind === 'text').length
    st().insertSubtitles(
      [{ content: 'xin chao', startSec: 0, durationSec: 2 }],
      { newTrack: true, trackName: 'Captions (vietnamese)' },
    )
    const tl = st().timeline
    expect(tl.tracks.filter((t) => t.kind === 'text').length).toBe(before + 1)
    const translated = tl.clips.find((c) => c.textData?.content === 'xin chao')!
    expect(translated.trackId).not.toBe('t1') // separate track, not merged with the original
  })

  it('magnetic off: dropping over a clip bumps to another track, no insert', () => {
    useUIStore.setState({ magneticMainTrack: false })
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'B', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
      ],
      magTracks, 30, 4,
    )
    st().beginClipDrag(['B'])
    st().setClipDragDelta(-2) // overlaps A
    st().setClipDragTargetTrack('v1')
    st().commitClipDrag()
    expect(startOf('A')).toBeCloseTo(0)
    expect(st().timeline.clips.find((c) => c.id === 'B')!.trackId).not.toBe('v1')
  })
})
