export { serialize, deserialize } from './project-serializer'
export type { ProjectSnapshot } from './types'
export { normalizeClip, snapshotToTimeline, type DeserializedTimeline } from './snapshot'
export {
  listProjects,
  getProject,
  saveProject,
  createProject,
  deleteProject,
  duplicateProject,
} from './projects-repo'
