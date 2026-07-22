import { afterEach, describe, expect, it, vi } from 'vitest'

import { desktopMediaFileSize, readDesktopMediaRange } from './desktop'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete (globalThis as { window?: unknown }).window
})

function installInvoke(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI__: { core: { invoke } } },
  })
}

describe('desktop media byte-range bridge', () => {
  it('returns the exact native file size', async () => {
    const invoke = vi.fn(async () => 123_456)
    installInvoke(invoke)

    await expect(desktopMediaFileSize('D:\\media\\clip.mp4')).resolves.toBe(123_456)
    expect(invoke).toHaveBeenCalledWith('media_file_size', {
      path: 'D:\\media\\clip.mp4',
    })
  })

  it('normalizes a binary view without leaking surrounding bytes', async () => {
    const backing = Uint8Array.from([99, 1, 2, 3, 88])
    const invoke = vi.fn(async () => new Uint8Array(backing.buffer, 1, 3))
    installInvoke(invoke)

    const result = await readDesktopMediaRange('D:\\media\\clip.mp4', 10, 13)

    expect([...new Uint8Array(result)]).toEqual([1, 2, 3])
    expect(invoke).toHaveBeenCalledWith('read_media_range', {
      path: 'D:\\media\\clip.mp4',
      start: 10,
      end: 13,
    })
  })
})
