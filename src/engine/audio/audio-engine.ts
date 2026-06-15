import type { Clip, Track } from '@engine/timeline'

import { createDenoiseNode, loadDenoiseModule } from './denoise'
import type { AudioEngine } from './types'

class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private masterVolume = 1
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly decoding = new Map<string, Promise<void>>()
  private active: AudioBufferSourceNode[] = []
  private aux: AudioNode[] = [] // per-play gain/denoise nodes to tear down on stop
  private denoiseReady = false

  private ensureContext(): { ctx: AudioContext; master: GainNode } {
    if (!this.ctx || !this.master) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.masterVolume
      this.master.connect(this.ctx.destination)
      // Preload the denoise worklet so it's ready by the time playback starts.
      void loadDenoiseModule(this.ctx).then((ok) => {
        this.denoiseReady = ok
      })
    }
    return { ctx: this.ctx, master: this.master }
  }

  async ensureDecoded(assetId: string, blob: Blob): Promise<void> {
    if (this.buffers.has(assetId)) return
    const inflight = this.decoding.get(assetId)
    if (inflight) return inflight

    const { ctx } = this.ensureContext()
    const task = (async () => {
      try {
        const arrayBuffer = await blob.arrayBuffer()
        const buffer = await ctx.decodeAudioData(arrayBuffer)
        this.buffers.set(assetId, buffer)
      } catch {
        // Asset may have no audio track — ignore.
      } finally {
        this.decoding.delete(assetId)
      }
    })()
    this.decoding.set(assetId, task)
    return task
  }

  hasBuffer(assetId: string): boolean {
    return this.buffers.has(assetId)
  }

  getBuffer(assetId: string): AudioBuffer | null {
    return this.buffers.get(assetId) ?? null
  }

  setMasterVolume(v: number): void {
    this.masterVolume = v
    if (this.master) this.master.gain.value = v
  }

  play(timelineSec: number, clips: Clip[], tracks: Track[]): void {
    this.stop()
    const { ctx, master } = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()

    const now = ctx.currentTime

    for (const clip of clips) {
      if (!clip.assetId || clip.muted) continue
      const track = tracks.find((t) => t.id === clip.trackId)
      if (!track || track.muted) continue
      if (track.kind !== 'audio' && track.kind !== 'video') continue

      const buffer = this.buffers.get(clip.assetId)
      if (!buffer) continue

      const speed = Math.max(clip.speed, 0.01)
      const effDur = (clip.outPointSec - clip.inPointSec) / speed
      const clipEndTimeline = clip.startSec + effDur
      if (clipEndTimeline <= timelineSec) continue // already finished

      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.playbackRate.value = speed

      const gain = ctx.createGain()
      gain.gain.value = clip.volume

      // Insert the spectral-gate denoise worklet when the clip requests it
      // (and the module loaded). Otherwise connect straight through.
      if (clip.denoise && this.denoiseReady) {
        try {
          const dn = createDenoiseNode(ctx, clip.denoise)
          src.connect(gain).connect(dn).connect(master)
          this.aux.push(gain, dn)
        } catch {
          src.connect(gain).connect(master)
          this.aux.push(gain)
        }
      } else {
        src.connect(gain).connect(master)
        this.aux.push(gain)
      }

      let when: number
      let offset: number
      let duration: number

      if (timelineSec >= clip.startSec) {
        when = now
        offset = clip.inPointSec + (timelineSec - clip.startSec) * speed
        duration = clip.outPointSec - offset
      } else {
        when = now + (clip.startSec - timelineSec)
        offset = clip.inPointSec
        duration = clip.outPointSec - clip.inPointSec
      }

      duration = Math.min(duration, Math.max(0, buffer.duration - offset))
      if (duration <= 0) continue

      try {
        src.start(when, offset, duration)
        this.active.push(src)
      } catch {
        // start can throw if params are out of range — skip this clip.
      }
    }
  }

  stop(): void {
    for (const src of this.active) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
      src.disconnect()
    }
    this.active = []
    for (const node of this.aux) {
      try {
        node.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.aux = []
  }

  dispose(): void {
    this.stop()
    this.buffers.clear()
    this.decoding.clear()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}

export function createAudioEngine(): AudioEngine {
  return new WebAudioEngine()
}

export const audioEngine = createAudioEngine()
