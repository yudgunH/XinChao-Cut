export {
  AUDIO_LIBRARY_PROJECT_ID,
  createMediaManager,
  mediaManager,
  MediaImportError,
  formatImportErrorForUi,
  scheduleMediaOrphanSweep,
} from './media-manager'
export type { MediaManager } from './media-manager'
export type { MediaAsset, MediaKind } from './types'
export { AUDIO_PROXY_SUFFIX, isAudioCapableProxyKey } from './types'
export {
  runImportTransaction,
  sweepOrphanMedia,
  IMPORT_TMP_PREFIX,
  IMPORT_TMP_GRACE_MS,
} from './import-transaction'
export { detectKind, captureVideoThumbnailStrip } from './probe'
export { extractWaveformPeaks } from './waveform'
export {
  desktopMediaFileSize,
  isTauri,
  kindFromName,
  openMediaDialog,
  pathToMediaUrl,
  readDesktopMediaRange,
} from './desktop'
