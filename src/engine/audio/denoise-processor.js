/**
 * Real-time spectral-gate denoise AudioWorklet.
 *
 * Streaming STFT (Hann window, 1024-pt frame, 256 hop / 75% overlap) with a
 * Wiener-style per-bin attenuation against a fixed noise floor. This mirrors
 * the *intent* of FFmpeg's `afftdn` used at server-export time so the preview
 * sounds close to the final render. It is an approximation, not a bit-exact
 * match.
 *
 * Plain JS (no imports): AudioWorklet global scope can't use bundled modules.
 */
const FRAME = 1024
const HOP = 256
const RING = 8192
const INV_NORM = 1 / 1.5 // Hann^2 overlap-add gain at 75% overlap

function makeHann(n) {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/** In-place iterative radix-2 FFT (n must be a power of two). */
function fft(re, im, inverse) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vr = re[b] * cr - im[b] * ci
        const vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr
        im[b] = im[a] - vi
        re[a] += vr
        im[a] += vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const nf = options?.processorOptions?.nf ?? -25 // noise floor, dBFS
    // Full-scale single-bin magnitude with a Hann analysis window ≈ 0.25*FRAME.
    // The gate threshold is that reference scaled by the noise floor.
    this.threshSq = Math.pow(0.25 * FRAME * Math.pow(10, nf / 20), 2)
    this.win = makeHann(FRAME)
    this.re = new Float32Array(FRAME)
    this.im = new Float32Array(FRAME)
    this.state = [] // per-channel STFT state
  }

  makeState() {
    return {
      sliding: new Float32Array(FRAME), // most-recent FRAME input samples
      ola: new Float32Array(FRAME), // synthesis overlap-add accumulator
      inHop: new Float32Array(HOP),
      inHopFill: 0,
      ring: new Float32Array(RING),
      read: 0,
      write: 0,
      available: 0,
      primed: 0, // samples consumed during initial latency fill
    }
  }

  processHop(st) {
    const { win, re, im } = this
    // Slide the analysis window forward by one hop.
    st.sliding.copyWithin(0, HOP)
    st.sliding.set(st.inHop, FRAME - HOP)

    for (let i = 0; i < FRAME; i++) {
      re[i] = st.sliding[i] * win[i]
      im[i] = 0
    }
    fft(re, im, false)

    // Wiener per-bin gate: bins near/below the noise floor are attenuated.
    const tsq = this.threshSq
    for (let k = 0; k < FRAME; k++) {
      const magSq = re[k] * re[k] + im[k] * im[k]
      const g = magSq / (magSq + tsq)
      re[k] *= g
      im[k] *= g
    }
    fft(re, im, true)

    // Synthesis window + overlap-add.
    for (let i = 0; i < FRAME; i++) st.ola[i] += re[i] * win[i] * INV_NORM

    // Emit the finished HOP samples into the output ring.
    for (let i = 0; i < HOP; i++) {
      if (st.available < RING) {
        st.ring[st.write] = st.ola[i]
        st.write = (st.write + 1) % RING
        st.available++
      }
    }
    st.ola.copyWithin(0, HOP)
    st.ola.fill(0, FRAME - HOP)
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    const nCh = output.length

    for (let ch = 0; ch < nCh; ch++) {
      const inCh = input && input[ch] ? input[ch] : null
      const outCh = output[ch]
      let st = this.state[ch]
      if (!st) st = this.state[ch] = this.makeState()

      for (let i = 0; i < outCh.length; i++) {
        st.inHop[st.inHopFill++] = inCh ? inCh[i] : 0
        if (st.inHopFill === HOP) {
          this.processHop(st)
          st.inHopFill = 0
        }
        // One frame of algorithmic latency: swallow the first FRAME outputs.
        if (st.available > 0) {
          const v = st.ring[st.read]
          st.read = (st.read + 1) % RING
          st.available--
          if (st.primed < FRAME) {
            st.primed++
            outCh[i] = 0
          } else {
            outCh[i] = v
          }
        } else {
          outCh[i] = 0
        }
      }
    }
    return true
  }
}

registerProcessor('denoise-processor', DenoiseProcessor)
