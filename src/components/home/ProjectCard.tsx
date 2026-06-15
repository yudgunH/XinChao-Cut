import { useEffect, useRef, useState } from 'react'
import { MoreVertical, Film, Pencil, Copy, Trash2 } from 'lucide-react'

import type { ProjectRow } from '@lib/dexie-db'

interface ProjectCardProps {
  row: ProjectRow
  onOpen: () => void
  onRename: (name: string) => void
  onDuplicate: () => void
  onDelete: () => void
}

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function ProjectCard({ row, onOpen, onRename, onDuplicate, onDelete }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const clipCount = row.snapshot.clips.length

  useEffect(() => {
    if (!menuOpen) return undefined
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  function startRename() {
    setMenuOpen(false)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function commitRename() {
    const val = inputRef.current?.value.trim()
    if (val && val !== row.name) onRename(val)
    setEditing(false)
  }

  return (
    <div className="group flex flex-col gap-2">
      <button
        onClick={onOpen}
        className="relative aspect-video overflow-hidden rounded-lg bg-bg-2 ring-1 ring-border transition-colors hover:ring-accent"
      >
        {row.snapshot.thumbnailDataUrl ? (
          <img
            src={row.snapshot.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-text-3">
            <Film size={28} />
          </div>
        )}
        <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-2xs text-white/90">
          {clipCount} clip{clipCount === 1 ? '' : 's'}
        </span>
      </button>

      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              defaultValue={row.name}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditing(false)
              }}
              autoFocus
              className="w-full rounded bg-bg-2 px-1.5 py-0.5 text-sm text-text-1 outline-none ring-1 ring-accent"
            />
          ) : (
            <button
              onDoubleClick={startRename}
              onClick={onOpen}
              title={row.name}
              className="block max-w-full truncate text-left text-sm font-medium text-text-1"
            >
              {row.name}
            </button>
          )}
          <p className="text-2xs text-text-3">{relativeTime(row.updatedAt)}</p>
        </div>

        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-text-3 opacity-0 transition-opacity hover:bg-bg-3 hover:text-text-1 group-hover:opacity-100 aria-expanded:opacity-100"
            aria-expanded={menuOpen}
            aria-label="Project actions"
          >
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-36 overflow-hidden rounded-md bg-bg-1 py-1 shadow-e3 ring-1 ring-border">
              <button
                onClick={startRename}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-1 hover:bg-bg-2"
              >
                <Pencil size={13} /> Rename
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  onDuplicate()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-1 hover:bg-bg-2"
              >
                <Copy size={13} /> Duplicate
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-danger hover:bg-bg-2"
              >
                <Trash2 size={13} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
