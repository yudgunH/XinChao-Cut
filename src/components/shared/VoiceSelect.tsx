import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

import type { TtsVoice } from '@engine/backend'
import {
  groupVoicesByLanguageAndGender,
  inferVoiceLanguage,
  voiceGenderLabel,
  voiceLanguageLabel,
  voiceSearchText,
} from './voiceCatalog'

function voiceLabel(voice: TtsVoice): string {
  return voice.name
}

export function VoiceSelect({
  voices,
  value,
  onChange,
  disabled,
  defaultLabel = 'Default',
  placeholder = 'Search voices...',
  className = '',
}: {
  voices: TtsVoice[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  defaultLabel?: string
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = voices.find((voice) => voice.id === value)
  const selectedLabel = selected ? voiceLabel(selected) : defaultLabel

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return voices
    return voices.filter((voice) => voiceSearchText(voice).includes(q))
  }, [query, voices])
  const grouped = useMemo(() => groupVoicesByLanguageAndGender(filtered), [filtered])

  const updateMenuPosition = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const gap = 6
    const spaceBelow = window.innerHeight - rect.bottom - gap
    const spaceAbove = rect.top - gap
    const maxHeight = Math.max(180, Math.min(360, Math.max(spaceBelow, spaceAbove) - 8))
    const opensUp = spaceBelow < 260 && spaceAbove > spaceBelow
    setMenuStyle({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      top: opensUp ? Math.max(8, rect.top - maxHeight - gap) : Math.min(window.innerHeight - 8, rect.bottom + gap),
      width: rect.width,
      maxHeight,
    })
  }, [])

  useLayoutEffect(() => {
    if (open) updateMenuPosition()
  }, [open, updateMenuPosition])

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => searchRef.current?.focus(), 0)
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    function onGeometryChange() {
      updateMenuPosition()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onGeometryChange)
    window.addEventListener('scroll', onGeometryChange, true)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onGeometryChange)
      window.removeEventListener('scroll', onGeometryChange, true)
    }
  }, [open, updateMenuPosition])

  function pick(next: string) {
    onChange(next)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-md bg-bg-2 px-3 py-2 text-left text-xs text-text-1 ring-1 ring-border hover:bg-bg-3 focus:outline-none focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        {selected && (
          <>
            <span className="shrink-0 rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-text-3">
              {voiceLanguageLabel(inferVoiceLanguage(selected))}
            </span>
            <span className="shrink-0 rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-text-3">
              {selected.type === 'clone' ? `clone / ${voiceGenderLabel(selected.gender)}` : voiceGenderLabel(selected.gender)}
            </span>
          </>
        )}
        <ChevronDown size={13} className={`shrink-0 text-text-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          style={menuStyle}
          className="fixed z-[120] overflow-hidden rounded-md border border-border bg-bg-1 shadow-e3"
        >
          <div className="flex items-center gap-2 border-b border-border bg-bg-2 px-2.5 py-2">
            <Search size={13} className="shrink-0 text-text-3" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-xs text-text-1 outline-none placeholder:text-text-3"
            />
          </div>

          <div className="overflow-auto py-1" style={{ maxHeight: `calc(${menuStyle.maxHeight}px - 41px)` }}>
            <button
              type="button"
              onClick={() => pick('')}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-bg-2 ${
                value === '' ? 'text-accent' : 'text-text-1'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{defaultLabel}</span>
              {value === '' && <Check size={13} className="shrink-0" />}
            </button>

            {grouped.map((languageGroup) => (
              <div key={languageGroup.id} className="py-1">
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-3">
                  <span>{languageGroup.label}</span>
                  <span className="rounded bg-bg-3 px-1.5 py-0.5">{languageGroup.voices.length}</span>
                </div>
                {languageGroup.genderGroups.map((group) => {
                  const groupVoices = group.voices
                  if (groupVoices.length === 0) return null
                  return (
                    <div key={`${languageGroup.id}-${group.id}`} className="py-1">
                      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-3">
                        {group.label}
                      </div>
                      {groupVoices.map((voice) => (
                        <button
                          key={voice.id}
                          type="button"
                          onClick={() => pick(voice.id)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-bg-2 ${
                            value === voice.id ? 'text-accent' : 'text-text-1'
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate">{voice.name}</span>
                          {voice.type === 'clone' && (
                            <span className="shrink-0 rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-text-3">
                              clone
                            </span>
                          )}
                          {value === voice.id && <Check size={13} className="shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}

            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-2xs text-text-3">No matching voices</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
