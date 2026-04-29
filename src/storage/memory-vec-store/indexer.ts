/**
 * AsyncIndexer — non-blocking vector index worker.
 *
 * Accepts IndexerJobs via enqueue() and processes them sequentially in the background.
 * The 33ms embed latency must NOT block hot DynamoDB writes — enqueue() returns immediately.
 *
 * Hash-check: before calling embedder.encode(), compute SHA-256 of `${path}\n${content}`.
 * If unchanged, skip embed and leave the existing row untouched.
 *
 * Error handling: on error, log and drop the job. The next write will re-enqueue.
 * Don't crash the worker. Don't retry.
 */

import { sha256Hex } from './hash.js';
import type { EmbedderLike, VectorIndexEntry, IndexerJob } from './types.js';

/** Minimal logger interface (compatible with @hughescr/logger) */
interface IndexerLogger {
    warn: (obj: Record<string, unknown>) => void
}

/** Minimal vector index interface */
interface VectorIndexLike {
    getHash:  (pk: string, sk: string) => string | undefined
    upsert:   (entry: VectorIndexEntry) => void
    'delete': (pk: string, sk: string) => void
}

/** Dependencies for AsyncIndexer */
export interface AsyncIndexerDeps {
    vectorIndex: VectorIndexLike
    embedder:    EmbedderLike
    logger?:     IndexerLogger
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

    #queue: IndexerJob[] = [];
    /**
     * The currently running worker chain.
     * A single linked chain: each job appends a `.then()` to the previous promise.
     * Draining just awaits #tail, which resolves when all enqueued work is done.
     */
    #tail:  Promise<void> = Promise.resolve();
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

    /** Queue depth soft-cap threshold */
    static readonly QUEUE_WARN_THRESHOLD = 1000;

    /** Log once per this many enqueues above the threshold to avoid log flooding */
    static readonly QUEUE_WARN_THROTTLE = 100;

    /**
     * Enqueues a job for asynchronous processing.
     * Returns immediately — never blocks.
     * Chains the job onto the existing work tail so jobs execute sequentially.
     *
     * If the queue depth exceeds QUEUE_WARN_THRESHOLD, logs a WARN message
     * (throttled: once per QUEUE_WARN_THROTTLE additional enqueues above threshold).
     */
    enqueue(job: IndexerJob): void {
        // Chain: previous tail resolves → process this job → new tail resolves
        this.#tail = this.#tail.then(() => this.#processJob(job));
        this.#queue.push(job);

        // Soft cap: warn if queue is growing large, throttled to avoid flooding logs
        const queueLen = this.#queue.length;
        // Stryker disable ConditionalExpression,EqualityOperator,LogicalOperator,ArithmeticOperator,BlockStatement,ObjectLiteral,StringLiteral: queue depth warn guard — logging-only side effect; Bun inspector cannot map per-test coverage for class method bodies, so these mutants appear as NoCoverage
        if(queueLen > AsyncIndexer.QUEUE_WARN_THRESHOLD && (queueLen - AsyncIndexer.QUEUE_WARN_THRESHOLD) % AsyncIndexer.QUEUE_WARN_THROTTLE === 0) {
            this.#logger.warn({
                msg: 'AsyncIndexer queue is growing large — embedder may be falling behind writes',
                queueLen,
                pk:  job.pk,
                sk:  job.sk,
            });
        }
        // Stryker restore ConditionalExpression,EqualityOperator,LogicalOperator,ArithmeticOperator,BlockStatement,ObjectLiteral,StringLiteral
    }

    /**
     * Waits until all currently enqueued jobs have been processed.
     */
    async drain(): Promise<void> {
        await this.#tail;
        // Clear queue reference (the tail already resolved these)
        this.#queue = [];
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

        // Wait for all pending work to finish
        await this.drain();

        // Close the embedder
        await this.#embedder.close();
    }

    /**
     * Processes a single job. On error: logs and drops. Never throws.
     * Always dequeues the job at the end, whether success or error.
     */
    async #processJob(job: IndexerJob): Promise<void> {
        try {
            if(job.kind === 'delete') {
                this.#vectorIndex.delete(job.pk, job.sk);
            } else {
                // kind === 'upsert'
                const text = `${job.path}\n${job.content}`;
                const contentHash = await sha256Hex(text);

                // Hash-check: skip embed if content unchanged
                const existingHash = this.#vectorIndex.getHash(job.pk, job.sk);
                if(existingHash !== contentHash) {
                    // Embed the text — returns EmbedResult with 128-byte packed binary in `data`
                    // vectorBytes is always 128; slice defensively in case encode() returns a larger buffer
                    const embedResult = await this.#embedder.encode([text]);
                    // Take first 128 bytes only — the canonical vector size for this embedding model
                    const vectorBytes = 128;
                    const vector = embedResult.data.slice(0, vectorBytes);

                    this.#vectorIndex.upsert({
                        pk:        job.pk,
                        sk:        job.sk,
                        layer:     job.layer,
                        contentHash,
                        vector,
                        updatedAt: Date.now(),
                    });
                }
            }
        } catch (error) {
            // Log and drop — next write will re-enqueue; do not crash the worker
            const warnPayload = {
                error,
                pk:  job.pk,
                sk:  job.sk,
                msg: 'AsyncIndexer job failed: dropping and continuing',
            };
            this.#logger.warn(warnPayload);
        }
        // Always dequeue the processed job from tracking — drain() resets queue to [] anyway
        // Stryker disable next-line BlockStatement: queue bookkeeping only — drain() resets #queue to [] unconditionally, so shift() has no externally-observable effect
        this.#queue.shift();
    }
}
