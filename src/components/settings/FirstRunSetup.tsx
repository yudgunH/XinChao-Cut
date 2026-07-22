import { useEffect, useState } from 'react'

import { getAiSetupStatus, type AiSetupStatus } from '@engine/backend'

import { AiSetupWizard } from './AiSetupWizard'

/** Prompt only when the packaged desktop runtime is missing or setup is active. */
export function needsInitialSetup(status: AiSetupStatus | null): boolean {
  return !!status?.packaged && (!status.ready || status.running)
}

/**
 * The app opens on Home, where BackendStatus is not mounted. Keep the first-run
 * bootstrap at app level so a fresh installer cannot silently sit offline.
 */
export function FirstRunSetup() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getAiSetupStatus().then((status) => {
      if (!cancelled && needsInitialSetup(status)) setOpen(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!open) return null
  return (
    <AiSetupWizard
      initialSetup
      onClose={() => setOpen(false)}
      onComplete={() => setOpen(false)}
    />
  )
}
