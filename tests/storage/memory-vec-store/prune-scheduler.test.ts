/**
 * Tests for prune-scheduler.ts — startup + hourly local expiry prune (#129), plus the hourly
 * delete-tombstone prune piggybacked onto the same scheduler (#134).
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { createVectorPruneScheduler, VECTOR_PRUNE_INTERVAL_MS } from '@/storage/memory-vec-store/prune-scheduler';

function makeDeps(prunedExpiry: () => number = () => 0, prunedTombstones: () => number = () => 0) {
    const vectorIndex = { isClosed: false, pruneExpired: mock(prunedExpiry), pruneExpiredTombstones: mock(prunedTombstones) };
    const logger = {
        debug: mock((_obj: Record<string, unknown>) => {}),
        info:  mock((_obj: Record<string, unknown>) => {}),
        warn:  mock((_obj: Record<string, unknown>) => {}),
    };
    return { vectorIndex, logger };
}

/** Isolates calls carrying a given `msg`, so an assertion about one log line survives the other prune's own logging in the same runOnce(). */
function callsWithMsg(logFn: ReturnType<typeof mock>, msg: string): unknown[][] {
    return (logFn.mock.calls as unknown as Record<string, unknown>[][]).filter(call => call[0].msg === msg);
}

describe('createVectorPruneScheduler', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('prunes hourly by default', () => {
        expect(VECTOR_PRUNE_INTERVAL_MS).toBe(3_600_000);
        const deps = makeDeps();
        const scheduler = createVectorPruneScheduler(deps);
        scheduler.start();
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(3_599_999);
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(2);
        scheduler.stop();
    });

    it('prunes tombstones hourly alongside expiry', () => {
        const deps = makeDeps();
        const scheduler = createVectorPruneScheduler(deps);
        scheduler.start();
        expect(deps.vectorIndex.pruneExpiredTombstones).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(3_599_999);
        expect(deps.vectorIndex.pruneExpiredTombstones).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(deps.vectorIndex.pruneExpiredTombstones).toHaveBeenCalledTimes(2);
        scheduler.stop();
    });

    it('prunes at start, then once per interval; a second start does not double the timer', () => {
        const deps = makeDeps();
        const scheduler = createVectorPruneScheduler({ ...deps, intervalMs: 100 });
        scheduler.start();
        scheduler.start();
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(300);
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(4);
        scheduler.stop();
    });

    it('stop clears the interval; stop is idempotent; start after stop restarts', () => {
        const deps = makeDeps();
        const scheduler = createVectorPruneScheduler({ ...deps, intervalMs: 100 });
        scheduler.stop();
        scheduler.start();
        scheduler.stop();
        scheduler.stop();
        jest.advanceTimersByTime(1000);
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(1);
        scheduler.start();
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(100);
        expect(deps.vectorIndex.pruneExpired).toHaveBeenCalledTimes(3);
        scheduler.stop();
    });

    it('logs a positive count at info and zero at debug', () => {
        let next = 3;
        const deps = makeDeps(() => next);
        const scheduler = createVectorPruneScheduler(deps);
        scheduler.runOnce();
        next = 0;
        scheduler.runOnce();
        expect(callsWithMsg(deps.logger.info, 'Pruned expired vector-index rows')).toEqual([[{ pruned: 3, msg: 'Pruned expired vector-index rows' }]]);
        expect(callsWithMsg(deps.logger.debug, 'No expired vector-index rows to prune')).toEqual([[{ pruned: 0, msg: 'No expired vector-index rows to prune' }]]);
        expect(deps.logger.warn).not.toHaveBeenCalled();
    });

    it('logs a count of exactly one at info, not debug', () => {
        const deps = makeDeps(() => 1);
        createVectorPruneScheduler(deps).runOnce();
        expect(callsWithMsg(deps.logger.info, 'Pruned expired vector-index rows')).toEqual([[{ pruned: 1, msg: 'Pruned expired vector-index rows' }]]);
        expect(callsWithMsg(deps.logger.debug, 'No expired vector-index rows to prune')).toHaveLength(0);
    });

    it('logs a positive tombstone count at info and zero at debug', () => {
        let next = 5;
        const deps = makeDeps(() => 0, () => next);
        const scheduler = createVectorPruneScheduler(deps);
        scheduler.runOnce();
        next = 0;
        scheduler.runOnce();
        expect(callsWithMsg(deps.logger.info, 'Pruned expired delete tombstones')).toEqual([[{ pruned: 5, msg: 'Pruned expired delete tombstones' }]]);
        expect(callsWithMsg(deps.logger.debug, 'No expired delete tombstones to prune')).toEqual([[{ pruned: 0, msg: 'No expired delete tombstones to prune' }]]);
    });

    it('logs a tombstone count of exactly one at info, not debug', () => {
        const deps = makeDeps(() => 0, () => 1);
        createVectorPruneScheduler(deps).runOnce();
        expect(callsWithMsg(deps.logger.info, 'Pruned expired delete tombstones')).toEqual([[{ pruned: 1, msg: 'Pruned expired delete tombstones' }]]);
        expect(callsWithMsg(deps.logger.debug, 'No expired delete tombstones to prune')).toHaveLength(0);
    });

    it('logs a failed expiry prune as a warning without rethrowing, and keeps the schedule', () => {
        const failure = new Error('database is locked');
        const deps = makeDeps(() => {
            throw failure;
        });
        const scheduler = createVectorPruneScheduler({ ...deps, intervalMs: 100 });
        expect(() => scheduler.start()).not.toThrow();
        jest.advanceTimersByTime(100);
        expect(callsWithMsg(deps.logger.warn, 'Vector-index expiry prune failed; will retry next interval')).toEqual([
            [{ error: failure, msg: 'Vector-index expiry prune failed; will retry next interval' }],
            [{ error: failure, msg: 'Vector-index expiry prune failed; will retry next interval' }],
        ]);
        scheduler.stop();
    });

    it('a tombstone-prune failure logs a warning without rethrowing and does not block the expiry prune', () => {
        const failure = new Error('tombstone prune boom');
        const deps = makeDeps(() => 3, () => {
            throw failure;
        });
        createVectorPruneScheduler(deps).runOnce();
        expect(callsWithMsg(deps.logger.warn, 'Vector-index tombstone prune failed; will retry next interval')).toEqual([
            [{ error: failure, msg: 'Vector-index tombstone prune failed; will retry next interval' }],
        ]);
        // The expiry prune still ran and logged: the two try/catches are independent.
        expect(callsWithMsg(deps.logger.info, 'Pruned expired vector-index rows')).toEqual([[{ pruned: 3, msg: 'Pruned expired vector-index rows' }]]);
    });

    it('an expiry-prune failure logs a warning without rethrowing and does not block the tombstone prune', () => {
        const failure = new Error('expiry prune boom');
        const deps = makeDeps(() => {
            throw failure;
        }, () => 7);
        createVectorPruneScheduler(deps).runOnce();
        expect(callsWithMsg(deps.logger.warn, 'Vector-index expiry prune failed; will retry next interval')).toEqual([
            [{ error: failure, msg: 'Vector-index expiry prune failed; will retry next interval' }],
        ]);
        // The tombstone prune still ran and logged: the two try/catches are independent.
        expect(callsWithMsg(deps.logger.info, 'Pruned expired delete tombstones')).toEqual([[{ pruned: 7, msg: 'Pruned expired delete tombstones' }]]);
    });

    it('skips a closed index', () => {
        const deps = makeDeps();
        deps.vectorIndex.isClosed = true;
        createVectorPruneScheduler(deps).runOnce();
        expect(deps.vectorIndex.pruneExpired).not.toHaveBeenCalled();
        expect(deps.vectorIndex.pruneExpiredTombstones).not.toHaveBeenCalled();
        expect(deps.logger.debug).not.toHaveBeenCalled();
    });
});
