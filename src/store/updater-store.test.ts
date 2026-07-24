import { describe, expect, it } from 'vitest'

import { describeUpdaterError, updatePercent } from './updater-store'

describe('updater helpers', () => {
  it('clamps download progress and handles unknown totals', () => {
    expect(updatePercent(50, 100)).toBe(50)
    expect(updatePercent(250, 100)).toBe(100)
    expect(updatePercent(50, null)).toBe(0)
    expect(updatePercent(-10, 100)).toBe(0)
  })

  it('turns invalid release metadata into an actionable message', () => {
    expect(
      describeUpdaterError(
        new Error('Could not fetch a valid release JSON from the remote'),
      ),
    ).toMatch(/GitHub Releases/i)
    expect(describeUpdaterError(new Error('request timeout'))).toMatch(/internet/i)
  })
})
