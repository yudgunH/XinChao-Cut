export interface ExportSettings {
  width: number
  height: number
  fps: number
  bitrateKbps: number
  format: 'mp4'
}

export interface ExportProgress {
  framesEncoded: number
  totalFrames: number
}

export interface Exporter {
  start(settings: ExportSettings, onProgress: (p: ExportProgress) => void): Promise<Blob>
  cancel(): void
}
