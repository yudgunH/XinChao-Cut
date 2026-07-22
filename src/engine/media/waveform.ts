import { assertDecodable } from '@engine/audio/decode-guard'

const NUM_BUCKETS = 300

let ac: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!ac) ac = new AudioContext()
  return ac
}

export async function extractWaveformPeaks(blob: Blob): Promise<number[]> {
  // Peaks are 300 numbers, but producing them decodes the WHOLE file into RAM.
  // Use the DURATION-aware guard, not just the size gate: a 60-min MP3 is only
  // ~50–100 MB on disk yet decodes to >1 GB of Float32 PCM, which the size gate
  // can't see. Callers already treat a throw as "no peaks".
  await assertDecodable(blob, 'This audio source', {
    maxInputBytes: 256 * 1024 * 1024,
    maxPcmBytes: 256 * 1024 * 1024,
  })
  const arrayBuffer = await blob.arrayBuffer()
  const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer)
  const channel = audioBuffer.getChannelData(0)
  const blockSize = Math.max(1, Math.floor(channel.length / NUM_BUCKETS))
  const peaks: number[] = new Array(NUM_BUCKETS)

  for (let i = 0; i < NUM_BUCKETS; i++) {
    let max = 0
    const start = i * blockSize
    const end = Math.min(start + blockSize, channel.length)
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j] ?? 0)
      if (abs > max) max = abs
    }
    peaks[i] = max
  }
  return peaks
}
