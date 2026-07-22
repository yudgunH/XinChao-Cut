import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'

import { describe, expect, it } from 'vitest'

const BRAND_ASSET = '/logo.png'
const BRAND_COMPONENTS = [
  'src/components/home/HomeScreen.tsx',
  'src/components/top-bar/TopBar.tsx',
  'src/components/shortcuts/ShortcutsOverlay.tsx',
]

describe('packaged brand asset', () => {
  it('exists in public and every brand image references it', () => {
    expect(existsSync(resolve(cwd(), `public${BRAND_ASSET}`))).toBe(true)

    for (const component of BRAND_COMPONENTS) {
      const source = readFileSync(resolve(cwd(), component), 'utf8')
      expect(source).toContain(`src="${BRAND_ASSET}"`)
      expect(source).not.toContain('logo-preview-rounded.svg')
    }
  })
})
