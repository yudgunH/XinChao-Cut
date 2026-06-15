import path from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@app': path.resolve(__dirname, 'src/app'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@engine': path.resolve(__dirname, 'src/engine'),
      '@store': path.resolve(__dirname, 'src/store'),
      '@workers': path.resolve(__dirname, 'src/workers'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@lib': path.resolve(__dirname, 'src/lib'),
      '@types': path.resolve(__dirname, 'src/types'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // During heavy Whisper inference the browser may drop the HMR WebSocket
    // briefly. Hiding the overlay prevents the "Lost connection" panic prompt
    // which causes users to reload and kill the in-progress worker.
    hmr: { overlay: false },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // A cold dev start was a ~30s black screen. The bulk of it (~11s) was Vite's
    // dependency *scan*: it crawls the whole module graph — including the
    // transcribe worker's `@huggingface/transformers` import, which drags in
    // onnxruntime-web (~130 MB of JS) — just to discover what to pre-bundle.
    //
    // `noDiscovery` skips that scan entirely and pre-bundles ONLY the list
    // below. This requires `include` to name every npm dependency the app
    // actually imports (transitive deps get bundled with their parent). KEEP
    // THIS IN SYNC WITH package.json `dependencies`: a runtime dep that's
    // missing here loads as raw ESM (slow, and breaks outright if it's CJS).
    include: [
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
      'zustand', 'immer', 'dexie', 'nanoid', 'lucide-react', 'comlink',
      'mp4box', 'mp4-muxer', '@breezystack/lamejs',
    ],
    // Heavy WASM/ML deps that are only used on demand (in-browser export, Whisper
    // captions). Excluding them keeps them out of the scan/pre-bundle and lets
    // them load natively the first time their feature is used.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'],
    noDiscovery: true,
    holdUntilCrawlEnd: false,
  },
})
