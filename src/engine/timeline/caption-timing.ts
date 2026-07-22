import { clipEffectiveDuration, type Clip, type WordTimestamp } from './types'

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const TOKEN_CLEAN_RE = /[^\p{L}\p{N}]+/gu

export type CaptionTimingIssue =
  | 'compound-timestamp'
  | 'invalid-timestamp'
  | 'text-timing-mismatch'

export interface NormalizedCaptionTiming {
  words: WordTimestamp[]
  repaired: boolean
  issues: CaptionTimingIssue[]
}

export interface CaptionTimingQaSummary {
  checkedCount: number
  repairedCount: number
  blockingCount: number
  issueCounts: Partial<Record<CaptionTimingIssue, number>>
}

const normalizationCache = new WeakMap<WordTimestamp[], {
  content: string
  duration: number
  result: NormalizedCaptionTiming
}>()

/** Tokenisation shared by timing repair. WhisperX normally returns one Latin
 * word per item, but its alignment-failure fallback can return a whole phrase;
 * CJK ASR often returns an unspaced phrase, so split that into characters. */
export function tokenizeCaptionText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (/\s/u.test(trimmed)) return trimmed.split(/\s+/u).filter(Boolean)
  if (CJK_RE.test(trimmed)) return Array.from(trimmed).filter((char) => !/\s/u.test(char))
  return [trimmed]
}

function comparable(token: string): string {
  return token.normalize('NFKC').toLocaleLowerCase().replace(TOKEN_CLEAN_RE, '')
}

function sameTokens(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((token, index) => comparable(token) === comparable(right[index] ?? ''))
}

function evenTimings(tokens: string[], startSec: number, endSec: number): WordTimestamp[] {
  if (tokens.length === 0) return []
  const span = Math.max(0.001, endSec - startSec)
  return tokens.map((word, index) => ({
    word,
    startSec: startSec + (index / tokens.length) * span,
    endSec: startSec + ((index + 1) / tokens.length) * span,
  }))
}

/** Align corrected tokens to ASR tokens with LCS. Matching words keep their
 * measured timing; inserted/replaced runs are interpolated only in the nearest
 * anchor gap instead of redistributing the whole sentence. */
function alignedTimings(tokens: string[], observed: WordTimestamp[]): WordTimestamp[] | null {
  const n = tokens.length
  const m = observed.length
  if (n === 0 || m === 0 || n * m > 20_000) return null
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = comparable(tokens[i]!) === comparable(observed[j]!.word)
        && comparable(tokens[i]!) !== ''
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  if (dp[0]![0] === 0) return null
  const matches: Array<{ token: number; observed: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (
      comparable(tokens[i]!) !== ''
      && comparable(tokens[i]!) === comparable(observed[j]!.word)
    ) {
      matches.push({ token: i++, observed: j++ })
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }

  const out: Array<WordTimestamp | undefined> = Array(n)
  for (const match of matches) {
    const timing = observed[match.observed]!
    out[match.token] = { ...timing, word: tokens[match.token]! }
  }
  const anchors = [
    { token: -1, startSec: observed[0]!.startSec, endSec: observed[0]!.startSec },
    ...matches.map((match) => ({ token: match.token, ...observed[match.observed]! })),
    {
      token: n,
      startSec: observed[m - 1]!.endSec,
      endSec: observed[m - 1]!.endSec,
    },
  ]
  for (let anchor = 0; anchor < anchors.length - 1; anchor++) {
    const left = anchors[anchor]!
    const right = anchors[anchor + 1]!
    const runStart = left.token + 1
    const runEnd = right.token
    if (runEnd <= runStart) continue
    let start = left.endSec
    let end = right.startSec
    // Adjacent ASR words often have no literal gap. Give inserted text the
    // local anchor span (overlap only this tiny neighborhood), never the full cue.
    if (end - start < 0.001 * (runEnd - runStart)) {
      start = left.token >= 0 ? left.startSec : start
      end = right.token < n ? right.endSec : end
    }
    const interpolated = evenTimings(tokens.slice(runStart, runEnd), start, Math.max(start + 0.001, end))
    for (let k = 0; k < interpolated.length; k++) out[runStart + k] = interpolated[k]
  }
  return out.every(Boolean) ? out as WordTimestamp[] : null
}

/**
 * Repair timestamp payloads without changing caption text.
 *
 * The important production case is a WhisperX alignment exception where the
 * backend historically stored an entire sentence in one `word` entry. The
 * renderer interpreted that as one word, producing giant cues and a karaoke
 * highlight that stayed active for the whole sentence. Compound entries are
 * expanded over their original time span. If ASR text and caption text no
 * longer correspond, the caption text wins and receives safe even timings over
 * the observed speech span.
 */
export function normalizeCaptionWordTimestamps(
  content: string,
  timestamps: WordTimestamp[] | undefined,
  clipDurationSec: number,
): NormalizedCaptionTiming {
  if (!timestamps?.length) return { words: [], repaired: false, issues: [] }

  const duration = Number.isFinite(clipDurationSec) && clipDurationSec > 0
    ? clipDurationSec
    : Number.POSITIVE_INFINITY
  const issues = new Set<CaptionTimingIssue>()
  const expanded: WordTimestamp[] = []

  for (const raw of timestamps) {
    const tokens = tokenizeCaptionText(String(raw?.word ?? ''))
    const rawStart = Number(raw?.startSec)
    const rawEnd = Number(raw?.endSec)
    if (tokens.length === 0 || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      issues.add('invalid-timestamp')
      continue
    }

    const start = Math.max(0, Math.min(duration, rawStart))
    const end = Math.max(start, Math.min(duration, rawEnd))
    if (start !== rawStart || end !== rawEnd || end <= start) issues.add('invalid-timestamp')
    if (end <= start) continue
    if (tokens.length > 1) issues.add('compound-timestamp')
    expanded.push(...evenTimings(tokens, start, end))
  }

  const contentTokens = tokenizeCaptionText(content)
  if (contentTokens.length === 0) {
    return { words: [], repaired: timestamps.length > 0, issues: [...issues] }
  }

  if (expanded.length > 0 && sameTokens(contentTokens, expanded.map((word) => word.word))) {
    const words = expanded.map((timing, index) => ({
      ...timing,
      // Timing labels are also used as Server karaoke render text. Use the
      // corrected caption token so punctuation/casing edits are not lost even
      // when their normalized lexical value still matches the ASR token.
      word: contentTokens[index]!,
    }))
    const labelsChanged = words.some((word, index) => word.word !== expanded[index]!.word)
    return { words, repaired: issues.size > 0 || labelsChanged, issues: [...issues] }
  }

  issues.add('text-timing-mismatch')
  const aligned = alignedTimings(contentTokens, expanded)
  if (aligned) {
    return { words: aligned, repaired: true, issues: [...issues] }
  }
  const observedStart = expanded[0]?.startSec ?? 0
  const observedEnd = expanded[expanded.length - 1]?.endSec
    ?? (Number.isFinite(duration) ? duration : observedStart + Math.max(0.1, contentTokens.length * 0.25))
  const safeEnd = Number.isFinite(duration) ? Math.min(duration, observedEnd) : observedEnd
  return {
    words: evenTimings(contentTokens, observedStart, Math.max(observedStart + 0.1, safeEnd)),
    repaired: true,
    issues: [...issues],
  }
}

/** Cached path for the per-frame canvas renderer. Timeline updates replace
 * textData/timestamp arrays immutably, so array identity is a safe cache key. */
export function cachedNormalizedCaptionWordTimestamps(
  content: string,
  timestamps: WordTimestamp[] | undefined,
  clipDurationSec: number,
): NormalizedCaptionTiming {
  if (!timestamps?.length) return { words: [], repaired: false, issues: [] }
  const cached = normalizationCache.get(timestamps)
  if (cached?.content === content && cached.duration === clipDurationSec) return cached.result
  const result = normalizeCaptionWordTimestamps(content, timestamps, clipDurationSec)
  normalizationCache.set(timestamps, { content, duration: clipDurationSec, result })
  return result
}

/** Inspect every word-timed caption before export. Repairable legacy payloads
 * are reported to the user; malformed data that remains unsafe after repair is
 * a hard gate rather than silently producing a broken burn. */
export function summarizeCaptionTimingQa(clips: Clip[]): CaptionTimingQaSummary {
  const summary: CaptionTimingQaSummary = {
    checkedCount: 0,
    repairedCount: 0,
    blockingCount: 0,
    issueCounts: {},
  }
  for (const clip of clips) {
    const td = clip.textData
    if (!td?.content.trim() || !td.wordTimestamps?.length) continue
    summary.checkedCount++
    const duration = clipEffectiveDuration(clip)
    const result = cachedNormalizedCaptionWordTimestamps(td.content, td.wordTimestamps, duration)
    if (result.repaired) summary.repairedCount++
    for (const issue of result.issues) {
      summary.issueCounts[issue] = (summary.issueCounts[issue] ?? 0) + 1
    }
    if (
      result.words.length === 0
      || result.words.some((word) =>
        !Number.isFinite(word.startSec)
        || !Number.isFinite(word.endSec)
        || word.startSec < 0
        || word.endSec <= word.startSec
        || word.endSec > duration + 0.001)
    ) {
      summary.blockingCount++
    }
  }
  return summary
}
