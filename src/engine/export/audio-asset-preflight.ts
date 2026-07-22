import type { MediaAsset } from '@engine/media'

export class MissingMediaError extends Error {
  readonly assetId: string

  constructor(asset: Pick<MediaAsset, 'id' | 'name'>) {
    super(`Cannot export: media data for "${asset.name}" is missing. Re-import this file and try again.`)
    this.name = 'MissingMediaError'
    this.assetId = asset.id
  }
}

interface AudioAssetPreflightOptions {
  audibleAssetIds: ReadonlySet<string>
  assets: readonly MediaAsset[]
  hasBuffer: (assetId: string) => boolean
  getBlob: (assetId: string) => Promise<Blob | null>
  signal?: AbortSignal
}

/** Verify every browser-mixed audio source exists before rendering starts. */
export async function preflightAudibleMediaBlobs(
  options: AudioAssetPreflightOptions,
): Promise<Map<string, Blob>> {
  const assetById = new Map(options.assets.map((asset) => [asset.id, asset]))
  const blobs = new Map<string, Blob>()
  for (const id of options.audibleAssetIds) {
    if (options.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
    if (options.hasBuffer(id)) continue
    const asset = assetById.get(id)
    if (!asset) throw new MissingMediaError({ id, name: id })
    if (asset.kind !== 'audio' && asset.kind !== 'video') continue
    if (asset.sourcePath || asset.playbackUrl) {
      throw new Error(
        `Cannot load the full desktop source "${asset.name}" into browser RAM for audio mixing. ` +
          'Use Hybrid/Server export, or create a short audio-only source first.',
      )
    }
    const blob = await options.getBlob(id)
    if (!blob) throw new MissingMediaError(asset)
    blobs.set(id, blob)
  }
  return blobs
}

export function assertAudibleAssetsResolved(
  audibleAssetIds: ReadonlySet<string>,
  assets: readonly MediaAsset[],
  buffers: ReadonlyMap<string, AudioBuffer>,
  streamAssetIds: ReadonlySet<string> = new Set(),
): void {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  for (const id of audibleAssetIds) {
    const asset = assetById.get(id)
    if (!asset || (asset.kind !== 'audio' && asset.kind !== 'video')) continue
    if (!buffers.has(id) && !streamAssetIds.has(id)) throw new MissingMediaError(asset)
  }
}
