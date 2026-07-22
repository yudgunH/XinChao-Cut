import { describe, expect, it } from 'vitest'

import { makeDefaultTextData, makeSubtitleTextData, resolvedTextWordSpacing, type TextClipData } from './types'
import { drawKaraokeSweep, drawTextWithSpacing, getActiveWordIndex, measureTextWithSpacing, setTextSpacing } from './text-layout'

describe('karaoke word timing', () => {
  it('does not highlight the first word before speech starts', () => {
    expect(getActiveWordIndex(2, {
      elapsedSec: 0.2,
      clipDuration: 3,
      unit: 1,
      wordTimestamps: [
        { word: 'xin', startSec: 0.8, endSec: 1.1 },
        { word: 'chào', startSec: 1.2, endSec: 1.6 },
      ],
    })).toEqual({ index: -1, popScale: 1, active: false })
  })

  it('never returns an index outside the rendered word list', () => {
    const result = getActiveWordIndex(2, {
      elapsedSec: 9,
      clipDuration: 10,
      unit: 1,
      wordTimestamps: [
        { word: 'one', startSec: 0, endSec: 1 },
        { word: 'two', startSec: 1, endSec: 2 },
        { word: 'stale', startSec: 2, endSec: 3 },
      ],
    })
    expect(result.index).toBe(1)
    expect(result.active).toBe(false)
  })

  it('stops highlighting during a pause between words', () => {
    const reveal = {
      elapsedSec: 1.5,
      clipDuration: 3,
      unit: 1,
      wordTimestamps: [
        { word: 'xin', startSec: 0.8, endSec: 1.1 },
        { word: 'chao', startSec: 2, endSec: 2.4 },
      ],
    }
    expect(getActiveWordIndex(2, reveal)).toEqual({ index: 0, popScale: 1, active: false })
    expect(getActiveWordIndex(2, { ...reveal, elapsedSec: 2.1 }).active).toBe(true)
  })
})

describe('karaoke typography', () => {
  it('starts new text and captions at character 5 and word 0', () => {
    expect(makeDefaultTextData()).toMatchObject({ letterSpacing: 5, wordSpacing: 0 })
    expect(makeSubtitleTextData('caption')).toMatchObject({ letterSpacing: 5, wordSpacing: 0 })
  })

  it('keeps character tracking separate from word spacing', () => {
    const ctx = {
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as unknown as CanvasRenderingContext2D

    setTextSpacing(ctx, 4, 6)
    // "AB CD" has four character gaps plus one word separator.
    expect(measureTextWithSpacing(ctx, 'AB CD')).toBe(72)
  })

  it('paints individually tracked characters instead of stretching a word gap', () => {
    const fills: Array<{ text: string; x: number }> = []
    const ctx = {
      fillStyle: '#fff',
      textAlign: 'center',
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillText: (text: string, x: number) => fills.push({ text, x }),
      strokeText: () => undefined,
      save: () => undefined,
      restore: () => undefined,
    } as unknown as CanvasRenderingContext2D

    setTextSpacing(ctx, 4, 0)
    drawTextWithSpacing(ctx, 'AB CD', 0, 0)

    expect(fills.map((item) => item.text)).toEqual(['A', 'B', 'C', 'D'])
    expect(fills[1]!.x - fills[0]!.x).toBe(14)
    expect(fills[2]!.x - fills[1]!.x).toBe(28)
  })

  it('gives legacy animated captions stroke-aware word spacing', () => {
    const td = {
      fontSize: 48,
      stroke: { color: '#000000', width: 10 },
      anim: { kind: 'karaoke', groupSize: 3 },
    } as TextClipData

    expect(resolvedTextWordSpacing(td)).toBe(11)
    expect(resolvedTextWordSpacing({ ...td, wordSpacing: 14 })).toBe(14)
  })

  it('paints every word once and replaces the active word colour in place', () => {
    const strokes: string[] = []
    const fills: Array<{ text: string; color: string }> = []
    const scales: Array<[number, number]> = []
    const mockContext = {
      fillStyle: '#ffffff',
      textAlign: 'center',
      textBaseline: 'middle',
      font: 'bold 48px Bangers',
      letterSpacing: '0px',
      wordSpacing: '10px',
      measureText: (text: string) => ({ width: [...text].reduce((sum, char) => sum + (char === ' ' ? 16 : 10), 0) }),
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      scale: (x: number, y: number) => scales.push([x, y]),
      strokeText: (text: string) => strokes.push(text),
      fillText: (text: string) => fills.push({ text, color: String(mockContext.fillStyle) }),
    }
    const ctx = mockContext as unknown as CanvasRenderingContext2D

    drawKaraokeSweep(
      ctx,
      ['SPARE TIRE FOREVER'],
      48,
      'center',
      { unit: 3, elapsedSec: 0.2, clipDuration: 3 },
      '#ffd400',
      { color: '#000000', width: 10 },
    )

    expect(strokes).toEqual(['SPARE', 'TIRE', 'FOREVER'])
    expect(fills).toEqual([
      { text: 'SPARE', color: '#ffd400' },
      { text: 'TIRE', color: '#ffffff' },
      { text: 'FOREVER', color: '#ffffff' },
    ])
    expect(scales).toEqual([])
  })
})
