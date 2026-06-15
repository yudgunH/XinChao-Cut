/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'

// Always fetch models from the HuggingFace hub (cached by the browser after first load).
env.allowLocalModels = false

let asr: any = null
let loadedModel = ''

async function loadPipeline(model: string) {
  const progress = (p: any) => self.postMessage({ type: 'progress', stage: 'model', data: p })
  const hasGpu = !!(self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu

  // IMPORTANT: the Whisper ENCODER must stay fp32 — quantising it (q8) corrupts
  // the audio features and produces completely wrong text. Only the decoder is
  // quantised on CPU to keep memory under the WASM 2GB limit. On WebGPU we run
  // full fp32 (the GPU has the memory and it's fast + most accurate).
  const wasmDtype = { encoder_model: 'fp32', decoder_model_merged: 'q8' } as const

  try {
    const dev = hasGpu ? 'webgpu' : 'wasm'
    const pipe = await pipeline('automatic-speech-recognition', model, {
      device: dev,
      ...(dev === 'wasm' ? { dtype: wasmDtype } : {}),
      progress_callback: progress,
    })
    self.postMessage({ type: 'progress', stage: 'device', device: dev })
    return pipe
  } catch {
    // WebGPU init can fail on some drivers — fall back to CPU (mixed precision).
    const pipe = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: wasmDtype,
      progress_callback: progress,
    })
    self.postMessage({ type: 'progress', stage: 'device', device: 'wasm' })
    return pipe
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { audio, model = 'Xenova/whisper-tiny', language } = e.data as {
    audio: Float32Array
    model?: string
    language?: string
  }
  try {
    if (!asr || loadedModel !== model) {
      asr = await loadPipeline(model)
      loadedModel = model
    }
    self.postMessage({ type: 'progress', stage: 'transcribe' })
    const out: any = await asr(audio, {
      // Smaller chunks → lower peak RAM per chunk. 25 s avoids the OOM spike
      // that word-level forced alignment can cause with 30 s chunks.
      chunk_length_s: 25,
      stride_length_s: 4,
      return_timestamps: 'word',
      // Block the "repeat the same phrase forever" hallucination loop.
      no_repeat_ngram_size: 3,
      // A language hint dramatically reduces hallucination vs auto-detect.
      ...(language && language !== 'auto' ? { language, task: 'transcribe' } : {}),
    })
    const chunks =
      Array.isArray(out?.chunks) && out.chunks.length > 0
        ? out.chunks
        : [{ text: out?.text ?? '', timestamp: [0, null] }]
    self.postMessage({ type: 'done', chunks })
  } catch (err: any) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) })
  }
}
