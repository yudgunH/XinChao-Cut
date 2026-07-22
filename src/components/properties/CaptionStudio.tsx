import { useMemo, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  CircleOff,
  Check,
  ChevronDown,
  Download,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
} from 'lucide-react'

import {
  resolvedTextWordSpacing,
  TEXT_PRESETS,
  type TextClipData,
  type TextPreset,
  type TextPresetStyle,
} from '@engine/timeline'
import {
  FONT_CATALOG,
  fontByFamily,
  registerCaptionFontFaces,
  type CaptionFont,
  type FontCategory,
} from '@engine/text/font-catalog'

type CaptionPatch = Partial<TextClipData>

interface Props {
  clipId: string
  td: TextClipData
  applyCaption: (patch: CaptionPatch) => void
  setClipText: (id: string, patch: CaptionPatch) => void
  beginHistoryStep: () => void
  textEditingRef: MutableRefObject<boolean>
}

type Tab = 'basic' | 'templates' | 'bubble' | 'effects'

const TABS: { id: Tab; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'templates', label: 'Templates' },
  { id: 'bubble', label: 'Bubble' },
  { id: 'effects', label: 'Effects' },
]

const CAT_LABEL: Record<FontCategory, string> = {
  vn: 'Vietnamese',
  jp: 'Japanese',
  kr: 'Korean',
}

const TEMPLATE_FILTERS = ['Trending', 'Classic', 'NEW', 'Hits', 'Word', 'Glow', 'Basic'] as const

const KARAOKE_TEMPLATES: TextPreset[] = [
  {
    id: 'karaoke-none',
    label: 'None',
    style: {
      color: '#ffffff',
      fontFamily: 'Inter, sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#000000', width: 6 },
      anim: { kind: 'none', groupSize: 1 },
    },
  },
  {
    id: 'karaoke-meme-down',
    label: 'DOWN I GO',
    style: {
      color: '#ffffff',
      fontFamily: '"Bangers", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#050505', width: 10 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffd400',
    },
  },
  {
    id: 'karaoke-meme-and-go',
    label: 'AND I GO',
    style: {
      color: '#ffffff',
      fontFamily: '"Rounded Mplus 1c Heavy", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#050505', width: 9 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffd400',
      letterSpacing: 1,
    },
  },
  {
    id: 'karaoke-sandler-here',
    label: 'MR SANDLER',
    style: {
      color: '#ffffff',
      fontFamily: '"Oswald", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#030303', width: 10 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffe500',
    },
  },
  {
    id: 'karaoke-white-punch',
    label: 'HERE WE GO',
    style: {
      color: '#ffffff',
      fontFamily: '"Cherry Bomb One", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#000000', width: 9 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffffff',
    },
  },
  {
    id: 'karaoke-red-punch',
    label: 'STOP RIGHT NOW',
    style: {
      color: '#ffffff',
      fontFamily: '"OAI Ironfist", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#050505', width: 10 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ff2d2d',
    },
  },
  {
    id: 'karaoke-blue-reaction',
    label: 'WAIT FOR IT',
    style: {
      color: '#ffffff',
      fontFamily: '"Oai Qylen", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#050505', width: 9 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#38bdf8',
    },
  },
  {
    id: 'karaoke-yellow-sweep',
    label: 'THE',
    style: {
      color: '#ffffff',
      fontFamily: '"Bangers", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#000000', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffd400',
    },
  },
  {
    id: 'karaoke-purple-pop',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"Cherry Bomb One", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#6d28d9', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#a855f7',
    },
  },
  {
    id: 'karaoke-red-alert',
    label: 'RUBAH',
    style: {
      color: '#ffffff',
      fontFamily: '"Oai The Rambler", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#111111', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ff3b30',
    },
  },
  {
    id: 'karaoke-neon-green',
    label: 'Aa',
    style: {
      color: '#00ff47',
      fontFamily: '"TP Dopestyle", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#001b08', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#b6ff00',
    },
  },
  {
    id: 'karaoke-blue-ice',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"Oai Qylen", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#0f4cff', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#2dd4ff',
    },
  },
  {
    id: 'karaoke-black-box',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"Rounded Mplus 1c Heavy", sans-serif',
      fontWeight: 'bold',
      hasBackground: true,
      backgroundColor: '#000000',
      stroke: { color: '#000000', width: 0 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffd400',
    },
  },
  {
    id: 'karaoke-yellow-box',
    label: 'Aa',
    style: {
      color: '#000000',
      fontFamily: '"Cherry Bomb One", sans-serif',
      fontWeight: 'bold',
      hasBackground: true,
      backgroundColor: '#ffd400',
      stroke: { color: '#000000', width: 0 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#000000',
    },
  },
  {
    id: 'karaoke-clean-white',
    label: 'Aa',
    style: {
      color: '#111111',
      fontFamily: '"Mochiy Pop One OTF", sans-serif',
      fontWeight: 'bold',
      hasBackground: true,
      backgroundColor: '#ffffff',
      stroke: { color: '#ffffff', width: 0 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#111111',
    },
  },
  {
    id: 'karaoke-hot-pink',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"Oai Cherione", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#be123c', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#fb7185',
    },
  },
  {
    id: 'karaoke-orange-hit',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"OAI Ironfist", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#9a3412', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#fb923c',
    },
  },
  {
    id: 'karaoke-shadow-classic',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"Oswald", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#111111', width: 9 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffd400',
    },
  },
  {
    id: 'karaoke-comic-yellow',
    label: 'HOM',
    style: {
      color: '#fff7ed',
      fontFamily: '"Bangers", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#7c2d12', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#facc15',
      letterSpacing: 1,
    },
  },
  {
    id: 'karaoke-soft-gray',
    label: 'YANG',
    style: {
      color: '#f4f4f5',
      fontFamily: '"Rounded Mplus 1c Black", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#27272a', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#a1a1aa',
    },
  },
  {
    id: 'karaoke-lazy-purple',
    label: 'THE',
    style: {
      color: '#ffffff',
      fontFamily: '"Mochiy Pop One OTF", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#581c87', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#c084fc',
    },
  },
  {
    id: 'karaoke-gold-sport',
    label: 'A',
    style: {
      color: '#facc15',
      fontFamily: '"OAI Ironfist", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#111111', width: 9 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffffff',
      letterSpacing: 2,
    },
  },
  {
    id: 'karaoke-candy-red',
    label: 'Aa',
    style: {
      color: '#ffffff',
      fontFamily: '"Cherry Bomb One", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#dc2626', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#fbbf24',
    },
  },
  {
    id: 'karaoke-mint-clean',
    label: 'Der',
    style: {
      color: '#a7f3d0',
      fontFamily: '"M+A1", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#064e3b', width: 6 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffffff',
    },
  },
  {
    id: 'karaoke-poster-block',
    label: 'ELECTRAS',
    style: {
      color: '#111827',
      fontFamily: '"OAI Showtilla", sans-serif',
      fontWeight: 'bold',
      hasBackground: true,
      backgroundColor: '#e5e7eb',
      stroke: { color: '#facc15', width: 2 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ef4444',
    },
  },
  {
    id: 'karaoke-blue-flash',
    label: 'Aa',
    style: {
      color: '#dbeafe',
      fontFamily: '"Oai Valter Std", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#1d4ed8', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#38bdf8',
    },
  },
  {
    id: 'karaoke-siren-cut',
    label: 'BRAUNER',
    style: {
      color: '#ff3b30',
      fontFamily: '"OAI Agnifa", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#050505', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ffffff',
      letterSpacing: 1,
    },
  },
  {
    id: 'karaoke-retro-cream',
    label: 'Vulpea',
    style: {
      color: '#f5d0a9',
      fontFamily: '"DL Calvera", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#5c2e14', width: 6 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#facc15',
    },
  },
  {
    id: 'karaoke-news-redline',
    label: 'NEWS',
    style: {
      color: '#ffffff',
      fontFamily: '"Oswald", sans-serif',
      fontWeight: 'bold',
      hasBackground: true,
      backgroundColor: '#dc2626',
      stroke: { color: '#ffffff', width: 1 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#fde047',
      letterSpacing: 1,
    },
  },
  {
    id: 'karaoke-kpop-lime',
    label: 'THE',
    style: {
      color: '#ecfccb',
      fontFamily: '"Jalnan Gothic", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#166534', width: 7 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#84cc16',
    },
  },
  {
    id: 'karaoke-sticker-white',
    label: 'Aa',
    style: {
      color: '#111827',
      fontFamily: '"Rounded Mplus 1c Heavy", sans-serif',
      fontWeight: 'bold',
      hasBackground: true,
      backgroundColor: '#f8fafc',
      stroke: { color: '#111827', width: 1 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#ef4444',
    },
  },
  {
    id: 'karaoke-violet-pulse',
    label: 'THE',
    style: {
      color: '#f5f3ff',
      fontFamily: '"Oai Lacotte", sans-serif',
      fontWeight: 'bold',
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#7c3aed', width: 8 },
      anim: { kind: 'karaoke', groupSize: 3 },
      highlightColor: '#f0abfc',
    },
  },
]

function familyValue(f: CaptionFont): string {
  return f.file ? `"${f.family}", sans-serif` : 'Inter, sans-serif'
}

function fontSample(cat: FontCategory): string {
  if (cat === 'jp') return 'Aa JP'
  if (cat === 'kr') return 'Aa KR'
  return 'Aa VN'
}

export function CaptionStudio({
  clipId,
  td,
  applyCaption,
  setClipText,
  beginHistoryStep,
  textEditingRef,
}: Props) {
  const [tab, setTab] = useState<Tab>('basic')
  const [fontQuery, setFontQuery] = useState('')
  const [tplQuery, setTplQuery] = useState('')
  const [tplFilter, setTplFilter] = useState<(typeof TEMPLATE_FILTERS)[number]>('Trending')

  const shownKaraokeTemplates = useMemo(() => {
    const q = tplQuery.trim().toLowerCase()
    const byQuery = q
      ? KARAOKE_TEMPLATES.filter((t) => t.id.toLowerCase().includes(q) || t.label.toLowerCase().includes(q))
      : KARAOKE_TEMPLATES
    if (tplFilter === 'Basic') return byQuery.filter((t) => t.style.anim?.kind === 'none')
    if (tplFilter === 'Glow') return byQuery.filter((t) => /pink|purple|green|blue|orange/.test(t.id))
    if (tplFilter === 'Word') return byQuery.filter((t) => (t.style.anim?.groupSize ?? 1) >= 3)
    return byQuery
  }, [tplFilter, tplQuery])

  const shownFonts = useMemo(() => {
    const q = fontQuery.trim().toLowerCase()
    const list = q
      ? FONT_CATALOG.filter((f) => f.label.toLowerCase().includes(q) || f.family.toLowerCase().includes(q))
      : FONT_CATALOG
    const groups: Record<FontCategory, CaptionFont[]> = { vn: [], jp: [], kr: [] }
    for (const f of list) groups[f.cat].push(f)
    return groups
  }, [fontQuery])

  const currentFont = fontByFamily(td.fontFamily)

  return (
    <div className="flex flex-col gap-3 text-xs text-text-1">
      <SegmentedTabs value={tab} onChange={setTab} />
      <ApplyAllRow />

      {tab === 'basic' && (
        <BasicTab
          clipId={clipId}
          td={td}
          currentFont={currentFont}
          shownFonts={shownFonts}
          fontQuery={fontQuery}
          onFontQuery={setFontQuery}
          setClipText={setClipText}
          applyCaption={applyCaption}
          beginHistoryStep={beginHistoryStep}
          textEditingRef={textEditingRef}
        />
      )}

      {tab === 'templates' && (
        <TemplatesTab
          templates={shownKaraokeTemplates}
          query={tplQuery}
          filter={tplFilter}
          onQuery={setTplQuery}
          onFilter={setTplFilter}
          onApply={applyCaption}
        />
      )}

      {tab === 'bubble' && <BubbleTab td={td} applyCaption={applyCaption} />}

      {tab === 'effects' && <EffectsTab td={td} applyCaption={applyCaption} />}

    </div>
  )
}

function SegmentedTabs({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div className="grid grid-cols-4 gap-0.5 rounded bg-[#161616] p-0.5">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`h-6 rounded text-[11px] transition ${
            value === t.id ? 'bg-[#3a3a3a] text-white' : 'text-text-2 hover:bg-bg-3 hover:text-text-1'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function ApplyAllRow() {
  return (
    <label className="flex h-6 items-center gap-2 border-b border-border pb-2 text-[11px] text-text-1">
      <span className="grid h-3.5 w-3.5 place-items-center rounded bg-[#21c8d4] text-black">
        <Check size={11} strokeWidth={3} />
      </span>
      <span>Apply to all main captions</span>
    </label>
  )
}

function BasicTab({
  clipId,
  td,
  currentFont,
  shownFonts,
  fontQuery,
  onFontQuery,
  setClipText,
  applyCaption,
  beginHistoryStep,
  textEditingRef,
}: {
  clipId: string
  td: TextClipData
  currentFont: CaptionFont | undefined
  shownFonts: Record<FontCategory, CaptionFont[]>
  fontQuery: string
  onFontQuery: (query: string) => void
  setClipText: (id: string, patch: CaptionPatch) => void
  applyCaption: (patch: CaptionPatch) => void
  beginHistoryStep: () => void
  textEditingRef: MutableRefObject<boolean>
}) {
  return (
    <div className="flex flex-col gap-4">
      <textarea
        value={td.content}
        onChange={(e) => {
          if (!textEditingRef.current) {
            textEditingRef.current = true
            beginHistoryStep()
          }
          setClipText(clipId, { content: e.target.value })
        }}
        onBlur={() => {
          textEditingRef.current = false
        }}
        className="min-h-[64px] w-full resize-none rounded bg-[#171717] p-3 text-xs leading-5 text-text-1 outline-none ring-1 ring-border focus:ring-accent"
        rows={3}
        placeholder="Enter caption text"
      />

      <div className="flex flex-col gap-3">
        <ControlRow label="Font">
          <FontDropdown
            currentFont={currentFont}
            shownFonts={shownFonts}
            query={fontQuery}
            onQuery={onFontQuery}
            applyCaption={applyCaption}
          />
        </ControlRow>

        <ControlRow label="Font size">
          <SliderValue value={td.fontSize} min={16} max={200} onChange={(fontSize) => applyCaption({ fontSize })} />
        </ControlRow>

        <ControlRow label="Pattern">
          <div className="flex gap-1">
            <ToggleButton active={td.fontWeight === 'bold'} onClick={() => applyCaption({ fontWeight: td.fontWeight === 'bold' ? 'normal' : 'bold' })}>
              B
            </ToggleButton>
          </div>
        </ControlRow>

        <ControlRow label="Color">
          <ColorInput value={td.color} onChange={(color) => applyCaption({ color })} />
        </ControlRow>

        <ControlRow label="Character spacing">
          <SliderValue
            value={td.letterSpacing ?? 0}
            min={-4}
            max={20}
            onChange={(letterSpacing) => applyCaption({ letterSpacing })}
            compact
          />
        </ControlRow>

        <ControlRow label="Word spacing">
          <SliderValue
            value={Math.round(resolvedTextWordSpacing(td))}
            min={0}
            max={32}
            onChange={(wordSpacing) => applyCaption({ wordSpacing })}
            compact
          />
        </ControlRow>

        <ControlRow label="Alignment">
          <div className="flex overflow-hidden rounded bg-[#3a3a3a]">
            {[
              { id: 'left' as const, icon: AlignLeft },
              { id: 'center' as const, icon: AlignCenter },
              { id: 'right' as const, icon: AlignRight },
            ].map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => applyCaption({ align: id })}
                className={`grid h-7 w-9 place-items-center ${
                  td.align === id ? 'bg-[#525252] text-white' : 'text-text-3 hover:bg-bg-4 hover:text-text-1'
                }`}
                title={id}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
        </ControlRow>
      </div>

      <section className="border-t border-border pt-4">
        <p className="mb-3 text-[11px] text-text-2">Preset style</p>
        <div className="grid grid-cols-7 gap-2">
          {TEXT_PRESETS.map((preset) => (
            <PresetTile key={preset.id} preset={preset} onApply={applyCaption} />
          ))}
        </div>
      </section>
    </div>
  )
}

function TemplatesTab({
  templates,
  query,
  filter,
  onQuery,
  onFilter,
  onApply,
}: {
  templates: TextPreset[]
  query: string
  filter: (typeof TEMPLATE_FILTERS)[number]
  onQuery: (query: string) => void
  onFilter: (filter: (typeof TEMPLATE_FILTERS)[number]) => void
  onApply: (patch: CaptionPatch) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2 top-2 text-text-3" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search for text templates"
          className="h-8 w-full rounded bg-[#171717] pl-7 pr-3 text-[11px] text-text-1 outline-none ring-1 ring-border placeholder:text-text-3 focus:ring-accent"
        />
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Chip icon={<Star size={12} fill="currentColor" />} active={false} onClick={() => onFilter('Trending')} />
        {TEMPLATE_FILTERS.map((item) => (
          <Chip key={item} active={filter === item} onClick={() => onFilter(item)}>
            {item}
          </Chip>
        ))}
        <Chip icon={<SlidersHorizontal size={12} />} active={false} onClick={() => onFilter('Trending')} />
        <Chip icon={<ChevronDown size={12} />} active={false} onClick={() => onFilter('Trending')} />
      </div>

      <p className="text-[11px] text-text-2">{filter}</p>

      <div className="grid grid-cols-4 gap-3">
        {templates.map((preset, i) => (
          <KaraokeTile key={preset.id} preset={preset} index={i} onApply={onApply} />
        ))}
      </div>
    </div>
  )
}

function BubbleTab({ td, applyCaption }: { td: TextClipData; applyCaption: (patch: CaptionPatch) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <ControlRow label="Bubble">
        <button
          type="button"
          onClick={() => applyCaption({ hasBackground: !td.hasBackground })}
          className={`h-7 rounded px-3 text-[11px] ${
            td.hasBackground ? 'bg-accent text-white' : 'bg-bg-2 text-text-2 hover:bg-bg-3'
          }`}
        >
          {td.hasBackground ? 'On' : 'Off'}
        </button>
      </ControlRow>
      <ControlRow label="Fill">
        <ColorInput value={td.backgroundColor} onChange={(backgroundColor) => applyCaption({ backgroundColor })} />
      </ControlRow>
      <ControlRow label="Outline">
        <SliderValue
          value={td.stroke?.width ?? 0}
          min={0}
          max={20}
          onChange={(width) => applyCaption({ stroke: { color: td.stroke?.color ?? '#000000', width } })}
        />
      </ControlRow>
      <ControlRow label="Outline color">
        <ColorInput
          value={td.stroke?.color ?? '#000000'}
          onChange={(color) => applyCaption({ stroke: { color, width: td.stroke?.width ?? 6 } })}
        />
      </ControlRow>
      <div className="grid grid-cols-4 gap-2">
        {[
          { backgroundColor: '#000000', color: '#ffffff' },
          { backgroundColor: '#ffffff', color: '#111111' },
          { backgroundColor: '#ffd400', color: '#000000' },
          { backgroundColor: '#ff3b30', color: '#ffffff' },
        ].map((style) => (
          <button
            key={`${style.backgroundColor}-${style.color}`}
            type="button"
            onClick={() => applyCaption(normalizePresetStyle({ ...style, hasBackground: true }))}
            className="grid h-14 place-items-center rounded bg-bg-2 ring-1 ring-border hover:ring-accent"
          >
            <span className="rounded px-2 py-1 text-sm font-black" style={style}>Aa</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function EffectsTab({ td, applyCaption }: { td: TextClipData; applyCaption: (patch: CaptionPatch) => void }) {
  const animOptions = [
    { id: 'none', label: 'None' },
    { id: 'word', label: 'Word' },
    { id: 'group', label: '3 words' },
    { id: 'karaoke', label: 'Karaoke 3' },
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <ControlRow label="Animation">
        <div className="grid flex-1 grid-cols-4 gap-1 rounded bg-[#171717] p-1">
          {animOptions.map((a) => {
            const active = (td.anim?.kind ?? 'none') === a.id
            return (
              <button
                key={a.id}
                type="button"
                onClick={() =>
                  applyCaption({
                    anim: { kind: a.id, groupSize: a.id === 'group' || a.id === 'karaoke' ? 3 : 1 },
                    ...(a.id === 'karaoke' && !td.highlightColor ? { highlightColor: '#ffd400' } : {}),
                    ...(a.id === 'karaoke' && resolvedTextWordSpacing(td) <= 0 ? { wordSpacing: 10 } : {}),
                  })
                }
                className={`h-7 rounded text-[11px] ${
                  active ? 'bg-[#3f3f46] text-white' : 'text-text-2 hover:bg-bg-3 hover:text-text-1'
                }`}
              >
                {a.label}
              </button>
            )
          })}
        </div>
      </ControlRow>

      <ControlRow label="Highlight">
        <ColorInput value={td.highlightColor ?? '#ffd400'} onChange={(highlightColor) => applyCaption({ highlightColor })} />
      </ControlRow>

      <ControlRow label="Position">
        <SliderValue value={Math.round(td.y * 100)} min={0} max={100} onChange={(y) => applyCaption({ y: y / 100 })} suffix="%" />
      </ControlRow>

      <div className="grid grid-cols-3 gap-2">
        {KARAOKE_TEMPLATES.slice(1, 7).map((preset, i) => (
          <KaraokeTile key={preset.id} preset={preset} index={i} onApply={applyCaption} compact />
        ))}
      </div>
    </div>
  )
}

function FontDropdown({
  currentFont,
  shownFonts,
  query,
  onQuery,
  applyCaption,
}: {
  currentFont: CaptionFont | undefined
  shownFonts: Record<FontCategory, CaptionFont[]>
  query: string
  onQuery: (query: string) => void
  applyCaption: (patch: CaptionPatch) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center justify-between rounded bg-[#363636] px-2 text-xs text-text-1 ring-1 ring-transparent hover:bg-[#404040] focus:outline-none focus:ring-accent"
      >
        <span className="truncate">{currentFont?.label ?? 'Inter'}</span>
        <ChevronDown size={14} className={`shrink-0 text-text-3 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-8 z-50 rounded-lg border border-border bg-[#141414] p-2 shadow-[0_12px_28px_rgba(0,0,0,0.55)]">
          <div className="relative mb-2">
            <Search size={13} className="pointer-events-none absolute left-2 top-2 text-text-3" />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search fonts"
              className="h-8 w-full rounded bg-[#171717] pl-7 pr-3 text-[11px] text-text-1 outline-none ring-1 ring-border placeholder:text-text-3 focus:ring-accent"
              autoFocus
            />
          </div>
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
            {(['vn', 'jp', 'kr'] as FontCategory[]).map((cat) =>
              shownFonts[cat].length === 0 ? null : (
                <div key={cat} className="flex flex-col gap-1">
                  <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-text-3">{CAT_LABEL[cat]}</p>
                  {shownFonts[cat].map((f) => {
                    const active = currentFont?.family === f.family
                    return (
                      <button
                        key={f.family}
                        type="button"
                        onClick={() => {
                          void registerCaptionFontFaces([f.family], document.fonts)
                          applyCaption({ fontFamily: familyValue(f) })
                          setOpen(false)
                        }}
                        onMouseEnter={() => void registerCaptionFontFaces([f.family], document.fonts)}
                        className={`flex h-8 items-center justify-between rounded px-2 text-left ring-1 transition ${
                          active ? 'bg-[#111827] ring-accent' : 'ring-transparent hover:bg-bg-2'
                        }`}
                      >
                        <span className="truncate text-xs text-text-2">{f.label}</span>
                        <span className="ml-2 shrink-0 text-sm text-text-1" style={{ fontFamily: familyValue(f) }}>
                          {fontSample(f.cat)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PresetTile({ preset, onApply }: { preset: TextPreset; onApply: (patch: CaptionPatch) => void }) {
  const s = preset.style
  return (
    <button
      type="button"
      onClick={() => onApply(normalizePresetStyle(s))}
      title={preset.id}
      className="grid h-10 place-items-center rounded-lg bg-[#3a3a3a] ring-1 ring-transparent transition hover:ring-accent"
      style={{ background: s.hasBackground ? s.backgroundColor : '#3a3a3a' }}
    >
      <span
        className="text-lg font-black leading-none"
        style={{
          color: s.color,
          WebkitTextStroke: s.stroke ? `1px ${s.stroke.color}` : undefined,
        }}
      >
        Aa
      </span>
    </button>
  )
}

function KaraokeTile({
  preset,
  index,
  onApply,
  compact = false,
}: {
  preset: TextPreset
  index: number
  onApply: (patch: CaptionPatch) => void
  compact?: boolean
}) {
  const s = preset.style
  const label = preset.label === 'None' ? '' : preset.label
  const labelWords = label.split(/\s+/).filter(Boolean)
  const isGroup = (s.anim?.groupSize ?? 1) >= 3
  const glow = s.highlightColor ?? s.color
  return (
    <button
      type="button"
      onClick={() => onApply(normalizePresetStyle(s, {
        wordSpacing: preset.id === 'karaoke-none' ? 0 : (s.wordSpacing ?? Math.max(10, s.stroke?.width ?? 0)),
      }))}
      title={preset.id}
      className={`group relative grid place-items-center overflow-hidden rounded-lg bg-[#202020] ring-1 ring-border transition hover:-translate-y-0.5 hover:ring-accent ${
        compact ? 'h-16' : 'h-[68px]'
      }`}
      style={{
        background: preset.id === 'karaoke-none'
          ? '#202020'
          : `linear-gradient(145deg, #262626 0%, #171717 48%, ${glow}22 100%)`,
      }}
    >
      <span className="absolute inset-x-2 top-2 h-px bg-white/10" />
      <span
        className="absolute bottom-0 left-0 h-1 w-2/3 opacity-70"
        style={{ background: `linear-gradient(90deg, ${glow}, transparent)` }}
      />
      {index % 3 === 1 && <Sparkles size={11} className="absolute left-2 top-2 text-[#a78bfa]" />}
      {isGroup && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1 py-0.5 text-[8px] font-bold text-white/80">
          3 WORDS
        </span>
      )}
      <span
        className="flex max-w-[92%] items-center justify-center gap-1.5 truncate text-center text-sm font-black leading-none"
        style={{
          color: s.color,
          background: s.hasBackground ? s.backgroundColor : 'transparent',
          borderRadius: s.hasBackground ? 4 : undefined,
          padding: s.hasBackground ? '3px 5px' : undefined,
          fontFamily: s.fontFamily,
          letterSpacing: s.letterSpacing ? `${s.letterSpacing * 0.35}px` : undefined,
          textShadow: s.stroke ? `0 0 5px ${s.stroke.color}, 0 1px 0 ${s.stroke.color}` : undefined,
          WebkitTextStroke: s.stroke && s.stroke.width > 0 ? `1px ${s.stroke.color}` : undefined,
        }}
      >
        {labelWords.length > 0 ? (
          labelWords.map((word, wordIndex) => (
            <span key={`${word}-${wordIndex}`} style={{ color: wordIndex === 0 ? glow : s.color }}>
              {word}
            </span>
          ))
        ) : (
          <CircleOff size={26} strokeWidth={1.5} className="text-text-2" />
        )}
      </span>
      {preset.id !== 'karaoke-none' && (
        <span className="absolute bottom-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/65 text-white">
          <Download size={12} />
        </span>
      )}
    </button>
  )
}

/** Applying a preset must replace optional effects from the previous style.
 * A shallow merge otherwise leaves a thick karaoke outline on `box-white`,
 * producing the unreadable black blobs seen in the editor. */
function normalizePresetStyle(style: Partial<TextPresetStyle>, overrides: Partial<CaptionPatch> = {}): CaptionPatch {
  return {
    ...style,
    ...overrides,
    stroke: overrides.stroke ?? style.stroke ?? { color: '#000000', width: 0 },
    anim: overrides.anim ?? style.anim ?? { kind: 'none', groupSize: 1 },
    letterSpacing: overrides.letterSpacing ?? style.letterSpacing ?? 5,
    wordSpacing: overrides.wordSpacing ?? style.wordSpacing ?? 0,
    highlightColor: overrides.highlightColor ?? style.highlightColor,
  }
}

function ControlRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] text-text-2">{label}</span>
      {children}
    </label>
  )
}

function SliderValue({
  value,
  min,
  max,
  onChange,
  suffix = '',
  compact = false,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  suffix?: string
  compact?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[#f4f4f5]"
      />
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${compact ? 'w-14' : 'w-16'} h-7 rounded bg-[#171717] text-center font-mono text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent`}
      />
      {suffix && <span className="-ml-2 text-[11px] text-text-3">{suffix}</span>}
    </div>
  )
}

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid h-7 w-8 place-items-center rounded text-sm font-black ${
        active ? 'bg-[#4a4a4a] text-white' : 'bg-[#303030] text-text-2 hover:bg-bg-4 hover:text-text-1'
      }`}
    >
      {children}
    </button>
  )
}

function ColorInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-16 cursor-pointer rounded border border-border bg-bg-2"
      />
      <span className="font-mono text-[11px] text-text-2">{value}</span>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
  icon,
}: {
  active: boolean
  onClick: () => void
  children?: ReactNode
  icon?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-semibold ${
        active ? 'bg-[#444444] text-white' : 'bg-[#303030] text-text-2 hover:bg-bg-4 hover:text-text-1'
      } ${icon && !children ? 'w-8 justify-center px-0' : ''}`}
    >
      {icon}
      {children}
    </button>
  )
}
