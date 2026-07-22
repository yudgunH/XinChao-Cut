/**
 * #8: speakCaptions / speakText must not inject project-A assets into project B
 * when the user switches mid-TTS. Imported assets are rolled back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WavAsset = {
  id: string
  name: string
  kind: 'audio'
  durationSec: number
  mimeType: string
  projectId: string
}

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = <T extends (...args: any[]) => any>(impl: T) => vi.fn(impl)

  let liveProjectId = 'proj-A'
  let generation = 1
  const assets: { id: string; projectId?: string }[] = []
  const insertedSeeds: unknown[] = []
  const removed: string[] = []
  let importSeq = 0

  const defaultImport = async (_file: File, projectId: string): Promise<WavAsset> => {
    importSeq += 1
    return {
      id: `voice-${importSeq}`,
      name: 'Voice.wav',
      kind: 'audio',
      durationSec: 2.5,
      mimeType: 'audio/wav',
      projectId,
    }
  }

  return {
    get liveProjectId() {
      return liveProjectId
    },
    setLiveProjectId(id: string) {
      liveProjectId = id
    },
    bump() {
      generation += 1
      return generation
    },
    assets,
    insertedSeeds,
    removed,
    defaultImport,
    reset() {
      liveProjectId = 'proj-A'
      generation = 1
      assets.length = 0
      insertedSeeds.length = 0
      removed.length = 0
      importSeq = 0
    },
    capture: () => ({ projectId: liveProjectId, generation }),
    stillOwns: (ownership: { projectId: string; generation: number }) => {
      if (ownership.generation !== generation) return false
      if (!ownership.projectId) return false
      return liveProjectId === ownership.projectId
    },
    startTts: fn(async () => 'tts-job-1'),
    getTtsStatus: fn(async () => ({ status: 'done' as const, done: 2, total: 2 })),
    ttsDownload: fn(async () => new Blob(['wav'], { type: 'audio/wav' })),
    cancelTts: fn(async () => {}),
    mediaImport: fn(defaultImport),
    mediaRemove: fn(async (id: string) => {
      removed.push(id)
    }),
    addAsset: fn((asset: { id: string; projectId?: string }) => {
      assets.push(asset)
    }),
    insertAudioClips: fn((seeds: unknown[]) => {
      insertedSeeds.push(...seeds)
      return seeds.map((_, i) => `clip-${i}`)
    }),
    timeline: {
      tracks: [{ id: 'text-1', kind: 'text' as const }],
      clips: [
        {
          id: 'cap-1',
          trackId: 'text-1',
          startSec: 0,
          inPointSec: 0,
          outPointSec: 2,
          speed: 1,
          effects: [],
          textData: { content: 'Hello world' },
        },
        {
          id: 'cap-2',
          trackId: 'text-1',
          startSec: 3,
          inPointSec: 0,
          outPointSec: 2,
          speed: 1,
          effects: [],
          textData: { content: 'Second line' },
        },
      ],
    },
  }
})

vi.mock('@lib/project-session', () => ({
  captureProjectOwnership: () => h.capture(),
  stillOwnsProject: (o: { projectId: string; generation: number }) => h.stillOwns(o),
}))

vi.mock('@engine/backend', () => ({
  startTts: h.startTts,
  getTtsStatus: h.getTtsStatus,
  ttsDownload: h.ttsDownload,
  cancelTts: h.cancelTts,
}))

vi.mock('@engine/media', () => ({
  mediaManager: {
    import: h.mediaImport,
    remove: h.mediaRemove,
  },
}))

vi.mock('@store/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      id: h.liveProjectId,
      addAsset: h.addAsset,
    }),
  },
}))

vi.mock('@store/timeline-store', () => ({
  useTimelineStore: {
    getState: () => ({
      timeline: h.timeline,
      insertAudioClips: h.insertAudioClips,
    }),
  },
}))

import { speakCaptions, speakText } from './tts-runner'

describe('tts-runner project ownership (#8)', () => {
  beforeEach(() => {
    h.reset()
    h.startTts.mockClear()
    h.getTtsStatus.mockClear()
    h.ttsDownload.mockClear()
    h.cancelTts.mockClear()
    h.mediaImport.mockReset()
    h.mediaImport.mockImplementation(h.defaultImport)
    h.mediaRemove.mockClear()
    h.addAsset.mockClear()
    h.insertAudioClips.mockClear()
  })

  it('speakCaptions on A then switch to B → timeline B has no A assets; imports rolled back', async () => {
    let importN = 0
    const resolvers: Array<() => void> = []
    h.mediaImport.mockImplementation((_file: File, projectId: string) => {
      importN += 1
      const id = `voice-A-${importN}`
      return new Promise<WavAsset>((resolve) => {
        resolvers.push(() =>
          resolve({
            id,
            name: `Voice ${importN}.wav`,
            kind: 'audio',
            durationSec: 2.5,
            mimeType: 'audio/wav',
            projectId,
          }),
        )
      })
    })

    const runP = speakCaptions({ projectId: 'proj-A' })

    // Wait until TTS finished and first import is waiting
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0))

    // User opens project B (session bump + live id change)
    h.setLiveProjectId('proj-B')
    h.bump()

    // Unblock imports that started under A
    for (const r of [...resolvers]) r()
    // Flush microtasks so the loop can queue the next import (if any)
    await Promise.resolve()
    for (const r of [...resolvers]) r()

    const n = await runP
    expect(n).toBe(0)

    // Must not mutate B's timeline
    expect(h.insertAudioClips).not.toHaveBeenCalled()
    expect(h.insertedSeeds).toHaveLength(0)
    // Assets imported under the aborted session must be rolled back
    expect(h.removed.length).toBeGreaterThan(0)
  })

  it('speakCaptions completes on A without switch → inserts voice clips', async () => {
    const n = await speakCaptions({ projectId: 'proj-A' })
    expect(n).toBe(2)
    expect(h.addAsset).toHaveBeenCalledTimes(2)
    expect(h.insertAudioClips).toHaveBeenCalledTimes(1)
    expect(h.removed).toHaveLength(0)
  })

  it('speakText aborts when project switches before addAsset', async () => {
    h.mediaImport.mockImplementationOnce(async (_file: File, projectId: string) => {
      h.setLiveProjectId('proj-B')
      h.bump()
      return {
        id: 'voice-orphan',
        name: 'Voice.wav',
        kind: 'audio' as const,
        durationSec: 1,
        mimeType: 'audio/wav',
        projectId,
      }
    })

    const id = await speakText('Hello', 0, { projectId: 'proj-A' })
    expect(id).toBeNull()
    expect(h.insertAudioClips).not.toHaveBeenCalled()
    expect(h.removed).toContain('voice-orphan')
  })

  it('speakCaptions with mismatched opts.projectId is a no-op', async () => {
    const n = await speakCaptions({ projectId: 'proj-OTHER' })
    expect(n).toBe(0)
    expect(h.startTts).not.toHaveBeenCalled()
  })
})
