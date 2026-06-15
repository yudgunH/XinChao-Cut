import { create } from 'zustand'

export interface MenuItem {
  label: string
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  openMenu: (x: number, y: number, items: MenuItem[]) => void
  closeMenu: () => void
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  openMenu: (x, y, items) => set({ open: true, x, y, items }),
  closeMenu: () => set({ open: false, items: [] }),
}))
