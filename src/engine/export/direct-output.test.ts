import { describe, expect, it } from 'vitest'

import {
  BackendMp4StreamSink,
  type BrowserStreamTransport,
} from './direct-output'

describe('BackendMp4StreamSink', () => {
  it('serializes random-access writes and finalizes with maximum end offset', async () => {
    const writes: Array<{ position: number; data: string }> = []
    let finalizedSize = 0
    let finalizedCodec: string | undefined
    const transport: BrowserStreamTransport = {
      start: async () => ({ streamId: 's1', path: 'D:/out.mp4' }),
      write: async (_id, position, data) => {
        writes.push({ position, data: String.fromCharCode(...data) })
      },
      finalize: async (_id, size, _signal, _onProgress, videoCodec) => {
        finalizedSize = size
        finalizedCodec = videoCodec
        return 'D:/out.mp4'
      },
      cancel: async () => {},
    }
    const sink = await BackendMp4StreamSink.create(
      { outputDir: 'D:/', outputName: 'out', estimatedBytes: 100 },
      transport,
    )
    sink.acceptMuxerData(Uint8Array.from([69, 70, 71, 72]), 4)
    sink.acceptMuxerData(Uint8Array.from([65, 66, 67, 68]), 0)

    expect(await sink.finalize(undefined, undefined, undefined, 'hevc')).toBe('D:/out.mp4')
    expect(writes).toEqual([
      { position: 4, data: 'EFGH' },
      { position: 0, data: 'ABCD' },
    ])
    expect(finalizedSize).toBe(8)
    expect(finalizedCodec).toBe('hevc')
  })

  it('cancels the reserved stream', async () => {
    let cancelled = false
    const transport: BrowserStreamTransport = {
      start: async () => ({ streamId: 's2', path: 'D:/out.mp4' }),
      write: async () => {},
      finalize: async () => 'D:/out.mp4',
      cancel: async () => { cancelled = true },
    }
    const sink = await BackendMp4StreamSink.create(
      { outputDir: 'D:/', outputName: 'out', estimatedBytes: 100 },
      transport,
    )
    await sink.abort()
    expect(cancelled).toBe(true)
  })

  it('aborts an in-flight transport write when export is cancelled', async () => {
    let writeSignal: AbortSignal | undefined
    const transport: BrowserStreamTransport = {
      start: async () => ({ streamId: 's3', path: 'D:/out.mp4' }),
      write: async (_id, _position, _data, signal) => {
        writeSignal = signal
        await new Promise<void>((_resolve, reject) => signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        ))
      },
      finalize: async () => 'D:/out.mp4',
      cancel: async () => {},
    }
    const sink = await BackendMp4StreamSink.create(
      { outputDir: 'D:/', outputName: 'out', estimatedBytes: 100 },
      transport,
    )
    sink.acceptMuxerData(Uint8Array.of(1), 0)
    await Promise.resolve()
    await sink.abort()

    expect(writeSignal?.aborted).toBe(true)
  })

  it('cancels an in-flight Hybrid finalize as soon as abort state changes', async () => {
    let cancelled = false
    let cancelCompleted = false
    let aborted = false
    const transport: BrowserStreamTransport = {
      start: async () => ({ streamId: 's4', path: 'D:/out.mp4' }),
      write: async () => {},
      finalize: async (_id, _size, signal) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Cancelled', 'AbortError'))
        }, { once: true })
      }),
      cancel: async () => {
        cancelled = true
        await new Promise((resolve) => setTimeout(resolve, 20))
        cancelCompleted = true
      },
    }
    const sink = await BackendMp4StreamSink.create(
      { outputDir: 'D:/', outputName: 'out', estimatedBytes: 100 },
      transport,
    )
    sink.acceptMuxerData(Uint8Array.of(1), 0)
    await sink.waitForCapacity()
    const finalizing = sink.finalize(() => aborted)
    aborted = true

    await expect(finalizing).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    expect(cancelCompleted).toBe(true)
  })
})
