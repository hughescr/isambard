import { afterEach, describe, expect, test } from 'bun:test';
import { zoteroTimestamp } from '@/integrations/zotero/timestamp';

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
    if(ORIGINAL_TZ === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = ORIGINAL_TZ;
    }
});

describe('zoteroTimestamp', () => {
    test('formats as Zotero\'s UTC "YYYY-MM-DD hh:mm:ss" with no milliseconds', () => {
        expect(zoteroTimestamp(Date.UTC(2026, 8, 28, 23, 15, 51, 133))).toBe('2026-09-28 23:15:51');
    });

    test('zero-pads a single-digit month, day, hour, minute and second', () => {
        expect(zoteroTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
    });

    test('renders the epoch and midnight', () => {
        expect(zoteroTimestamp(0)).toBe('1970-01-01 00:00:00');
        expect(zoteroTimestamp(Date.UTC(2026, 8, 27))).toBe('2026-09-27 00:00:00');
    });

    test('drops (does not round) fractional seconds', () => {
        expect(zoteroTimestamp(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31 23:59:59');
    });

    test.each(['Pacific/Auckland', 'America/Los_Angeles', 'UTC'])('is UTC whatever the local zone (%s)', (zone) => {
        process.env.TZ = zone;
        expect(zoteroTimestamp(Date.UTC(2026, 11, 31, 23, 30, 0))).toBe('2026-12-31 23:30:00');
    });
});
