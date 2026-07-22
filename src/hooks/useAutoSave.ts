import { useEffect, useRef } from 'react'

import { AutoSaveGeneration } from '@lib/autosave-generation'
import { AsyncListenerLease } from '@lib/async-listener-lease'
import { saveCurrentProject } from '@lib/project-session'
import { projectSaveCoordinator } from '@lib/project-save-coordinator'
import { type CloseSaveResult } from '@lib/native-close-guard'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'

const DEBOUNCE_MS = 3000

/**
 * Auto-saves the open project to IndexedDB whenever the timeline content (not
 * selection/zoom) or the project name/aspect changes, debounced by DEBOUNCE_MS.
 * Loading a project is handled by `openProject` in project-session. Mount once
 * at the editor root.
 */
export function useAutoSave(): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // An older in-flight save must never clear the dirty state of a newer edit.
  const generationRef = useRef(new AutoSaveGeneration())

  useEffect(() => {
    let unsubTimeline: (() => void) | undefined
    let unsubProject: (() => void) | undefined
    const tauriCloseListener = new AsyncListenerLease()

    async function flushNow(): Promise<CloseSaveResult> {
      const generations = generationRef.current
      if (!generations.isDirty()) {
        // A manual save can already be in the
        // coordinator without touching this hook's debounce generation. Native
        // close must wait for that write too or the WebView can die mid-IDB commit.
        const projectId = useProjectStore.getState().id
        try {
          if (projectId) await projectSaveCoordinator.whenIdle(projectId)
          return { ok: true }
        } catch (error) {
          useProjectStore.getState().setSaveStatus('error')
          return { ok: false, error }
        }
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      useProjectStore.getState().setSaveStatus('saving')
      try {
        // Tauri can await close. Drain again if an edit lands while the
        // current IndexedDB write is settling.
        while (generations.isDirty()) {
          const target = generations.current()
          await saveCurrentProject()
          generations.commit(target)
        }
        useProjectStore.getState().setSaveStatus('saved')
        return { ok: true }
      } catch (error) {
        useProjectStore.getState().setSaveStatus('error')
        return { ok: false, error }
      }
    }

    function scheduleSave() {
      // Don't persist while on the Home grid or before a project is open.
      if (useUIStore.getState().view !== 'editor' || !useProjectStore.getState().id) return
      useProjectStore.getState().setSaveStatus('unsaved')
      generationRef.current.markDirty()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(async () => {
        timerRef.current = null
        const generations = generationRef.current
        const target = generations.current()
        useProjectStore.getState().setSaveStatus('saving')
        try {
          // S13: saveCurrentProject serializes+coalesces; concurrent timers only
          // enqueue trailing captures of the latest dirty store.
          await saveCurrentProject()
          const clean = generations.commit(target)
          useProjectStore.getState().setSaveStatus(clean ? 'saved' : 'unsaved')
        } catch {
          // The generation remains dirty so unmount/close or the next edit retries.
          useProjectStore.getState().setSaveStatus('error')
        }
      }, DEBOUNCE_MS)
    }

    let prevTimeline = useTimelineStore.getState().timeline
    let prevName = useProjectStore.getState().name
    let prevAspect = useProjectStore.getState().aspect

    unsubTimeline = useTimelineStore.subscribe((s) => {
      if (s.timeline === prevTimeline) return // selection/zoom didn't touch content
      prevTimeline = s.timeline
      scheduleSave()
    })
    unsubProject = useProjectStore.subscribe((s) => {
      if (s.name === prevName && s.aspect === prevAspect) return // assets/status only
      prevName = s.name
      prevAspect = s.aspect
      scheduleSave()
    })

    // Best-effort flush on tab/window close. No preventDefault → no prompt.
    // The write is async and the tab may die before it lands, but IndexedDB
    // requests kicked off here still complete in modern browsers. Browser build
    // only — the desktop shell drives close through Rust (see below).
    // Inline Tauri detection — no barrel import (avoids a heavy/circular
    // dependency in this core hook). Tauri v2 injects __TAURI_INTERNALS__.
    const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    const onBeforeUnload = () => { void flushNow() }
    if (!desktop) window.addEventListener('beforeunload', onBeforeUnload)

    // DESKTOP close is driven from Rust, not the webview. The WebView2 close
    // path (JS `onCloseRequested` / `beforeunload`) is unreliable here — the
    // titlebar X could wedge the window with no event ever reaching JS. Instead
    // the Rust `CloseRequested` handler prevents the close, emits
    // `app-close-requested`, and force-destroys the window after a ~2s fallback.
    // We just listen for that event, flush the coalesced project save, then ask
    // Rust to tear the window down immediately. If this never runs (or the save
    // hangs), the Rust fallback still closes the window, so it can never wedge.
    // Use the `withGlobalTauri` globals rather than importing
    // `@tauri-apps/api/event`. Adding that as a NEW bundler dependency forces a
    // Vite dev dep re-optimization + mid-load reload that wedged the splash.
    // The globals are always present in the Tauri shell and need no import.
    if (desktop) {
      const tauri = (window as unknown as {
        __TAURI__?: {
          event?: { listen?: (e: string, h: () => void) => Promise<() => void> }
          core?: { invoke?: (cmd: string) => Promise<unknown> }
        }
      }).__TAURI__
      const listen = tauri?.event?.listen
      const invoke = tauri?.core?.invoke
      if (listen && invoke) {
        void listen('app-close-requested', () => {
          void (async () => {
            try {
              await flushNow()
            } finally {
              try {
                await invoke('commit_window_close')
              } catch {
                // Rust's fallback timer destroys the window regardless.
              }
            }
          })()
        }).then((unlisten) => tauriCloseListener.install(unlisten))
          .catch(() => { /* event bridge unavailable — Rust fallback still closes */ })
      }
    }

    return () => {
      unsubTimeline?.()
      unsubProject?.()
      if (!desktop) window.removeEventListener('beforeunload', onBeforeUnload)
      tauriCloseListener.dispose()
      // Fire-and-forget: useEffect cleanup can't await, but the promise still
      // resolves and the DB write settles.
      void flushNow()
    }
  }, [])
}
