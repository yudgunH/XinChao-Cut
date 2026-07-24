/**
 * Yield one macrotask without the browser's nested setTimeout(0) 4ms clamp.
 * MessageChannel posts to the macrotask queue without timer throttling. This is
 * used by export/decode loops that must yield for UI and abort handling while
 * still running as quickly as possible.
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
