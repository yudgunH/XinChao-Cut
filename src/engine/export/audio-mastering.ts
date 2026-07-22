import type { PcmAudio } from './exporter'

export type AudioMasteringPreset = 'off' | 'social' | 'voice'

export interface AudioMasteringAnalysis {
  rms: number
  peak: number
  samples: number
}

export interface MasterableAudioBlock {
  channels: Float32Array[]
  frames: number
}

const TARGET_DBFS: Record<Exclude<AudioMasteringPreset, 'off'>, number> = {
  social: -14,
  voice: -16,
}
const PEAK_LIMIT = 10 ** (-1 / 20)
const MAX_GAIN = 10 ** (12 / 20)

function emptyAnalysis(): AudioMasteringAnalysis {
  return { rms: 0, peak: 0, samples: 0 }
}

function accumulate(
  analysis: AudioMasteringAnalysis,
  channels: Float32Array[],
): AudioMasteringAnalysis {
  let sumSquares = analysis.rms * analysis.rms * analysis.samples
  let peak = analysis.peak
  let samples = analysis.samples
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      const sample = channel[index] ?? 0
      sumSquares += sample * sample
      peak = Math.max(peak, Math.abs(sample))
      samples++
    }
  }
  return {
    rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
    peak,
    samples,
  }
}

export function analyzePcmAudio(audio: PcmAudio): AudioMasteringAnalysis {
  return accumulate(emptyAnalysis(), audio.channels)
}

export function masterAudioBufferInPlace(
  audio: AudioBuffer,
  preset: AudioMasteringPreset,
): AudioMasteringAnalysis {
  const channels = Array.from(
    { length: audio.numberOfChannels },
    (_, channel) => audio.getChannelData(channel),
  )
  const analysis = accumulate(emptyAnalysis(), channels)
  if (preset !== 'off') applyGain(channels, masteringGain(preset, analysis))
  return analysis
}

export async function analyzeAudioBlocks(
  blocks: AsyncIterable<MasterableAudioBlock>,
  signal?: AbortSignal,
  onFrames?: (cumulativeFrames: number) => void,
): Promise<AudioMasteringAnalysis> {
  let analysis = emptyAnalysis()
  let frames = 0
  for await (const block of blocks) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
    analysis = accumulate(analysis, block.channels)
    // Two-pass loudness runs a full mix before any video frame is encoded; on a
    // long timeline that is minutes of silent work. Report progress so the UI
    // never appears frozen at "preparing".
    if (onFrames) {
      frames += block.frames
      onFrames(frames)
    }
  }
  return analysis
}

export function masteringGain(
  preset: AudioMasteringPreset,
  analysis: AudioMasteringAnalysis,
): number {
  if (preset === 'off' || analysis.samples === 0 || analysis.rms <= 1e-12) return 1
  const target = 10 ** (TARGET_DBFS[preset] / 20)
  const rmsGain = Math.min(MAX_GAIN, target / analysis.rms)
  const peakGain = analysis.peak > 1e-12 ? PEAK_LIMIT / analysis.peak : MAX_GAIN
  return Math.max(0, Math.min(rmsGain, peakGain))
}

function applyGain(channels: Float32Array[], gain: number): void {
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      const scaled = (channel[index] ?? 0) * gain
      channel[index] = Math.max(-PEAK_LIMIT, Math.min(PEAK_LIMIT, scaled))
    }
  }
}

export function masterPcmAudioInPlace(
  audio: PcmAudio,
  preset: AudioMasteringPreset,
): AudioMasteringAnalysis {
  const analysis = analyzePcmAudio(audio)
  if (preset !== 'off') applyGain(audio.channels, masteringGain(preset, analysis))
  return analysis
}

export async function* masterAudioBlocks<T extends MasterableAudioBlock>(
  blocks: AsyncIterable<T>,
  preset: AudioMasteringPreset,
  analysis: AudioMasteringAnalysis,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const gain = masteringGain(preset, analysis)
  for await (const block of blocks) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
    if (preset !== 'off') applyGain(block.channels, gain)
    yield block
  }
}
