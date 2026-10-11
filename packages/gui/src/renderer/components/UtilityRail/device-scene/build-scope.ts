/**
 * What a scene build owns before its handle exists (ADR 0057 §6.5).
 *
 * `createDeviceScene` awaits seven times — the renderer's init, the texture
 * loads, two glTF loads, the pipeline compile, the quiet wait, the first
 * presented frame — and until it resolves the caller holds nothing it could
 * dispose. Toggling 立体板砖 off mid-build therefore ran the build to
 * completion on a detached canvas, and toggling it back on started a
 * second one beside it; a build that threw (a missing bake UV, a loader
 * failure) leaked its renderer, PMREM, worker pool and textures outright.
 *
 * The scope is the fix's shape: each resource is registered as it is made;
 * `checkpoint()` after every await throws — releasing everything, newest
 * first — once the caller's signal has aborted; the build's catch releases
 * on a throw; `adopt()` hands the lot to the scene's own `dispose` once it
 * exists; `commit()` marks the handle as the owner when the build lands.
 */
export class BuildScope {
  private owned: (() => void)[] = [];
  private released = false;

  constructor(private readonly signal?: AbortSignal) {}

  /** Register a resource; after a release it is disposed at once. */
  own(dispose: () => void): void {
    if (this.released) {
      dispose();
      return;
    }
    this.owned.push(dispose);
  }

  /** One dispose now stands for everything owned so far. */
  adopt(dispose: () => void): void {
    this.owned = [dispose];
  }

  get aborted(): boolean {
    return this.signal?.aborted === true;
  }

  /** After each await: an abandoned build releases and stops here. */
  checkpoint(): void {
    if (!this.aborted) return;
    this.release();
    throw new DOMException("the scene build was aborted", "AbortError");
  }

  /** Release everything owned, newest first. Idempotent; one disposer's
   *  throw does not keep the rest alive. */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const dispose of this.owned.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // one failing disposer must not keep the rest alive
      }
    }
  }

  /** The build landed: the handle owns the resources from here. */
  commit(): void {
    this.released = true;
    this.owned = [];
  }
}
