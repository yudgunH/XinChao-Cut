export { serialize, deserialize } from './project-serializer'
export type { ProjectSnapshot } from './types'
export {
  normalizeClip,
  snapshotToTimeline,
  snapshotToCompounds,
  type DeserializedTimeline,
  type DeserializedCompound,
} from './snapshot'
export {
  listProjects,
  getProject,
  saveProject,
  createProject,
  deleteProject,
  duplicateProject,
  listProjectBackups,
  restoreProjectBackup,
} from './projects-repo'
