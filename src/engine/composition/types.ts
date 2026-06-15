export interface RenderRequest {
  timeSec: number
  width: number
  height: number
}

export interface Compositor {
  renderFrame(req: RenderRequest): Promise<ImageBitmap | null>
  dispose(): void
}
