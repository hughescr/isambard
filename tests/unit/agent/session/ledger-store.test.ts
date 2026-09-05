import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { createLedgerStore, type LedgerStoreDeps } from '@/agent/session/ledger';

const SENTINEL = new Date('2099-01-01T00:00:00Z');
const T1 = new Date('2026-09-04T12:00:00Z');

describe('createLedgerStore', () => {
    let mockLogger: LedgerStoreDeps['logger'];

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(SENTINEL);
        mockLogger = { error: jest.fn() };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('get() returns the initial ledger for the given role before any dispatch', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });

        expect(store.get().role).toBe('conversation');
        expect(store.get().turn).toBeNull();
    });

    it('dispatch folds the event via reduceLedger and updates get()', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });

        store.dispatch({ type: 'envelope_queued', kind: 'discord', at: T1 });

        expect(store.get().queued).toEqual({ human: 1, other: 0 });
    });

    it('notifies a subscriber with the new ledger and the causing event when dispatch changes it', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });
        const listener = jest.fn();
        store.subscribe(listener);

        const event = { type: 'envelope_queued', kind: 'discord', at: T1 } as const;
        store.dispatch(event);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(store.get(), event);
    });

    it('does not notify when dispatch does not change the ledger (reference-equal result)', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });
        const listener = jest.fn();
        store.subscribe(listener);

        store.dispatch({ type: 'interrupt_requested', at: T1 });

        expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribe stops delivery to that listener', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });
        const listener = jest.fn();
        const unsubscribe = store.subscribe(listener);

        unsubscribe();
        store.dispatch({ type: 'envelope_queued', kind: 'discord', at: T1 });

        expect(listener).not.toHaveBeenCalled();
    });

    it('a throwing subscriber does not block the others, and is logged exactly once', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });
        const thrownError = new Error('boom');
        const throwing = jest.fn(() => {
            throw thrownError;
        });
        const other = jest.fn();
        store.subscribe(throwing);
        store.subscribe(other);

        store.dispatch({ type: 'envelope_queued', kind: 'discord', at: T1 });

        expect(other).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith({ error: thrownError }, 'Ledger subscriber threw');
    });

    it('delivers a stable per-dispatch snapshot to later subscribers even when an earlier one dispatches reentrantly', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });
        const seenByB: number[] = [];
        let reentered = false;
        store.subscribe(() => {
            if(!reentered) {
                reentered = true;
                store.dispatch({ type: 'envelope_queued', kind: 'discord', at: T1 });
            }
        });
        store.subscribe((ledger) => {
            seenByB.push(ledger.queued.human);
        });

        store.dispatch({ type: 'envelope_queued', kind: 'discord', at: T1 });

        // Reentrant dispatch (human: 1 -> 2) notifies both subscribers immediately with ledger(2);
        // the outer dispatch's own loop then reaches subscriber B with the snapshot IT captured
        // (ledger(1) from before the reentrant call), not whatever `ledger` has become meanwhile.
        expect(seenByB).toEqual([2, 1]);
    });

    it('notifies multiple subscribers on the same change', () => {
        const store = createLedgerStore('conversation', { logger: mockLogger });
        const first = jest.fn();
        const second = jest.fn();
        store.subscribe(first);
        store.subscribe(second);

        store.dispatch({ type: 'envelope_queued', kind: 'discord', at: T1 });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });
});
