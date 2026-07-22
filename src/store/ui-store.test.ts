import { beforeEach, describe, expect, it } from 'vitest'

import { useUIStore } from './ui-store'

describe('editor layout', () => {
  beforeEach(() => {
    useUIStore.setState({ view: 'home', timelineHeight: 180 })
  })

  it('restores the default timeline height whenever the editor opens', () => {
    useUIStore.getState().setView('editor')

    // Must match DEFAULT_TIMELINE_HEIGHT in ui-store.ts.
    expect(useUIStore.getState()).toMatchObject({ view: 'editor', timelineHeight: 350 })
  })

  it('still allows resizing while the editor is open', () => {
    useUIStore.getState().setView('editor')
    useUIStore.getState().setTimelineHeight(420)

    expect(useUIStore.getState().timelineHeight).toBe(420)
  })
})
