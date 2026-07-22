export type VoiceGender = 'male' | 'female' | 'unknown'

export interface VoiceLike {
  id: string
  name: string
  type?: string
  gender?: string | null
  language?: string | null
}

export const VOICE_GENDER_GROUPS: { id: VoiceGender; label: string; shortLabel: string }[] = [
  { id: 'male', label: 'Giọng nam', shortLabel: 'Nam' },
  { id: 'female', label: 'Giọng nữ', shortLabel: 'Nữ' },
  { id: 'unknown', label: 'Chưa rõ', shortLabel: 'Chưa rõ' },
]

const LANGUAGE_LABELS: Record<string, string> = {
  vi: 'Tiếng Việt',
  en: 'Tiếng Anh',
  ja: 'Tiếng Nhật',
  ko: 'Tiếng Hàn',
  de: 'Tiếng Đức',
  zh: 'Tiếng Trung',
  multi: 'Đa ngôn ngữ',
  unknown: 'Chưa rõ ngôn ngữ',
}

const LANGUAGE_ORDER = ['vi', 'en', 'ko', 'ja', 'de', 'zh', 'multi', 'unknown']

export function normalizeVoiceGender(gender?: string | null): VoiceGender {
  if (gender === 'male' || gender === 'female') return gender
  return 'unknown'
}

export function voiceGenderLabel(gender?: string | null): string {
  return VOICE_GENDER_GROUPS.find((group) => group.id === normalizeVoiceGender(gender))?.shortLabel ?? 'Chưa rõ'
}

export function normalizeVoiceLanguage(language?: string | null): string {
  const raw = (language ?? '').trim().toLowerCase()
  const aliases: Record<string, string> = {
    vn: 'vi',
    vie: 'vi',
    vietnamese: 'vi',
    eng: 'en',
    english: 'en',
    jp: 'ja',
    jpn: 'ja',
    japanese: 'ja',
    kr: 'ko',
    kor: 'ko',
    korean: 'ko',
    ger: 'de',
    deu: 'de',
    german: 'de',
    cn: 'zh',
    chi: 'zh',
    chinese: 'zh',
  }
  return aliases[raw] ?? raw
}

/**
 * Language bucket for grouping in pickers. Backend `/tts/voices` already
 * resolves `language` (`_voice_language`); listTtsVoices normalizes it onto
 * each TtsVoice. We only normalize the field here — no id tables / name
 * heuristics (those drifted from the backend). Missing language → 'unknown'.
 */
export function inferVoiceLanguage(voice: VoiceLike): string {
  return normalizeVoiceLanguage(voice.language) || 'unknown'
}

export function voiceLanguageLabel(language?: string | null): string {
  const code = normalizeVoiceLanguage(language) || 'unknown'
  return LANGUAGE_LABELS[code] ?? code.toUpperCase()
}

export function voiceSearchText(voice: VoiceLike): string {
  const gender = voiceGenderLabel(voice.gender)
  const language = voiceLanguageLabel(inferVoiceLanguage(voice))
  return `${voice.name} ${voice.type ?? ''} ${gender} ${language} ${inferVoiceLanguage(voice)}`.toLowerCase()
}

export function groupVoicesByLanguageAndGender<T extends VoiceLike>(voices: T[]) {
  const languageCodes = Array.from(new Set(voices.map((voice) => inferVoiceLanguage(voice))))
  languageCodes.sort((a, b) => {
    const rankA = LANGUAGE_ORDER.indexOf(a)
    const rankB = LANGUAGE_ORDER.indexOf(b)
    if (rankA !== -1 || rankB !== -1) return (rankA === -1 ? 999 : rankA) - (rankB === -1 ? 999 : rankB)
    return voiceLanguageLabel(a).localeCompare(voiceLanguageLabel(b))
  })

  return languageCodes.map((language) => {
    const languageVoices = voices.filter((voice) => inferVoiceLanguage(voice) === language)
    return {
      id: language,
      label: voiceLanguageLabel(language),
      voices: languageVoices,
      genderGroups: VOICE_GENDER_GROUPS.map((gender) => ({
        ...gender,
        voices: languageVoices.filter((voice) => normalizeVoiceGender(voice.gender) === gender.id),
      })).filter((group) => group.voices.length > 0),
    }
  })
}
