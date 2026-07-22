import { describe, expect, it } from 'vitest'

import {
  ProjectSaveCoordinator,
  mayCommitRevision,
  type SaveRevisionCarrier,
} from './project-save-coordinator'

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('F19 autosave race — reproduction', () => {
  it('CONFIRMED: older save completing last overwrites newer snapshot (naive)', async () => {
    let db = ''
    const writes: string[] = []
    const holdOld = deferred<void>()

    // Save OLD: capture first, put held
    const pOld = (async () => {
      const snap = 'OLD_TIMELINE'
      await holdOld.promise
      db = snap
      writes.push(snap)
    })()

    // Save NEW: put completes immediately (simulates faster second save)
    const pNew = (async () => {
      const snap = 'NEW_TIMELINE'
      db = snap
      writes.push(snap)
    })()

    await pNew
    expect(db).toBe('NEW_TIMELINE')
    holdOld.resolve()
    await pOld

    // Race: final is OLD — F19 overwrite confirmed.
    expect(db).toBe('OLD_TIMELINE')
    expect(writes).toEqual(['NEW_TIMELINE', 'OLD_TIMELINE'])
  })
})

describe('ProjectSaveCoordinator — fix', () => {
  it('out-of-order intent: final committed snapshot is the latest capture', async () => {
    const coord = new ProjectSaveCoordinator()
    let live = 'v1'
    const writes: Array<{ body: string; rev: number }> = []
    const holdFirst = deferred<void>()
    let first = true

    const persist = async (snap: { body: string } & SaveRevisionCarrier) => {
      if (first) {
        first = false
        await holdFirst.promise
      }
      writes.push({ body: snap.body, rev: snap.saveRevision! })
    }

    const p1 = coord.requestSave('p1', () => ({ id: 'p1', body: live }), persist)
    live = 'v2'
    const p2 = coord.requestSave('p1', () => ({ id: 'p1', body: live }), persist)
    live = 'v3'
    const p3 = coord.requestSave('p1', () => ({ id: 'p1', body: live }), persist)

    holdFirst.resolve()
    await Promise.all([p1, p2, p3])

    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(writes[writes.length - 1]!.body).toBe('v3')
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i]!.rev).toBeGreaterThan(writes[i - 1]!.rev)
    }
  })

  it('edit during save is coalesced into trailing write', async () => {
    const coord = new ProjectSaveCoordinator()
    let live = 'before'
    const bodies: string[] = []
    const hold = deferred<void>()
    let entered = false

    const p1 = coord.requestSave(
      'p1',
      () => ({ id: 'p1', body: live }),
      async (s) => {
        if (!entered) {
          entered = true
          await hold.promise
        }
        bodies.push((s as { body: string }).body)
      },
    )
    live = 'during'
    const p2 = coord.requestSave('p1', () => ({ id: 'p1', body: live }), async (s) => {
      bodies.push((s as { body: string }).body)
    })
    hold.resolve()
    await Promise.all([p1, p2])
    expect(bodies[bodies.length - 1]).toBe('during')
  })

  it('save fail re-arms dirty; retry persists latest', async () => {
    const coord = new ProjectSaveCoordinator()
    let live = 'A'
    let failOnce = true
    const writes: string[] = []

    await expect(
      coord.requestSave(
        'p1',
        () => ({ id: 'p1', body: live }),
        async () => {
          if (failOnce) {
            failOnce = false
            throw new Error('disk full')
          }
        },
      ),
    ).rejects.toThrow('disk full')
    expect(coord.isDirty('p1')).toBe(true)

    live = 'B'
    await coord.requestSave(
      'p1',
      () => ({ id: 'p1', body: live }),
      async (s) => {
        writes.push((s as { body: string }).body)
      },
    )
    expect(writes.at(-1)).toBe('B')
    expect(coord.isDirty('p1')).toBe(false)
  })

  it('mayCommitRevision rejects strictly older revision', () => {
    expect(mayCommitRevision(1, 2)).toBe(false)
    expect(mayCommitRevision(2, 2)).toBe(true)
    expect(mayCommitRevision(3, 2)).toBe(true)
    expect(mayCommitRevision(undefined, 5)).toBe(true)
    expect(mayCommitRevision(5, undefined)).toBe(true)
  })

  it('no infinite loop when capture is stable', async () => {
    const coord = new ProjectSaveCoordinator()
    let n = 0
    await coord.requestSave(
      'p1',
      () => ({ id: 'p1', body: 'x' }),
      async () => {
        n++
      },
    )
    expect(n).toBe(1)
    expect(coord.isDirty('p1')).toBe(false)
  })

  it('CAS drops a stale put that races after a newer commit', async () => {
    let dbRev = 0
    let dbBody = ''
    // Simulate two puts where older revision arrives late:
    const apply = (body: string, rev: number) => {
      if (!mayCommitRevision(rev, dbRev)) return false
      dbRev = rev
      dbBody = body
      return true
    }
    expect(apply('new', 2)).toBe(true)
    expect(apply('old', 1)).toBe(false)
    expect(dbBody).toBe('new')
    expect(dbRev).toBe(2)
  })

  it('switch project: independent chains', async () => {
    const coord = new ProjectSaveCoordinator()
    const out: string[] = []
    await Promise.all([
      coord.requestSave(
        'A',
        () => ({ id: 'A', body: 'a' }),
        async (s) => {
          out.push(`A:${(s as { body: string }).body}`)
        },
      ),
      coord.requestSave(
        'B',
        () => ({ id: 'B', body: 'b' }),
        async (s) => {
          out.push(`B:${(s as { body: string }).body}`)
        },
      ),
    ])
    expect(out.sort()).toEqual(['A:a', 'B:b'])
  })
})

describe('S13/F19 — restart data loss (revision seeding + non-silent skip)', () => {
  it('seedRevision makes the first save land above the on-disk revision', async () => {
    const coord = new ProjectSaveCoordinator()
    // Simulate a DB row already at revision 50 (e.g. after 50 saves last session).
    let dbRev = 50
    const stamped: number[] = []
    // Without seeding the first save would stamp rev 1 and be rejected forever.
    coord.seedRevision('p1', dbRev)
    await coord.requestSave(
      'p1',
      () => ({ id: 'p1' }),
      async (s: SaveRevisionCarrier) => {
        const rev = s.saveRevision ?? 0
        stamped.push(rev)
        if (rev < dbRev) return { committed: false, dbRevision: dbRev }
        dbRev = rev
        return { committed: true }
      },
    )
    expect(stamped).toEqual([51])
    expect(dbRev).toBe(51)
    expect(coord.getCommittedRevision('p1')).toBe(51)
  })

  it('a stale skip re-arms and retries with a higher revision (no silent drop)', async () => {
    const coord = new ProjectSaveCoordinator()
    // Unseeded coordinator (revision counter at 0) against a DB at revision 50.
    let dbRev = 50
    const stamped: number[] = []
    await coord.requestSave(
      'p1',
      () => ({ id: 'p1' }),
      async (s: SaveRevisionCarrier) => {
        const rev = s.saveRevision ?? 0
        stamped.push(rev)
        if (rev < dbRev) return { committed: false, dbRevision: dbRev }
        dbRev = rev
        return { committed: true }
      },
    )
    // First attempt stamps 1 (skip → dbRevision 50), retry jumps to 51 and commits.
    expect(stamped).toEqual([1, 51])
    expect(dbRev).toBe(51)
    expect(coord.isDirty('p1')).toBe(false)
  })

  it('a persistently-ahead DB (rival writer) throws after bounded retries', async () => {
    const coord = new ProjectSaveCoordinator()
    let attempts = 0
    await expect(
      coord.requestSave(
        'p1',
        () => ({ id: 'p1' }),
        async () => {
          attempts++
          // Always ahead — simulate another tab bumping the revision each time.
          return { committed: false, dbRevision: 1000 + attempts }
        },
      ),
    ).rejects.toThrow(/save skipped/)
    // 1 initial + MAX_STALE_RETRIES retries, then it gives up.
    expect(attempts).toBe(4)
    expect(coord.isDirty('p1')).toBe(true)
  })
})
