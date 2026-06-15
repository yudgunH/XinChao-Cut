import { useRef, useState } from 'react'

import { useProjectStore } from '@store/project-store'

export function ProjectName() {
  const name = useProjectStore((s) => s.name)
  const setName = useProjectStore((s) => s.setName)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit() {
    setEditing(true)
    setTimeout(() => {
      inputRef.current?.select()
    }, 0)
  }

  function commit() {
    const val = inputRef.current?.value.trim()
    if (val) setName(val)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        defaultValue={name}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="rounded bg-bg-2 px-2 py-0.5 text-sm font-medium text-text-1 outline-none ring-1 ring-accent"
        style={{ minWidth: 120 }}
        autoFocus
      />
    )
  }

  return (
    <button
      onClick={startEdit}
      title="Click to rename"
      className="rounded px-1 py-0.5 text-sm font-medium text-text-1 hover:bg-bg-2"
    >
      {name}
    </button>
  )
}
