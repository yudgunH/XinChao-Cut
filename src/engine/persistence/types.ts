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
  assetIds: string[]
  /** Data-URL thumbnail for the Home project card (first video/asset frame). */
  thumbnailDataUrl?: string
  createdAt?: number
  updatedAt: number
}
