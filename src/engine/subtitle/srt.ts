export interface SubtitleCue {
  startSec: number
  endSec: number
  content: string
  words?: { word: string; startSec: number; endSec: number }[] // relative to startSec
}

const MIN_REPEAT_TOKENS = 3
const REPEAT_GRACE_SEC = 0.6
const REPEAT_WINDOW_SEC = 8

const TC = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/

interface Token {
  raw: string
  key: string
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function tokenize(text: string): Token[] {
  return (text.match(/\S+/g) ?? [])
    .map((raw) => ({ raw, key: normalizeToken(raw) }))
    .filter((token) => token.key.length > 0)
}

function normalizedText(text: string): string {
  return tokenize(text)
    .map((token) => token.key)
    .join(' ')
}

function overlapsOrTouches(a: SubtitleCue, b: SubtitleCue): boolean {
  return a.startSec <= b.endSec + REPEAT_GRACE_SEC && b.startSec <= a.endSec + REPEAT_GRACE_SEC
}

function overlapRatio(a: SubtitleCue, b: SubtitleCue): number {
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec)
  if (overlap <= 0) return 0
  const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec)
  return shorter > 0 ? overlap / shorter : 0
}

function matchingPrefixLength(tokens: Token[], previous: Token[], startIndex: number): number {
  let length = 0
  while (
    length < tokens.length &&
    startIndex + length < previous.length &&
    tokens[length]!.key === previous[startIndex + length]!.key
  ) {
    length++
  }
  return length
}

function repeatedPrefixLength(cue: SubtitleCue, tokens: Token[], accepted: SubtitleCue[]): number {
  let best = 0
  for (let i = accepted.length - 1; i >= 0; i--) {
    const prev = accepted[i]!
    if (cue.startSec - prev.endSec > REPEAT_WINDOW_SEC) break
    if (!overlapsOrTouches(prev, cue)) continue

    const prevTokens = tokenize(prev.content)
    for (let j = 0; j < prevTokens.length; j++) {
      const length = matchingPrefixLength(tokens, prevTokens, j)
      if (length >= MIN_REPEAT_TOKENS) best = Math.max(best, length)
    }
  }
  return best
}

function trimCuePrefix<T extends SubtitleCue>(cue: T, dropTokens: number): T | null {
  const words = cue.words?.filter((word) => word.word.trim())
  if (words && words.length >= dropTokens) {
    const kept = words.slice(dropTokens)
    if (kept.length === 0) return null
    const startOffset = kept[0]!.startSec
    const endOffset = kept[kept.length - 1]!.endSec
    const startSec = cue.startSec + startOffset
    return {
      ...cue,
      startSec,
      endSec: Math.max(cue.startSec + endOffset, startSec + 0.3),
      content: kept.map((word) => word.word).join(' '),
      words: kept.map((word) => ({
        word: word.word,
        startSec: Math.max(0, word.startSec - startOffset),
        endSec: Math.max(0.05, word.endSec - startOffset),
      })),
    }
  }

  const kept = (cue.content.match(/\S+/g) ?? []).slice(dropTokens)
  if (kept.length === 0) return null
  return { ...cue, content: kept.join(' ') }
}

function isDuplicateOfAccepted(cue: SubtitleCue, tokens: Token[], accepted: SubtitleCue): boolean {
  if (!overlapsOrTouches(cue, accepted)) return false

  const text = tokens.map((token) => token.key).join(' ')
  const acceptedText = normalizedText(accepted.content)
  if (!text || !acceptedText) return false
  if (text === acceptedText) return true

  const acceptedTokens = tokenize(accepted.content)
  return (
    tokens.length <= acceptedTokens.length &&
    acceptedText.includes(text) &&
    overlapRatio(cue, accepted) >= 0.45
  )
}

/** Remove overlapping ASR repeats while preserving real repeated speech after a gap. */
export function dedupeSubtitleCues<T extends SubtitleCue>(cues: T[]): T[] {
  const ordered = [...cues]
    .filter((cue) => cue.content.trim() && cue.endSec > cue.startSec)
    .sort((a, b) => a.startSec - b.startSec || b.endSec - a.endSec)

  const out: T[] = []
  for (const original of ordered) {
    let cue: T | null = { ...original, content: original.content.trim() }
    let tokens = tokenize(cue.content)
    if (tokens.length === 0) continue

    const dropTokens = repeatedPrefixLength(cue, tokens, out)
    if (dropTokens >= MIN_REPEAT_TOKENS) {
      cue = trimCuePrefix(cue, dropTokens)
      if (!cue) continue
      tokens = tokenize(cue.content)
      if (tokens.length === 0) continue
    }

    const duplicate = out.find((accepted) => isDuplicateOfAccepted(cue!, tokens, accepted))
    if (duplicate) {
      duplicate.endSec = Math.max(duplicate.endSec, cue.endSec)
      continue
    }
    out.push(cue)
  }
  return out
}

function toSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

function pad(n: number, width: number): string {
  return Math.max(0, Math.floor(n)).toString().padStart(width, '0')
}

/** Format seconds as an SRT timecode: HH:MM:SS,mmm */
function toTimecode(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`
}

/** Serialize timed cues into an SRT document. */
export function buildSrt(cues: SubtitleCue[]): string {
  const ordered = dedupeSubtitleCues(cues)
    .filter((c) => c.content.trim() && c.endSec > c.startSec)
    .sort((a, b) => a.startSec - b.startSec)
  return (
    ordered
      .map((c, i) =>
        `${i + 1}\n${toTimecode(c.startSec)} --> ${toTimecode(c.endSec)}\n${c.content.trim()}`,
      )
      .join('\n\n') + '\n'
  )
}

/** Parse an SRT (or VTT-ish) subtitle file into timed cues. */
export function parseSrt(text: string): SubtitleCue[] {
  const blocks = text
    .replace(/\r/g, '')
    .replace(/^WEBVTT.*$/m, '')
    .trim()
    .split(/\n{2,}/)

  const cues: SubtitleCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const tcIndex = lines.findIndex((l) => TC.test(l))
    if (tcIndex < 0) continue
    const m = TC.exec(lines[tcIndex]!)
    if (!m) continue
    const startSec = toSec(m[1]!, m[2]!, m[3]!, m[4]!)
    const endSec = toSec(m[5]!, m[6]!, m[7]!, m[8]!)
    const content = lines
      .slice(tcIndex + 1)
      .join('\n')
      .trim()
    if (content && endSec > startSec) cues.push({ startSec, endSec, content })
  }
  return cues
}
