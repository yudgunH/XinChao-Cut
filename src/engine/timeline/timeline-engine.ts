import type { TimelineState, Track } from './types'

export function createTimeline(fps = 30): TimelineState {
  return {
    tracks: [],
    clips: [],
    durationSec: 0,
    fps,
  }
}

/** Default track layout for a fresh project (CapCut-style): one text track, two
 *  video tracks, one audio track. */
export function makeDefaultTracks(): Track[] {
  return [
    { id: 't1', kind: 'text', name: 'Text 1', muted: false, locked: false },
    { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false },
    { id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked: false },
    { id: 'a1', kind: 'audio', name: 'Audio 1', muted: false, locked: false },
  ]
}

export function makeDefaultTimeline(): TimelineState {
  return {
    tracks: makeDefaultTracks(),
    clips: [],
    durationSec: 0,
    fps: 30,
  }
}
