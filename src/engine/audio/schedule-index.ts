import type { Clip, Track } from '@engine/timeline'

function clipEnd(clip: Clip): number {
  const speed = Math.max(clip.speed, 0.01)
  return clip.startSec + (clip.outPointSec - clip.inPointSec) / speed
}

const CONTINUOUS_EDGE_EPS_SEC = 1e-4

function sameDenoise(a: Clip, b: Clip): boolean {
  return a.denoise === b.denoise
}

/**
 * Turn adjacent split pieces of the same source into one playback item. The
 * editor stores every cut as a separate clip, but stopping and restarting an
 * HTMLMediaElement at each cut is main-thread-timer sensitive and can lose the
 * first audio block when React/WebView2 stalls near the edge. A continuous
 * chain keeps the native decoder running straight through like the unsplit
 * source.
 */
export function coalesceContinuousAudioClips(clips: readonly Clip[]): Clip[] {
  const byTrack = new Map<string, Clip[]>()
  for (const clip of clips) {
    const trackClips = byTrack.get(clip.trackId) ?? []
    trackClips.push(clip)
    byTrack.set(clip.trackId, trackClips)
  }

  const out: Clip[] = []
  for (const trackClips of byTrack.values()) {
    trackClips.sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
    let current: Clip | null = null
    for (const next of trackClips) {
      if (!current) {
        current = next
        continue
      }
      const continuous =
        current.assetId === next.assetId &&
        Math.abs(clipEnd(current) - next.startSec) <= CONTINUOUS_EDGE_EPS_SEC &&
        Math.abs(current.outPointSec - next.inPointSec) <= CONTINUOUS_EDGE_EPS_SEC &&
        Math.abs(current.speed - next.speed) <= 1e-6 &&
        Math.abs(current.volume - next.volume) <= 1e-6 &&
        sameDenoise(current, next)
      if (continuous) {
        current = { ...current, outPointSec: next.outPointSec }
      } else {
        out.push(current)
        current = next
      }
    }
    if (current) out.push(current)
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
}

/** Monotonic playback-horizon cursor; unresolved buffers stay pending. */
export class AudioScheduleIndex {
  private readonly clips: Clip[]
  private readonly clipsById: Map<string, Clip>
  private readonly pending = new Map<string, Clip>()
  private next = 0
  private examined = 0

  constructor(clips: Clip[], tracks: Track[]) {
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    this.clips = coalesceContinuousAudioClips(clips
      .filter((clip) => {
        if (!clip.assetId || clip.muted || clip.volume <= 0) return false
        const track = trackById.get(clip.trackId)
        return Boolean(track && !track.muted && !track.hidden && track.kind === 'audio')
      }))
    this.clipsById = new Map(this.clips.map((clip) => [clip.id, clip]))
  }

  advance(timelineSec: number, horizonEnd: number): readonly Clip[] {
    while (this.next < this.clips.length) {
      const clip = this.clips[this.next]!
      if (clip.startSec >= horizonEnd) break
      this.next += 1
      this.examined += 1
      if (clipEnd(clip) > timelineSec) this.pending.set(clip.id, clip)
    }
    for (const [id, clip] of this.pending) {
      if (clipEnd(clip) <= timelineSec) this.pending.delete(id)
    }
    return [...this.pending.values()]
  }

  remove(clipId: string): void {
    this.pending.delete(clipId)
  }

  getClip(clipId: string): Clip | undefined {
    return this.clipsById.get(clipId)
  }

  getExaminedCount(): number {
    return this.examined
  }
}
