/**
 * Single source of truth for the bundled caption fonts. Used by:
 *  - the caption UI font picker (labels + live previews),
 *  - the preview/main-thread canvas (fonts also declared as @font-face in
 *    reset.css so the DOM can preview them),
 *  - the export WORKER, which has NO access to the document's @font-face rules,
 *    so it must register these FontFaces into its own FontFaceSet before drawing
 *    captions (else custom-font captions render in a fallback face).
 *
 * `cat` groups fonts in the picker: 'vn' = full Vietnamese diacritics, 'jp'/'kr'
 * = Japanese/Korean display faces (Latin only for VN — use for stylistic text).
 */
export type FontCategory = 'vn' | 'jp' | 'kr'

export interface CaptionFont {
  /** Font-family name as embedded in the file — what ctx.font / CSS must use. */
  family: string
  /** Short human label for the picker. */
  label: string
  /** Bundled file name under generated src/assets/fonts-subset. */
  file: string
  cat: FontCategory
  /** The font's REAL internal family name (name table ID1) when it differs from
   *  `family`. libass matches by internal name, so the server export must write
   *  this into the ASS Fontname or the face silently falls back. */
  assFamily?: string
  /** (usWinAscent+usWinDescent)/unitsPerEm — libass (VSFilter-compat) scales a
   *  font so its win-cell height equals the ASS Fontsize, while canvas px are
   *  em units. Multiplying the ASS Fontsize by this ratio makes the burned text
   *  the same visual size as the preview. Measured with fonttools; 1 when the
   *  cell equals the em. */
  sizeScale?: number
}

// The URL graph lives behind a dynamic module so the editor entry and CSS do
// not eagerly pull the optional font pack into the startup dependency graph.
const fontUrlCache = new Map<string, string>()

async function urlForFile(file: string): Promise<string | undefined> {
  const cached = fontUrlCache.get(file)
  if (cached) return cached
  const { loadCaptionFontUrl } = await import('./font-assets')
  const url = await loadCaptionFontUrl(file)
  if (!url) return undefined
  fontUrlCache.set(file, url)
  return url
}

// assFamily/sizeScale measured from the actual font files (fonttools: name ID1,
// unitsPerEm, OS/2 usWinAscent+usWinDescent). Re-run the scan when adding fonts.
export const FONT_CATALOG: CaptionFont[] = [
  { family: 'Inter', label: 'Inter', file: '', cat: 'vn' },
  { family: 'Oswald', label: 'Oswald', file: 'Oswald-Variable.ttf', cat: 'vn', sizeScale: 1.702 },
  { family: 'Bangers', label: 'Bangers', file: 'Bangers-Regular.ttf', cat: 'vn', sizeScale: 1.757 },
]

/** Look up a catalog entry by its family name (as stored in TextClipData.fontFamily). */
export function fontByFamily(family: string): CaptionFont | undefined {
  return FONT_CATALOG.find((f) => f.family === family || family.startsWith(`"${f.family}"`) || family.startsWith(f.family))
}

/** Bundled libass fallback faces for scripts a Latin/Vietnamese display font
 * may not contain. Canvas/Chromium does this fallback automatically; server
 * export needs the actual fallback files shipped into fontsdir. */
export function fallbackCaptionFamiliesForText(_text: string): string[] {
  return []
}

/**
 * Bundled font files needed to render the given `fontFamily` stacks — used by
 * the server export to ship the actual .ttf/.otf files to libass (fontsdir),
 * so the burn uses the same faces as the canvas preview instead of a system
 * fallback. Family matching mirrors the backend's `_font_name`: first entry of
 * the stack, quotes stripped. Deduped by file; system fonts (no file) skipped.
 */
export interface BundledFontRef {
  family: string
  file: string
  url: string
  /** libass-visible family name (internal ID1) — see CaptionFont.assFamily. */
  assFamily: string
  /** ASS Fontsize multiplier — see CaptionFont.sizeScale. */
  sizeScale: number
}

export async function bundledFontsForFamilies(families: Iterable<string>): Promise<BundledFontRef[]> {
  const out = new Map<string, BundledFontRef>()
  for (const stack of families) {
    const first = (stack || '').split(',')[0]!.trim().replace(/^["']|["']$/g, '')
    const hit = FONT_CATALOG.find((f) => f.family === first)
    if (!hit?.file || out.has(hit.file)) continue
    const url = await urlForFile(hit.file)
    if (url) {
      out.set(hit.file, {
        family: hit.family,
        file: hit.file,
        url,
        assFamily: hit.assFamily ?? hit.family,
        sizeScale: hit.sizeScale ?? 1,
      })
    }
  }
  return [...out.values()]
}

const registeredBySet = new WeakMap<FontFaceSet, Set<string>>()

/**
 * Add only requested bundled fonts to `fontSet` (document.fonts or worker
 * self.fonts). The optional font URL module and each face load on first use.
 * Idempotent per FontFaceSet; workers do not inherit document font rules.
 */
export async function registerCaptionFontFaces(
  families: Iterable<string>,
  fontSet?: FontFaceSet,
): Promise<void> {
  const set = fontSet ?? (globalThis as unknown as { fonts?: FontFaceSet }).fonts
  if (!set) return
  let registered = registeredBySet.get(set)
  if (!registered) {
    registered = new Set()
    registeredBySet.set(set, registered)
  }
  for (const family of families) {
    const font = fontByFamily(family)
    if (!font?.file) continue // system/unknown font (Inter)
    if (registered.has(font.family)) continue
    const url = await urlForFile(font.file)
    if (!url) continue
    try {
      set.add(new globalThis.FontFace(font.family, `url(${JSON.stringify(url)})`, { display: 'swap' }))
      registered.add(font.family)
    } catch {
      // Duplicate family or malformed URL — skip; a fallback face still renders.
    }
  }
}
