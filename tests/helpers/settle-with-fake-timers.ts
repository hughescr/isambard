/**
 * Drives a promise to settlement under `jest.useFakeTimers()` when its code path schedules
 * chained timers (retry backoff, pacing): each round fires every pending timer, then yields one
 * microtask so the continuation can schedule the next timer. Rounds stop as soon as the promise
 * settles, so the helper does not depend on how many microtask hops sit between timers.
 *
 * @module tests/helpers/settle-with-fake-timers
 */
import { jest } from 'bun:test';

const MAX_ROUNDS = 1000;

/** Returns `promise` once it has settled; the caller awaits it (or `.rejects`) as usual. */
export async function settleWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
    const state = { settled: false };
    const markSettled = (): void => {
        state.settled = true;
    };
    void promise.then(markSettled).catch(markSettled);
    for(let round = 0; round < MAX_ROUNDS && !state.settled; round++) {
        jest.runAllTimers();
        // eslint-disable-next-line no-await-in-loop -- each retry timer is scheduled only after the preceding microtask
        await Promise.resolve();
    }
    if(!state.settled) {
        throw new Error(`promise did not settle after ${MAX_ROUNDS} fake-timer rounds`);
    }
    return promise;
}
