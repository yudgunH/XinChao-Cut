/** Tracks editor dirtiness independently from the lifetime of an async save. */
export class AutoSaveGeneration {
  private dirtyGeneration = 0
  private savedGeneration = 0

  markDirty(): number {
    this.dirtyGeneration += 1
    return this.dirtyGeneration
  }

  current(): number {
    return this.dirtyGeneration
  }

  isDirty(): boolean {
    return this.savedGeneration < this.dirtyGeneration
  }

  /** Mark only the edits covered by this save as durable. */
  commit(generation: number): boolean {
    this.savedGeneration = Math.max(this.savedGeneration, generation)
    return !this.isDirty()
  }
}
