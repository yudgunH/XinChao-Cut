import { create } from 'zustand'

export type ShortcutActionId =
  | 'toggleShortcuts'
  | 'playPause'
  | 'stepBackFrame'
  | 'stepForwardFrame'
  | 'jumpStart'
  | 'jumpEnd'
  | 'split'
  | 'delete'
  | 'deselect'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'

export interface ShortcutAction {
  id: ShortcutActionId
  group: 'Playback' | 'Editing' | 'Clipboard' | 'Timeline'
  label: string
  description: string
  defaultShortcut: string
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: 'toggleShortcuts',
    group: 'Timeline',
    label: 'Shortcut panel',
    description: 'Open or close the shortcut panel',
    defaultShortcut: 'Shift+?',
  },
  {
    id: 'playPause',
    group: 'Playback',
    label: 'Play / Pause',
    description: 'Toggle timeline playback',
    defaultShortcut: 'Space',
  },
  {
    id: 'stepBackFrame',
    group: 'Playback',
    label: 'Previous frame',
    description: 'Move playhead back by one frame',
    defaultShortcut: 'ArrowLeft',
  },
  {
    id: 'stepForwardFrame',
    group: 'Playback',
    label: 'Next frame',
    description: 'Move playhead forward by one frame',
    defaultShortcut: 'ArrowRight',
  },
  {
    id: 'jumpStart',
    group: 'Playback',
    label: 'Jump to start',
    description: 'Move playhead to the beginning',
    defaultShortcut: 'Home',
  },
  {
    id: 'jumpEnd',
    group: 'Playback',
    label: 'Jump to end',
    description: 'Move playhead to the end of the timeline',
    defaultShortcut: 'End',
  },
  {
    id: 'split',
    group: 'Editing',
    label: 'Split',
    description: 'Split selected clips, or active clips under the playhead',
    defaultShortcut: 'S',
  },
  {
    id: 'delete',
    group: 'Editing',
    label: 'Delete selected',
    description: 'Remove selected clips',
    defaultShortcut: 'Delete',
  },
  {
    id: 'deselect',
    group: 'Editing',
    label: 'Deselect',
    description: 'Clear timeline selection',
    defaultShortcut: 'Escape',
  },
  {
    id: 'undo',
    group: 'Editing',
    label: 'Undo',
    description: 'Undo last edit',
    defaultShortcut: 'Ctrl+Z',
  },
  {
    id: 'redo',
    group: 'Editing',
    label: 'Redo',
    description: 'Redo last undone edit',
    defaultShortcut: 'Ctrl+Shift+Z',
  },
  {
    id: 'copy',
    group: 'Clipboard',
    label: 'Copy',
    description: 'Copy selected clips',
    defaultShortcut: 'Ctrl+C',
  },
  {
    id: 'cut',
    group: 'Clipboard',
    label: 'Cut',
    description: 'Cut selected clips',
    defaultShortcut: 'Ctrl+X',
  },
  {
    id: 'paste',
    group: 'Clipboard',
    label: 'Paste',
    description: 'Paste copied clips at the playhead',
    defaultShortcut: 'Ctrl+V',
  },
  {
    id: 'duplicate',
    group: 'Clipboard',
    label: 'Duplicate',
    description: 'Duplicate selected clips',
    defaultShortcut: 'Ctrl+D',
  },
]

export type ShortcutMap = Record<ShortcutActionId, string>

const STORAGE_KEY = 'xinchao-cut-shortcuts-v1'

function defaultShortcuts(): ShortcutMap {
  return SHORTCUT_ACTIONS.reduce((acc, action) => {
    acc[action.id] = action.defaultShortcut
    return acc
  }, {} as ShortcutMap)
}

function loadShortcuts(): ShortcutMap {
  const defaults = defaultShortcuts()
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<ShortcutMap>
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

function saveShortcuts(shortcuts: ShortcutMap) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts))
}

interface ShortcutState {
  shortcuts: ShortcutMap
  setShortcut: (id: ShortcutActionId, shortcut: string) => void
  resetShortcut: (id: ShortcutActionId) => void
  resetAllShortcuts: () => void
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  shortcuts: loadShortcuts(),

  setShortcut: (id, shortcut) =>
    set((s) => {
      const shortcuts = { ...s.shortcuts }
      for (const action of SHORTCUT_ACTIONS) {
        if (action.id !== id && shortcuts[action.id] === shortcut) shortcuts[action.id] = ''
      }
      shortcuts[id] = shortcut
      saveShortcuts(shortcuts)
      return { shortcuts }
    }),

  resetShortcut: (id) =>
    set((s) => {
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === id)
      if (!action) return s
      const shortcuts = { ...s.shortcuts }
      for (const candidate of SHORTCUT_ACTIONS) {
        if (candidate.id !== id && shortcuts[candidate.id] === action.defaultShortcut) {
          shortcuts[candidate.id] = ''
        }
      }
      shortcuts[id] = action.defaultShortcut
      saveShortcuts(shortcuts)
      return { shortcuts }
    }),

  resetAllShortcuts: () =>
    set(() => {
      const shortcuts = defaultShortcuts()
      saveShortcuts(shortcuts)
      return { shortcuts }
    }),
}))

export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('+')
}

export function shortcutFromEvent(e: KeyboardEvent): string | null {
  const key = normalizeKey(e)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function shortcutMatchesEvent(shortcut: string, e: KeyboardEvent): boolean {
  return normalizeShortcut(shortcut) === shortcutFromEvent(e)
}

function normalizeKey(e: KeyboardEvent): string | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null
  if (e.key === ' ') return 'Space'
  if (e.key === 'Esc') return 'Escape'
  if (e.key === '?' || (e.shiftKey && e.key === '/')) return '?'
  if (e.key.length === 1) return e.key.toUpperCase()
  return e.key
}
