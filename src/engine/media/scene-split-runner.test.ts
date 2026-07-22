import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  cancelSceneDetect: vi.fn(),
  hashBlob: vi.fn(),
  checkAssets: vi.fn(),
  isRetryableBackendPollError: vi.fn(() => false),
  uploadAsset: vi.fn(),
  startSceneDetect: vi.fn(),
  getSceneDetectStatus: vi.fn(),
}))
const project = vi.hoisted(() => ({
  owns: true,
  state: {
    id: 'project-1',
    assets: [{
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'video',
      name: 'source.mp4',
      sourcePath: 'C:/media/source.mp4',
    }],
    updateAsset: vi.fn(),
  },
}))
const timeline = vi.hoisted(() => ({
  state: {
    timeline: {
      clips: [{ id: 'clip-1', assetId: 'asset-1', speed: 1 }],
    },
    splitClipAtSourceTimes: vi.fn(),
  },
}))
const scene = vi.hoisted(() => ({
  state: {
    jobId: null as string | null,
    pct: 0,
    assetName: '',
    busy: false,
    start: vi.fn((assetName: string) => {
      scene.state.busy = true
      scene.state.assetName = assetName
      scene.state.jobId = null
    }),
    setJob: vi.fn((jobId: string) => { scene.state.jobId = jobId }),
    setPct: vi.fn((pct: number) => { scene.state.pct = pct }),
    clear: vi.fn(() => {
      scene.state.busy = false
      scene.state.jobId = null
      scene.state.pct = 0
    }),
  },
}))
const toast = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('@engine/backend', () => backend)
vi.mock('@lib/project-session', () => ({
  captureProjectOwnership: () => ({ projectId: 'project-1', generation: 1 }),
  stillOwnsProject: () => project.owns,
}))
vi.mock('@store/project-store', () => ({ useProjectStore: { getState: () => project.state } }))
vi.mock('@store/timeline-store', () => ({ useTimelineStore: { getState: () => timeline.state } }))
vi.mock('@store/scene-split-store', () => ({ useSceneSplitStore: { getState: () => scene.state } }))
vi.mock('@store/toast-store', () => ({ useToastStore: { getState: () => toast } }))
vi.mock('./media-manager', () => ({
  mediaManager: { getBlob: vi.fn(), setContentHash: vi.fn() },
}))

import { runSceneSplit } from './scene-split-runner'

describe('scene split lifecycle', () => {
  beforeEach(() => {
    project.owns = true
    project.state.updateAsset.mockReset()
    timeline.state.splitClipAtSourceTimes.mockReset()
    scene.state.jobId = null
    scene.state.pct = 0
    scene.state.busy = false
    scene.state.start.mockClear()
    scene.state.setJob.mockClear()
    scene.state.setPct.mockClear()
    scene.state.clear.mockClear()
    toast.push.mockReset()
    for (const mock of Object.values(backend)) mock.mockReset()
    backend.cancelSceneDetect.mockResolvedValue(undefined)
    backend.isRetryableBackendPollError.mockReturnValue(false)
  })

  it('splits only after a completed owned backend job', async () => {
    backend.startSceneDetect.mockResolvedValue('scene-job')
    backend.getSceneDetectStatus.mockResolvedValue({
      id: 'scene-job', status: 'done', pct: 100, scenes: [1.25, 2.5],
    })
    timeline.state.splitClipAtSourceTimes.mockReturnValue(2)

    await runSceneSplit('clip-1')

    expect(timeline.state.splitClipAtSourceTimes).toHaveBeenCalledWith(
      'clip-1',
      [1.25, 2.5],
    )
    expect(backend.cancelSceneDetect).not.toHaveBeenCalled()
    expect(scene.state.clear).toHaveBeenCalledTimes(1)
  })

  it('cancels remote FFmpeg and never mutates the timeline after project switch', async () => {
    backend.startSceneDetect.mockResolvedValue('scene-job')
    let pollingStarted!: () => void
    const started = new Promise<void>((resolve) => { pollingStarted = resolve })
    backend.getSceneDetectStatus.mockImplementation((_jobId: string, signal: AbortSignal) => {
      pollingStarted()
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        )
      })
    })

    const running = runSceneSplit('clip-1')
    await started
    project.owns = false
    await running

    expect(backend.cancelSceneDetect).toHaveBeenCalledWith('scene-job')
    expect(timeline.state.splitClipAtSourceTimes).not.toHaveBeenCalled()
    expect(toast.push).not.toHaveBeenCalled()
  })
})
