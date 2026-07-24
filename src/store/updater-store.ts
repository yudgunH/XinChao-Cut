import { create } from 'zustand'

import type { Update } from '@tauri-apps/plugin-updater'

import { isDesktopShell } from '@engine/backend'
import { flushProject } from '@lib/project-session'
import { useProjectStore } from '@store/project-store'

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

interface CheckOptions {
  silent?: boolean
}

interface UpdaterState {
  phase: UpdaterPhase
  currentVersion: string | null
  availableVersion: string | null
  releaseNotes: string | null
  downloaded: number
  total: number | null
  checkedAt: number | null
  message: string | null
  popupVisible: boolean
  initialize: () => Promise<void>
  checkNow: (options?: CheckOptions) => Promise<void>
  install: () => Promise<void>
  dismissPopup: () => void
}

let pendingUpdate: Update | null = null
let initializePromise: Promise<void> | null = null
let checkPromise: Promise<void> | null = null
let installPromise: Promise<void> | null = null

export function describeUpdaterError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason)
  if (/valid release json|release json|404|not found/i.test(raw)) {
    return 'GitHub Releases does not have valid update metadata yet.'
  }
  if (/timed? out|timeout/i.test(raw)) {
    return 'The update check timed out. Check your internet connection and try again.'
  }
  if (/signature|public key|verification/i.test(raw)) {
    return 'The update signature could not be verified. Download the release manually from GitHub.'
  }
  return raw || 'Unable to check for updates.'
}

export function updatePercent(downloaded: number, total: number | null): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)))
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  phase: 'idle',
  currentVersion: null,
  availableVersion: null,
  releaseNotes: null,
  downloaded: 0,
  total: null,
  checkedAt: null,
  message: null,
  popupVisible: false,

  initialize: async () => {
    if (get().currentVersion || initializePromise) return initializePromise ?? Promise.resolve()
    initializePromise = (async () => {
      if (!isDesktopShell()) {
        set({ currentVersion: 'Web/Dev' })
        return
      }
      try {
        const { getVersion } = await import('@tauri-apps/api/app')
        set({ currentVersion: await getVersion() })
      } catch {
        set({ currentVersion: 'Unknown' })
      }
    })().finally(() => {
      initializePromise = null
    })
    return initializePromise
  },

  checkNow: async (options = {}) => {
    if (checkPromise) return checkPromise
    checkPromise = (async () => {
      await get().initialize()
      if (!isDesktopShell()) {
        if (!options.silent) {
          set({
            phase: 'error',
            message: 'Updates are available only in the installed Windows app.',
            checkedAt: Date.now(),
          })
        }
        return
      }

      if (!options.silent) set({ phase: 'checking', message: null })
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check({ timeout: 15_000 })
        pendingUpdate = update
        if (update) {
          set({
            phase: 'available',
            availableVersion: update.version,
            releaseNotes: update.body ?? null,
            checkedAt: Date.now(),
            message: null,
            popupVisible: true,
          })
        } else {
          pendingUpdate = null
          set({
            phase: 'up-to-date',
            availableVersion: null,
            releaseNotes: null,
            checkedAt: Date.now(),
            message: 'You are using the latest version of XinChao-Cut.',
            popupVisible: false,
          })
        }
      } catch (reason) {
        pendingUpdate = null
        if (!options.silent) {
          set({
            phase: 'error',
            availableVersion: null,
            releaseNotes: null,
            checkedAt: Date.now(),
            message: describeUpdaterError(reason),
            popupVisible: false,
          })
        }
      }
    })().finally(() => {
      checkPromise = null
    })
    return checkPromise
  },

  install: async () => {
    if (installPromise) return installPromise
    const update = pendingUpdate
    if (!update) {
      set({ phase: 'error', message: 'There is no pending update to install.' })
      return
    }
    installPromise = (async () => {
      let downloaded = 0
      let total: number | null = null
      set({
        phase: 'downloading',
        downloaded: 0,
        total: null,
        message: null,
        popupVisible: true,
      })
      try {
        const projectId = useProjectStore.getState().id
        if (projectId) await flushProject(projectId)
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? null
          else if (event.event === 'Progress') downloaded += event.data.chunkLength
          set({ downloaded, total })
        })
        set({
          phase: 'ready',
          message: 'Download complete. XinChao-Cut is restarting.',
        })
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      } catch (reason) {
        set({
          phase: 'error',
          message: describeUpdaterError(reason),
          popupVisible: true,
        })
      }
    })().finally(() => {
      installPromise = null
    })
    return installPromise
  },

  dismissPopup: () => set({ popupVisible: false }),
}))
