import { Github, Heart, UserRound, X } from 'lucide-react'
import { createPortal } from 'react-dom'

export const APP_AUTHOR = 'Nguyễn Duy Hưng'
export const APP_REPOSITORY_URL = 'https://github.com/yudgunH/XinChao-Cut'
export const AUTHOR_GITHUB_URL = 'https://github.com/yudgunH'

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-[500px] max-w-full overflow-hidden rounded-xl bg-bg-1 shadow-e3 ring-1 ring-border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-1">
            <UserRound size={15} className="text-accent" /> About the Author
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          <div className="flex items-center gap-4">
            <img
              src="/logo.png"
              alt="XinChao-Cut"
              className="h-16 w-16 rounded-2xl ring-1 ring-border"
              draggable={false}
            />
            <div>
              <p className="text-base font-semibold text-text-1">{APP_AUTHOR}</p>
              <p className="mt-1 text-xs text-text-3">Creator and maintainer of XinChao-Cut</p>
            </div>
          </div>

          <p className="mt-5 text-sm leading-6 text-text-2">
            I built XinChao-Cut as an open-source desktop editor that makes practical video
            editing and local AI tools easier to use. The project is developed in public, with
            a focus on fast workflows, reliable exports, and user-owned media.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <a
              href={AUTHOR_GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-bg-3 px-3 py-2 text-xs text-text-1 hover:bg-bg-4"
            >
              <Github size={14} /> @yudgunH
            </a>
            <a
              href={APP_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-hover"
            >
              <Heart size={14} /> View open-source project
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
