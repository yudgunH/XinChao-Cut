import { useEffect, useRef } from 'react'

import { saveCurrentProject } from '@lib/project-session'
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

  useEffect(() => {
    let unsubTimeline: (() => void) | undefined
    let unsubProject: (() => void) | undefined

    function scheduleSave() {
      // Don't persist while on the Home grid or before a project is open.
      if (useUIStore.getState().view !== 'editor' || !useProjectStore.getState().id) return
      useProjectStore.getState().setSaveStatus('unsaved')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(async () => {
        useProjectStore.getState().setSaveStatus('saving')
        try {
          await saveCurrentProject()
          useProjectStore.getState().setSaveStatus('saved')
        } catch {
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

    return () => {
      unsubTimeline?.()
      unsubProject?.()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])
}
