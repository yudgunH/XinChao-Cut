/**
 * Export output-folder helpers: a persisted "save exports here" directory plus a
 * native folder picker. The backend (running on the same machine) writes the
 * finished file straight into this folder, so the user doesn't download it.
 */
const LS_KEY = 'xinchao.exportDir'

/** The remembered export folder, or '' when none is set. */
export function getExportDir(): string {
  try {
    return window.localStorage.getItem(LS_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Persist (or clear, with '') the export folder. */
export function setExportDir(dir: string): void {
  try {
    if (dir) window.localStorage.setItem(LS_KEY, dir)
    else window.localStorage.removeItem(LS_KEY)
  } catch {
    /* storage disabled — keep working with the in-memory value only */
  }
}

/**
 * Open the OS folder picker (Tauri dialog plugin) and return the chosen absolute
 * path, or null if cancelled / unavailable. Outside the desktop shell (plain
 * browser dev) the plugin import or call fails — callers fall back to letting the
 * user paste a path into the text field.
 */
export async function pickExportFolder(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, multiple: false, title: 'Choose export folder' })
    return typeof picked === 'string' ? picked : null
  } catch {
    return null
  }
}

/** True when the native folder picker is usable (running inside the Tauri app). */
export function canPickFolder(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Default export filename: today's date as DDMM (e.g. 24 June → "2406"). The
 * backend auto-increments to 2406(1), 2406(2)… when the file already exists. */
export function defaultExportName(d: Date = new Date()): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}${mm}`
}
