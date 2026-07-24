import { beforeEach, describe, expect, it } from 'vitest'

import { usePlaybackStore } from './playback-store'

describe('playback buffering state', () => {
  beforeEach(() => {
    usePlaybackStore.setState({
      isPlaying: false,
      isBuffering: false,
      currentSec: 0,
      seekNonce: 0,
      volume: 1,
    })
  })

  it('pause and toggle-off always cancel buffering', () => {
    usePlaybackStore.getState().play()
    usePlaybackStore.getState().setBuffering(true)
    usePlaybackStore.getState().pause()
    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: false, isBuffering: false })

    usePlaybackStore.getState().play()
    usePlaybackStore.getState().setBuffering(true)
    usePlaybackStore.getState().toggle()
    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: false, isBuffering: false })
  })

  it('a user seek pauses playback before decoder re-sync', () => {
    usePlaybackStore.getState().play()
    usePlaybackStore.getState().setBuffering(true)
    usePlaybackStore.getState().seek(12.5)
    expect(usePlaybackStore.getState()).toMatchObject({
      currentSec: 12.5,
      isPlaying: false,
      isBuffering: false,
    })
  })

  it('internal history seek preserves an active transport', () => {
    usePlaybackStore.getState().play()
    usePlaybackStore.getState().seekInternal(7.25)
    expect(usePlaybackStore.getState()).toMatchObject({
      currentSec: 7.25,
      isPlaying: true,
      isBuffering: false,
    })
  })
})
