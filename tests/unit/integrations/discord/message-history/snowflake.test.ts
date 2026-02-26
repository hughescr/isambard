import { describe, test, expect } from 'bun:test';
import { ErrorCode } from '@/errors';
import {
    DISCORD_EPOCH,
    timestampToSnowflake,
    snowflakeToTimestamp,
    InvalidSnowflakeError
} from '@/integrations/discord/message-history/snowflake';

describe.concurrent('DISCORD_EPOCH', () => {
    test('should be January 1, 2015 UTC in milliseconds as bigint', () => {
        expect(DISCORD_EPOCH).toBe(1_420_070_400_000n);
        const epochDate = new Date(Number(DISCORD_EPOCH));
        expect(epochDate.getUTCFullYear()).toBe(2015);
        expect(epochDate.getUTCMonth()).toBe(0);
    });
});

describe('snowflakeToTimestamp', () => {
    // Known Discord snowflake: 175928847299117063
    // This is a well-known Discord snowflake (Discord's announcement of snowflakes)
    // Timestamp: 1462015105796 (April 30, 2016)
    test('should convert a known snowflake to correct timestamp', () => {
        const snowflake = '175928847299117063';
        const timestamp = snowflakeToTimestamp(snowflake);

        // Expected timestamp: Discord epoch + (snowflake >> 22)
        // 175928847299117063 >> 22 = 41944705796
        // 1420070400000 + 41944705796 = 1462015105796
        expect(timestamp.getTime()).toBe(1_462_015_105_796);
    });

    test('should convert Discord epoch snowflake (0) to Discord epoch date', () => {
        // A snowflake of "0" means timestamp bits are 0, so date = Discord epoch
        const snowflake = '0';
        const timestamp = snowflakeToTimestamp(snowflake);
        expect(timestamp.getTime()).toBe(1_420_070_400_000);
    });

    test('should handle a recent snowflake correctly', () => {
        // Snowflake: 1187456789012345678 (a more recent ID)
        // Timestamp bits: 1187456789012345678 >> 22 = 283111760380
        // Expected: 1420070400000 + 283111760380 = 1703182160380
        const snowflake = '1187456789012345678';
        const timestamp = snowflakeToTimestamp(snowflake);
        expect(timestamp.getTime()).toBe(1_703_182_160_380);
    });

    test.each([
        ['empty string', ''],
        ['non-numeric string', 'not-a-number'],
        ['negative snowflake', '-123456789012345678'],
        ['snowflake with letters', '123abc456'],
        ['snowflake with whitespace', '123 456'],
    ])('should throw InvalidSnowflakeError for %s', (_, invalidSnowflake) => {
        expect(() => snowflakeToTimestamp(invalidSnowflake)).toThrow(InvalidSnowflakeError);
    });

    test('should handle very large snowflakes', () => {
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
    test('should convert Discord epoch to snowflake "0"', () => {
        const epochDate = new Date(1_420_070_400_000);
        const snowflake = timestampToSnowflake(epochDate);
        expect(snowflake).toBe('0');
    });

    test('should convert a known timestamp to correct snowflake base', () => {
        // Using the same known conversion from snowflakeToTimestamp test
        // Timestamp: 1462015105796 -> offset from epoch: 41944705796
        // Snowflake = 41944705796 << 22 = 175928847298985984
        const date = new Date(1_462_015_105_796);
        const snowflake = timestampToSnowflake(date);

        // The generated snowflake will have 0s for worker/process/sequence
        // so it will be the base snowflake for that timestamp
        expect(snowflake).toBe('175928847298985984');
    });

    test.each([
        ['specific date', new Date('2024-06-15T12:30:45.123Z')],
        ['current time', new Date()],
    ])('should produce snowflakes that convert back to the same timestamp - %s', (_, originalDate) => {
        const snowflake = timestampToSnowflake(originalDate);
        const recoveredDate = snowflakeToTimestamp(snowflake);
        expect(recoveredDate.getTime()).toBe(originalDate.getTime());
    });

    test('should produce valid numeric string snowflakes', () => {
        const date = new Date();
        const snowflake = timestampToSnowflake(date);

        // Should be a string of digits only
        expect(snowflake).toMatch(/^\d+$/);
    });

    test('should produce increasing snowflakes for increasing timestamps', () => {
        const date1 = new Date('2024-01-01T00:00:00Z');
        const date2 = new Date('2024-06-01T00:00:00Z');
        const date3 = new Date('2024-12-01T00:00:00Z');

        const snowflake1 = timestampToSnowflake(date1);
        const snowflake2 = timestampToSnowflake(date2);
        const snowflake3 = timestampToSnowflake(date3);

        expect(BigInt(snowflake1)).toBeLessThan(BigInt(snowflake2));
        expect(BigInt(snowflake2)).toBeLessThan(BigInt(snowflake3));
    });

    test('should throw for dates before Discord epoch', () => {
        const beforeEpoch = new Date('2014-12-31T23:59:59.999Z');
        expect(() => timestampToSnowflake(beforeEpoch)).toThrow();
    });
});

describe('InvalidSnowflakeError', () => {
    test('should have correct error properties', () => {
        const error = new InvalidSnowflakeError('test-snowflake');
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('InvalidSnowflakeError');
        expect(error.code).toBe(ErrorCode.INVALID_SNOWFLAKE);
        expect(error.context.snowflake).toBe('test-snowflake');
        expect(error.message).toContain('test-snowflake');
        expect(error.stack).toBeDefined();
    });
});

describe('round-trip conversions', () => {
    test('should preserve timestamp precision for millisecond boundaries', () => {
        // Test timestamps at exact millisecond boundaries
        const baseTime = 1_700_000_000_000;
        for(let ms = 0; ms < 10; ms++) {
            const date = new Date(baseTime + ms);
            const snowflake = timestampToSnowflake(date);
            const recovered = snowflakeToTimestamp(snowflake);
            expect(recovered.getTime()).toBe(date.getTime());
        }
    });
});
