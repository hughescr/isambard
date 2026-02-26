import { DiscordSnowflake } from '@sapphire/snowflake';
import { z } from 'zod';
import { InvalidSnowflakeError } from '@/errors';

// Re-export error class for backward compatibility

/**
 * Discord epoch: January 1, 2015 00:00:00 UTC in milliseconds.
 * This is the base timestamp used for Discord snowflake ID generation.
 * Re-exported from @sapphire/snowflake for backward compatibility.
 */
export const DISCORD_EPOCH = DiscordSnowflake.epoch;

/**
 * Zod schema for validating Discord snowflake strings.
 * A valid snowflake is a non-empty string containing only digits (non-negative integer).
 */
// Stryker disable all: Schema validation error messages are not behavioral
export const snowflakeSchema = z
    .string()
    .min(1, 'Snowflake cannot be empty')
    .regex(/^\d+$/, 'Snowflake must contain only digits');
// Stryker restore all

/**
 * Converts a Discord snowflake ID to a Date timestamp.
 *
 * Discord snowflakes encode the creation timestamp in the upper 42 bits.
 * The timestamp is extracted by right-shifting 22 bits and adding the Discord epoch.
 *
 * @param snowflake - The Discord snowflake ID as a string
 * @returns Date object representing when the snowflake was created
 * @throws {InvalidSnowflakeError} If the snowflake is not a valid non-negative integer string
 *
 * @example
 * ```typescript
 * const timestamp = snowflakeToTimestamp('175928847299117063');
 * // Returns Date for April 30, 2016
 * ```
 */
export function snowflakeToTimestamp(snowflake: string): Date {
    const validation = snowflakeSchema.safeParse(snowflake);
    if(!validation.success) {
        throw new InvalidSnowflakeError(snowflake);
    }

    // DiscordSnowflake.timestampFrom returns Unix timestamp in milliseconds as a number
    const unixTimestamp = DiscordSnowflake.timestampFrom(snowflake);

    return new Date(unixTimestamp);
}

/**
 * Converts a Date to a Discord snowflake ID.
 *
 * Creates a snowflake with the timestamp bits set and all other bits (worker, process, sequence) set to 0.
 * This produces the minimum snowflake ID for the given timestamp.
 *
 * @param date - The Date to convert to a snowflake
 * @returns A Discord snowflake ID string representing the given timestamp
 * @throws {Error} If the date is before the Discord epoch (January 1, 2015)
 *
 * @example
 * ```typescript
 * const snowflake = timestampToSnowflake(new Date('2024-06-15T12:30:45.123Z'));
 * // Returns a snowflake ID string like '1251234567890'
 * ```
 */
export function timestampToSnowflake(date: Date): string {
    const unixTimestamp = BigInt(date.getTime());

    // Calculate offset from Discord epoch
    const timestampOffset = unixTimestamp - DISCORD_EPOCH;

    if(timestampOffset < 0n) {
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        throw new Error('Date is before Discord epoch (January 1, 2015)');
    }

    // Generate snowflake with all lower bits set to 0 for backward compatibility
    const snowflake = DiscordSnowflake.generate({
        timestamp: date,
        increment: 0n,
        workerId:  0n,
        processId: 0n,
    });

    return snowflake.toString();
}

export { InvalidSnowflakeError } from '@/errors';
