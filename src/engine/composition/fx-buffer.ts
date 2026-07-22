/**
 * Buffer canvas tái sử dụng cho các hiệu ứng cần snapshot-rồi-vẽ-lại
 * (filter full-frame, blur sticker). Tránh tạo/huỷ <canvas> mỗi frame
 * (alloc backing store + GC churn) trong vòng render preview/export.
 *
 * Mỗi "slot" giữ một canvas riêng để hai lời gọi trong cùng một frame
 * (vd vừa filter vừa blur) không đè buffer của nhau. Slot resize lazily.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _buffers = new Map<string, { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: any }>()

export function getFxBuffer(
  slot: string,
  w: number,
  h: number,
): CanvasRenderingContext2D | null {
  const iw = Math.max(1, Math.floor(w))
  const ih = Math.max(1, Math.floor(h))
  let entry = _buffers.get(slot)
  if (!entry) {
    // OffscreenCanvas in Web Workers (document not available), HTMLCanvasElement on main thread.
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof document !== 'undefined'
        ? document.createElement('canvas')
        : new OffscreenCanvas(iw, ih)
    // OffscreenCanvasRenderingContext2D is structurally identical to CanvasRenderingContext2D
    // for all operations used here; cast to keep callers typed simply.
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!ctx) return null
    entry = { canvas, ctx }
    _buffers.set(slot, entry)
  }
  if (entry.canvas.width !== iw || entry.canvas.height !== ih) {
    entry.canvas.width = iw
    entry.canvas.height = ih
  }
  return entry.ctx
}

/** Release backing stores after a preview/export session ends. */
export function releaseFxBuffers(prefix?: string): void {
  for (const [slot, entry] of _buffers) {
    if (prefix && !slot.startsWith(prefix)) continue
    entry.canvas.width = 1
    entry.canvas.height = 1
    _buffers.delete(slot)
  }
}
