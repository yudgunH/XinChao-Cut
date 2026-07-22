import { describe, it, expect } from 'vitest'

import { buildSrt, parseSrt, dedupeSubtitleCues, type SubtitleCue } from './srt'

describe('buildSrt', () => {
  it('formats timecodes as HH:MM:SS,mmm and numbers cues', () => {
    const srt = buildSrt([
      { startSec: 0, endSec: 1.5, content: 'Hello' },
      { startSec: 2, endSec: 3.25, content: 'World' },
    ])
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nHello')
    expect(srt).toContain('2\n00:00:02,000 --> 00:00:03,250\nWorld')
    expect(srt.endsWith('\n')).toBe(true)
  })

  it('orders cues by start time and drops empty/zero-length ones', () => {
    const srt = buildSrt([
      { startSec: 5, endSec: 6, content: 'second' },
      { startSec: 1, endSec: 2, content: 'first' },
      { startSec: 3, endSec: 3, content: 'zero-length' }, // dropped
      { startSec: 4, endSec: 5, content: '   ' },          // dropped
    ])
    expect(srt.indexOf('first')).toBeLessThan(srt.indexOf('second'))
    expect(srt).not.toContain('zero-length')
  })
})

describe('parseSrt', () => {
  it('round-trips a built SRT', () => {
    const cues: SubtitleCue[] = [
      { startSec: 0, endSec: 1.5, content: 'Hello' },
      { startSec: 2, endSec: 3.25, content: 'World' },
    ]
    const parsed = parseSrt(buildSrt(cues))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ startSec: 0, endSec: 1.5, content: 'Hello' })
    expect(parsed[1]).toMatchObject({ startSec: 2, endSec: 3.25, content: 'World' })
  })

  it('accepts comma or dot millisecond separators and strips WEBVTT header', () => {
    const parsed = parseSrt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHi there')
    expect(parsed).toEqual([{ startSec: 1, endSec: 2.5, content: 'Hi there' }])
  })

  it('skips blocks without a valid timecode', () => {
    expect(parseSrt('not a cue\n\njust text')).toEqual([])
  })
})

describe('dedupeSubtitleCues', () => {
  it('collapses an overlapping exact duplicate, extending the end time', () => {
    const out = dedupeSubtitleCues([
      { startSec: 0, endSec: 2, content: 'hello world' },
      { startSec: 1, endSec: 3, content: 'hello world' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.endSec).toBe(3)
  })

  it('keeps a real repeat that occurs after a long gap', () => {
    const out = dedupeSubtitleCues([
      { startSec: 0, endSec: 2, content: 'hello world' },
      { startSec: 20, endSec: 22, content: 'hello world' },
    ])
    expect(out).toHaveLength(2)
  })

  it('keeps a real repeat separated by a short (>0.2s) pause — e.g. a repeated command', () => {
    // A person shouting "stop resisting" twice ~0.4s apart is genuine speech,
    // not an ASR hallucination. Previously the 0.6s grace merged these away.
    const out = dedupeSubtitleCues([
      { startSec: 0, endSec: 0.65, content: 'stop resisting' },
      { startSec: 1.1, endSec: 1.75, content: 'stop resisting' },
      { startSec: 2.2, endSec: 2.85, content: 'stop resisting' },
    ])
    expect(out).toHaveLength(3)
  })

  it('still collapses a contiguous same-text split (<0.2s gap, hallucination residue)', () => {
    const out = dedupeSubtitleCues([
      { startSec: 0, endSec: 2, content: 'hello world' },
      { startSec: 2.1, endSec: 4, content: 'hello world' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.endSec).toBe(4)
  })
})
