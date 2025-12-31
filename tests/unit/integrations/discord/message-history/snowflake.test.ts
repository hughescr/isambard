import { describe, it, expect } from 'bun:test';
import {
    DISCORD_EPOCH,
    timestampToSnowflake,
    snowflakeToTimestamp,
    InvalidSnowflakeError
} from '@/integrations/discord/message-history/snowflake';

describe('DISCORD_EPOCH', () => {
    it('should be January 1, 2015 UTC in milliseconds as bigint', () => {
        expect(DISCORD_EPOCH).toBe(1420070400000n);
    });

    it('should represent the correct date', () => {
        const epochDate = new Date(Number(DISCORD_EPOCH));
        expect(epochDate.getUTCFullYear()).toBe(2015);
        expect(epochDate.getUTCMonth()).toBe(0); // January is 0
        expect(epochDate.getUTCDate()).toBe(1);
        expect(epochDate.getUTCHours()).toBe(0);
        expect(epochDate.getUTCMinutes()).toBe(0);
        expect(epochDate.getUTCSeconds()).toBe(0);
    });
});

describe('snowflakeToTimestamp', () => {
    // Known Discord snowflake: 175928847299117063
    // This is a well-known Discord snowflake (Discord's announcement of snowflakes)
    // Timestamp: 1462015105796 (April 30, 2016)
    it('should convert a known snowflake to correct timestamp', () => {
        const snowflake = '175928847299117063';
        const timestamp = snowflakeToTimestamp(snowflake);

        // Expected timestamp: Discord epoch + (snowflake >> 22)
        // 175928847299117063 >> 22 = 41944705796
        // 1420070400000 + 41944705796 = 1462015105796
        expect(timestamp.getTime()).toBe(1462015105796);
    });

    it('should convert Discord epoch snowflake (0) to Discord epoch date', () => {
        // A snowflake of "0" means timestamp bits are 0, so date = Discord epoch
        const snowflake = '0';
        const timestamp = snowflakeToTimestamp(snowflake);
        expect(timestamp.getTime()).toBe(1420070400000);
    });

    it('should handle a recent snowflake correctly', () => {
        // Snowflake: 1187456789012345678 (a more recent ID)
        // Timestamp bits: 1187456789012345678 >> 22 = 283111760380
        // Expected: 1420070400000 + 283111760380 = 1703182160380
        const snowflake = '1187456789012345678';
        const timestamp = snowflakeToTimestamp(snowflake);
        expect(timestamp.getTime()).toBe(1703182160380);
    });

    it('should throw InvalidSnowflakeError for empty string', () => {
        expect(() => snowflakeToTimestamp('')).toThrow(InvalidSnowflakeError);
    });

    it('should throw InvalidSnowflakeError for non-numeric string', () => {
        expect(() => snowflakeToTimestamp('not-a-number')).toThrow(InvalidSnowflakeError);
    });

    it('should throw InvalidSnowflakeError for negative snowflake', () => {
        expect(() => snowflakeToTimestamp('-123456789012345678')).toThrow(InvalidSnowflakeError);
    });

    it('should throw InvalidSnowflakeError for snowflake with letters', () => {
        expect(() => snowflakeToTimestamp('123abc456')).toThrow(InvalidSnowflakeError);
    });

    it('should throw InvalidSnowflakeError for snowflake with whitespace', () => {
        expect(() => snowflakeToTimestamp('123 456')).toThrow(InvalidSnowflakeError);
    });

    it('should handle very large snowflakes', () => {
        // Maximum 64-bit unsigned int: 18446744073709551615
        // This is a valid snowflake format
        const snowflake = '18446744073709551615';
        // Should not throw, just return a very far future date
        const timestamp = snowflakeToTimestamp(snowflake);
        expect(timestamp).toBeInstanceOf(Date);
        expect(timestamp.getTime()).toBeGreaterThan(Date.now());
    });
});

describe('timestampToSnowflake', () => {
    it('should convert Discord epoch to snowflake "0"', () => {
        const epochDate = new Date(1420070400000);
        const snowflake = timestampToSnowflake(epochDate);
        expect(snowflake).toBe('0');
    });

    it('should convert a known timestamp to correct snowflake base', () => {
        // Using the same known conversion from snowflakeToTimestamp test
        // Timestamp: 1462015105796 -> offset from epoch: 41944705796
        // Snowflake = 41944705796 << 22 = 175928847298985984
        const date = new Date(1462015105796);
        const snowflake = timestampToSnowflake(date);

        // The generated snowflake will have 0s for worker/process/sequence
        // so it will be the base snowflake for that timestamp
        expect(snowflake).toBe('175928847298985984');
    });

    it('should produce snowflakes that convert back to the same timestamp', () => {
        // Round-trip test: timestamp -> snowflake -> timestamp
        const originalDate = new Date('2024-06-15T12:30:45.123Z');
        const snowflake = timestampToSnowflake(originalDate);
        const recoveredDate = snowflakeToTimestamp(snowflake);

        // Should be exactly the same since we're using the full millisecond precision
        expect(recoveredDate.getTime()).toBe(originalDate.getTime());
    });

    it('should handle current time', () => {
        const now = new Date();
        const snowflake = timestampToSnowflake(now);
        const recoveredDate = snowflakeToTimestamp(snowflake);

        expect(recoveredDate.getTime()).toBe(now.getTime());
    });

    it('should produce valid numeric string snowflakes', () => {
        const date = new Date();
        const snowflake = timestampToSnowflake(date);

        // Should be a string of digits only
        expect(snowflake).toMatch(/^\d+$/);
    });

    it('should produce increasing snowflakes for increasing timestamps', () => {
        const date1 = new Date('2024-01-01T00:00:00Z');
        const date2 = new Date('2024-06-01T00:00:00Z');
        const date3 = new Date('2024-12-01T00:00:00Z');

        const snowflake1 = timestampToSnowflake(date1);
        const snowflake2 = timestampToSnowflake(date2);
        const snowflake3 = timestampToSnowflake(date3);

        expect(BigInt(snowflake1)).toBeLessThan(BigInt(snowflake2));
        expect(BigInt(snowflake2)).toBeLessThan(BigInt(snowflake3));
    });

    it('should throw for dates before Discord epoch', () => {
        const beforeEpoch = new Date('2014-12-31T23:59:59.999Z');
        expect(() => timestampToSnowflake(beforeEpoch)).toThrow();
    });
});

describe('InvalidSnowflakeError', () => {
    it('should be an instance of Error', () => {
        const error = new InvalidSnowflakeError('test-snowflake');
        expect(error).toBeInstanceOf(Error);
    });

    it('should have correct name', () => {
        const error = new InvalidSnowflakeError('test-snowflake');
        expect(error.name).toBe('InvalidSnowflakeError');
    });

    it('should include snowflake in message', () => {
        const error = new InvalidSnowflakeError('invalid-id');
        expect(error.message).toContain('invalid-id');
    });

    it('should store the snowflake value', () => {
        const error = new InvalidSnowflakeError('bad-snowflake');
        expect(error.snowflake).toBe('bad-snowflake');
    });

    it('should have correct error code', () => {
        const error = new InvalidSnowflakeError('test');
        expect(error.code).toBe('INVALID_SNOWFLAKE');
    });

    it('should have a stack trace', () => {
        const error = new InvalidSnowflakeError('test');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('InvalidSnowflakeError');
    });
});

describe('round-trip conversions', () => {
    it('should preserve timestamp precision for multiple dates', () => {
        const testDates = [
            new Date('2020-01-01T00:00:00.000Z'),
            new Date('2023-07-15T14:30:00.500Z'),
            new Date('2024-12-25T08:15:30.750Z'),
        ];

        for(const originalDate of testDates) {
            const snowflake = timestampToSnowflake(originalDate);
            const recoveredDate = snowflakeToTimestamp(snowflake);
            expect(recoveredDate.getTime()).toBe(originalDate.getTime());
        }
    });

    it('should handle millisecond boundaries', () => {
        // Test timestamps at exact millisecond boundaries
        const baseTime = 1700000000000;
        for(let ms = 0; ms < 10; ms++) {
            const date = new Date(baseTime + ms);
            const snowflake = timestampToSnowflake(date);
            const recovered = snowflakeToTimestamp(snowflake);
            expect(recovered.getTime()).toBe(date.getTime());
        }
    });
});
