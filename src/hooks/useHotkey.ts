import { useEffect } from 'react'

type Handler = (e: KeyboardEvent) => void

export function useHotkey(combo: string, handler: Handler, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const keys = combo.toLowerCase().split('+')
    const main = keys[keys.length - 1] ?? ''
    const mods = {
      ctrl: keys.includes('ctrl') || keys.includes('cmd'),
      shift: keys.includes('shift'),
      alt: keys.includes('alt'),
    }
    function onKey(e: KeyboardEvent) {
      if (
        e.key.toLowerCase() === main &&
        (e.ctrlKey || e.metaKey) === mods.ctrl &&
        e.shiftKey === mods.shift &&
        e.altKey === mods.alt
      ) {
        handler(e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo, handler, enabled])
}
