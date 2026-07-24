import { LayoutGrid, X } from 'lucide-react'

export function ToolPanelCloseButton({
  onClick,
  disabled,
  label = 'Back to menu',
}: {
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-bg-2 px-3 text-xs font-medium text-text-2 ring-1 ring-border transition-colors hover:bg-bg-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <LayoutGrid size={15} />
      <span className="hidden sm:inline">{label}</span>
      <X size={14} className="sm:hidden" />
    </button>
  )
}
