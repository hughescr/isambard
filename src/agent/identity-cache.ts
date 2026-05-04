/**
 * Write-through in-memory cache for the agent's core identity context.
 *
 * On cold start the loader is invoked once and the result is retained for the
 * lifetime of the process (or until explicitly invalidated / replaced).
 *
 * Invalidation is driven by the memory-tool write path: whenever a write
 * commits to the `identity` layer, callers should call `invalidate()` so the
 * next `get()` re-fetches.  A caller that already holds the new content may
 * call `set(text)` to push it directly and skip the re-read.
 *
 * Race semantics: a `get()` that is already mid-flight inside the loader will
 * resolve with the value that loader call produces, even if `invalidate()` is
 * called concurrently.  The in-flight promise is tracked and shared so
 * concurrent `get()` calls issued while the loader is running do NOT trigger
 * duplicate loads — they join the same promise.
 */

/**
 * Async factory that produces the identity string.
 * Injected at construction time so the cache can be tested without real I/O.
 */
export type IdentityLoader = () => Promise<string>;

/**
 * In-memory write-through cache for the bot's core identity context blob.
 *
 * Construct one per bot lifetime, injecting the loader via the constructor.
 * The same instance must be passed to both the presence-setup and the
 * memory-tool backend (via an `onIdentityWrite` callback) so invalidations
 * are visible to callers.
 */
export class IdentityCache {
    private readonly loader: IdentityLoader;
    private cached:          string | undefined = undefined;
    private inflight:        Promise<string> | undefined = undefined;

    constructor(loader: IdentityLoader) {
        this.loader = loader;
    }

    /**
     * Returns the cached identity string, invoking the loader on the first call
     * (cold start) or after an `invalidate()`.
     *
     * Concurrent calls issued while the loader is already running join the same
     * in-flight promise — the loader is invoked at most once per cache slot.
     *
     * If the loader throws, the cache slot is NOT populated.  The next `get()`
     * will retry the loader.
     */
    async get(): Promise<string> {
        if(this.cached !== undefined) {
            return this.cached;
        }
        // Stryker disable next-line ConditionalExpression: in-flight deduplication guard — concurrent callers join the existing promise
        if(this.inflight !== undefined) {
            return this.inflight;
        }
        this.inflight = this.load();
        return this.inflight;
    }

    private async load(): Promise<string> {
        try {
            const value = await this.loader();
            this.cached   = value;
            this.inflight = undefined;
            return value;
        } catch (err) {
            // On loader failure, clear the in-flight slot so the next get()
            // will retry.  Do NOT populate cached.
            this.inflight = undefined;
            throw err;
        }
    }

    /**
     * Clears the cached value so the next `get()` re-invokes the loader.
     *
     * Any `get()` already in flight continues to its natural completion; its
     * result will be stored in the cache once it resolves.  The _next_ `get()`
     * issued after invalidate (i.e. once the in-flight settles) will trigger a
     * fresh load.
     *
     * Calling `invalidate()` while no value is cached is a no-op.
     */
    invalidate(): void {
        this.cached = undefined;
    }

    /**
     * Stores a pre-computed identity string directly, bypassing the loader.
     *
     * Use this when the caller that triggered the write already holds the new
     * content and wants to avoid an extra round-trip.
     *
     * @param text - The new identity string to cache.
     */
    set(text: string): void {
        this.cached = text;
    }
}
