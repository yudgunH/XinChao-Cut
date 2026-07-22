import { describe, expect, it } from 'vitest'

import type { MediaAsset } from '@engine/media'

import { MissingMediaError, preflightAudibleMediaBlobs } from './audio-asset-preflight'

const asset = {
  id: 'audio-1',
  projectId: 'project-1',
  kind: 'audio',
  name: 'voice.wav',
  mimeType: 'audio/wav',
  sizeBytes: 10,
  durationSec: 1,
  storageKey: 'audio-1__voice.wav',
  createdAt: 1,
} satisfies MediaAsset

describe('browser export audio preflight', () => {
  it('throws MissingMediaError when an audible OPFS blob is absent', async () => {
    await expect(preflightAudibleMediaBlobs({
      audibleAssetIds: new Set([asset.id]),
      assets: [asset],
      hasBuffer: () => false,
      getBlob: async () => null,
    })).rejects.toBeInstanceOf(MissingMediaError)
  })
})
