import { describe, expect, it } from 'vitest'

import { encodeMp3, encodeWavAsync } from './audio-file'

function fakeBuffer(frames: number, channels = 2): AudioBuffer {
  const data = Array.from({ length: channels }, (_, ch) => {
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++) samples[i] = Math.sin((i + ch) / 20) * 0.25
    return samples
  })
  return {
    numberOfChannels: channels,
    sampleRate: 48_000,
    length: frames,
    getChannelData: (channel: number) => data[channel]!,
  } as AudioBuffer
}

describe('cooperative audio file encoding', () => {
  it('writes a valid PCM WAV header', async () => {
    const blob = await encodeWavAsync(fakeBuffer(100))
    expect(blob.type).toBe('audio/wav')
    expect(await blob.slice(0, 4).text()).toBe('RIFF')
  })

  it('honours cancellation while encoding a long MP3', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 0)
    await expect(encodeMp3(fakeBuffer(200_000), 192, ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('honours a pre-aborted WAV export', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(encodeWavAsync(fakeBuffer(100), ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
