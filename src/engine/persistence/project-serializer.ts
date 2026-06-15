import type { ProjectSnapshot } from './types'

export function serialize(_snapshot: ProjectSnapshot): string {
  throw new Error('Not implemented')
}

export function deserialize(_json: string): ProjectSnapshot {
  throw new Error('Not implemented')
}
