/**
 * AsyncIndexer — non-blocking vector index worker.
 *
 * Accepts IndexerJobs via enqueue() and processes them sequentially in the background.
 * The 33ms embed latency must NOT block hot DynamoDB writes — enqueue() returns immediately.
 *
 * Hash-check: before calling embedder.encode(), compute SHA-256 of `${path}\n${content}`.
 * If unchanged, skip the embed and only bring the row's TTL up to date (#129), so a TTL refresh
 * or removal still reaches the index.
 *
 * Error handling: retry transient embedding and SQLite lock failures in memory with bounded
 * exponential backoff. Log and drop other failures (or exhausted retries); the next write or
 * backfill repairs derived index data. Don't crash the worker.
 */

import { MemoryToolKeyGenerator } from '../memory-tool/key-generator.js';
import { sha256Hex } from './hash.js';
import { encodeOne, type EmbedderLike, type VectorIndexEntry, type IndexerJob, type VectorTtlUpdate } from './types.js';

/** Minimal logger interface (compatible with @hughescr/logger) */
interface IndexerLogger {
    warn: (obj: Record<string, unknown>) => void
}

/** Minimal vector index interface */
interface VectorIndexLike {
    getHash:  (pk: string, sk: string) => string | undefined
    upsert:   (entry: VectorIndexEntry) => void
    setTtls:  (entries: readonly VectorTtlUpdate[]) => number
    'delete': (pk: string, sk: string) => void
}

/** Dependencies for AsyncIndexer */
export interface AsyncIndexerDeps {
    vectorIndex: VectorIndexLike
    embedder:    EmbedderLike
    logger?:     IndexerLogger
}

type WorkState = 'queued' | 'executing' | 'sleeping' | 'complete';

interface IndexerWork {
    job:         IndexerJob
    attempts:    number
    state:       WorkState
    retryTimer?: ReturnType<typeof setTimeout>
    completion:  Promise<void>
    resolve:     () => void
}

/**
 * Async vector indexer that processes upsert/delete jobs sequentially.
 *
 * Create with `new AsyncIndexer(deps)` then:
 * - `enqueue(job)` — non-blocking, push to queue
 * - `drain()` — wait until queue is empty and worker is idle
 * - `close()` — drain then close embedder
 */
export class AsyncIndexer {
    readonly #vectorIndex: VectorIndexLike;
    readonly #embedder:    EmbedderLike;
    readonly #logger:      IndexerLogger;

    #pending = 0;
    /** The serial execution chain. Delayed retries append only when their timer fires. */
    #tail:           Promise<void> = Promise.resolve();
    /** Completion chain for logical work, including retry delays captured by drain(). */
    #completionTail: Promise<void> = Promise.resolve();
    /** The newest work for each path, used to retire stale pending retries. */
    #latestWorkByPath = new Map<string, IndexerWork>();
    #closed = false;

    constructor(deps: AsyncIndexerDeps) {
        this.#vectorIndex = deps.vectorIndex;
        this.#embedder    = deps.embedder;
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op logger when none provided; intentionally does nothing
        this.#logger      = deps.logger ?? { warn: () => {} };
    }

    /** True once close() has been called. */
    get isClosed(): boolean {
        return this.#closed;
    }

    /**
     * Number of paths with unfinished work (queued, executing or sleeping on a retry).
     * Observability for the supersession bookkeeping: it returns to 0 once all work settles.
     *
     * @internal
     */
    get trackedPathCount(): number {
        return this.#latestWorkByPath.size;
    }

    /** Queue depth soft-cap threshold */
    static readonly QUEUE_WARN_THRESHOLD = 1000;

    /** Log once per this many enqueues above the threshold to avoid log flooding */
    static readonly QUEUE_WARN_THROTTLE = 100;

    /** Initial attempt plus this many bounded retry attempts. */
    static readonly RETRY_MAX_ATTEMPTS = 3;

    /** Delay before the first retry; subsequent retries double this delay. */
    static readonly RETRY_BASE_DELAY_MS = 250;

    /**
     * Enqueues a job for asynchronous processing.
     * Returns immediately — never blocks.
     * Chains the job onto the existing work tail so jobs execute sequentially.
     *
     * If the queue depth exceeds QUEUE_WARN_THRESHOLD, logs a WARN message
     * (throttled: once per QUEUE_WARN_THROTTLE additional enqueues above threshold).
     */
    enqueue(job: IndexerJob): void {
        const prior = this.#latestWorkByPath.get(job.path);
        if(prior?.state === 'sleeping' || (prior?.state === 'queued' && prior.attempts > 0)) {
            // A newer write makes a pending retry stale. Supersession is expected, not a failure.
            this.#completeWork(prior);
        }

        const work = this.#createWork(job);
        this.#latestWorkByPath.set(job.path, work);
        this.#appendWork(work);
        this.#pending++;

        // Soft cap: warn if queue is growing large, throttled to avoid flooding logs
        const queueLen = this.#pending;
        if(queueLen > AsyncIndexer.QUEUE_WARN_THRESHOLD && queueLen % AsyncIndexer.QUEUE_WARN_THROTTLE === 0) {
            this.#logger.warn({
                msg:  'AsyncIndexer queue is growing large — embedder may be falling behind writes',
                queueLen,
                path: job.path,
            });
        }
    }

    /** Waits until all work captured at call time has settled, including delayed retries. */
    async drain(): Promise<void> {
        await this.#completionTail;
    }

    /**
     * Drains all pending jobs then closes the embedder.
     * Idempotent — safe to call multiple times.
     */
    async close(): Promise<void> {
        // Guard: idempotent — second close() is a no-op
        if(this.#closed) {
            return;
        }
        this.#closed = true;

        // Wait for all pending work, including bounded delayed retries, to finish
        await this.drain();

        // Close the embedder
        await this.#embedder.close();
    }

    #createWork(job: IndexerJob): IndexerWork {
        let resolveWork!: () => void;
        const completion = new Promise<void>((resolve) => {
            resolveWork = resolve;
        });
        const work: IndexerWork = { job, attempts: 0, state: 'queued', completion, resolve: resolveWork };
        this.#completionTail = this.#completionTail.then(() => completion);
        return work;
    }

    #appendWork(work: IndexerWork): void {
        this.#tail = this.#tail.then(() => this.#processWork(work));
    }

    /** Processes one attempt. Delayed retries are deliberately outside the serial tail. */
    async #processWork(work: IndexerWork): Promise<void> {
        // A superseded queued retry is already 'complete' by the time its turn comes.
        if(work.state !== 'queued') {
            return;
        }
        work.state = 'executing';
        work.attempts++;
        let encoding = false;
        try {
            const keys = MemoryToolKeyGenerator.createKeys(work.job.path);
            if(work.job.kind === 'delete') {
                this.#vectorIndex.delete(keys.PK, keys.SK);
            } else {
                const text = `${work.job.path}\n${work.job.content}`;
                const contentHash = await sha256Hex(text);
                const ttl = work.job.ttl ?? null;
                const { sourceUpdatedAt } = work.job;
                // Hash-check: skip embed if content unchanged, but still carry the TTL (and the
                // source version the vector index guards writes with) across
                const existingHash = this.#vectorIndex.getHash(keys.PK, keys.SK);
                if(existingHash === contentHash) {
                    this.#vectorIndex.setTtls([{ pk: keys.PK, sk: keys.SK, ttl, sourceUpdatedAt }]);
                } else {
                    encoding = true;
                    const vector = await encodeOne(this.#embedder, text);
                    encoding = false;
                    this.#vectorIndex.upsert({
                        pk:        keys.PK,
                        sk:        keys.SK,
                        layer:     work.job.layer,
                        contentHash,
                        vector,
                        updatedAt: Date.now(),
                        ttl,
                        sourceUpdatedAt,
                    });
                }
            }
            this.#completeWork(work);
        } catch (error) {
            if((encoding || this.#isBusyError(error)) && work.attempts < AsyncIndexer.RETRY_MAX_ATTEMPTS && this.#latestWorkByPath.get(work.job.path) === work) {
                this.#scheduleRetry(work, error);
                return;
            }
            this.#logger.warn({
                error,
                path: work.job.path,
                msg:  'AsyncIndexer job failed: dropping and continuing',
            });
            this.#completeWork(work);
        }
    }

    #scheduleRetry(work: IndexerWork, error: unknown): void {
        const delayMs = AsyncIndexer.RETRY_BASE_DELAY_MS * 2 ** (work.attempts - 1);
        work.state = 'sleeping';
        this.#logger.warn({
            error,
            path:        work.job.path,
            attempt:     work.attempts,
            nextAttempt: work.attempts + 1,
            delayMs,
            msg:         'AsyncIndexer job failed: retrying with bounded backoff',
        });
        // Only #completeWork() moves a work out of 'sleeping' before this fires, and it clears the
        // timer synchronously — so when the timer does fire, the work is still the path's latest.
        work.retryTimer = setTimeout(() => {
            work.retryTimer = undefined;
            work.state = 'queued';
            this.#appendWork(work);
        }, delayMs);
    }

    /**
     * Settles a work exactly once. Callers only ever pass unsettled work: enqueue() retires the
     * path's latest work (never 'complete', since completion removes it from the map), and
     * #processWork() completes the work it is executing.
     */
    #completeWork(work: IndexerWork): void {
        work.state = 'complete';
        clearTimeout(work.retryTimer);
        work.retryTimer = undefined;
        this.#pending--;
        if(this.#latestWorkByPath.get(work.job.path) === work) {
            this.#latestWorkByPath.delete(work.job.path);
        }
        work.resolve();
    }

    #isBusyError(error: unknown): boolean {
        return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
    }
}
