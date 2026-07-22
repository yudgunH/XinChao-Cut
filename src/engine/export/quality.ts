export type ExportQualityProfile = 'fast' | 'balanced' | 'quality'

export interface ExportQualityDefinition {
  id: ExportQualityProfile
  label: string
  videoBitrateMultiplier: number
  audioBitrateKbps: number
  maxKeyframeIntervalSec: number
}

export const EXPORT_QUALITY_PROFILES: readonly ExportQualityDefinition[] = [
  {
    id: 'fast',
    label: 'Fast',
    videoBitrateMultiplier: 0.75,
    audioBitrateKbps: 160,
    maxKeyframeIntervalSec: 4,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    videoBitrateMultiplier: 1,
    audioBitrateKbps: 192,
    maxKeyframeIntervalSec: 2,
  },
  {
    id: 'quality',
    label: 'High quality',
    videoBitrateMultiplier: 1.35,
    audioBitrateKbps: 256,
    maxKeyframeIntervalSec: 2,
  },
] as const

export function exportQualityDefinition(
  profile: ExportQualityProfile | undefined,
): ExportQualityDefinition {
  return EXPORT_QUALITY_PROFILES.find((item) => item.id === profile)
    ?? EXPORT_QUALITY_PROFILES[1]!
}
