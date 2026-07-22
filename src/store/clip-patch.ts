import type { Clip } from '@engine/timeline'

type ClipPatcher = (clip: Clip) => Clip

// The cache belongs to an immutable array revision. A successful replacement
// preserves positions/ids, so its map can safely carry forward to the new array.
const indexByArray = new WeakMap<readonly Clip[], Map<string, number>>()

function indexFor(clips: readonly Clip[]): Map<string, number> {
  const cached = indexByArray.get(clips)
  if (cached) return cached
  const built = new Map<string, number>()
  for (let index = 0; index < clips.length; index++) built.set(clips[index]!.id, index)
  indexByArray.set(clips, built)
  return built
}

export function patchClipById(clips: readonly Clip[], id: string, patch: ClipPatcher): Clip[] | readonly Clip[] {
  let index = indexFor(clips).get(id)
  // Defend against accidental in-place mutation violating the immutable-store invariant.
  if (index === undefined || clips[index]?.id !== id) {
    indexByArray.delete(clips)
    index = indexFor(clips).get(id)
  }
  if (index === undefined) return clips
  const current = clips[index]!
  const replacement = patch(current)
  if (replacement === current) return clips
  const next = clips.slice()
  next[index] = replacement
  if (replacement.id === current.id) indexByArray.set(next, indexFor(clips))
  return next
}

export function patchClipsById(
  clips: readonly Clip[],
  ids: Iterable<string>,
  patch: ClipPatcher,
): Clip[] | readonly Clip[] {
  const index = indexFor(clips)
  let next: Clip[] | null = null
  let idsStable = true
  for (const id of new Set(ids)) {
    const position = index.get(id)
    if (position === undefined || clips[position]?.id !== id) continue
    const current = (next ?? clips)[position]!
    const replacement = patch(current)
    if (replacement === current) continue
    next ??= clips.slice()
    next[position] = replacement
    idsStable &&= replacement.id === current.id
  }
  if (!next) return clips
  if (idsStable) indexByArray.set(next, index)
  return next
}
