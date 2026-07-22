export interface VideoSyncDecision {
  hardSeek: boolean
  /** Multiplier applied to the clip's authored playback speed. */
  rateCorrection: number
}

/** Keep transport and decoded video within one display frame at the cut. */
const RATE_CORRECTION_THRESHOLD_SEC = 1 / 60
const RATE_CORRECTION_GAIN = 1.2
const HARD_SEEK_THRESHOLD_SEC = 0.18

/**
 * Correct small A/V drift smoothly and reserve visible seeks for large drift.
 * Positive drift means the media element is behind the transport clock.
 *
 * `currentSec`/`targetSec` are SOURCE seconds, but the thresholds are meant in
 * WALL-CLOCK (display) time, so drift is normalized by `playbackRate` before
 * comparing. Un-normalized, a fixed source-time threshold shrinks in real time
 * as the rate grows: a 4x speed-adjusted span crossed the 0.18s hard-seek bar
 * after only 45ms of wall time — shorter than a typical H.264 seek — so every
 * seek was re-targeted (aborted) before it could land and playback wedged on
 * "Loading video frame" until the user paused. Normalized, the element gets the
 * same 180ms of real time to land a seek at any speed, and the residual lag is
 * absorbed by rate correction instead of another seek.
 */
export function decideVideoSync(
  currentSec: number,
  targetSec: number,
  playbackRate = 1,
): VideoSyncDecision {
  const rate = Math.max(playbackRate, 0.0625)
  const wallDrift = (targetSec - currentSec) / rate
  const distance = Math.abs(wallDrift)
  if (distance >= HARD_SEEK_THRESHOLD_SEC) return { hardSeek: true, rateCorrection: 1 }
  if (distance >= RATE_CORRECTION_THRESHOLD_SEC) {
    return {
      hardSeek: false,
      // rateCorrection multiplies the clip speed, so wall drift closes at
      // (correction − 1) per second regardless of the authored rate.
      rateCorrection: Math.max(0.9, Math.min(1.1, 1 + wallDrift * RATE_CORRECTION_GAIN)),
    }
  }
  return { hardSeek: false, rateCorrection: 1 }
}

/**
 * Where a hard seek should aim while PLAYING: not the transport's current
 * source position, but where the transport WILL be once the seek lands.
 *
 * Seeking to "now" chases a moving target: a seek that takes T seconds lands
 * `rate × T` source-seconds behind, which at 2–4x spans immediately crosses
 * the hard-seek bar again — an endless seek carousel that presents ~1 frame per
 * seek and freezes the canvas in between (the un-watchable "treo"). Leading by
 * the instance's measured seek latency lands ~on target, so playback simply
 * continues.
 *
 * The target is capped at the clip's source out-point so a lead near a cut
 * never shows frames that belong past the clip's own window.
 */
export function leadCompensatedSeekTarget(
  srcSec: number,
  playbackRate: number,
  seekEtaSec: number,
  sourceOutSec: number,
): number {
  const eta = Math.min(0.6, Math.max(0.05, seekEtaSec))
  const lead = Math.max(playbackRate, 0) * eta
  return Math.min(Math.max(sourceOutSec, srcSec), srcSec + lead)
}
