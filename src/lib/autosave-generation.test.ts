import { describe, expect, it } from 'vitest'

import { AutoSaveGeneration } from './autosave-generation'

describe('AutoSaveGeneration', () => {
  it('does not let an older save clear a newer edit', () => {
    const state = new AutoSaveGeneration()
    const first = state.markDirty()
    state.markDirty()

    expect(state.commit(first)).toBe(false)
    expect(state.isDirty()).toBe(true)
  })

  it('becomes clean only after the latest generation commits', () => {
    const state = new AutoSaveGeneration()
    state.markDirty()
    const latest = state.markDirty()

    expect(state.commit(latest)).toBe(true)
    expect(state.isDirty()).toBe(false)
  })
})
