export interface WorkerPool {
  size: number
}

export function createWorkerPool(_size = navigator.hardwareConcurrency - 1): WorkerPool {
  throw new Error('Not implemented')
}
