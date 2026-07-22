/**
 * Canvas filter string for a look filter, including a SHARPEN pass — CSS/canvas
 * `filter` has no sharpen function, so we reference an SVG feConvolveMatrix by id
 * (`ctx.filter = 'url(#xinchao-sharpen) brightness(…) …'`, supported in Chromium /
 * the Tauri WebView). The convolution kernel is updated per draw to the requested
 * strength. Used by both the preview and the in-browser exporter so they match.
 */
import { type FilterFxData, filterParams, filterToCanvas } from './types'

const SVG_NS = 'http://www.w3.org/2000/svg'
const FILTER_ID = 'xinchao-sharpen'
let convEl: SVGElement | null = null

function ensureSharpen(): SVGElement | null {
  if (typeof document === 'undefined') return null
  if (convEl && document.getElementById(FILTER_ID)) return convEl
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.setAttribute('id', FILTER_ID)
  // colorInterpolationFilters=sRGB keeps the sharpen perceptually neutral.
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  const conv = document.createElementNS(SVG_NS, 'feConvolveMatrix')
  conv.setAttribute('order', '3')
  conv.setAttribute('preserveAlpha', 'true')
  conv.setAttribute('edgeMode', 'duplicate')
  conv.setAttribute('kernelMatrix', '0 0 0 0 1 0 0 0 0') // identity until set
  filter.appendChild(conv)
  svg.appendChild(filter)
  document.body.appendChild(svg)
  convEl = conv
  return conv
}

function setSharpen(amount: number): boolean {
  const conv = ensureSharpen()
  if (!conv) return false
  const a = Math.max(0, amount)
  // Unsharp 3x3 kernel that sums to 1 (brightness-preserving): centre 1+4a,
  // orthogonal neighbours −a.
  conv.setAttribute('kernelMatrix', `0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`)
  return true
}

/** Full `ctx.filter` string for a filter fx — sharpen (when the preset has it)
 *  followed by the colour grade. Falls back to colour-only if the SVG filter
 *  can't be installed (e.g. no DOM). */
export function canvasFilterString(fx: FilterFxData): string {
  const color = filterToCanvas(fx)
  const { sharpen } = filterParams(fx)
  if (sharpen > 0.001 && setSharpen(sharpen)) {
    return `url(#${FILTER_ID}) ${color}`
  }
  return color
}
