/**
 * #10: module-scoped in-flight keys prevent stacked backfill jobs per asset.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  backfillInFlightCountForTests,
  beginBackfill,
  endBackfill,
  isBackfillInFlight,
  resetBackfillInFlightForTests,
} from './backfill-inflight'

describe('backfill-inflight (#10)', () => {
  afterEach(() => {
    resetBackfillInFlightForTests()
  })

  it('second begin for same asset+kind returns null while first is live', () => {
    const a = beginBackfill('asset-1', 'thumbnails')
    expect(a).not.toBeNull()
    expect(isBackfillInFlight('asset-1', 'thumbnails')).toBe(true)

    const b = beginBackfill('asset-1', 'thumbnails')
    expect(b).toBeNull()
    expect(backfillInFlightCountForTests()).toBe(1)
  })

  it('waveform and thumbnails for same asset can run in parallel (different kinds)', () => {
    const t = beginBackfill('asset-1', 'thumbnails')
    const w = beginBackfill('asset-1', 'waveform')
    expect(t).not.toBeNull()
    expect(w).not.toBeNull()
    expect(backfillInFlightCountForTests()).toBe(2)
  })

  it('endBackfill frees the slot so a new job can start', () => {
    const a = beginBackfill('asset-1', 'thumbnails')!
    endBackfill('asset-1', 'thumbnails', a)
    expect(isBackfillInFlight('asset-1', 'thumbnails')).toBe(false)
    const b = beginBackfill('asset-1', 'thumbnails')
    expect(b).not.toBeNull()
  })

  it('endBackfill with a stale controller does not clear a newer claim', () => {
    const a = beginBackfill('asset-1', 'thumbnails')!
    endBackfill('asset-1', 'thumbnails', a)
    const b = beginBackfill('asset-1', 'thumbnails')!
    endBackfill('asset-1', 'thumbnails', a) // stale
    expect(isBackfillInFlight('asset-1', 'thumbnails')).toBe(true)
    endBackfill('asset-1', 'thumbnails', b)
    expect(isBackfillInFlight('asset-1', 'thumbnails')).toBe(false)
  })
})
