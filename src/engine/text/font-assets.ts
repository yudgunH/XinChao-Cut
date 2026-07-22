/** Heavy optional font URL graph, split from the editor entry chunk. */
const FONT_URL_LOADERS = import.meta.glob('../../assets/fonts-subset/*.{ttf,otf,TTF,OTF}', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>

const cache = new Map<string, string>()

export async function loadCaptionFontUrl(file: string): Promise<string | undefined> {
  const cached = cache.get(file)
  if (cached) return cached
  const hit = Object.keys(FONT_URL_LOADERS).find((key) => key.endsWith(`/${file}`))
  if (!hit) return undefined
  const url = await FONT_URL_LOADERS[hit]!()
  cache.set(file, url)
  return url
}
