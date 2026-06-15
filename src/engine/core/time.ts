export type Seconds = number
export type Frames = number

export function secondsToFrames(s: Seconds, fps: number): Frames {
  return Math.round(s * fps)
}

export function framesToSeconds(f: Frames, fps: number): Seconds {
  return f / fps
}

export function formatTimecode(s: Seconds, fps: number): string {
  const totalFrames = Math.max(0, Math.round(s * fps))
  const ff = totalFrames % fps
  const totalSec = Math.floor(totalFrames / fps)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}
