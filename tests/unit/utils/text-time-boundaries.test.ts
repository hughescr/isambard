import { afterEach, describe, expect, jest, test } from 'bun:test';
import { truncateToWordBoundary } from '@/utils/text';
import { formatTimeSince } from '@/utils/time';

afterEach(() => jest.useRealTimers());

describe('text and time public boundaries', () => {
    test('prefers a space at the final allowed character over an earlier space', () => {
        expect(truncateToWordBoundary('a bc def', 5)).toBe('a bc…');
    });

    test('rounds 58 elapsed hours to two days', () => {
        const now = new Date('2026-01-04T00:00:00.000Z');
        jest.useFakeTimers();
        jest.setSystemTime(now);
        expect(formatTimeSince(new Date(now.getTime() - 58 * 60 * 60 * 1000))).toBe('2 days');
    });
});
