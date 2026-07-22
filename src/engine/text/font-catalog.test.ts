import { describe, expect, it } from 'vitest'

import {
  FONT_CATALOG,
  fallbackCaptionFamiliesForText,
  fontByFamily,
} from './font-catalog'

describe('minimal open-source caption font catalog', () => {
  it('ships the two licensed bundled display fonts', () => {
    expect(FONT_CATALOG.filter((font) => font.file).map((font) => font.family)).toEqual([
      'Oswald',
      'Bangers',
    ])
  })

  it('resolves quoted CSS font stacks', () => {
    expect(fontByFamily('"Oswald", sans-serif')?.file).toBe('Oswald-Variable.ttf')
  })

  it('uses system fallback for scripts not included in the minimal font pack', () => {
    expect(fallbackCaptionFamiliesForText('Xin chào 日本語 안녕하세요')).toEqual([])
  })
})
