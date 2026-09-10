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
 * duplicate loads — they join the same promise.  An `invalidate()`/`set()`
 * nonetheless RELEASES that slot, so a `get()` issued after the write starts a
 * fresh load rather than joining (and being answered by) a load that began
 * before the write landed — the silent staleness that would otherwise defeat
 * the system-prompt refresh below.
 *
 * Change fan-out: `onChange(listener)` registers a callback fired after every
 * `invalidate()`/`set()`, and `revision()` exposes the generation counter.
 * Together they are what lets the long-lived sessions rebuild their SDK
 * `systemPrompt` (which is fixed at `query()` time) and ask their conductor for
 * a controlled close-and-resume when Izzy's identity changes.
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
    /**
     * Change listeners, invoked synchronously after every {@link invalidate} and {@link set}.
     * A listener must not throw — one that does would abort the notify loop and starve every
     * listener registered after it.
     */
    private readonly listeners = new Set<() => void>();
    /**
     * Generation counter.  Incremented by `invalidate()` and `set()` so that an
     * in-flight load can detect that the cache has moved on since it started.
     * If the generation has changed by the time the loader resolves, the result
     * is discarded rather than committed to `this.cached`.
     */
    private generation             = 0;

    constructor(loader: IdentityLoader) {
        this.loader = loader;
    }

    /**
     * Registers `listener`, invoked synchronously after every {@link invalidate} and {@link set}
     * — i.e. whenever the identity behind a long-lived session's system prompt may have changed.
     *
     * @param listener - Called with no arguments; must not throw.
     * @returns An unsubscribe function; calling it removes only this listener.
     */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Monotonic counter bumped by every {@link invalidate}/{@link set}.  A caller that reads it
     * before `get()` and again afterwards can tell whether the value it received has already
     * been superseded — the cache commits nothing in that case either (see the generation guard
     * in the private loader below).
     *
     * @returns The current generation.
     */
    revision(): number {
        return this.generation;
    }

    /** Fires every registered {@link onChange} listener, in registration order. */
    private notify(): void {
        for(const listener of this.listeners) {
            listener();
        }
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
        this.inflight = this.load(this.generation);
        return this.inflight;
    }

    private async load(generationAtStart: number): Promise<string> {
        try {
            const value = await this.loader();
            // Only commit to cache if no invalidate() or set() has happened since
            // this load was started.  If the generation has advanced, discard the
            // result so the next get() will start a fresh load.
            // The in-flight slot is released only by the load that still owns it: a superseded
            // load clearing it would strand whatever newer load invalidate()/set() started, so
            // that newer load's own callers would never be joined and a third get() would fire a
            // redundant third load.
            if(this.generation === generationAtStart) {
                this.cached = value;
                this.inflight = undefined;
            }
            return value;
        } catch (err) {
            // On loader failure, clear the in-flight slot so the next get()
            // will retry.  Do NOT populate cached.  Same ownership rule as above.
            if(this.generation === generationAtStart) {
                this.inflight = undefined;
            }
            throw err;
        }
    }

    /**
     * Clears the cached value so the next `get()` re-invokes the loader.
     *
     * Any `get()` already in flight continues to its natural completion and the
     * in-flight caller will still receive the value the loader produces, but that
     * result is NOT committed to the cache slot AND the in-flight slot is released
     * here, so a `get()` issued after this call starts a FRESH load rather than
     * joining the pre-write one.  (Joining it is what would return pre-write
     * identity to the very refresh this invalidation exists to drive.)
     *
     * Calling `invalidate()` while no value is cached and no load is in flight
     * is a no-op in terms of the cached value, but the generation counter still
     * advances and every {@link onChange} listener is still fired.
     */
    invalidate(): void {
        this.cached = undefined;
        this.inflight = undefined;
        // Stryker disable next-line UpdateOperator: direction of generation change is irrelevant — any change invalidates the in-flight load
        this.generation++;
        this.notify();
    }

    /**
     * Stores a pre-computed identity string directly, bypassing the loader.
     *
     * Use this when the caller that triggered the write already holds the new
     * content and wants to avoid an extra round-trip.  Advancing the generation
     * ensures any concurrent in-flight load does not overwrite this value.
     *
     * @param text - The new identity string to cache.
     */
    set(text: string): void {
        this.cached = text;
        this.inflight = undefined;
        // Stryker disable next-line UpdateOperator: direction of generation change is irrelevant — any change invalidates the in-flight load
        this.generation++;
        this.notify();
    }
}
