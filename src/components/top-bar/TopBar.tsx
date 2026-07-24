import {
  Film,
  Music,
  Type,
  Smile,
  Sparkles,
  ArrowLeftRight,
  Captions,
  AudioLines,
  Sliders,
  Undo2,
  Redo2,
  Keyboard,
  Settings,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'

/** App owner — shown in the brand tooltip and the shortcuts/about overlay. */
export const APP_OWNER = 'Nguyễn Duy Hưng'

import { leaveToHome } from '@lib/project-session'
import { useUIStore, type LeftPanelTab } from '@store/ui-store'
import { useTimelineStore } from '@store/timeline-store'
import { useShortcutStore } from '@store/shortcut-store'

import { AiSettings } from '@components/settings/AiSettings'

import { BackendStatus } from './BackendStatus'
import { ProjectName } from './ProjectName'
import { SaveStatus } from './SaveStatus'
import { ExportButton } from './ExportButton'

const PANEL_TABS: { id: LeftPanelTab; label: string; icon: LucideIcon }[] = [
  { id: 'media', label: 'Media', icon: Film },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'stickers', label: 'Stickers', icon: Smile },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'transitions', label: 'Transitions', icon: ArrowLeftRight },
  { id: 'captions', label: 'Captions', icon: Captions },
  { id: 'voice', label: 'Voice', icon: AudioLines },
  { id: 'filters', label: 'Filters', icon: Sliders },
]

interface TopBarProps {
  onOpenShortcuts?: () => void
}

export function TopBar({ onOpenShortcuts }: TopBarProps) {
  const activeLeftTab = useUIStore((s) => s.activeLeftTab)
  const setActiveLeftTab = useUIStore((s) => s.setActiveLeftTab)
  const canUndo = useTimelineStore((s) => s.canUndo)
  const canRedo = useTimelineStore((s) => s.canRedo)
  const undo = useTimelineStore((s) => s.undo)
  const redo = useTimelineStore((s) => s.redo)
  const shortcuts = useShortcutStore((s) => s.shortcuts)
  const [aiOpen, setAiOpen] = useState(false)

  return (
    <header className="flex h-11 shrink-0 items-stretch overflow-hidden border-b border-border bg-bg-1">
      {/* Left: brand logo + panel tabs */}
      <div className="flex items-stretch">
        <button
          onClick={() => void leaveToHome()}
          className="group flex w-11 items-center justify-center"
          title="Back to projects"
          aria-label="Back to projects"
        >
          <img
            src="/logo.png"
            alt="XinChao-Cut logo"
            className="h-7 w-7 rounded-md group-hover:hidden"
            draggable={false}
          />
          <LayoutGrid size={18} className="hidden text-text-1 group-hover:block" />
        </button>

        <div className="flex items-stretch">
          {PANEL_TABS.map((tab) => {
            const Icon = tab.icon
            const active = activeLeftTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveLeftTab(tab.id)}
                className={`relative flex items-center gap-1.5 px-3 text-xs transition-colors ${
                  active ? 'text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'
                }`}
              >
                <Icon size={14} className="shrink-0" />
                {/* Labels collapse to icon-only on narrower windows so the tab
                    row never crowds the project name / controls. */}
                <span className="hidden xl:inline">{tab.label}</span>
                {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Right: project controls. min-w-0 lets the project name truncate instead
          of pushing the controls off-screen; the controls group stays full-size. */}
      <div className="ml-auto flex min-w-0 items-center gap-1 px-3">
        <ProjectName />
        <div className="flex shrink-0 items-center gap-1">
          <div className="mx-2 h-4 w-px bg-border" />
          <button
            onClick={undo}
            disabled={!canUndo}
            title={`Undo (${shortcuts.undo || 'Unassigned'})`}
            className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Undo"
          >
            <Undo2 size={15} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title={`Redo (${shortcuts.redo || 'Unassigned'})`}
            className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Redo"
          >
            <Redo2 size={15} />
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={onOpenShortcuts}
            title={`Keyboard shortcuts (${shortcuts.toggleShortcuts || 'Unassigned'})`}
            className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={15} />
          </button>
          <button
            onClick={() => setAiOpen(true)}
            title="AI settings (provider / API key / model)"
            className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
            aria-label="AI settings"
          >
            <Settings size={15} />
          </button>
          {aiOpen && <AiSettings onClose={() => setAiOpen(false)} />}
          <div className="mx-1 h-4 w-px bg-border" />
          <BackendStatus />
          <SaveStatus />
          <ExportButton />
        </div>
      </div>
    </header>
  )
}
