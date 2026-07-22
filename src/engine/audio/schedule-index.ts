import type { Clip, Track } from '@engine/timeline'

function clipEnd(clip: Clip): number {
  const speed = Math.max(clip.speed, 0.01)
  return clip.startSec + (clip.outPointSec - clip.inPointSec) / speed
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
    this.clips = clips
      .filter((clip) => {
        if (!clip.assetId || clip.muted || clip.volume <= 0) return false
        const track = trackById.get(clip.trackId)
        return Boolean(track && !track.muted && !track.hidden && track.kind === 'audio')
      })
      .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
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
