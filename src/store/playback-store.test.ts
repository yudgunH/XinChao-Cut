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
})
