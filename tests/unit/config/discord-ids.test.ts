import { describe, test, expect } from 'bun:test';
import { discordSnowflakeSchema } from '@/config';

describe('discordSnowflakeSchema', () => {
    test('accepts a full-length Discord snowflake unchanged', () => {
        expect(discordSnowflakeSchema.parse('1283746501928374650')).toBe('1283746501928374650');
    });

    test('accepts a single-digit snowflake', () => {
        expect(discordSnowflakeSchema.parse('0')).toBe('0');
    });

    test('rejects an empty string with the snowflake message', () => {
        expect(discordSnowflakeSchema.safeParse('').error?.issues.map(issue => issue.message)).toEqual(['Discord ID must be a decimal snowflake']);
    });

    test('rejects a non-digit prefix before the digits', () => {
        expect(discordSnowflakeSchema.safeParse('x1283746501928374650').success).toBe(false);
    });

    test('rejects a non-digit suffix after the digits', () => {
        expect(discordSnowflakeSchema.safeParse('1283746501928374650x').success).toBe(false);
    });

    test('rejects an all-letter id', () => {
        expect(discordSnowflakeSchema.safeParse('channel').success).toBe(false);
    });

    test('rejects a negative number', () => {
        expect(discordSnowflakeSchema.safeParse('-1').success).toBe(false);
    });
});
