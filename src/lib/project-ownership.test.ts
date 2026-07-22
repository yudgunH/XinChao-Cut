import { describe, expect, it } from 'vitest'

import {
  ProjectOwnershipCoordinator,
  canCommitImportAsset,
  canCommitProjectLoad,
  simulateOpenSequence,
} from './project-ownership'
import { gateImportCommit, runProjectLoadPipeline } from './project-load-pipeline'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ProjectOwnershipCoordinator', () => {
  it('bump invalidates prior generation', () => {
    const c = new ProjectOwnershipCoordinator()
    const g1 = c.bump()
    expect(c.isCurrent(g1)).toBe(true)
    const g2 = c.bump()
    expect(c.isCurrent(g1)).toBe(false)
    expect(c.isCurrent(g2)).toBe(true)
  })

  it('stillOwns requires matching project id and generation', () => {
    const c = new ProjectOwnershipCoordinator()
    c.bump()
    const own = c.capture('proj-A')
    expect(c.stillOwns(own, 'proj-A')).toBe(true)
    expect(c.stillOwns(own, 'proj-B')).toBe(false)
    c.bump()
    expect(c.stillOwns(own, 'proj-A')).toBe(false)
  })
})

describe('canCommitProjectLoad / canCommitImportAsset', () => {
  it('load commit only when generation matches', () => {
    expect(
      canCommitProjectLoad({ loadGeneration: 2, currentGeneration: 2, targetProjectId: 'A' }),
    ).toBe(true)
    expect(
      canCommitProjectLoad({ loadGeneration: 1, currentGeneration: 2, targetProjectId: 'A' }),
    ).toBe(false)
  })

  it('import never commits asset stamped for a different project', () => {
    expect(
      canCommitImportAsset({
        ownership: { projectId: 'A', generation: 1 },
        currentGeneration: 1,
        liveProjectId: 'A',
        assetProjectId: 'B',
      }),
    ).toBe(false)
  })
})

describe('runProjectLoadPipeline — deferred races', () => {
  it('open A then B, A resolves last → only B commits; state not mixed', async () => {
    const coord = new ProjectOwnershipCoordinator()
    const snapA = deferred<{ id: string; name: string; assetIds: string[]; payload: string }>()
    const snapB = deferred<{ id: string; name: string; assetIds: string[]; payload: string }>()
    const assetsA = deferred<{ id: string; projectId?: string }[]>()
    const assetsB = deferred<{ id: string; projectId?: string }[]>()

    let live = { projectId: '', assets: [] as string[], timeline: '' }
    const commits: string[] = []
    const evicts: string[] = []

    const depsFor = (
      id: string,
      snap: ReturnType<typeof deferred<{ id: string; name: string; assetIds: string[]; payload: string }>>,
      assets: ReturnType<typeof deferred<{ id: string; projectId?: string }[]>>,
    ) => ({
      coord,
      getProject: async (pid: string) => {
        if (pid !== id) throw new Error('wrong id')
        return snap.promise
      },
      listOwnedAssets: async () => assets.promise,
      listAssetsByIds: async () => [],
      mergeAssets: (owned: { id: string }[]) => owned,
      commitBatch: ({ snapshot, assets: a }: { snapshot: { id: string; payload: string }; assets: { id: string }[] }) => {
        commits.push(snapshot.id)
        live = {
          projectId: snapshot.id,
          assets: a.map((x) => x.id),
          timeline: String(snapshot.payload),
        }
      },
      afterCommit: ({ assets: a }: { assets: { id: string }[] }) => {
        evicts.push(...a.map((x) => x.id))
      },
    })

    const pA = runProjectLoadPipeline('A', depsFor('A', snapA, assetsA))
    const pB = runProjectLoadPipeline('B', depsFor('B', snapB, assetsB))

    // B finishes fully first
    snapB.resolve({ id: 'B', name: 'Bee', assetIds: [], payload: 'timeline-B' })
    assetsB.resolve([{ id: 'asset-B', projectId: 'B' }])
    await pB

    // A resolves late with its own assets
    snapA.resolve({ id: 'A', name: 'Ay', assetIds: [], payload: 'timeline-A' })
    assetsA.resolve([{ id: 'asset-A', projectId: 'A' }])
    const resultA = await pA

    expect(resultA.status).toBe('discarded')
    expect(commits).toEqual(['B'])
    expect(live).toEqual({ projectId: 'B', assets: ['asset-B'], timeline: 'timeline-B' })
    // Stale A must not have run afterCommit evict of B's media with A's set
    expect(evicts).toEqual(['asset-B'])
  })

  it('B fails while A is stale — A still discarded; no mixed commit', async () => {
    const coord = new ProjectOwnershipCoordinator()
    const snapA = deferred<{ id: string; name: string; assetIds: string[]; payload: string }>()
    const snapB = deferred<{ id: string; name: string; assetIds: string[]; payload: string }>()

    let live = { projectId: 'seed', assets: ['seed-asset'] as string[] }
    const commits: string[] = []

    const baseDeps = {
      coord,
      listOwnedAssets: async () => [] as { id: string }[],
      listAssetsByIds: async () => [] as { id: string }[],
      mergeAssets: (o: { id: string }[]) => o,
      commitBatch: ({ snapshot }: { snapshot: { id: string } }) => {
        commits.push(snapshot.id)
        live = { projectId: snapshot.id, assets: [] }
      },
    }

    const pA = runProjectLoadPipeline('A', {
      ...baseDeps,
      getProject: async () => snapA.promise,
    })
    const pB = runProjectLoadPipeline('B', {
      ...baseDeps,
      getProject: async () => snapB.promise,
    })

    snapB.reject(new Error('disk fail'))
    const rB = await pB
    expect(rB.status).toBe('discarded')
    expect(rB).toMatchObject({ reason: 'error' })

    snapA.resolve({ id: 'A', name: 'A', assetIds: [], payload: 'tA' })
    const rA = await pA
    expect(rA.status).toBe('discarded')
    expect(commits).toEqual([])
    expect(live).toEqual({ projectId: 'seed', assets: ['seed-asset'] })
  })

  it('close (bump) during load discards commit', async () => {
    const coord = new ProjectOwnershipCoordinator()
    const snap = deferred<{ id: string; name: string; assetIds: string[]; payload: string }>()
    let committed = false
    const p = runProjectLoadPipeline('A', {
      coord,
      getProject: async () => snap.promise,
      listOwnedAssets: async () => [{ id: 'a1' }],
      listAssetsByIds: async () => [],
      mergeAssets: (o) => o,
      commitBatch: () => {
        committed = true
      },
    })
    // User closes / leaves home → invalidate
    coord.bump()
    snap.resolve({ id: 'A', name: 'A', assetIds: [], payload: 't' })
    const r = await p
    expect(r.status).toBe('discarded')
    expect(committed).toBe(false)
  })

  it('does not commit partial state: assets load after snapshot under same gen', async () => {
    const coord = new ProjectOwnershipCoordinator()
    const snap = deferred<{ id: string; name: string; assetIds: string[]; payload: string }>()
    const owned = deferred<{ id: string }[]>()
    const events: string[] = []

    const p = runProjectLoadPipeline('A', {
      coord,
      getProject: async () => {
        events.push('get')
        return snap.promise
      },
      listOwnedAssets: async () => {
        events.push('list')
        return owned.promise
      },
      listAssetsByIds: async () => {
        events.push('byIds')
        return []
      },
      mergeAssets: (o) => o,
      commitBatch: () => {
        events.push('commit')
      },
    })

    snap.resolve({ id: 'A', name: 'A', assetIds: ['x'], payload: 't' })
    await Promise.resolve()
    expect(events).toContain('get')
    expect(events).not.toContain('commit')
    owned.resolve([{ id: 'x' }])
    await p
    expect(events).toEqual(['get', 'list', 'byIds', 'commit'])
  })
})

describe('import ownership — deferred', () => {
  it('import A then switch B before probe finishes → discard addAsset', async () => {
    const coord = new ProjectOwnershipCoordinator()
    coord.bump()
    const ownership = coord.capture('A')
    let liveProjectId = 'A'
    const store: string[] = []

    const probe = deferred<{ id: string; projectId: string }>()
    const importPromise = (async () => {
      const asset = await probe.promise
      const gate = gateImportCommit({
        coord,
        ownership,
        liveProjectId,
        assetProjectId: asset.projectId,
      })
      if (gate === 'commit') store.push(asset.id)
      return gate
    })()

    // Switch to B (new open bumps generation and changes live id)
    coord.bump()
    liveProjectId = 'B'

    probe.resolve({ id: 'asset-from-A', projectId: 'A' })
    expect(await importPromise).toBe('discard')
    expect(store).toEqual([])
  })

  it('close during import discards', async () => {
    const coord = new ProjectOwnershipCoordinator()
    coord.bump()
    const ownership = coord.capture('A')
    const probe = deferred<{ id: string; projectId: string }>()
    const p = probe.promise.then((asset) =>
      gateImportCommit({
        coord,
        ownership,
        liveProjectId: 'A',
        assetProjectId: asset.projectId,
      }),
    )
    coord.bump() // close
    probe.resolve({ id: 'x', projectId: 'A' })
    expect(await p).toBe('discard')
  })

  it('two concurrent imports same project both may commit', async () => {
    const coord = new ProjectOwnershipCoordinator()
    coord.bump()
    const ownership = coord.capture('A')
    const d1 = deferred<{ id: string; projectId: string }>()
    const d2 = deferred<{ id: string; projectId: string }>()
    const store: string[] = []

    const run = async (d: typeof d1) => {
      const asset = await d.promise
      if (
        gateImportCommit({
          coord,
          ownership,
          liveProjectId: 'A',
          assetProjectId: asset.projectId,
        }) === 'commit'
      ) {
        store.push(asset.id)
      }
    }

    const p1 = run(d1)
    const p2 = run(d2)
    d2.resolve({ id: 'b', projectId: 'A' })
    d1.resolve({ id: 'a', projectId: 'A' })
    await Promise.all([p1, p2])
    expect(store.sort()).toEqual(['a', 'b'])
  })

  it('asset persisted for old project is not committed into new store', () => {
    const coord = new ProjectOwnershipCoordinator()
    coord.bump()
    const ownership = coord.capture('A')
    coord.bump()
    // Even if live id were still A (shouldn't), generation mismatch discards
    expect(
      gateImportCommit({
        coord,
        ownership,
        liveProjectId: 'A',
        assetProjectId: 'A',
      }),
    ).toBe('discard')
  })
})

describe('simulateOpenSequence helper', () => {
  it('only latest generation among overlapping opens commits', () => {
    const coord = new ProjectOwnershipCoordinator()
    const { commits, discarded } = simulateOpenSequence(coord, [
      { id: 'A', resolveOrder: 2 },
      { id: 'B', resolveOrder: 1 },
    ])
    expect(commits).toEqual(['B'])
    expect(discarded).toEqual(['A'])
  })
})
