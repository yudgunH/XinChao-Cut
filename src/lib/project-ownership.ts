/**
 * S9A / F09+F10 — Project session ownership (generation token).
 *
 * A single monotonic generation covers open / close / switch / import:
 * - Every load/open/close bumps the generation → pending async work that
 *   captured an older token must not mutate stores.
 * - Import captures `{ projectId, generation }` at start; after probe/import
 *   only `addAsset` when stillOwns still holds — assets persisted for the old
 *   project stay on disk/DB (S9B cleans orphans) but never enter the new store.
 *
 * Pure helpers are exported for deterministic deferred-promise tests without
 * mounting React or touching OPFS.
 */

export interface ProjectOwnership {
  /** Project id that owned the operation when it started ('' = none). */
  projectId: string
  /** Generation at capture time. */
  generation: number
}

/** Mutable coordinator — one process-wide instance in project-session. */
export class ProjectOwnershipCoordinator {
  private generation = 0

  getGeneration(): number {
    return this.generation
  }

  /**
   * Invalidate every in-flight load/import. Returns the new generation that
   * the caller should treat as its ownership token for a fresh load.
   */
  bump(): number {
    this.generation += 1
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  capture(projectId: string): ProjectOwnership {
    return { projectId, generation: this.generation }
  }

  /**
   * True when the session generation is unchanged AND the live project id still
   * matches the captured owner (and owner is non-empty for import mutations).
   */
  stillOwns(ownership: ProjectOwnership, liveProjectId: string): boolean {
    if (!this.isCurrent(ownership.generation)) return false
    if (!ownership.projectId) return false
    return liveProjectId === ownership.projectId
  }

  /** Test helper: reset without bumping past a known value. */
  resetForTests(generation = 0): void {
    this.generation = generation
  }
}

/** Decide whether a finished load may commit (pure). */
export function canCommitProjectLoad(opts: {
  loadGeneration: number
  currentGeneration: number
  /** Id we intended to load. */
  targetProjectId: string
}): boolean {
  return (
    opts.loadGeneration === opts.currentGeneration &&
    opts.targetProjectId.length > 0
  )
}

/** Decide whether import may mutate the live project store (pure). */
export function canCommitImportAsset(opts: {
  ownership: ProjectOwnership
  currentGeneration: number
  liveProjectId: string
  /** projectId stamped on the imported asset row. */
  assetProjectId: string
}): boolean {
  if (opts.ownership.generation !== opts.currentGeneration) return false
  if (!opts.ownership.projectId) return false
  if (opts.liveProjectId !== opts.ownership.projectId) return false
  // Asset must belong to the same project we captured — never inject old-project
  // rows into a switched session even if generation somehow matched.
  if (opts.assetProjectId !== opts.ownership.projectId) return false
  return true
}

/**
 * Simulate sequential open A then open B with deferred resolutions.
 * Returns which load generations would commit (for tests / docs).
 */
export function simulateOpenSequence(
  coord: ProjectOwnershipCoordinator,
  opens: Array<{ id: string; resolveOrder: number }>,
): { commits: string[]; discarded: string[] } {
  const tokens = opens.map((o) => ({
    id: o.id,
    resolveOrder: o.resolveOrder,
    gen: coord.bump(),
  }))
  // Sort by resolve order; only the latest generation may commit.
  const byResolve = [...tokens].sort((a, b) => a.resolveOrder - b.resolveOrder)
  const commits: string[] = []
  const discarded: string[] = []
  for (const t of byResolve) {
    if (canCommitProjectLoad({
      loadGeneration: t.gen,
      currentGeneration: coord.getGeneration(),
      targetProjectId: t.id,
    })) {
      commits.push(t.id)
    } else {
      discarded.push(t.id)
    }
  }
  return { commits, discarded }
}
