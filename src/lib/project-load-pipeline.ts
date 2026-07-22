/**
 * S9A — Transactional project load pipeline (injectable for tests).
 *
 * Protocol:
 * 1. bump generation (invalidates prior load/import)
 * 2. await snapshot + assets fully
 * 3. after every await, re-check generation
 * 4. commit timeline + project + assets in one synchronous batch
 * 5. only then run side effects (audio evict) if still current
 *
 * Never commits partial state mid-flight. Stale loads discard even in
 * error/finally paths (callers must not commit after throw either).
 */

import type { ProjectOwnershipCoordinator } from './project-ownership'
import { canCommitProjectLoad } from './project-ownership'

export interface ProjectLoadSnapshot {
  id: string
  name: string
  assetIds: string[]
  /** Opaque payload the commit handler understands (timeline fields, etc.). */
  payload: unknown
}

export interface ProjectLoadAsset {
  id: string
  projectId?: string
}

export type ProjectLoadResult =
  | { status: 'committed'; projectId: string; generation: number; assets: ProjectLoadAsset[] }
  | { status: 'discarded'; reason: 'stale' | 'missing' | 'error'; projectId: string; generation: number }
  | { status: 'missing'; projectId: string; generation: number }

export interface ProjectLoadDeps<TSnapshot extends ProjectLoadSnapshot = ProjectLoadSnapshot> {
  coord: ProjectOwnershipCoordinator
  getProject: (id: string) => Promise<TSnapshot | null>
  listOwnedAssets: (projectId: string) => Promise<ProjectLoadAsset[]>
  listAssetsByIds: (ids: string[]) => Promise<ProjectLoadAsset[]>
  mergeAssets: (owned: ProjectLoadAsset[], referenced: ProjectLoadAsset[]) => ProjectLoadAsset[]
  /**
   * Synchronous batch commit. Must not await. Only invoked when generation is
   * still current.
   */
  commitBatch: (args: {
    snapshot: TSnapshot
    assets: ProjectLoadAsset[]
    generation: number
  }) => void
  /**
   * Post-commit side effect (e.g. audioEngine.evictExcept). Skipped when stale
   * so a late A cannot evict B's media.
   */
  afterCommit?: (args: {
    snapshot: TSnapshot
    assets: ProjectLoadAsset[]
    generation: number
  }) => void
}

/**
 * Load one project under ownership rules. Safe to race multiple calls — only
 * the latest generation commits.
 */
export async function runProjectLoadPipeline<TSnapshot extends ProjectLoadSnapshot>(
  projectId: string,
  deps: ProjectLoadDeps<TSnapshot>,
): Promise<ProjectLoadResult> {
  const generation = deps.coord.bump()
  try {
    const snapshot = await deps.getProject(projectId)
    if (!deps.coord.isCurrent(generation)) {
      return { status: 'discarded', reason: 'stale', projectId, generation }
    }
    if (!snapshot) {
      return { status: 'missing', projectId, generation }
    }

    const owned = await deps.listOwnedAssets(projectId)
    if (!deps.coord.isCurrent(generation)) {
      return { status: 'discarded', reason: 'stale', projectId, generation }
    }

    const referenced = await deps.listAssetsByIds(snapshot.assetIds ?? [])
    if (!deps.coord.isCurrent(generation)) {
      return { status: 'discarded', reason: 'stale', projectId, generation }
    }

    const assets = deps.mergeAssets(owned, referenced)

    if (
      !canCommitProjectLoad({
        loadGeneration: generation,
        currentGeneration: deps.coord.getGeneration(),
        targetProjectId: projectId,
      })
    ) {
      return { status: 'discarded', reason: 'stale', projectId, generation }
    }

    // Synchronous batch — no await between timeline / project / assets.
    deps.commitBatch({ snapshot, assets, generation })

    if (deps.coord.isCurrent(generation)) {
      deps.afterCommit?.({ snapshot, assets, generation })
    }

    return { status: 'committed', projectId, generation, assets }
  } catch {
    // Do not commit on error. Generation stays bumped so stale siblings still lose.
    if (!deps.coord.isCurrent(generation)) {
      return { status: 'discarded', reason: 'stale', projectId, generation }
    }
    return { status: 'discarded', reason: 'error', projectId, generation }
  }
}

/** Import commit gate used after mediaManager.import resolves. */
export function gateImportCommit(opts: {
  coord: ProjectOwnershipCoordinator
  ownership: { projectId: string; generation: number }
  liveProjectId: string
  assetProjectId: string
}): 'commit' | 'discard' {
  if (!opts.coord.stillOwns(opts.ownership, opts.liveProjectId)) return 'discard'
  if (opts.assetProjectId !== opts.ownership.projectId) return 'discard'
  return 'commit'
}
