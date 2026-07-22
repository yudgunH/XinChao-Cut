import { describe, expect, it } from 'vitest'

import { EXPORT_QUALITY_PROFILES, exportQualityDefinition } from './quality'

describe('export quality profiles', () => {
  it('defaults unknown and missing profiles to balanced', () => {
    expect(exportQualityDefinition(undefined).id).toBe('balanced')
    expect(exportQualityDefinition('missing' as never).id).toBe('balanced')
  })

  it('increases audio/video quality monotonically', () => {
    const [fast, balanced, quality] = EXPORT_QUALITY_PROFILES
    expect(fast!.videoBitrateMultiplier).toBeLessThan(balanced!.videoBitrateMultiplier)
    expect(balanced!.videoBitrateMultiplier).toBeLessThan(quality!.videoBitrateMultiplier)
    expect(fast!.audioBitrateKbps).toBeLessThan(balanced!.audioBitrateKbps)
    expect(balanced!.audioBitrateKbps).toBeLessThan(quality!.audioBitrateKbps)
  })
})
