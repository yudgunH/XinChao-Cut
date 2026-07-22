/**
 * Owns an unsubscribe callback that may arrive after its consumer disposed.
 *
 * Native listener APIs are asynchronous: the underlying listener can already
 * be registered while React is unmounting, before the promise returns its
 * unlisten callback. Installing through this lease closes that race by
 * immediately releasing callbacks that arrive after disposal.
 */
export class AsyncListenerLease {
  private closed = false
  private unlisten: (() => void) | null = null

  get disposed(): boolean {
    return this.closed
  }

  install(unlisten: () => void): boolean {
    if (this.closed) {
      unlisten()
      return false
    }
    // A lease owns at most one live listener. Replacing it must not leave the
    // previous listener registered.
    this.unlisten?.()
    this.unlisten = unlisten
    return true
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    const unlisten = this.unlisten
    this.unlisten = null
    unlisten?.()
  }
}
