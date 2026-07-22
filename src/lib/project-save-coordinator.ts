/**
 * S13 / F19 — Serialize + coalesce project autosaves.
 *
 * Problem (CONFIRMED by deferred tests): `useAutoSave` debounces *scheduling*
 * but does not prevent a second `saveCurrentProject` from starting while the
 * first is still awaiting IndexedDB. The older capture can finish last and
 * overwrite the newer snapshot via last-write-wins `db.projects.put`.
 *
 * Fix:
 * 1. Per-project promise chain — at most one persist in flight.
 * 2. Coalesce: dirty while in flight → trailing capture after current finishes.
 * 3. Monotonic `saveRevision` stamped at capture; `saveProject` skips put when
 *    the DB already holds a higher revision (compare-and-set).
 * 4. On persist failure, re-arm dirty so retry keeps the latest intent.
 */

export interface SaveRevisionCarrier {
  id?: string
  /** Monotonic per-project revision stamped when the snapshot is captured. */
  saveRevision?: number
}

/**
 * Outcome of a persist. `committed:false` means the DB already held a revision
 * ≥ the one we tried to write (a stale/behind writer) — the coordinator uses
 * `dbRevision` to jump its counter forward and retry so no edit is lost.
 */
export interface SaveOutcome {
  committed: boolean
  /** The revision the DB row currently holds (present when we could read it). */
  dbRevision?: number
}

/**
 * Whether an incoming snapshot may overwrite the DB row (revision CAS).
 * Missing revisions always allow write (legacy snapshots).
 */
export function mayCommitRevision(
  incoming: number | undefined,
  existing: number | undefined,
): boolean {
  if (incoming == null || existing == null) return true
  return incoming >= existing
}

type CaptureFn<T extends SaveRevisionCarrier> = () => T | null | Promise<T | null>
/** Persist may report a stale skip so the coordinator can re-arm + bump. Older
 *  callers returning `void` are treated as an unconditional commit. */
type PersistFn<T extends SaveRevisionCarrier> = (snapshot: T) => Promise<SaveOutcome | void>

/** Cap on consecutive stale-skip retries so a rival live writer (another tab
 *  racing the same project) can't spin drain forever. */
const MAX_STALE_RETRIES = 3

export class ProjectSaveCoordinator {
  private readonly chain = new Map<string, Promise<void>>()
  private readonly dirty = new Map<string, boolean>()
  private readonly nextRev = new Map<string, number>()
  private readonly committedRev = new Map<string, number>()

  getCommittedRevision(projectId: string): number {
    return this.committedRev.get(projectId) ?? 0
  }

  /**
   * Seed the counter from a revision already on disk (loaded snapshot). Without
   * this the counter restarts at 0 every process launch, so the first save after
   * an app restart stamps revision 1 — which the DB CAS then rejects against a
   * row at (say) revision 50, silently dropping every edit until the RAM counter
   * catches up. Called at project-load commit. Monotonic (never lowers).
   */
  seedRevision(projectId: string, rev: number): void {
    if (!projectId || !Number.isFinite(rev) || rev <= 0) return
    this.nextRev.set(projectId, Math.max(this.nextRev.get(projectId) ?? 0, rev))
    this.committedRev.set(projectId, Math.max(this.committedRev.get(projectId) ?? 0, rev))
  }

  isDirty(projectId: string): boolean {
    return this.dirty.get(projectId) === true
  }

  markDirty(projectId: string): void {
    this.dirty.set(projectId, true)
  }

  /** Drop pending dirty for a project (e.g. after explicit abandon). */
  clearDirty(projectId: string): void {
    this.dirty.delete(projectId)
  }

  /**
   * Request a save. Multiple calls coalesce into at most one trailing capture
   * after the in-flight drain finishes.
   */
  requestSave<T extends SaveRevisionCarrier>(
    projectId: string,
    capture: CaptureFn<T>,
    persist: PersistFn<T>,
  ): Promise<void> {
    if (!projectId) return Promise.resolve()
    this.dirty.set(projectId, true)

    const prev = this.chain.get(projectId) ?? Promise.resolve()
    const run = prev
      .catch(() => {
        /* prior failure re-armed dirty; continue */
      })
      .then(() => this.drain(projectId, capture, persist))

    const linked = run.finally(() => {
      if (this.chain.get(projectId) === linked) this.chain.delete(projectId)
    })
    this.chain.set(projectId, linked)
    return linked
  }

  /** Wait until the chain for this project is idle (optional flush helper). */
  whenIdle(projectId: string): Promise<void> {
    return this.chain.get(projectId) ?? Promise.resolve()
  }

  private async drain<T extends SaveRevisionCarrier>(
    projectId: string,
    capture: CaptureFn<T>,
    persist: PersistFn<T>,
  ): Promise<void> {
    let staleRetries = 0
    while (this.dirty.get(projectId)) {
      this.dirty.set(projectId, false)
      const raw = await capture()
      if (raw == null) continue

      const rev = (this.nextRev.get(projectId) ?? 0) + 1
      this.nextRev.set(projectId, rev)
      const stamped = { ...raw, saveRevision: rev } as T

      try {
        const outcome = await persist(stamped)
        if (outcome && outcome.committed === false) {
          // The DB is ahead of our counter (unseeded path, or a rival tab wrote
          // a higher revision). Jump past it and retry so the edit still lands —
          // NEVER report success. Bounded so two live writers can't spin forever.
          const dbRev = outcome.dbRevision ?? rev
          this.nextRev.set(projectId, Math.max(rev, dbRev))
          if (staleRetries++ < MAX_STALE_RETRIES) {
            this.dirty.set(projectId, true)
            continue
          }
          throw new Error(
            `save skipped: DB revision ${dbRev} ≥ attempted ${rev} after ${staleRetries} retries`,
          )
        }
        staleRetries = 0
        this.committedRev.set(projectId, rev)
      } catch (e) {
        this.dirty.set(projectId, true)
        throw e
      }
    }
  }
}

/** Process-wide coordinator used by saveCurrentProject / autosave. */
export const projectSaveCoordinator = new ProjectSaveCoordinator()
