import { lazy, Suspense, useRef } from 'react'

import { HomeScreen } from '@components/home/HomeScreen'
import { DesktopNativeDropBridge } from '@components/shared/DesktopNativeDropBridge'
import { useTtsStore } from '@store/tts-store'
import { useUIStore } from '@store/ui-store'

import { Editor } from './Editor'

const VoiceStudioPanel = lazy(() =>
  import('@components/media-panel/VoiceStudioPanel').then((module) => ({
    default: module.VoiceStudioPanel,
  })),
)

export function App() {
  const view = useUIStore((state) => state.view)
  const voiceOpen = useTtsStore((state) => state.studioOpen)
  const voiceLoaded = useRef(false)
  if (voiceOpen) voiceLoaded.current = true

  return (
    <>
      <DesktopNativeDropBridge />
      {view === 'home' ? <HomeScreen /> : <Editor />}
      <Suspense fallback={null}>
        {voiceLoaded.current && <VoiceStudioPanel />}
      </Suspense>
    </>
  )
}
