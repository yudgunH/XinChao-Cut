/**
 * Nhường một "macrotask" mà KHÔNG bị trình duyệt clamp 4ms như setTimeout(0)
 * lồng nhau. Dùng MessageChannel: postMessage lên hàng đợi macrotask nhưng
 * không qua timer throttling. Dành cho vòng lặp export/decode cần yield cho
 * UI/abort nhưng vẫn chạy nhanh nhất có thể.
 */
let _port: MessagePort | null = null
const _queue: (() => void)[] = []

function ensurePort(): MessagePort | null {
  if (_port) return _port
  if (typeof MessageChannel === 'undefined') return null
  const mc = new MessageChannel()
  mc.port1.onmessage = () => {
    const fn = _queue.shift()
    fn?.()
  }
  _port = mc.port2
  return _port
}

export function yieldToMacrotask(): Promise<void> {
  const port = ensurePort()
  if (!port) return new Promise((r) => setTimeout(r, 0))
  return new Promise<void>((resolve) => {
    _queue.push(resolve)
    port.postMessage(0)
  })
}
