/** Tracks in-flight remote WorkspaceEdits so local→CRDT skips echo. */
export class OriginTracker {
  private depth = 0;

  isRemote(): boolean {
    return this.depth > 0;
  }

  async markRemote(fn: () => Thenable<unknown> | Promise<unknown>): Promise<void> {
    this.depth++;
    try {
      await fn();
    } finally {
      this.depth--;
    }
  }
}
