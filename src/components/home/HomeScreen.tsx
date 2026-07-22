import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Plus,
  Clapperboard,
  Settings,
  Mic,
  Search,
  Home as HomeIcon,
  ArrowUpRight,
  Sparkles,
  Trash2,
  X,
  CheckSquare,
  type LucideIcon,
} from 'lucide-react'

import {
  deleteProject,
  duplicateProject,
  listProjects,
  saveProject,
  getProject,
} from '@engine/persistence'
import { createAndOpenProject, openProject } from '@lib/project-session'
import type { ProjectListRow } from '@lib/dexie-db'
import { APP_OWNER } from '@components/top-bar/TopBar'
import { useTtsStore } from '@store/tts-store'

import { AiSettings } from '@components/settings/AiSettings'

import { ProjectCard } from './ProjectCard'
import { NewProjectDialog } from './NewProjectDialog'

interface RectBounds {
  left: number
  right: number
  top: number
  bottom: number
}

function rectsIntersect(a: RectBounds, b: RectBounds): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

interface MarqueeBox {
  left: number
  top: number
  width: number
  height: number
}

const MARQUEE_THRESHOLD_PX = 4

/** Left-rail navigation entry. */
function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium transition-colors ${
        active ? 'bg-bg-3 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'
      }`}
    >
      <Icon size={16} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  )
}

/** A "mode" tile under the hero — title + desc + tinted icon, hover lift. */
interface Mode {
  key: string
  icon: LucideIcon
  title: string
  desc: string
  onClick: () => void
  bg: string
  iconWrap: string
  badge?: boolean
}

function ModeCard({ mode }: { mode: Mode }) {
  const Icon = mode.icon
  return (
    <button
      onClick={mode.onClick}
      className={`group relative flex min-h-[104px] items-center gap-3.5 overflow-hidden rounded-xl p-4 text-left ring-1 ring-border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-e2 hover:ring-border-strong ${mode.bg}`}
    >
      <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-lg ${mode.iconWrap}`}>
        <Icon size={22} />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-text-1">{mode.title}</p>
          {mode.badge && (
            <span className="rounded bg-accent/20 px-1 py-px text-[9px] font-bold leading-none text-accent">
              AI
            </span>
          )}
        </div>
        <p className="mt-1 text-2xs leading-4 text-text-3">{mode.desc}</p>
      </div>
      <ArrowUpRight
        size={16}
        className="absolute right-3 top-3 text-text-3 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  )
}

function ConfirmDelete({
  title,
  message,
  onCancel,
  onConfirm,
}: {
  title: string
  message: React.ReactNode
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
        <h2 className="text-sm font-medium text-text-1">{title}</h2>
        <p className="mt-2 text-xs text-text-2">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
          >
            Huỷ
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-danger px-4 py-2 text-xs font-medium text-white hover:bg-danger/90"
          >
            Xoá
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function HomeScreen() {
  const [projects, setProjects] = useState<ProjectListRow[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProjectListRow | null>(null)
  const [query, setQuery] = useState('')

  // Multi-select (rubber-band + ctrl/shift-click) and bulk delete.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)
  const gridWrapRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<{ moved: boolean } | null>(null)
  const lastSelectedRef = useRef<string | null>(null)
  const suppressClickRef = useRef(false)

  const refresh = useCallback(async () => {
    setProjects(await listProjects())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleRename(row: ProjectListRow, name: string) {
    const snap = await getProject(row.id)
    if (!snap) return
    await saveProject({ ...snap, name, updatedAt: Date.now() })
    await refresh()
  }

  async function handleDuplicate(row: ProjectListRow) {
    await duplicateProject(row.id)
    await refresh()
  }

  async function handleDelete(row: ProjectListRow) {
    await deleteProject(row.id)
    setPendingDelete(null)
    setSelectedIds((prev) => prev.filter((id) => id !== row.id))
    await refresh()
  }

  const openVoice = () => useTtsStore.getState().setStudioOpen(true)

  const modes: Mode[] = [
    {
      key: 'voice',
      icon: Mic,
      title: 'Voice Studio',
      desc: 'Tạo audio từ văn bản và quản lý giọng clone',
      onClick: openVoice,
      bg: 'bg-gradient-to-br from-amber-500/10 to-bg-1',
      iconWrap: 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20',
      badge: true,
    },
  ]

  const visible = useMemo(() => {
    if (!projects) return null
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, query])

  const visibleIds = useMemo(() => (visible ?? []).map((p) => p.id), [visible])
  const count = projects?.length ?? 0

  const clearSelection = useCallback(() => setSelectedIds([]), [])

  // Toggle / range-select a card (from a card click or its checkbox).
  const toggleSelect = useCallback(
    (id: string, additive: boolean, range: boolean) => {
      const ids = visibleIds
      const last = lastSelectedRef.current
      lastSelectedRef.current = id
      setSelectedIds((prev) => {
        if (range && last) {
          const from = ids.indexOf(last)
          const to = ids.indexOf(id)
          if (from >= 0 && to >= 0) {
            const [s, e] = from < to ? [from, to] : [to, from]
            const rangeIds = ids.slice(s, e + 1)
            return additive ? Array.from(new Set([...prev, ...rangeIds])) : rangeIds
          }
        }
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      })
    },
    [visibleIds],
  )

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    await Promise.all(ids.map((id) => deleteProject(id)))
    setSelectedIds([])
    setBulkConfirm(false)
    await refresh()
  }

  // Delete key removes the current selection (with a confirm).
  useEffect(() => {
    if (selectedIds.length === 0) return undefined
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        setBulkConfirm(true)
      } else if (e.key === 'Escape') {
        setSelectedIds([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds])

  // ── Rubber-band (marquee) selection over the projects grid ──────────────
  const handleGridMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const wrap = gridWrapRef.current
      if (!wrap) return
      const target = e.target as HTMLElement
      // Don't start a marquee from a text input (rename) — let it focus normally.
      if (target.closest('input,textarea') || target.isContentEditable) return

      suppressClickRef.current = false
      const startedOnCard = !!target.closest('[data-project-id]')
      const additive = e.ctrlKey || e.metaKey || e.shiftKey
      const initialIds = selectedIds
      const startX = e.clientX
      const startY = e.clientY
      marqueeRef.current = { moved: false }

      function onMove(me: MouseEvent) {
        const active = marqueeRef.current
        if (!active) return
        if (!active.moved && Math.hypot(me.clientX - startX, me.clientY - startY) < MARQUEE_THRESHOLD_PX) {
          return
        }
        active.moved = true

        const wrapRect = wrap!.getBoundingClientRect()
        const left = Math.min(startX, me.clientX) - wrapRect.left
        const top = Math.min(startY, me.clientY) - wrapRect.top
        setMarquee({
          left,
          top,
          width: Math.abs(me.clientX - startX),
          height: Math.abs(me.clientY - startY),
        })

        const viewRect: RectBounds = {
          left: Math.min(startX, me.clientX),
          right: Math.max(startX, me.clientX),
          top: Math.min(startY, me.clientY),
          bottom: Math.max(startY, me.clientY),
        }
        const hitIds = Array.from(wrap!.querySelectorAll<HTMLElement>('[data-project-id]'))
          .filter((el) => rectsIntersect(viewRect, el.getBoundingClientRect()))
          .map((el) => el.dataset.projectId)
          .filter((id): id is string => !!id)
        setSelectedIds(additive ? Array.from(new Set([...initialIds, ...hitIds])) : hitIds)
      }

      function onUp() {
        const active = marqueeRef.current
        marqueeRef.current = null
        setMarquee(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (active?.moved) {
          // Swallow ONLY the click the browser fires synchronously right after a
          // drag (so a marquee ending on a card doesn't also open/toggle it).
          // Self-heal on the next tick: if no trailing click fires (marquee ended
          // on a different element than it began), the flag must not get stuck and
          // eat the user's next real click.
          suppressClickRef.current = true
          setTimeout(() => {
            suppressClickRef.current = false
          }, 0)
        } else if (!startedOnCard && !additive) {
          // Plain click on empty space clears the selection.
          setSelectedIds([])
        }
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [selectedIds],
  )

  const handleGridClickCapture = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      e.preventDefault()
      e.stopPropagation()
      suppressClickRef.current = false
    }
  }, [])

  const selectionActive = selectedIds.length > 0

  return (
    <div className="flex h-full overflow-hidden bg-bg-0 text-text-1">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-bg-1">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img
            src="/logo-preview-rounded.svg"
            alt="XinChao-Cut"
            className="h-8 w-8 rounded-lg"
            draggable={false}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">XinChao-Cut</p>
            <p className="truncate text-2xs text-text-3">{APP_OWNER}</p>
          </div>
        </div>

        <div className="px-2.5">
          <button
            onClick={() => setShowNew(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white shadow-e1 transition-colors hover:bg-accent-hover"
          >
            <Plus size={15} />
            Dự án mới
          </button>
        </div>

        <nav className="mt-4 flex flex-col gap-0.5 px-2.5">
          <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-text-3">
            Chỉnh sửa video
          </p>
          <NavItem icon={HomeIcon} label="Trang chủ" active onClick={() => {}} />
          <NavItem icon={Mic} label="Voice Studio" onClick={openVoice} />
        </nav>

        <div className="mt-auto flex flex-col gap-0.5 border-t border-border p-2.5">
          <NavItem icon={Settings} label="Cấu hình AI" onClick={() => setShowSettings(true)} />
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        <div className="px-6 py-6">
          {/* Hero — create project banner */}
          <button
            onClick={() => setShowNew(true)}
            className="group relative flex h-40 w-full items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-[#00d8d6] via-[#22a8e0] to-[#4f9cf9] shadow-e2 transition-shadow hover:shadow-e3"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute -left-10 -top-12 h-40 w-40 rounded-full bg-white/20 blur-3xl"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute -bottom-16 right-10 h-44 w-44 rounded-full bg-black/10 blur-3xl"
            />
            <div className="relative flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-black/20 text-white ring-1 ring-white/20 transition-transform group-hover:scale-105">
                <Plus size={24} />
              </span>
              <div className="text-left">
                <p className="text-lg font-semibold text-white">Tạo dự án mới</p>
                <p className="text-xs text-white/80">Mở timeline trống để bắt đầu dựng video</p>
              </div>
            </div>
          </button>

          {/* Tools */}
          <div className="mt-6 flex items-center gap-2">
            <Sparkles size={14} className="text-text-3" />
            <h2 className="text-sm font-semibold text-text-1">Công cụ</h2>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {modes.map((m) => (
              <ModeCard key={m.key} mode={m} />
            ))}
          </div>

          {/* Projects */}
          <section className="mt-8">
            <div className="mb-4 flex h-8 items-center justify-between gap-3">
              {selectionActive ? (
                // Selection toolbar
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-1">
                      Đã chọn {selectedIds.length}
                    </span>
                    <button
                      onClick={() => setSelectedIds(visibleIds)}
                      className="flex items-center gap-1 rounded-md bg-bg-2 px-2.5 py-1.5 text-2xs font-medium text-text-2 ring-1 ring-border hover:bg-bg-3 hover:text-text-1"
                    >
                      <CheckSquare size={13} /> Chọn tất cả
                    </button>
                    <button
                      onClick={clearSelection}
                      className="flex items-center gap-1 rounded-md bg-bg-2 px-2.5 py-1.5 text-2xs font-medium text-text-2 ring-1 ring-border hover:bg-bg-3 hover:text-text-1"
                    >
                      <X size={13} /> Bỏ chọn
                    </button>
                  </div>
                  <button
                    onClick={() => setBulkConfirm(true)}
                    className="flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-2xs font-semibold text-white hover:bg-danger/90"
                  >
                    <Trash2 size={13} /> Xoá ({selectedIds.length})
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-text-1">Dự án</h2>
                    {count > 0 && (
                      <span className="rounded-full bg-bg-2 px-2 py-0.5 text-2xs font-medium text-text-3">
                        {count}
                      </span>
                    )}
                  </div>
                  {count > 0 && (
                    <div className="relative">
                      <Search
                        size={14}
                        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3"
                      />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Tìm dự án…"
                        className="w-44 rounded-md bg-bg-2 py-1.5 pl-8 pr-3 text-xs text-text-1 outline-none ring-1 ring-border transition-all placeholder:text-text-3 focus:w-56 focus:ring-accent"
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            {projects === null ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex flex-col gap-2">
                    <div className="aspect-video animate-pulse rounded-lg bg-bg-2 ring-1 ring-border" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-bg-2" />
                    <div className="h-2 w-1/3 animate-pulse rounded bg-bg-2" />
                  </div>
                ))}
              </div>
            ) : count === 0 ? (
              <div className="grid place-items-center rounded-xl border border-dashed border-border bg-bg-1/40 py-16">
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="grid h-14 w-14 place-items-center rounded-2xl bg-bg-2 text-text-3 ring-1 ring-border">
                    <Clapperboard size={26} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-text-1">Chưa có dự án nào</p>
                    <p className="mt-0.5 text-xs text-text-3">
                      Tạo dự án đầu tiên để bắt đầu dựng video.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowNew(true)}
                    className="mt-1 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-medium text-white shadow-e1 hover:bg-accent-hover"
                  >
                    <Plus size={15} />
                    Tạo dự án đầu tiên
                  </button>
                </div>
              </div>
            ) : visible && visible.length === 0 ? (
              <div className="grid place-items-center rounded-xl border border-dashed border-border py-14 text-center">
                <p className="text-sm text-text-2">Không tìm thấy dự án khớp “{query}”.</p>
                <button
                  onClick={() => setQuery('')}
                  className="mt-2 text-xs font-medium text-accent hover:underline"
                >
                  Xoá tìm kiếm
                </button>
              </div>
            ) : (
              <div
                ref={gridWrapRef}
                onMouseDown={handleGridMouseDown}
                onClickCapture={handleGridClickCapture}
                className="relative"
              >
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
                  {visible!.map((row) => (
                    <ProjectCard
                      key={row.id}
                      row={row}
                      selected={selectedIds.includes(row.id)}
                      selectionMode={selectionActive}
                      onOpen={() => void openProject(row.id)}
                      onToggleSelect={(additive, range) => toggleSelect(row.id, additive, range)}
                      onRename={(name) => void handleRename(row, name)}
                      onDuplicate={() => void handleDuplicate(row)}
                      onDelete={() => setPendingDelete(row)}
                    />
                  ))}
                </div>
                {marquee && (
                  <div
                    className="pointer-events-none absolute z-20 rounded-sm border border-accent bg-accent/15"
                    style={{
                      left: marquee.left,
                      top: marquee.top,
                      width: marquee.width,
                      height: marquee.height,
                    }}
                  />
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {showSettings && <AiSettings onClose={() => setShowSettings(false)} />}
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
          title="Xoá dự án"
          message={
            <>
              Xoá <span className="font-medium text-text-1">{pendingDelete.name}</span> cùng toàn bộ
              media của nó? Thao tác này không thể hoàn tác.
            </>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleDelete(pendingDelete)}
        />
      )}
      {bulkConfirm && (
        <ConfirmDelete
          title="Xoá nhiều dự án"
          message={
            <>
              Xoá <span className="font-medium text-text-1">{selectedIds.length} dự án</span> đã chọn
              cùng toàn bộ media của chúng? Thao tác này không thể hoàn tác.
            </>
          }
          onCancel={() => setBulkConfirm(false)}
          onConfirm={() => void handleBulkDelete()}
        />
      )}
    </div>
  )
}
