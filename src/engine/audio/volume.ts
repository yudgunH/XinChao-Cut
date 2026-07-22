export const MIN_VOLUME_DB = -60
export const MAX_VOLUME_DB = 12
export const NORMAL_VOLUME_DB = 0
export const MAX_VOLUME_LINEAR = Math.pow(10, MAX_VOLUME_DB / 20)

export function clampVolumeLinear(volume: number): number {
  if (!Number.isFinite(volume)) return 1
  return Math.max(0, Math.min(MAX_VOLUME_LINEAR, volume))
}

export function volumeToDb(volume: number): number {
  const safe = clampVolumeLinear(volume)
  if (safe <= 0) return MIN_VOLUME_DB
  return Math.max(MIN_VOLUME_DB, Math.min(MAX_VOLUME_DB, 20 * Math.log10(safe)))
}

export function dbToVolume(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_VOLUME_DB) return 0
  return clampVolumeLinear(Math.pow(10, db / 20))
}
