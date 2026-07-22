export const HIGH_PERFORMANCE_GPU_OPTIONS: GPURequestAdapterOptions = {
  powerPreference: 'high-performance',
}

export interface BrowserGpuAdapterInfo {
  vendor: string
  architecture: string
  device: string
  description: string
  isFallbackAdapter: boolean
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function summarizeGpuAdapter(adapter: GPUAdapter): BrowserGpuAdapterInfo {
  const raw = ((adapter as GPUAdapter & { info?: unknown }).info ?? {}) as unknown as Record<string, unknown>
  return {
    vendor: readString(raw.vendor),
    architecture: readString(raw.architecture),
    device: readString(raw.device),
    description: readString(raw.description),
    isFallbackAdapter: raw.isFallbackAdapter === true,
  }
}

/** Prefer the discrete/high-performance adapter on dual-GPU laptops.
 * ``powerPreference`` remains a browser hint, so callers must still inspect
 * the returned adapter and preserve their software fallback. */
export async function requestHighPerformanceGpuAdapter(): Promise<{
  adapter: GPUAdapter
  info: BrowserGpuAdapterInfo
} | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null
  const adapter = await navigator.gpu.requestAdapter(HIGH_PERFORMANCE_GPU_OPTIONS)
  if (!adapter) return null
  return { adapter, info: summarizeGpuAdapter(adapter) }
}

export function webViewRuntimeVersion(userAgent: string): string {
  // Edge/WebView2 UAs contain both Chrome/x and Edg/y. The Edg token is the
  // actual runtime version and must win even though Chrome appears first.
  return userAgent.match(/Edg\/([\d.]+)/i)?.[1]
    ?? userAgent.match(/Chrome\/([\d.]+)/i)?.[1]
    ?? 'unknown'
}
