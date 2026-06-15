import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import importPlugin from 'eslint-plugin-import'

// All browser / Web-platform globals used across the codebase.  ESLint's
// built-in env lists are either too broad (they pull in Node globals in
// browser files) or too narrow (missing newer APIs like WebCodecs).
const BROWSER_GLOBALS = {
  // Core runtime
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  performance: 'readonly', self: 'readonly', postMessage: 'readonly',
  addEventListener: 'readonly', crypto: 'readonly',
  structuredClone: 'readonly', fetch: 'readonly',
  // DOM elements / events
  Blob: 'readonly', URL: 'readonly', File: 'readonly', Image: 'readonly',
  HTMLElement: 'readonly', HTMLDivElement: 'readonly',
  HTMLCanvasElement: 'readonly', HTMLVideoElement: 'readonly',
  HTMLImageElement: 'readonly', HTMLInputElement: 'readonly',
  KeyboardEvent: 'readonly', MouseEvent: 'readonly',
  MessageEvent: 'readonly', AbortController: 'readonly',
  AbortSignal: 'readonly', DOMException: 'readonly',
  Node: 'readonly', ResizeObserver: 'readonly', Worker: 'readonly',
  FileSystemDirectoryHandle: 'readonly', FileSystemWritableFileStream: 'readonly',
  // Canvas
  CanvasRenderingContext2D: 'readonly', CanvasTextAlign: 'readonly',
  // WebGL (spike compositor)
  WebGL2RenderingContext: 'readonly', WebGLShader: 'readonly',
  WebGLProgram: 'readonly', WebGLTexture: 'readonly', WebGLUniformLocation: 'readonly',
  // Web Audio API
  AudioContext: 'readonly', OfflineAudioContext: 'readonly',
  AudioBuffer: 'readonly', AudioData: 'readonly',
  AudioNode: 'readonly', GainNode: 'readonly',
  AudioBufferSourceNode: 'readonly', BaseAudioContext: 'readonly',
  AudioWorkletNode: 'readonly', AudioWorkletProcessor: 'readonly',
  registerProcessor: 'readonly',
  // WebCodecs
  VideoFrame: 'readonly', VideoEncoder: 'readonly',
  VideoDecoder: 'readonly', VideoDecoderConfig: 'readonly',
  VideoEncoderConfig: 'readonly',
  EncodedVideoChunk: 'readonly', EncodedVideoChunkMetadata: 'readonly',
  AudioEncoder: 'readonly', EncodedAudioChunk: 'readonly',
  // Fetch / network
  Response: 'readonly', FormData: 'readonly',
  // Offscreen rendering
  OffscreenCanvas: 'readonly', ImageBitmap: 'readonly',
  BlobPart: 'readonly',
  // React namespace (used in .tsx type annotations: React.RefObject<…>)
  React: 'readonly',
}

export default [
  { ignores: ['dist', 'node_modules', '.vite', 'backend', 'src-tauri'] },
  js.configs.recommended,
  // TypeScript + React source files
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: BROWSER_GLOBALS,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react: reactPlugin,
      'react-hooks': reactHooks,
      import: importPlugin,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-unused-vars': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/jsx-key': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          // Blank lines between/within import groups are a style preference —
          // enforcing them here generates noise across the whole codebase while
          // offering no correctness benefit.  Leave them to the formatter.
          'newlines-between': 'ignore',
        },
      ],
    },
  },
  // Plain JS source files (AudioWorklets, etc.) — browser globals, no TS parser
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
    },
  },
  // Node.js context for Vite / config files
  {
    files: ['*.config.{js,ts}', '*.config.*.{js,ts}'],
    languageOptions: {
      globals: {
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', require: 'readonly',
        module: 'readonly', exports: 'readonly', Buffer: 'readonly',
      },
    },
  },
]
