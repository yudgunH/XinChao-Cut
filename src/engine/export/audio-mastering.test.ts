import { describe, expect, it } from 'vitest'

import {
  analyzePcmAudio,
  masterPcmAudioInPlace,
  masteringGain,
} from './audio-mastering'

function pcm(values: number[]) {
  return {
    sampleRate: 48_000,
    length: values.length,
    numberOfChannels: 1,
    channels: [Float32Array.from(values)],
  }
}

describe('audio mastering', () => {
  it('keeps off bit-identical', () => {
    const audio = pcm([0.1, -0.5, 0.9])
    const before = audio.channels[0]!.slice()
    masterPcmAudioInPlace(audio, 'off')
    expect(audio.channels[0]).toEqual(before)
  })

  it('raises quiet audio while respecting the -1 dB peak ceiling', () => {
    const audio = pcm([0.01, -0.01, 0.02, -0.02])
    const before = analyzePcmAudio(audio)
    masterPcmAudioInPlace(audio, 'social')
    const after = analyzePcmAudio(audio)
    expect(after.rms).toBeGreaterThan(before.rms)
    expect(after.peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6)
  })

  it('never boosts a hot signal through the peak ceiling', () => {
    const analysis = { rms: 0.5, peak: 1, samples: 100 }
    expect(masteringGain('social', analysis)).toBeLessThanOrEqual(10 ** (-1 / 20))
  })
})
