/**
 * Encode an AudioBuffer (the mixed timeline audio) into a downloadable
 * WAV or MP3 file — used by the "Audio" export option.
 */
import { Mp3Encoder } from '@breezystack/lamejs'

/** Clamp a Float32 sample to the signed 16-bit PCM range. */
function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample))
  return s < 0 ? s * 0x8000 : s * 0x7fff
}

/** Encode an AudioBuffer to a 16-bit PCM WAV Blob. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numCh = Math.min(buffer.numberOfChannels, 2) || 1
  const sr = buffer.sampleRate
  const len = buffer.length
  const blockAlign = numCh * 2
  const dataSize = len * blockAlign
  const ab = new ArrayBuffer(44 + dataSize)
  const view = new DataView(ab)

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
  }

  // RIFF / WAVE header
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)            // PCM chunk size
  view.setUint16(20, 1, true)             // audio format = PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sr, true)
  view.setUint32(28, sr * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)            // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  // Interleaved 16-bit samples
  const channels: Float32Array[] = []
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c))

  let offset = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      view.setInt16(offset, floatToInt16(channels[c]![i]!), true)
      offset += 2
    }
  }

  return new Blob([ab], { type: 'audio/wav' })
}

/** Encode an AudioBuffer to an MP3 Blob via lamejs (CBR). */
export function encodeMp3(buffer: AudioBuffer, kbps = 192): Blob {
  const numCh = Math.min(buffer.numberOfChannels, 2) || 1
  const sr = buffer.sampleRate
  const encoder = new Mp3Encoder(numCh, sr, kbps)

  const left = buffer.getChannelData(0)
  const right = numCh > 1 ? buffer.getChannelData(1) : left
  const len = buffer.length

  // Convert to Int16 PCM up front.
  const l16 = new Int16Array(len)
  const r16 = numCh > 1 ? new Int16Array(len) : l16
  for (let i = 0; i < len; i++) {
    l16[i] = floatToInt16(left[i]!)
    if (numCh > 1) r16[i] = floatToInt16(right[i]!)
  }

  const BLOCK = 1152 // MP3 frame size
  const chunks: Uint8Array[] = []
  for (let i = 0; i < len; i += BLOCK) {
    const lChunk = l16.subarray(i, i + BLOCK)
    const buf =
      numCh > 1
        ? encoder.encodeBuffer(lChunk, r16.subarray(i, i + BLOCK))
        : encoder.encodeBuffer(lChunk)
    if (buf.length > 0) chunks.push(new Uint8Array(buf))
  }
  const end = encoder.flush()
  if (end.length > 0) chunks.push(new Uint8Array(end))

  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
}
