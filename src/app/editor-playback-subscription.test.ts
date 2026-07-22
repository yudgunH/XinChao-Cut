import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('Editor playback subscription', () => {
  it('does not subscribe the editor root to the per-frame playhead', async () => {
    const source = await readFile(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('usePlaybackStore((s) => s.currentSec)')
    expect(source).toContain('usePlaybackStore.getState().currentSec')
  })
})
