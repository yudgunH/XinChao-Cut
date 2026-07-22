export interface ProjectSnapshot {
  /** Stable project id (also the key in the `projects` table). Optional for
   *  back-compat with single-project snapshots saved under the legacy
   *  `'current'` key before multi-project support. */
  id?: string
  version: number
  name: string
  fps: number
  width: number
  height: number
  /** Aspect-ratio label (e.g. "16:9"), matching ASPECT_RATIOS. Optional for
   *  back-compat with snapshots saved before aspect was persisted. */
  aspect?: string
  tracks: unknown[]
  clips: unknown[]
  /** Compound (nested) sub-timelines, keyed by compoundId. Optional — older
   *  snapshots predate compounds. clips/tracks stay raw (normalized on load). */
  compounds?: Record<
    string,
    { name: string; timeline: { tracks: unknown[]; clips: unknown[]; fps: number; durationSec: number } }
  >
  assetIds: string[]
  /** Data-URL thumbnail for the Home project card (first video/asset frame). */
  thumbnailDataUrl?: string
  createdAt?: number
  updatedAt: number
  /**
   * Monotonic per-project save revision (S13). Stamped by ProjectSaveCoordinator
   * at capture time; `saveProject` refuses to put a row when the DB already has
   * a higher revision (compare-and-set against out-of-order writers).
   */
  saveRevision?: number
}
