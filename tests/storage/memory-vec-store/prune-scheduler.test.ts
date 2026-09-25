/**
 * Tests for prune-scheduler.ts — startup + hourly local expiry prune (#129).
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { createVectorPruneScheduler, VECTOR_PRUNE_INTERVAL_MS } from '@/storage/memory-vec-store/prune-scheduler';

function makeDeps(pruned: () => number = () => 0) {
    const vectorIndex = { isClosed: false, pruneExpired: mock(pruned) };
    const logger = {
        debug: mock((_obj: Record<string, unknown>) => {}),
        info:  mock((_obj: Record<string, unknown>) => {}),
        warn:  mock((_obj: Record<string, unknown>) => {}),
    };
    return { vectorIndex, logger };
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
        expect(deps.logger.info.mock.calls).toEqual([[{ pruned: 3, msg: 'Pruned expired vector-index rows' }]]);
        expect(deps.logger.debug.mock.calls).toEqual([[{ pruned: 0, msg: 'No expired vector-index rows to prune' }]]);
        expect(deps.logger.warn).not.toHaveBeenCalled();
    });

    it('logs a count of exactly one at info, not debug', () => {
        const deps = makeDeps(() => 1);
        createVectorPruneScheduler(deps).runOnce();
        expect(deps.logger.info.mock.calls).toEqual([[{ pruned: 1, msg: 'Pruned expired vector-index rows' }]]);
        expect(deps.logger.debug).not.toHaveBeenCalled();
    });

    it('logs a failed prune as a warning without rethrowing, and keeps the schedule', () => {
        const failure = new Error('database is locked');
        const deps = makeDeps(() => {
            throw failure;
        });
        const scheduler = createVectorPruneScheduler({ ...deps, intervalMs: 100 });
        expect(() => scheduler.start()).not.toThrow();
        jest.advanceTimersByTime(100);
        expect(deps.logger.warn.mock.calls).toEqual([
            [{ error: failure, msg: 'Vector-index expiry prune failed; will retry next interval' }],
            [{ error: failure, msg: 'Vector-index expiry prune failed; will retry next interval' }],
        ]);
        scheduler.stop();
    });

    it('skips a closed index', () => {
        const deps = makeDeps();
        deps.vectorIndex.isClosed = true;
        createVectorPruneScheduler(deps).runOnce();
        expect(deps.vectorIndex.pruneExpired).not.toHaveBeenCalled();
        expect(deps.logger.debug).not.toHaveBeenCalled();
    });
});
