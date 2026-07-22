import { describe, expect, it } from 'vitest'

import { normalizeCaptionWordTimestamps, summarizeCaptionTimingQa, tokenizeCaptionText } from './caption-timing'

describe('caption timestamp repair', () => {
  it('expands an alignment-fallback sentence into real word timings', () => {
    const result = normalizeCaptionWordTimestamps(
      'Xin chao ban',
      [{ word: 'Xin chao ban', startSec: 1, endSec: 2.5 }],
      4,
    )
    expect(result.words.map((word) => word.word)).toEqual(['Xin', 'chao', 'ban'])
    expect(result.words.map((word) => [word.startSec, word.endSec])).toEqual([
      [1, 1.5],
      [1.5, 2],
      [2, 2.5],
    ])
    expect(result.issues).toContain('compound-timestamp')
  })

  it('uses caption text when timestamp words no longer match it', () => {
    const result = normalizeCaptionWordTimestamps(
      'correct grammar here',
      [{ word: 'wrong words', startSec: 0.5, endSec: 2 }],
      3,
    )
    expect(result.words.map((word) => word.word)).toEqual(['correct', 'grammar', 'here'])
    expect(result.words[0]!.startSec).toBe(0.5)
    expect(result.words.at(-1)!.endSec).toBe(2)
    expect(result.issues).toContain('text-timing-mismatch')
  })

  it('keeps corrected punctuation in word labels used by Server karaoke', () => {
    const result = normalizeCaptionWordTimestamps(
      'Hello world.',
      [
        { word: 'Hello', startSec: 0, endSec: 0.5 },
        { word: 'world', startSec: 0.5, endSec: 1 },
      ],
      1,
    )
    expect(result.words.map((word) => word.word)).toEqual(['Hello', 'world.'])
    expect(result.repaired).toBe(true)
  })

  it('preserves matched ASR timings when AI inserts a corrected word', () => {
    const result = normalizeCaptionWordTimestamps(
      'I really love this',
      [
        { word: 'I', startSec: 0, endSec: 0.2 },
        { word: 'love', startSec: 0.4, endSec: 0.8 },
        { word: 'this', startSec: 0.9, endSec: 1.2 },
      ],
      2,
    )
    expect(result.words[0]).toMatchObject({ word: 'I', startSec: 0, endSec: 0.2 })
    expect(result.words[2]).toMatchObject({ word: 'love', startSec: 0.4, endSec: 0.8 })
    expect(result.words[3]).toMatchObject({ word: 'this', startSec: 0.9, endSec: 1.2 })
    expect(result.words[1]).toMatchObject({ word: 'really', startSec: 0.2, endSec: 0.4 })
  })

  it('tokenizes unspaced CJK captions per character', () => {
    expect(tokenizeCaptionText('你好世界')).toEqual(['你', '好', '世', '界'])
  })

  it('reports repairable legacy caption timing without blocking export', () => {
    const summary = summarizeCaptionTimingQa([{
      id: 'caption-1', assetId: null, trackId: 'text-1', startSec: 0,
      inPointSec: 0, outPointSec: 3, speed: 1, opacity: 1, volume: 1,
      effects: [],
      transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
      adjust: { brightness: 0, contrast: 0, saturation: 0 },
      textData: {
        content: 'one two', fontSize: 48, color: '#fff', fontFamily: 'Inter',
        fontWeight: 'bold', align: 'center', x: 0.5, y: 0.8,
        hasBackground: false, backgroundColor: '#000',
        wordTimestamps: [{ word: 'one two', startSec: 0, endSec: 2 }],
      },
    }])
    expect(summary.repairedCount).toBe(1)
    expect(summary.blockingCount).toBe(0)
  })
})
