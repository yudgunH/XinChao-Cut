import { describe, it, expect, beforeEach } from 'vitest'

import { clipEffectiveDuration, makeDefaultAdjust, makeDefaultTransform, makeSubtitleTextData, type Clip, type Track } from '@engine/timeline'

import { useTimelineStore } from './timeline-store'
import { useUIStore } from './ui-store'
import { usePlaybackStore } from './playback-store'

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
  usePlaybackStore.setState({ isPlaying: false, currentSec: 0, seekNonce: 0, volume: 1 })
  // Fresh timeline with one clip; replaceTimeline clears undo history.
  useTimelineStore.getState().replaceTimeline([clip()], tracks, 30, 5)
})

const st = () => useTimelineStore.getState()
const firstClip = () => st().timeline.clips[0]!

describe('normalizeTrackOverlaps', () => {
  it('trims ms-level overlaps between sequential clips without a history entry', () => {
    // Two video pieces whose boundary overlaps by 8ms (min-clip floor
    // inflation) — the earlier clip's out-point is trimmed to the next start.
    st().replaceTimeline([
      clip({ id: 'v-a', startSec: 0, inPointSec: 0, outPointSec: 2.008 }),
      clip({ id: 'v-b', startSec: 2, inPointSec: 2.008, outPointSec: 4 }),
    ], tracks, 30, 4)

    st().normalizeTrackOverlaps(['v1'])

    const [a, b] = st().timeline.clips
    expect(a!.startSec + clipEffectiveDuration(a!)).toBeCloseTo(b!.startSec, 9)
    expect(b!.outPointSec).toBe(4) // only the earlier clip changes
    expect(st().canUndo).toBe(false) // silent normalization
  })

  it('is a no-op when boundaries already touch', () => {
    st().replaceTimeline([
      clip({ id: 'v-a', startSec: 0, inPointSec: 0, outPointSec: 2 }),
      clip({ id: 'v-b', startSec: 2, inPointSec: 2, outPointSec: 4 }),
    ], tracks, 30, 4)
    const before = st().timeline.clips
    st().normalizeTrackOverlaps(['v1'])
    expect(st().timeline.clips).toBe(before)
  })
})

describe('insertVideoClips audio policy', () => {
  it('applies mute per remap span instead of muting the whole source', () => {
    const ids = st().insertVideoClips([
      { assetId: 'source', startSec: 5, inPointSec: 0, outPointSec: 2, speed: 1, muted: true },
      { assetId: 'source', startSec: 7, inPointSec: 2, outPointSec: 4, speed: 1, muted: false },
    ])
    const inserted = st().timeline.clips.filter((c) => ids.includes(c.id))
    expect(inserted.map((c) => c.muted)).toEqual([true, false])
  })
})

describe('insertAudioSpanClips', () => {
  it('keeps background stem windows and speed aligned with remapped video spans', () => {
    const ids = st().insertAudioSpanClips([
      { assetId: 'music', startSec: 0, inPointSec: 0, outPointSec: 2, speed: 1 },
      { assetId: 'music', startSec: 2, inPointSec: 2, outPointSec: 5, speed: 1.5 },
    ], { trackName: 'Music & SFX' })

    const inserted = st().timeline.clips.filter((c) => ids.includes(c.id))
    expect(inserted).toHaveLength(2)
    expect(inserted.map((c) => [c.startSec, c.inPointSec, c.outPointSec, c.speed])).toEqual([
      [0, 0, 2, 1],
      [2, 2, 5, 1.5],
    ])
    expect(inserted.every((c) => c.volume === 1 && !c.muted)).toBe(true)
    const track = st().timeline.tracks.find((t) => t.id === inserted[0]!.trackId)
    expect(track?.name).toBe('Music & SFX')
  })
})

describe('separation on a split video clip', () => {
  it('mutes only the separated part and leaves later siblings audible', () => {
    st().replaceTimeline([
      clip({ id: 'part-1', startSec: 0, inPointSec: 0, outPointSec: 1 }),
      clip({ id: 'part-2', startSec: 1, inPointSec: 1, outPointSec: 2 }),
      clip({ id: 'part-3', startSec: 2, inPointSec: 2, outPointSec: 5 }),
    ], tracks, 30, 5)

    st().addSeparatedStems('part-1', {
      vocalsAssetId: 'stem-vocals',
      musicAssetId: 'stem-music',
    })

    const timeline = st().timeline
    expect(timeline.clips.find((item) => item.id === 'part-1')?.muted).toBe(true)
    expect(timeline.clips.find((item) => item.id === 'part-2')?.muted).toBeFalsy()
    expect(timeline.clips.find((item) => item.id === 'part-3')?.muted).toBeFalsy()
    const stems = timeline.clips.filter((item) => item.assetId?.startsWith('stem-'))
    expect(stems).toHaveLength(2)
    expect(stems.every((item) => (
      item.startSec === 0 && item.inPointSec === 0 && item.outPointSec === 1
    ))).toBe(true)
  })
})

describe('detach audio on one split video clip', () => {
  it('mutes only that part and keeps later same-asset siblings audible', () => {
    st().replaceTimeline([
      clip({ id: 'part-1', assetId: 'source', startSec: 0, inPointSec: 0, outPointSec: 1 }),
      clip({ id: 'part-2', assetId: 'source', startSec: 1, inPointSec: 1, outPointSec: 2 }),
      clip({ id: 'part-3', assetId: 'source', startSec: 2, inPointSec: 2, outPointSec: 5 }),
    ], tracks, 30, 5)

    st().detachAudios(['part-1'])

    const timeline = st().timeline
    expect(timeline.clips.find((item) => item.id === 'part-1')?.muted).toBe(true)
    expect(timeline.clips.find((item) => item.id === 'part-2')?.muted).toBeFalsy()
    expect(timeline.clips.find((item) => item.id === 'part-3')?.muted).toBeFalsy()
    const detached = timeline.clips.find((item) => item.detachedFromClipId === 'part-1')
    expect(detached).toMatchObject({
      assetId: 'source', startSec: 0, inPointSec: 0, outPointSec: 1,
    })
    expect(detached?.muted).toBeFalsy()
  })
})

describe('clip drag commit', () => {
  it('does not re-track existing overlaps after a plain click with no movement', () => {
    const captionTrack: Track = {
      id: 't1', kind: 'text', name: 'Captions', muted: false, locked: false,
    }
    const firstTextData = makeSubtitleTextData('first')
    const secondTextData = makeSubtitleTextData('second')
    st().replaceTimeline([
      clip({
        id: 'cap1', trackId: 't1', assetId: null, startSec: 0,
        inPointSec: 0, outPointSec: 1.001, textData: firstTextData,
      }),
      clip({
        id: 'cap2', trackId: 't1', assetId: null, startSec: 1,
        inPointSec: 0, outPointSec: 1, textData: secondTextData,
      }),
    ], [captionTrack], 30, 2)

    // TimelineClip starts this potential drag on pointer-down even for a click.
    st().beginClipDrag(['cap1', 'cap2'], 't1')
    st().commitClipDrag()

    expect(st().timeline.tracks).toEqual([captionTrack])
    expect(st().timeline.clips.map((item) => item.trackId)).toEqual(['t1', 't1'])
    expect(st().timeline.clips[0]!.textData).toBe(firstTextData)
    expect(st().canUndo).toBe(false)
    expect(st().draggingIds).toEqual([])
  })
})

describe('history semantics for live setters (TASK: slider spam / undo gaps)', () => {
  it('no-op live setters preserve state, timeline, and clips references', () => {
    const before = st()
    before.setClipOpacity('c1', 1)
    expect(st()).toBe(before)
    before.setClipVolume('c1', 1)
    expect(st()).toBe(before)
    before.setClipAdjust('c1', { brightness: 0 })
    expect(st()).toBe(before)
  })

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

  it('speed stretch changes speed from the requested timeline duration', () => {
    st().beginHistoryStep()
    st().setClipSpeedDuration('c1', 1, 10)
    expect(firstClip().startSec).toBeCloseTo(1)
    expect(firstClip().speed).toBeCloseTo(0.5)
    expect(clipEffectiveDuration(firstClip())).toBeCloseTo(10)
    st().undo()
    expect(firstClip().startSec).toBeCloseTo(0)
    expect(firstClip().speed).toBeCloseTo(1)
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

describe('history playback parity (U1)', () => {
  it('keeps playback running and reschedules audio on undo and redo', () => {
    st().beginHistoryStep()
    st().setClipVolume('c1', 0.25)
    usePlaybackStore.setState({ isPlaying: true, currentSec: 2 })
    const beforeUndo = usePlaybackStore.getState().seekNonce

    st().undo()
    expect(usePlaybackStore.getState().isPlaying).toBe(true)
    expect(usePlaybackStore.getState().currentSec).toBe(2)
    expect(usePlaybackStore.getState().seekNonce).toBe(beforeUndo + 1)

    st().redo()
    expect(usePlaybackStore.getState().isPlaying).toBe(true)
    expect(usePlaybackStore.getState().seekNonce).toBe(beforeUndo + 2)
  })
})

describe('AI caption correction transaction', () => {
  it('applies distinct content atomically, reconciles word timing, and undoes once', () => {
    const textTracks: Track[] = [
      { id: 't1', kind: 'text', name: 'Captions', muted: false, locked: false },
    ]
    const textData = makeSubtitleTextData('helo word', [
      { word: 'helo', startSec: 0, endSec: 0.8 },
      { word: 'word', startSec: 0.8, endSec: 1.6 },
    ])
    st().replaceTimeline([
      clip({ id: 'cap1', trackId: 't1', assetId: null, outPointSec: 2, textData }),
    ], textTracks, 30, 2)

    expect(st().applyCaptionCorrections({ cap1: 'Hello world.' })).toBe(1)
    expect(firstClip().textData?.content).toBe('Hello world.')
    expect(firstClip().textData?.wordTimestamps?.map((word) => word.word)).toEqual([
      'Hello', 'world.',
    ])
    expect(st().canUndo).toBe(true)

    st().undo()
    expect(firstClip().textData?.content).toBe('helo word')
  })

  it('does not create history for unchanged or unknown corrections', () => {
    expect(st().applyCaptionCorrections({ missing: 'anything' })).toBe(0)
    expect(st().canUndo).toBe(false)
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

  it('delete/ripple never removes or moves overlapping audio', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'B', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'audioA', trackId: 'a1', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'audioB', trackId: 'a1', startSec: 2, inPointSec: 0, outPointSec: 2 }),
      ],
      [
        ...magTracks,
        { id: 'a1', kind: 'audio', name: 'A1', muted: false, locked: false },
      ],
      30,
      4,
    )

    st().removeClips(['A'])

    expect(startOf('B')).toBeCloseTo(0)
    expect(startOf('audioA')).toBeCloseTo(0)
    expect(startOf('audioB')).toBeCloseTo(2)
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

  it('insertSubtitles: slightly overlapping ASR cues are clamped onto ONE text track', () => {
    st().replaceTimeline(
      [],
      [{ id: 't1', kind: 'text', name: 'T1', muted: false, locked: false }], 30, 10,
    )
    // Min-duration padding upstream (mapCuesToTimeline) makes short cues spill
    // slightly into the next one; these must NOT be bumped to a second track.
    st().insertSubtitles([
      { content: '一句', startSec: 0, durationSec: 1.0 },
      { content: '两句', startSec: 0.9, durationSec: 1.0 }, // overlaps prev by 0.1
      { content: '三句', startSec: 1.85, durationSec: 1.0 }, // overlaps prev by 0.05
    ])
    const tl = st().timeline
    expect(tl.tracks.filter((t) => t.kind === 'text').length).toBe(1)
    const caps = tl.clips
      .filter((c) => c.textData)
      .sort((a, b) => a.startSec - b.startSec)
    expect(caps).toHaveLength(3)
    expect(caps.every((c) => c.trackId === 't1')).toBe(true)
    // Earlier cue ends were trimmed to the next cue's start.
    expect(caps[0]!.startSec + caps[0]!.outPointSec).toBeCloseTo(0.9)
    expect(caps[1]!.startSec + caps[1]!.outPointSec).toBeCloseTo(1.85)
  })

  it('insertAudioClips without volume defaults to 1 (never undefined/NaN)', () => {
    // volume: undefined used to OVERRIDE makeClip's default via spread, then
    // crash WebAudio (`AudioParam.value = NaN`) and silence the whole timeline.
    const ids = st().insertAudioClips([{ assetId: 'a1', startSec: 0, durationSec: 2 }])
    const inserted = st().timeline.clips.find((c) => c.id === ids[0])!
    expect(inserted.volume).toBe(1)
    expect(Number.isFinite(inserted.speed)).toBe(true)
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

describe('splitClipEveryNSeconds (anti-bloat cap)', () => {
  it('rejects with -1 and creates NO clips when the cut count exceeds the cap', () => {
    // 600s clip, N=0.1 ⇒ ~6000 segments > 2000 cap.
    st().replaceTimeline([clip({ outPointSec: 600 })], tracks, 30, 600)
    const result = st().splitClipEveryNSeconds('c1', 0.1)
    expect(result).toBe(-1)
    expect(st().timeline.clips).toHaveLength(1) // untouched
    expect(st().canUndo).toBe(false) // never pushed history
  })

  it('splits evenly when under the cap', () => {
    st().replaceTimeline([clip({ outPointSec: 600 })], tracks, 30, 600)
    const result = st().splitClipEveryNSeconds('c1', 5) // 120 cuts
    expect(result).toBeGreaterThan(0)
    expect(st().timeline.clips).toHaveLength(result + 1)
  })

  it('returns 0 for a clip too short to split', () => {
    expect(st().splitClipEveryNSeconds('c1', 10)).toBe(0) // 5s clip, N=10
    expect(st().timeline.clips).toHaveLength(1)
  })
})

describe('multi-track drag keeps one clip per row', () => {
  const audioTracks: Track[] = [
    { id: 'a1', kind: 'audio', name: 'A1', muted: false, locked: false },
    { id: 'a2', kind: 'audio', name: 'A2', muted: false, locked: false },
  ]
  const byId = (id: string) => st().timeline.clips.find((c) => c.id === id)!

  /** No two clips on the SAME track may overlap in time. */
  function expectNoSameTrackOverlap() {
    const cs = st().timeline.clips
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i]!
        const b = cs[j]!
        if (a.trackId !== b.trackId) continue
        const aEnd = a.startSec + clipEffectiveDuration(a)
        const bEnd = b.startSec + clipEffectiveDuration(b)
        expect(a.startSec < bEnd && b.startSec < aEnd).toBe(false)
      }
    }
  }

  beforeEach(() => {
    useUIStore.setState({ magneticMainTrack: false, linkEnabled: false })
  })

  it('horizontal drag of a 2-track selection does NOT collapse onto one row', () => {
    st().replaceTimeline(
      [
        clip({ id: 'X', trackId: 'a1', assetId: 'ax', startSec: 2, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'Y', trackId: 'a2', assetId: 'ay', startSec: 2, inPointSec: 0, outPointSec: 2 }),
      ],
      audioTracks, 30, 4,
    )
    st().beginClipDrag(['X', 'Y'], 'a1')
    st().setClipDragDelta(1)
    st().setClipDragTargetTrack('a1') // cursor stays over the anchor's own row
    st().commitClipDrag()

    expect(byId('X').trackId).toBe('a1')
    expect(byId('Y').trackId).toBe('a2') // did NOT collapse onto a1
    expect(byId('X').startSec).toBe(3)
    expect(byId('Y').startSec).toBe(3)
    expectNoSameTrackOverlap()
  })

  it('overlapping clips forced onto the same row get bumped apart', () => {
    st().replaceTimeline(
      [
        clip({ id: 'X', trackId: 'a1', assetId: 'ax', startSec: 0, inPointSec: 0, outPointSec: 2 }),
        clip({ id: 'Y', trackId: 'a2', assetId: 'ay', startSec: 0, inPointSec: 0, outPointSec: 2 }),
      ],
      audioTracks, 30, 2,
    )
    // Drag both down a row → both prefer a2; their time-overlap must split them.
    st().beginClipDrag(['X', 'Y'], 'a1')
    st().setClipDragDelta(0)
    st().setClipDragTargetTrack('a2')
    st().commitClipDrag()

    expect(byId('X').trackId).not.toBe(byId('Y').trackId)
    expectNoSameTrackOverlap()
  })
})

describe('clip groups (select / move / delete together)', () => {
  beforeEach(() => {
    st().replaceTimeline(
      [clip({ id: 'c1' }), clip({ id: 'c2', startSec: 5 }), clip({ id: 'c3', startSec: 10 })],
      tracks,
      30,
      15,
    )
  })
  const gid = (id: string) => st().timeline.clips.find((c) => c.id === id)!.groupId

  it('groupClips assigns a shared groupId and selects the members', () => {
    st().groupClips(['c1', 'c2'])
    expect(gid('c1')).toBeTruthy()
    expect(gid('c2')).toBe(gid('c1'))
    expect(gid('c3')).toBeUndefined()
    expect([...st().selectedClipIds].sort()).toEqual(['c1', 'c2'])
  })

  it('selecting one grouped clip expands selection to the whole group', () => {
    st().groupClips(['c1', 'c2'])
    st().selectClips(['c1'])
    expect([...st().selectedClipIds].sort()).toEqual(['c1', 'c2'])
    // An ungrouped clip still selects alone.
    st().selectClips(['c3'])
    expect(st().selectedClipIds).toEqual(['c3'])
  })

  it('groupClips needs at least two clips', () => {
    st().groupClips(['c1'])
    expect(gid('c1')).toBeUndefined()
  })

  it('ungroupClips clears the group for every member, and is undoable', () => {
    st().groupClips(['c1', 'c2'])
    st().ungroupClips(['c1'])
    expect(gid('c1')).toBeUndefined()
    expect(gid('c2')).toBeUndefined()
    st().undo() // back to grouped
    expect(gid('c1')).toBeTruthy()
  })
})

describe('compound clips (nested sub-timeline)', () => {
  beforeEach(() => {
    useUIStore.setState({ magneticMainTrack: false, linkEnabled: true })
    st().replaceTimeline(
      [clip({ id: 'c1' }), clip({ id: 'c2', startSec: 5 }), clip({ id: 'c3', startSec: 10 })],
      tracks,
      30,
      15,
    )
  })

  it('createCompound gathers clips into one compound clip + a sub-timeline', () => {
    st().createCompound(['c2', 'c3'])
    const tl = st().timeline
    expect(tl.clips.find((c) => c.id === 'c2')).toBeUndefined()
    expect(tl.clips.find((c) => c.id === 'c3')).toBeUndefined()
    const comp = tl.clips.find((c) => c.compoundId)!
    expect(comp).toBeTruthy()
    expect(comp.assetId).toBeNull()
    expect(comp.startSec).toBe(5) // earliest member's start
    // sub-timeline registered, clips re-based to start at 0
    const reg = st().compounds[comp.compoundId!]!
    expect(reg.timeline.clips.map((c) => c.startSec).sort((a, b) => a - b)).toEqual([0, 5])
    expect(comp.outPointSec).toBeCloseTo(reg.timeline.durationSec)
    expect(st().selectedClipIds).toEqual([comp.id])
  })

  it('enter / edit / exit round-trips and refreshes the compound length', () => {
    st().createCompound(['c2', 'c3'])
    const cid = st().timeline.clips.find((c) => c.compoundId)!.compoundId!
    st().enterCompound(cid)
    expect(st().compoundStack.length).toBe(1)
    expect(st().timeline.clips.length).toBe(2) // editing the sub-timeline now
    const subIds = st().timeline.clips.map((c) => c.id)
    st().removeClips([subIds[1]!])
    const newDur = st().timeline.durationSec
    st().exitCompound()
    expect(st().compoundStack.length).toBe(0)
    const comp = st().timeline.clips.find((c) => c.compoundId)!
    expect(comp.outPointSec).toBeCloseTo(newDur) // parent clip length follows edits
    expect(st().compounds[cid]!.timeline.clips.length).toBe(1) // registry updated
  })

  it('flatTimeline expands a compound back into its repositioned contents', () => {
    st().createCompound(['c2', 'c3'])
    const flat = st().flatTimeline()
    expect(flat.clips.some((c) => c.compoundId)).toBe(false) // no compound clips remain
    expect(flat.clips.length).toBe(3) // c1 + the 2 expanded contents
    expect(flat.clips.map((c) => c.startSec).sort((a, b) => a - b)).toEqual([0, 5, 10])
  })

  it('breakCompound replaces a compound with baked child clips', () => {
    st().createCompound(['c2', 'c3'])
    const comp = st().timeline.clips.find((c) => c.compoundId)!
    const compoundId = comp.compoundId!
    st().setClipTransform(comp.id, { x: 0.6, scale: 2 })

    st().breakCompound([comp.id])

    expect(st().timeline.clips.some((c) => c.compoundId)).toBe(false)
    expect(st().timeline.clips).toHaveLength(3)
    expect(st().timeline.clips.map((c) => c.startSec).sort((a, b) => a - b)).toEqual([0, 5, 10])
    const children = st().timeline.clips.filter((c) => c.id.startsWith(`${comp.id}::`))
    expect(children).toHaveLength(2)
    expect(st().selectedClipIds).toEqual(children.map((c) => c.id))
    expect(children[0]!.transform.x).toBeCloseTo(0.6)
    expect(children[0]!.transform.scale).toBeCloseTo(2)
    expect(st().compounds[compoundId]).toBeUndefined()
  })

  it('rootSnapshot returns the ROOT timeline while editing inside a compound', () => {
    st().createCompound(['c2', 'c3'])
    const cid = st().timeline.clips.find((c) => c.compoundId)!.compoundId!
    const rootClipCount = st().timeline.clips.length // c1 + the compound clip
    st().enterCompound(cid)
    const snap = st().rootSnapshot()
    expect(snap.timeline.clips.length).toBe(rootClipCount) // root, not the sub-timeline
    expect(snap.compounds[cid]!.timeline.clips.length).toBe(2) // live sub flushed in
  })
})

describe('keyframes', () => {
  beforeEach(() => {
    useUIStore.setState({ magneticMainTrack: false, linkEnabled: true })
    st().replaceTimeline([clip({ id: 'c1', startSec: 2 })], tracks, 30, 10)
  })

  it('toggleKeyframes adds then removes a keyframe at the playhead (clip-local time)', () => {
    st().toggleKeyframes('c1', ['x'], 2) // playhead at clip start → local 0
    expect(firstClip().keyframes?.x?.length).toBe(1)
    expect(firstClip().keyframes!.x![0]!.t).toBeCloseTo(0)
    st().toggleKeyframes('c1', ['x'], 2) // same time → removes
    expect(firstClip().keyframes?.x).toBeUndefined()
  })

  it('setClipTransformKeyed sets the static field when not animated, else keyframes', () => {
    st().beginHistoryStep()
    st().setClipTransformKeyed('c1', { x: 0.3 }, 2)
    expect(firstClip().transform.x).toBeCloseTo(0.3)
    expect(firstClip().keyframes?.x).toBeUndefined()

    st().toggleKeyframes('c1', ['x'], 2) // animate x (captures 0.3 at local 0)
    st().setClipTransformKeyed('c1', { x: 0.8 }, 6) // local 4 → second keyframe
    const x = firstClip().keyframes?.x
    expect(x?.length).toBe(2)
    expect(x![1]!.v).toBeCloseTo(0.8)
  })
})

describe('sync multi-edit (plural live setters)', () => {
  beforeEach(() => {
    st().replaceTimeline([clip({ id: 'c1' }), clip({ id: 'c2', startSec: 5 })], tracks, 30, 10)
  })

  it('apply the same value to every id and push NO history of their own', () => {
    st().setClipsOpacity(['c1', 'c2'], 0.5)
    st().setClipsAdjust(['c1', 'c2'], { brightness: 20 })
    st().setClipsVolume(['c1', 'c2'], 0.3)
    for (const id of ['c1', 'c2']) {
      const c = st().timeline.clips.find((x) => x.id === id)!
      expect(c.opacity).toBeCloseTo(0.5)
      expect(c.adjust.brightness).toBe(20)
      expect(c.volume).toBeCloseTo(0.3)
    }
    expect(st().canUndo).toBe(false)
  })
})

describe('compound registry survives undo/redo (P1: break → undo lost registry)', () => {
  beforeEach(() => {
    st().replaceTimeline([clip({ id: 'c1' }), clip({ id: 'c2', startSec: 5 })], tracks, 30, 10)
  })

  const compoundClip = () => st().timeline.clips.find((c) => c.compoundId)

  it('break → undo restores BOTH the compound clip and its registry entry', () => {
    st().createCompound(['c1', 'c2'])
    const made = compoundClip()
    expect(made?.compoundId).toBeTruthy()
    const compoundId = made!.compoundId!
    expect(st().compounds[compoundId]).toBeTruthy()

    st().breakCompound([made!.id])
    expect(compoundClip()).toBeUndefined()
    expect(st().compounds[compoundId]).toBeUndefined()

    st().undo()
    // The clip is back — and so is the registry entry it points at.
    const restored = compoundClip()
    expect(restored?.compoundId).toBe(compoundId)
    expect(st().compounds[compoundId]).toBeTruthy()
    // flatTimeline can actually expand it (this was empty before the fix).
    expect(st().flatTimeline().clips.length).toBeGreaterThan(0)
  })

  it('undo → redo drops the registry entry again, consistently with the clip', () => {
    st().createCompound(['c1', 'c2'])
    const compoundId = compoundClip()!.compoundId!
    st().breakCompound([compoundClip()!.id])
    st().undo()
    expect(st().compounds[compoundId]).toBeTruthy()

    st().redo()
    expect(compoundClip()).toBeUndefined()
    expect(st().compounds[compoundId]).toBeUndefined()
  })

  it('create → undo removes the registry entry with the clip', () => {
    st().createCompound(['c1', 'c2'])
    const compoundId = compoundClip()!.compoundId!
    st().undo()
    expect(compoundClip()).toBeUndefined()
    expect(st().compounds[compoundId]).toBeUndefined()
  })
})

describe('caption sync on clip speed change', () => {
  const speedTracks: Track[] = [
    { id: 't1', kind: 'text', name: 'T1', muted: false, locked: false },
    { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false },
  ]
  const capOf = (id: string) => st().timeline.clips.find((c) => c.id === id)!

  it('speeding up a clip rescales its linked captions (position, duration, words)', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 8 }),
        clip({
          id: 'cap', trackId: 't1', assetId: undefined, startSec: 2, inPointSec: 0, outPointSec: 1,
          textData: makeSubtitleTextData('xin chao', [
            { word: 'xin', startSec: 0, endSec: 0.4 },
            { word: 'chao', startSec: 0.4, endSec: 1 },
          ]),
        } as unknown as Partial<Clip>),
      ],
      speedTracks, 30, 8,
    )
    st().setClipSpeed('A', 2)
    const cap = capOf('cap')
    expect(cap.startSec).toBeCloseTo(1) // same SOURCE moment: 2s × (1/2)
    expect(clipEffectiveDuration(cap)).toBeCloseTo(0.5)
    expect(cap.textData!.wordTimestamps![0]!.endSec).toBeCloseTo(0.2)
    expect(cap.textData!.wordTimestamps![1]!.endSec).toBeCloseTo(0.5)
  })

  it('leaves audio independent when the video and caption speed changes', () => {
    const audioTracks: Track[] = [
      ...speedTracks,
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, locked: false },
    ]
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 8 }),
        clip({
          id: 'cap', trackId: 't1', assetId: null, startSec: 2, inPointSec: 0, outPointSec: 1,
          textData: makeSubtitleTextData('xin chao'),
        } as unknown as Partial<Clip>),
        clip({
          id: 'voice', trackId: 'a1', assetId: 'voice-wav', kind: 'audio', startSec: 2,
          inPointSec: 0, outPointSec: 1, syncToClipId: 'cap',
        } as unknown as Partial<Clip>),
      ],
      audioTracks, 30, 8,
    )

    st().setClipSpeed('A', 2)

    const voice = capOf('voice')
    expect(voice.startSec).toBeCloseTo(2)
    expect(voice.speed).toBeCloseTo(1)
    expect(clipEffectiveDuration(voice)).toBeCloseTo(1)
  })

  it('slowing down stretches captions; unrelated/unlinked captions stay put', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 4 }),
        clip({
          id: 'inside', trackId: 't1', assetId: undefined, startSec: 1, inPointSec: 0, outPointSec: 1,
          textData: makeSubtitleTextData('trong clip'),
        } as unknown as Partial<Clip>),
        clip({
          id: 'outside', trackId: 't1', assetId: undefined, startSec: 6, inPointSec: 0, outPointSec: 1,
          textData: makeSubtitleTextData('ngoai clip'),
        } as unknown as Partial<Clip>),
      ],
      speedTracks, 30, 8,
    )
    st().setClipSpeed('A', 0.5)
    expect(capOf('inside').startSec).toBeCloseTo(2)
    expect(clipEffectiveDuration(capOf('inside'))).toBeCloseTo(2)
    expect(capOf('outside').startSec).toBeCloseTo(6) // not riding A → untouched

    // Link disabled → captions never move with speed.
    useUIStore.setState({ linkEnabled: false })
    st().setClipSpeed('A', 1)
    expect(capOf('inside').startSec).toBeCloseTo(2)
    useUIStore.setState({ linkEnabled: true })
  })

  it('magnetic main track re-packs later clips and their captions after a speed-up', () => {
    useUIStore.setState({ magneticMainTrack: true, linkEnabled: true })
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 4 }),
        clip({ id: 'B', trackId: 'v1', startSec: 4, inPointSec: 0, outPointSec: 4 }),
        clip({
          id: 'capB', trackId: 't1', assetId: undefined, startSec: 5, inPointSec: 0, outPointSec: 1,
          textData: makeSubtitleTextData('cua B'),
        } as unknown as Partial<Clip>),
      ],
      speedTracks, 30, 8,
    )
    st().setClipSpeed('A', 2) // A: 4s → 2s on track
    expect(st().timeline.clips.find((c) => c.id === 'B')!.startSec).toBeCloseTo(2)
    expect(capOf('capB').startSec).toBeCloseTo(3) // rides B, shifted with it
    useUIStore.setState({ magneticMainTrack: false })
  })

  it('setClipSpeedDuration anchors captions when the clip start moves too', () => {
    st().replaceTimeline(
      [
        clip({ id: 'A', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 4 }),
        clip({
          id: 'cap', trackId: 't1', assetId: undefined, startSec: 2, inPointSec: 0, outPointSec: 1,
          textData: makeSubtitleTextData('neo'),
        } as unknown as Partial<Clip>),
      ],
      speedTracks, 30, 8,
    )
    st().setClipSpeedDuration('A', 1, 8) // start → 1, speed → 0.5
    const cap = capOf('cap')
    expect(cap.startSec).toBeCloseTo(5) // 1 + (2-0) × 2
    expect(clipEffectiveDuration(cap)).toBeCloseTo(2)
  })
})
