import { useEffect, useState } from 'react'
import { Check, Loader2, AlertCircle } from 'lucide-react'

import { useProjectStore } from '@store/project-store'

export function SaveStatus() {
  const status = useProjectStore((s) => s.saveStatus)
  const lastSavedAt = useProjectStore((s) => s.lastSavedAt)
  const [ago, setAgo] = useState('')

  useEffect(() => {
    if (!lastSavedAt) return
    function update() {
      const diff = Math.floor((Date.now() - (lastSavedAt ?? 0)) / 1000)
      if (diff < 5) setAgo('just now')
      else if (diff < 60) setAgo(`${diff}s ago`)
      else setAgo(`${Math.floor(diff / 60)}m ago`)
    }
    update()
    const id = setInterval(update, 5000)
    return () => clearInterval(id)
  }, [lastSavedAt])

  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-text-3">
        <Loader2 size={11} className="animate-spin" />
        Saving…
      </span>
    )
  }
  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-text-3">
        <Check size={11} className="text-success" />
        Saved{ago ? ` · ${ago}` : ''}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-danger">
        <AlertCircle size={11} />
        Save failed
      </span>
    )
  }
  return <span className="text-xs text-text-3">Unsaved</span>
}
