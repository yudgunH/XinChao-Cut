import { describe, it, expect } from 'vitest'

import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

import {
  buildExportSpec,
  usedAssetIds,
  serverExportGaps,
  serverExportStrictGaps,
} from './spec'

const settings = { width: 1920, height: 1080, fps: 30, videoBitrateKbps: 8000 }

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1', trackId: 'v1', assetId: 'asset-1', kind: 'video',
    startSec: 0, inPointSec: 0, outPointSec: 5, speed: 1,
    opacity: 1, volume: 1,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: { scale: 1, scaleX: 1, scaleY: 1, x: 0.5, y: 0.5, rotation: 0 },
    effects: [],
    ...over,
  } as Clip
}

const tracks: Track[] = [{ id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked: false }]

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1', kind: 'video', name: 'clip.mp4', mimeType: 'video/mp4',
    sizeBytes: 1000, durationSec: 5, storageKey: 'k', createdAt: 0,
    ...over,
  }
}

describe('usedAssetIds', () => {
  it('dedupes and drops null asset ids', () => {
    const ids = usedAssetIds([
      clip({ id: 'a', assetId: 'x' }),
      clip({ id: 'b', assetId: 'x' }),
      clip({ id: 'c', assetId: null as unknown as string }),
      clip({ id: 'd', assetId: 'y' }),
    ])
    expect(ids.sort()).toEqual(['x', 'y'])
  })
})

describe('serverExportGaps', () => {
  it('is empty for a plain clip and for FFmpeg-supported effects', () => {
    expect(serverExportGaps([clip()])).toEqual([])
    expect(serverExportGaps([clip({
      effects: [{ id: 'e', type: 'fade-in', params: { duration: 0.5 } },
                { id: 'z', type: 'zoom-in', params: { amount: 0.2 } }],
    })])).toEqual([])
  })

  it('does NOT flag keyframes — the FFmpeg builder renders them all', () => {
    expect(serverExportGaps([clip({ keyframes: { x: [{ t: 0, v: 0.5 }, { t: 1, v: 0.7 }] } })]))
      .toEqual([])
    expect(serverExportGaps([clip({ keyframes: { scale: [{ t: 0, v: 1 }, { t: 1, v: 2 }] } })]))
      .toEqual([])
    // opacity keyframes are rendered via geq on the alpha plane
    expect(serverExportGaps([clip({ keyframes: { opacity: [{ t: 0, v: 1 }, { t: 1, v: 0 }] } })]))
      .toEqual([])
  })

  it('keeps plain / static-styled / faded captions on the server', () => {
    const textClip = (over = {}) => clip({
      assetId: null as unknown as string, trackId: 't',
      textData: { content: 'hi' }, ...over,
    } as Partial<Clip>)
    // plain caption
    expect(serverExportGaps([textClip()])).toEqual([])
    // fade-in/out effects are reproduced by libass
    expect(serverExportGaps([textClip({
      effects: [{ id: 'f', type: 'fade-in', params: { duration: 0.5 } }],
    })])).toEqual([])
  })

  it('routes transformed / animated text to the browser', () => {
    const textClip = (over = {}) => clip({
      assetId: null as unknown as string, trackId: 't',
      textData: { content: 'hi' }, ...over,
    } as Partial<Clip>)
    expect(serverExportGaps([textClip({
      transform: { scale: 1.5, scaleX: 1, scaleY: 1, x: 0.5, y: 0.5, rotation: 0 },
    })])).toEqual(['text-animation'])
    expect(serverExportGaps([textClip({
      keyframes: { opacity: [{ t: 0, v: 1 }, { t: 1, v: 0 }] },
    })])).toEqual(['text-animation'])
    expect(serverExportGaps([textClip({
      effects: [{ id: 'z', type: 'zoom-in', params: { amount: 0.2 } }],
    })])).toEqual(['text-animation'])
  })

  it('flags dense keyframe tracks that would overflow the FFmpeg expression', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i, v: i }))
    expect(serverExportGaps([clip({ keyframes: { scale: many(48) } })])).toEqual([])
    expect(serverExportGaps([clip({ keyframes: { scale: many(100) } })])).toEqual(['dense-keyframes'])
    expect(serverExportGaps([clip({ keyframes: { opacity: many(40) } })])).toEqual(['dense-keyframes'])
  })

  it('flags motion effects the FFmpeg path does not reproduce', () => {
    const gaps = serverExportGaps([clip({
      effects: [{ id: 'p', type: 'pan-left', params: { amount: 0.3 } },
                { id: 'u', type: 'pulse', params: { amount: 0.3 } }],
    })])
    expect(gaps.sort()).toEqual(['effect:pan-left', 'effect:pulse'])
  })
})

describe('strict preview-parity contract', () => {
  const cases: Array<[string, Partial<Clip>, string]> = [
    ['captions', { textData: { content: 'caption' } as Clip['textData'] }, 'captions'],
    ['fx overlays', { assetId: null, fxData: {
      type: 'blur-sticker', x: 0.5, y: 0.5, w: 0.2, h: 0.2, blurPx: 12, radius: 4,
    } }, 'fx'],
    ['blur fill', { canvasFill: { mode: 'blur', blurPx: 24 } }, 'blur-fill'],
    ['colour adjustment', {
      adjust: { brightness: 0.1, contrast: 0, saturation: 0 },
    }, 'adjust'],
    ['effects', {
      effects: [{ id: 'fade', type: 'fade-in', params: { duration: 0.5 } }],
    }, 'effects'],
    ['opacity', { opacity: 0.5 }, 'opacity'],
    ['keyframes', {
      keyframes: { x: [{ t: 0, v: 0.5 }, { t: 1, v: 0.7 }] },
    }, 'keyframes'],
    ['transform', {
      transform: { scale: 1.2, scaleX: 1, scaleY: 1, x: 0.5, y: 0.5, rotation: 0 },
    }, 'transform'],
  ]

  it.each(cases)('routes %s through the preview renderer', (_name, patch, token) => {
    expect(serverExportStrictGaps([clip(patch)])).toContain(token)
  })

  it('allows only a visually neutral trim/transcode clip on strict Server', () => {
    expect(serverExportStrictGaps([clip()])).toEqual([])
  })
})

describe('buildExportSpec', () => {
  it('maps settings + substitutes the server content hash for the asset id', () => {
    const hashes = new Map([['asset-1', 'HASH123']])
    const spec = buildExportSpec(settings, 5, [clip()], tracks, [asset()], hashes)
    expect(spec).toMatchObject({ width: 1920, height: 1080, fps: 30, durationSec: 5 })
    expect(spec.clips[0]!.assetId).toBe('HASH123')
    expect(spec.tracks[0]).toEqual({ id: 'v1', kind: 'video', muted: false, hidden: false })
  })

  it('marks kind=text for text clips regardless of asset', () => {
    const textClip = clip({ assetId: null as unknown as string, textData: { content: 'Hi' } } as unknown as Partial<Clip>)
    const spec = buildExportSpec(settings, 5, [textClip], tracks, [], new Map())
    expect(spec.clips[0]!.kind).toBe('text')
    expect(spec.clips[0]!.assetId).toBeNull()
  })

  it('marks blur sticker clips as fx with no asset', () => {
    const fxClip = clip({
      assetId: null,
      trackId: 'fx1',
      fxData: { type: 'blur-sticker', x: 0.5, y: 0.5, w: 0.25, h: 0.2, blurPx: 18, radius: 8 },
    })
    const spec = buildExportSpec(
      settings,
      5,
      [fxClip],
      [{ id: 'fx1', kind: 'fx', name: 'FX 1', muted: false, locked: false }],
      [],
      new Map(),
    )
    expect(spec.clips[0]!.kind).toBe('fx')
    expect(spec.clips[0]!.assetId).toBeNull()
    expect(spec.clips[0]!.fxData).toMatchObject({ type: 'blur-sticker', blurPx: 18 })
  })

  it('serializes a detached video asset on an audio track as audio', () => {
    const audioTrack: Track = {
      id: 'a1', kind: 'audio', name: 'Detached audio', muted: false, locked: false,
    }
    const detached = clip({ id: 'detached', trackId: 'a1', detachedFromClipId: 'part-1' })
    const spec = buildExportSpec(
      settings,
      5,
      [detached],
      [audioTrack],
      [asset({ waveformPeaks: [0.1, 0.2] })],
      new Map([['asset-1', 'H']]),
    )

    expect(spec.clips[0]!.kind).toBe('audio')
    expect(spec.clips[0]!.assetId).toBe('H')
    expect(spec.clips[0]!.hasAudio).toBe(true)
    expect(spec.clips[0]!.detachedFromClipId).toBe('part-1')
  })

  it('hasAudio is false for a video whose waveform is just the sentinel', () => {
    const hashes = new Map([['asset-1', 'H']])
    const noAudio = buildExportSpec(settings, 5, [clip()], tracks,
      [asset({ waveformPeaks: [0] })], hashes)
    expect(noAudio.clips[0]!.hasAudio).toBe(false)

    const withAudio = buildExportSpec(settings, 5, [clip()], tracks,
      [asset({ waveformPeaks: [0.1, 0.5, 0.2] })], hashes)
    expect(withAudio.clips[0]!.hasAudio).toBe(true)
  })

  it('muted clip never reports hasAudio', () => {
    const hashes = new Map([['asset-1', 'H']])
    const spec = buildExportSpec(settings, 5, [clip({ muted: true })], tracks,
      [asset({ waveformPeaks: [0.1, 0.5] })], hashes)
    expect(spec.clips[0]!.hasAudio).toBe(false)
  })

  it('keeps sourcePath so the backend can read desktop-imported media directly', () => {
    const hashes = new Map([['asset-1', 'local-asset-1']])
    const spec = buildExportSpec(settings, 5, [clip()], tracks,
      [asset({ sourcePath: 'C:\\media\\clip.mp4', storageKey: '' })], hashes)
    expect(spec.clips[0]!.assetId).toBe('local-asset-1')
    expect(spec.clips[0]!.sourcePath).toBe('C:\\media\\clip.mp4')
  })
})
