/** Bounded weekly reconciliation of the derived SQLite vector index with DynamoDB (#137). */
import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { decodeStoredMemoryToolItem, storedTtl } from '../memory-tool/decode-stored-item.js';
import { MemoryToolKeyGenerator } from '../memory-tool/key-generator.js';
import { classifyMemoryPath, createMemoryPath } from '../memory-tool/types.js';
import { createRcuPacer, recordRcuPage, requireConsumedReadUnits, sleepRespectingSignal, waitForRcuPacer } from '../utils/rcu-pacing.js';
import type { VectorIndex } from './backend.js';
import { sha256Hex } from './hash.js';
import type { AsyncIndexer } from './indexer.js';

export const VECTOR_CROSS_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const STARTUP_GRACE_MS = 1000;
const PAGE_SIZE = 100;
const BATCH_SIZE = 4;
const MAX_RCU = 2000;
const MAX_REQUEUES = 100;
const RCU_PER_SECOND = 1;

type Snapshot = ReturnType<VectorIndex['listRowSnapshotsAfter']>[number];
interface Client {
    send: (command: BatchGetCommand, options?: { abortSignal?: AbortSignal }) => Promise<Pick<BatchGetCommandOutput, 'Responses' | 'UnprocessedKeys' | 'ConsumedCapacity'>>
}
interface Candidate {
    row:  Snapshot
    path: ReturnType<typeof createMemoryPath>
}
interface Counters {
    checked:   number
    deleted:   number
    requeued:  number
    malformed: number
    rcu:       number
}

export interface VectorCrossCheckDeps {
    vectorIndex: VectorIndex
    /** The holder, not a captured document client, so reconnects replace a wedged connection. */
    docClient:   Client | { getDocClient: () => Client }
    tableName:   string
    indexer:     Pick<AsyncIndexer, 'enqueue' | 'drain'>
    logger:      { info: (obj: Record<string, unknown>) => void, error: (obj: Record<string, unknown>) => void }
    now?:        () => number
    sleep?:      (ms: number, signal: AbortSignal) => Promise<void>
}

export interface VectorCrossCheckScheduler {
    start:   () => void
    stop:    () => Promise<void>
    runOnce: () => Promise<void>
}

function checkAbort(signal: AbortSignal): void {
    if(signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
}

/** Refuse to tombstone a fully absent page: the configured table or stage may be wrong. */
function assertSafeAbsence(checked: number, absent: number): void {
    if(absent === checked) {
        throw new Error(`Vector cross-check refused mass absence: ${absent}/${checked} keys missing (wrong table or stage?)`);
    }
}

function keyOf(item: Record<string, unknown>): string {
    return `${String(item.PK)}\0${String(item.SK)}`;
}

function candidateKeys(candidates: Candidate[]): { PK: string, SK: string }[] {
    return candidates.map(({ row }) => ({ PK: row.pk, SK: row.sk }));
}

function parseCandidates(page: Snapshot[], counts: Counters): Candidate[] {
    const candidates: Candidate[] = [];
    for(const row of page) {
        try {
            const path = createMemoryPath(MemoryToolKeyGenerator.parsePath(row.pk, row.sk));
            const keys = MemoryToolKeyGenerator.createKeys(path);
            if(keys.PK !== row.pk || keys.SK !== row.sk) {
                counts.malformed++;
                continue;
            }
            candidates.push({ row, path });
        } catch{
            counts.malformed++;
        }
    }
    return candidates;
}

function decodeCandidate(raw: Record<string, unknown>, candidate: Candidate): NonNullable<ReturnType<typeof decodeStoredMemoryToolItem>> {
    const item = decodeStoredMemoryToolItem(raw);
    if(item?.path !== candidate.path) {
        throw new TypeError(`Vector cross-check found malformed DynamoDB memory at ${candidate.path}`);
    }
    return item;
}

/** A single shared reader/pacer for all phases of a run, including UnprocessedKeys retries. */
function createReader(deps: VectorCrossCheckDeps, signal: AbortSignal, counts: Counters): (keys: { PK: string, SK: string }[], consistent: boolean) => Promise<Record<string, unknown>[]> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? sleepRespectingSignal;
    const pacer = createRcuPacer();
    return async (keys, consistent) => {
        const found: Record<string, unknown>[] = [];
        let pending = keys;
        let retries = 0;
        while(pending.length > 0) {
            checkAbort(signal);
            // eslint-disable-next-line no-await-in-loop -- Each request must pay the previous request's shared RCU debt.
            await waitForRcuPacer(pacer, now, ms => sleep(ms, signal));
            checkAbort(signal);
            const client = 'getDocClient' in deps.docClient ? deps.docClient.getDocClient() : deps.docClient;
            // eslint-disable-next-line no-await-in-loop -- UnprocessedKeys are retried only after the previous response is accounted for.
            const response = await client.send(new BatchGetCommand({
                RequestItems:           { [deps.tableName]: { Keys: pending, ConsistentRead: consistent } },
                ReturnConsumedCapacity: 'TOTAL',
            }), { abortSignal: signal });
            const units = requireConsumedReadUnits(response.ConsumedCapacity?.[0]?.CapacityUnits, 'Vector cross-check BatchGetItem');
            counts.rcu += units;
            recordRcuPage(pacer, units, RCU_PER_SECOND, true, () => {
                throw new Error('Missing vector cross-check RCU report');
            }, now);
            found.push(...(response.Responses?.[deps.tableName] ?? []));
            pending = (response.UnprocessedKeys?.[deps.tableName]?.Keys ?? []) as { PK: string, SK: string }[];
            if(pending.length > 0) {
                if(++retries > 10) {
                    throw new Error('Vector cross-check exhausted UnprocessedKeys retries');
                }
                // DynamoDB requests exponential backoff for UnprocessedKeys; reuse the shared
                // deadline so a retry also pays any outstanding RCU debt.
                pacer.nextAllowedAtMs = Math.max(pacer.nextAllowedAtMs, now() + Math.min(1000 * 2 ** (retries - 1), 30_000));
            }
        }
        return found;
    };
}

function deleteConfirmedOrphan(deps: VectorCrossCheckDeps, row: Snapshot, counts: Counters): void {
    const { pk, sk, rowid: _rowid, ...generation } = row;
    // A source-version tombstone must not mask an in-flight recreation stamped before this read.
    if(deps.vectorIndex.deleteIfSameGenerationAndTombstone(pk, sk, generation, row.sourceUpdatedAt ?? (deps.now ?? Date.now)())) {
        counts.deleted++;
    }
}

/** A complete page is checkpointed only after its repair jobs actually converge in SQLite. */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- The page has distinct validation, orphan, stale and verification phases; all share one checkpoint boundary.
async function checkPage(deps: VectorCrossCheckDeps, page: Snapshot[], signal: AbortSignal, counts: Counters, fetch: ReturnType<typeof createReader>): Promise<void> {
    const candidates = parseCandidates(page, counts);
    if(candidates.length === 0) {
        return;
    }
    const missing: Candidate[] = [];
    const stale: Candidate[] = [];
    for(let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
        const batch = candidates.slice(offset, offset + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop -- The table's read-capacity debt is shared across batches.
        const rows = await fetch(candidateKeys(batch), false);
        const found = new Map(rows.map(item => [keyOf(item), item]));
        for(const candidate of batch) {
            counts.checked++;
            const raw = found.get(`${candidate.row.pk}\0${candidate.row.sk}`);
            if(raw === undefined) {
                missing.push(candidate);
                continue;
            }
            let item: ReturnType<typeof decodeCandidate>;
            try {
                item = decodeCandidate(raw, candidate);
            } catch{
                counts.malformed++;
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- Compare each row's content fingerprint without another DynamoDB request.
            const hash = await sha256Hex(`${candidate.path}\n${item.content}`);
            if(hash !== candidate.row.contentHash || (storedTtl(raw) ?? null) !== candidate.row.ttl) {
                stale.push(candidate);
            } else {
                deps.vectorIndex.setTtls([{ pk: candidate.row.pk, sk: candidate.row.sk, ttl: storedTtl(raw) ?? null, sourceUpdatedAt: Date.parse(item.updatedAt) }]);
            }
        }
    }
    // Fail closed before any tombstone if the configured stage/table may be wrong.
    assertSafeAbsence(candidates.length, missing.length);
    for(let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
        const batch = missing.slice(offset, offset + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop -- A strong confirmation must precede this batch's synchronous deletes.
        const found = await fetch(candidateKeys(batch), true);
        const present = new Set(found.map(item => keyOf(item)));
        checkAbort(signal);
        for(const { row } of batch) {
            if(present.has(`${row.pk}\0${row.sk}`)) {
                continue;
            }
            deleteConfirmedOrphan(deps, row, counts);
        }
    }
    // Strong full-item reads cannot supersede a newer live write's pending retry with old content.
    const verify: Candidate[] = [];
    for(let offset = 0; offset < stale.length; offset += BATCH_SIZE) {
        const batch = stale.slice(offset, offset + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop -- Stale candidates share the same table capacity budget.
        const rows = await fetch(candidateKeys(batch), true);
        const found = new Map(rows.map(item => [keyOf(item), item]));
        for(const candidate of batch) {
            const raw = found.get(`${candidate.row.pk}\0${candidate.row.sk}`);
            if(raw === undefined) {
                checkAbort(signal);
                deleteConfirmedOrphan(deps, candidate.row, counts);
                continue;
            }
            let item: ReturnType<typeof decodeCandidate>;
            try {
                item = decodeCandidate(raw, candidate);
            } catch{
                counts.malformed++;
                continue;
            }
            const version = Date.parse(item.updatedAt);
            // eslint-disable-next-line no-await-in-loop -- Hashing occurs locally after a bounded batch fetch.
            const hash = await sha256Hex(`${candidate.path}\n${item.content}`);
            if(candidate.row.sourceUpdatedAt !== null && version < candidate.row.sourceUpdatedAt) {
                continue;
            }
            verify.push(candidate);
            checkAbort(signal);
            if(hash !== candidate.row.contentHash) {
                deps.indexer.enqueue({ kind: 'upsert', path: candidate.path, layer: classifyMemoryPath(candidate.path).namespace, content: item.content, ttl: storedTtl(raw), sourceUpdatedAt: version });
                counts.requeued++;
            } else if((storedTtl(raw) ?? null) !== candidate.row.ttl) {
                deps.vectorIndex.setTtls([{ pk: candidate.row.pk, sk: candidate.row.sk, ttl: storedTtl(raw) ?? null, sourceUpdatedAt: version }]);
            }
        }
    }
    await deps.indexer.drain();
    checkAbort(signal);
    for(let offset = 0; offset < verify.length; offset += BATCH_SIZE) {
        const batch = verify.slice(offset, offset + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop -- Recheck persisted results after drain, which can silently drop failed jobs.
        const rows = await fetch(candidateKeys(batch), true);
        const found = new Map(rows.map(item => [keyOf(item), item]));
        for(const candidate of batch) {
            const raw = found.get(`${candidate.row.pk}\0${candidate.row.sk}`);
            if(raw === undefined) {
                const indexed = deps.vectorIndex.listRowSnapshotsAfter(candidate.row.rowid - 1, 1)[0];
                if(indexed?.pk === candidate.row.pk && indexed.sk === candidate.row.sk) {
                    checkAbort(signal);
                    deleteConfirmedOrphan(deps, indexed, counts);
                }
                continue;
            }
            let item: ReturnType<typeof decodeCandidate>;
            try {
                item = decodeCandidate(raw, candidate);
            } catch{
                counts.malformed++;
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- Each post-drain comparison hashes locally, not via per-row network calls.
            const hash = await sha256Hex(`${candidate.path}\n${item.content}`);
            const indexed = deps.vectorIndex.listRowSnapshotsAfter(candidate.row.rowid - 1, 1)[0];
            if(indexed?.pk !== candidate.row.pk || indexed.sk !== candidate.row.sk
              || indexed.contentHash !== hash || indexed.ttl !== (storedTtl(raw) ?? null)) {
                throw new Error('Vector cross-check requeue did not converge');
            }
        }
    }
}

export function createVectorCrossCheckScheduler(deps: VectorCrossCheckDeps): VectorCrossCheckScheduler {
    const now = deps.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    let active: Promise<void> | undefined;
    let controller: AbortController | undefined;

    const run = async (signal: AbortSignal): Promise<void> => {
        let state = deps.vectorIndex.enrollCrossCheck(now(), VECTOR_CROSS_CHECK_INTERVAL_MS);
        const counts: Counters = { checked: 0, deleted: 0, requeued: 0, malformed: 0, rcu: 0 };
        let completed = false;
        let error: unknown;
        const fetch = createReader(deps, signal, counts);
        try {
            while(true) {
                checkAbort(signal);
                const page = deps.vectorIndex.listRowSnapshotsAfter(state.lastCompletedRowid, PAGE_SIZE);
                if(page.length === 0) {
                    completed = true;
                    state = { nextDueAt: now() + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: now(), lastCompletedRowid: 0 };
                    deps.vectorIndex.saveCrossCheckState(state);
                    break;
                }
                // eslint-disable-next-line no-await-in-loop -- Every page is fully settled before its cursor advances.
                await checkPage(deps, page, signal, counts, fetch);
                checkAbort(signal);
                state = { nextDueAt: now() + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: now(), lastCompletedRowid: page.at(-1)!.rowid };
                deps.vectorIndex.saveCrossCheckState(state);
                if(counts.rcu >= MAX_RCU || counts.requeued >= MAX_REQUEUES) {
                    break;
                }
            }
        } catch (error_) {
            error = error_;
            if(!signal.aborted && !deps.vectorIndex.isClosed) {
                deps.vectorIndex.saveCrossCheckState({ ...state, nextDueAt: now() + RETRY_MS });
                deps.logger.error({ error: error_, msg: 'Vector cross-check failed; retry scheduled' });
            }
        } finally {
            deps.logger.info({ msg: 'Vector cross-check summary', ...counts, cursor: state.lastCompletedRowid, completed, error });
        }
    };

    const runOnce = (): Promise<void> => {
        if(active) {
            return active;
        }
        controller = new AbortController();
        const task = run(controller.signal);
        active = task;
        const clearActive = (): void => {
            active = undefined;
        };
        void task.catch((error: unknown) => {
            deps.logger.error({ error, msg: 'Vector cross-check could not enroll' });
        }).then(clearActive);
        return task;
    };
    const schedule = (retry = false): void => {
        if(!started) {
            return;
        }
        let delay = RETRY_MS;
        if(!retry) {
            try {
                const state = deps.vectorIndex.enrollCrossCheck(now(), VECTOR_CROSS_CHECK_INTERVAL_MS);
                delay = Math.max(STARTUP_GRACE_MS, state.nextDueAt - now());
            } catch (error) {
                deps.logger.error({ error, msg: 'Vector cross-check enrollment failed; retry scheduled' });
            }
        }
        timer = setTimeout(() => {
            void runOnce().then(() => schedule()).catch((error: unknown) => {
                deps.logger.error({ error, msg: 'Vector cross-check could not start; retry scheduled' });
                schedule(true);
            });
        }, delay);
    };
    return {
        start: () => {
            if(!started) {
                started = true;
                schedule();
            }
        },
        stop: async () => {
            started = false;
            clearTimeout(timer);
            controller?.abort();
            await active;
        },
        runOnce,
    };
}
