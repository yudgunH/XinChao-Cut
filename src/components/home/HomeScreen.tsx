import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Clapperboard } from 'lucide-react'

import {
  deleteProject,
  duplicateProject,
  listProjects,
  saveProject,
  getProject,
} from '@engine/persistence'
import { createAndOpenProject, openProject } from '@lib/project-session'
import type { ProjectRow } from '@lib/dexie-db'
import { APP_OWNER } from '@components/top-bar/TopBar'

import { ProjectCard } from './ProjectCard'
import { NewProjectDialog } from './NewProjectDialog'

function ConfirmDelete({
  name,
  onCancel,
  onConfirm,
}: {
  name: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80"
      onClick={onCancel}
    >
      <div
        className="w-[400px] rounded-xl bg-bg-1 p-5 shadow-e3 ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium text-text-1">Delete project</h2>
        <p className="mt-2 text-xs text-text-2">
          Delete <span className="font-medium text-text-1">{name}</span> and all of its media? This
          can’t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-danger px-4 py-2 text-xs font-medium text-white hover:bg-danger/90"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function HomeScreen() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProjectRow | null>(null)

  const refresh = useCallback(async () => {
    setProjects(await listProjects())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleRename(row: ProjectRow, name: string) {
    const snap = await getProject(row.id)
    if (!snap) return
    await saveProject({ ...snap, name, updatedAt: Date.now() })
    await refresh()
  }

  async function handleDuplicate(row: ProjectRow) {
    await duplicateProject(row.id)
    await refresh()
  }

  async function handleDelete(row: ProjectRow) {
    await deleteProject(row.id)
    setPendingDelete(null)
    await refresh()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-0 text-text-1">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="XinChao-Cut" className="h-8 w-8 rounded-md" draggable={false} />
          <div>
            <h1 className="text-base font-semibold leading-tight">XinChao-Cut</h1>
            <p className="text-2xs text-text-3">Owner: {APP_OWNER}</p>
          </div>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-hover"
        >
          <Plus size={15} />
          New Project
        </button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {projects === null ? null : projects.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <Clapperboard size={40} className="text-text-3" />
              <p className="text-sm text-text-2">No projects yet</p>
              <button
                onClick={() => setShowNew(true)}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-hover"
              >
                <Plus size={15} />
                Create your first project
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
            {projects.map((row) => (
              <ProjectCard
                key={row.id}
                row={row}
                onOpen={() => void openProject(row.id)}
                onRename={(name) => void handleRename(row, name)}
                onDuplicate={() => void handleDuplicate(row)}
                onDelete={() => setPendingDelete(row)}
              />
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewProjectDialog
          onCancel={() => setShowNew(false)}
          onCreate={(name, aspect) => {
            setShowNew(false)
            void createAndOpenProject(name, aspect)
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDelete
          name={pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleDelete(pendingDelete)}
        />
      )}
    </div>
  )
}
