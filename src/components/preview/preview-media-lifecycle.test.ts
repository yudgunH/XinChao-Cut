import { describe, expect, it } from 'vitest'

import {
  canCommitPreviewUrl,
  decidePreviewUrlResolve,
  makePreviewLoadToken,
  previewIdsToDispose,
  shouldRetainPreviewMedia,
} from './preview-media-lifecycle'

describe('shouldRetainPreviewMedia (F17)', () => {
  it('requires both usedIds and project asset membership', () => {
    const used = new Set(['a'])
    const project = new Set(['a', 'b'])
    expect(shouldRetainPreviewMedia('a', used, project)).toBe(true)
    expect(shouldRetainPreviewMedia('b', used, project)).toBe(false) // library only
    expect(shouldRetainPreviewMedia('a', new Set(), project)).toBe(false)
    expect(shouldRetainPreviewMedia('a', used, new Set())).toBe(false)
  })
})

describe('previewIdsToDispose', () => {
  it('disposes library-only assets that still have pooled media', () => {
    const pooled = ['on-timeline', 'library-only', 'gone']
    const used = new Set(['on-timeline'])
    const project = new Set(['on-timeline', 'library-only'])
    expect(previewIdsToDispose(pooled, used, project).sort()).toEqual(['gone', 'library-only'])
  })

  it('keeps assets that are used and still in the project', () => {
    expect(
      previewIdsToDispose(['x'], new Set(['x']), new Set(['x'])),
    ).toEqual([])
  })
})

describe('makePreviewLoadToken', () => {
  it('is stable per assetId + desiredKey', () => {
    expect(makePreviewLoadToken('a', 'k1')).toBe(makePreviewLoadToken('a', 'k1'))
    expect(makePreviewLoadToken('a', 'k1')).not.toBe(makePreviewLoadToken('a', 'k2'))
    expect(makePreviewLoadToken('a', 'k1')).not.toBe(makePreviewLoadToken('b', 'k1'))
  })
})

describe('canCommitPreviewUrl (stale async)', () => {
  const base = {
    assetId: 'vid-1',
    startedGeneration: 3,
    currentGeneration: 3,
    startedKey: 'key-a',
    currentKey: 'key-a',
    usedIds: new Set(['vid-1']),
    assetIdsInProject: new Set(['vid-1']),
  }

  it('allows commit when key and used set still match', () => {
    expect(canCommitPreviewUrl(base)).toBe(true)
  })

  it('still commits after generation bump when key is unchanged (token-based)', () => {
    // Global generation used to discard valid in-flight loads → black preview.
    expect(canCommitPreviewUrl({ ...base, currentGeneration: 4 })).toBe(true)
  })

  it('rejects when clip left usedIds before resolve finished', () => {
    expect(canCommitPreviewUrl({ ...base, usedIds: new Set() })).toBe(false)
  })

  it('rejects when desired storage key changed mid-flight', () => {
    expect(canCommitPreviewUrl({ ...base, currentKey: 'key-proxy' })).toBe(false)
  })

  it('rejects when asset was removed from the project', () => {
    expect(canCommitPreviewUrl({ ...base, assetIdsInProject: new Set() })).toBe(false)
  })

  it('rejects when dispose cleared currentKey (re-add must start a fresh load)', () => {
    expect(canCommitPreviewUrl({ ...base, currentKey: undefined })).toBe(false)
  })
})

describe('decidePreviewUrlResolve — discard vs requeue', () => {
  const assetId = 'vid-1'
  const keyA = 'storage-a'
  const keyB = 'storage-b'
  const tokenA = makePreviewLoadToken(assetId, keyA)
  const tokenB = makePreviewLoadToken(assetId, keyB)
  const used = new Set([assetId])
  const project = new Set([assetId])

  it('commits when started token still matches current desire', () => {
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: tokenA,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: false,
      }),
    ).toBe('commit')
  })

  it('discards when asset left the working set', () => {
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: tokenA,
        usedIds: new Set(),
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: false,
      }),
    ).toBe('discard')
  })

  it('stale generation/token but asset still active and bare → requeue', () => {
    // Simulates: effect re-ran (or key flipped away and back) while a resolve
    // finished for a non-current token / cleared slot with nothing else loading.
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: tokenB, // desire moved on
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: false,
      }),
    ).toBe('requeue')
  })

  it('stale result discarded (no requeue) when current desire already loading', () => {
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: tokenB,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: true,
        alreadyHaveCurrent: false,
      }),
    ).toBe('discard')
  })

  it('stale result discarded when current desire already has media', () => {
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: tokenB,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: true,
      }),
    ).toBe('discard')
  })

  it('slow load: key changes away then back — original token can commit; bare slot requeues', () => {
    // 1) Start load for A
    const started = tokenA
    // 2) desiredKey → B (new load owns B)
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: started,
        currentToken: tokenB,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: true,
        alreadyHaveCurrent: false,
      }),
    ).toBe('discard')

    // 3) desiredKey → A again, but loading flag cleared without media (stuck path)
    //    Stale/orphan resolve must requeue so we are not stuck loading forever.
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenB, // leftover from intermediate key
        currentToken: tokenA,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: false,
      }),
    ).toBe('requeue')

    // 4) A fresh load for A that finishes while A is still desired commits.
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: tokenA,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: false,
      }),
    ).toBe('commit')
  })

  it('simulates effect re-run: same key, loading cleared after stale discard → requeue if bare', () => {
    // After global-gen discard, loadingIds was cleared and skip-logic left a hole.
    // currentToken still matches started but canCommit was false under gen model;
    // with tokens, same key commits. If currentToken is missing (dispose race)
    // while still used → requeue.
    expect(
      decidePreviewUrlResolve({
        assetId,
        startedToken: tokenA,
        currentToken: undefined,
        usedIds: used,
        assetIdsInProject: project,
        alreadyLoadingCurrent: false,
        alreadyHaveCurrent: false,
      }),
    ).toBe('requeue')
  })
})

describe('add/remove/re-add soak (10 cycles, deterministic)', () => {
  it('after each remove the id is disposable; re-add requires a matching token commit', () => {
    let generation = 0
    const project = new Set(['asset'])
    let used = new Set<string>()
    let currentKey: string | undefined
    const pooled = new Set<string>()

    for (let i = 0; i < 10; i++) {
      // add to timeline
      used = new Set(['asset'])
      generation++
      const startedGen = generation
      currentKey = 'storage-v1'
      // simulate async resolve success (token match; gen ignored)
      expect(
        canCommitPreviewUrl({
          assetId: 'asset',
          startedGeneration: startedGen,
          currentGeneration: generation,
          startedKey: 'storage-v1',
          currentKey,
          usedIds: used,
          assetIdsInProject: project,
        }),
      ).toBe(true)
      pooled.add('asset')

      // remove from timeline (still in library)
      used = new Set()
      generation++
      const toDrop = previewIdsToDispose(pooled, used, project)
      expect(toDrop).toEqual(['asset'])
      for (const id of toDrop) {
        pooled.delete(id)
        currentKey = undefined // dispose clears key
      }
      expect(pooled.size).toBe(0)

      // stale resolve from the previous add must not revive the pool
      expect(
        canCommitPreviewUrl({
          assetId: 'asset',
          startedGeneration: startedGen,
          currentGeneration: generation,
          startedKey: 'storage-v1',
          currentKey,
          usedIds: used,
          assetIdsInProject: project,
        }),
      ).toBe(false)
      expect(
        decidePreviewUrlResolve({
          assetId: 'asset',
          startedToken: makePreviewLoadToken('asset', 'storage-v1'),
          currentToken: undefined,
          usedIds: used,
          assetIdsInProject: project,
          alreadyLoadingCurrent: false,
          alreadyHaveCurrent: false,
        }),
      ).toBe('discard')
    }

    // final re-add works with a fresh token match
    used = new Set(['asset'])
    generation++
    currentKey = 'storage-v1'
    expect(
      canCommitPreviewUrl({
        assetId: 'asset',
        startedGeneration: generation,
        currentGeneration: generation,
        startedKey: 'storage-v1',
        currentKey,
        usedIds: used,
        assetIdsInProject: project,
      }),
    ).toBe(true)
  })
})

describe('dispose idempotence contract', () => {
  it('previewIdsToDispose is stable when called on an empty pool', () => {
    expect(previewIdsToDispose([], new Set(), new Set())).toEqual([])
    expect(previewIdsToDispose(['a'], new Set(['a']), new Set(['a']))).toEqual([])
  })
})
