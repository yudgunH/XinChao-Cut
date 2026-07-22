import { describe, expect, it } from 'vitest'

import type { AiSetupStatus } from '@engine/backend'

import { needsInitialSetup } from './FirstRunSetup'

function status(patch: Partial<AiSetupStatus> = {}): AiSetupStatus {
  return {
    packaged: true,
    venvMain: false,
    venvOmni: false,
    ffmpeg: false,
    core: false,
    captions: false,
    funasr: false,
    audio: false,
    tts: false,
    python: 'py -3.11',
    ready: false,
    running: false,
    whisperModel: null,
    modelDownloadPolicy: null,
    ...patch,
  }
}

describe('needsInitialSetup', () => {
  it('prompts a fresh packaged install', () => {
    expect(needsInitialSetup(status())).toBe(true)
  })

  it('keeps setup visible while an install is running', () => {
    expect(needsInitialSetup(status({ ready: true, running: true }))).toBe(true)
  })

  it('does not prompt once Core and FFmpeg are ready', () => {
    expect(needsInitialSetup(status({ ready: true }))).toBe(false)
  })

  it('does not prompt in a browser or an unpackaged dev shell', () => {
    expect(needsInitialSetup(null)).toBe(false)
    expect(needsInitialSetup(status({ packaged: false }))).toBe(false)
  })
})
