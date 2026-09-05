import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { systemClock } from '../../../../src/agent/session/clock';

describe('systemClock', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(1_700_000_000_000);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('now() returns the current system time', () => {
        expect(systemClock.now()).toBe(1_700_000_000_000);

        jest.setSystemTime(1_700_000_005_000);
        expect(systemClock.now()).toBe(1_700_000_005_000);
    });

    it('setTimer does not fire before the delay elapses', () => {
        const fn = jest.fn();
        systemClock.setTimer(fn, 1000);

        jest.advanceTimersByTime(999);

        expect(fn).not.toHaveBeenCalled();
    });

    it('setTimer fires the callback after the delay elapses', () => {
        const fn = jest.fn();
        systemClock.setTimer(fn, 1000);

        jest.advanceTimersByTime(1000);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('clearTimer cancels a pending timer so it never fires', () => {
        const fn = jest.fn();
        const handle = systemClock.setTimer(fn, 1000);
        systemClock.clearTimer(handle);

        jest.advanceTimersByTime(5000);

        expect(fn).not.toHaveBeenCalled();
    });
});
