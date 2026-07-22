import { create } from 'zustand'

export type LeftPanelTab =
  | 'media'
  | 'audio'
  | 'text'
  | 'stickers'
  | 'effects'
  | 'transitions'
  | 'captions'
  | 'voice'
  | 'filters'

export type RightPanelTab = 'video' | 'audio' | 'speed' | 'animation' | 'adjust'

/** Top-level app view: the project Home grid vs. the editor. */
export type AppView = 'home' | 'editor'

/**
 * When the backend auto-generates low-res preview proxies for video assets:
 *  - 'off'    — never (manual only, via the clip context menu)
 *  - 'smart'  — only sources taller than 1080p (1440p/4K) — the default
 *  - 'always' — every video asset
 */
export type ProxyMode = 'off' | 'smart' | 'always'

interface UIState {
  view: AppView
  leftPanelWidth: number
  rightPanelWidth: number
  timelineHeight: number
  snapEnabled: boolean
  timelineSnapGuideSec: number | null
  /** Linkage: dragging a video clip also moves — and deleting it also removes —
   *  the captions/audio sitting over it (CapCut "link"). On by default. */
  linkEnabled: boolean
  /** Magnetic main video track: the bottom-most video track auto-closes gaps
   *  between its clips after a delete/move, so no unintended blanks appear.
   *  Off by default (opt-in, like CapCut's main-track behaviour). */
  magneticMainTrack: boolean
  proxyMode: ProxyMode
  activeLeftTab: LeftPanelTab
  activeRightTab: RightPanelTab
  /** Clip whose visual crop/rotate dialog is open (null = closed). Set from the
   *  timeline toolbar Crop button and the clip right-click menu. */
  cropClipId: string | null
  openCrop: (clipId: string) => void
  closeCrop: () => void
  setLeftWidth: (w: number) => void
  setRightWidth: (w: number) => void
  setTimelineHeight: (h: number) => void
  toggleSnap: () => void
  setTimelineSnapGuideSec: (sec: number | null) => void
  toggleLink: () => void
  toggleMagneticMainTrack: () => void
  setProxyMode: (m: ProxyMode) => void
  setActiveLeftTab: (t: LeftPanelTab) => void
  setActiveRightTab: (t: RightPanelTab) => void
  setView: (v: AppView) => void
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

const DEFAULT_TIMELINE_HEIGHT = 350

export const useUIStore = create<UIState>((set) => ({
  view: 'home',
  leftPanelWidth: 320,
  rightPanelWidth: 360,
  timelineHeight: DEFAULT_TIMELINE_HEIGHT,
  snapEnabled: true,
  timelineSnapGuideSec: null,
  linkEnabled: true,
  magneticMainTrack: false,
  proxyMode: 'smart',
  activeLeftTab: 'media',
  activeRightTab: 'video',
  cropClipId: null,
  openCrop: (cropClipId) => set({ cropClipId }),
  closeCrop: () => set({ cropClipId: null }),
  setLeftWidth: (w) => set({ leftPanelWidth: clamp(w, 200, 520) }),
  setRightWidth: (w) => set({ rightPanelWidth: clamp(w, 240, 520) }),
  setTimelineHeight: (h) => set({ timelineHeight: clamp(h, 140, 580) }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled, timelineSnapGuideSec: null })),
  setTimelineSnapGuideSec: (timelineSnapGuideSec) => set({ timelineSnapGuideSec }),
  toggleLink: () => set((s) => ({ linkEnabled: !s.linkEnabled })),
  toggleMagneticMainTrack: () => set((s) => ({ magneticMainTrack: !s.magneticMainTrack })),
  setProxyMode: (proxyMode) => set({ proxyMode }),
  setActiveLeftTab: (activeLeftTab) => set({ activeLeftTab }),
  setActiveRightTab: (activeRightTab) => set({ activeRightTab }),
  // Enter every editor session with the roomy timeline layout. A resize made in
  // the previous project/session should not carry over to the next one.
  setView: (view) => set(
    view === 'editor'
      ? { view, timelineHeight: DEFAULT_TIMELINE_HEIGHT }
      : { view },
  ),
}))
