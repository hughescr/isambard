import { z } from 'zod';

/**
 * EpochSeconds is a branded type representing a Unix timestamp in whole seconds —
 * specifically the unit DynamoDB's `TTL` attribute expects. Every other timestamp in this
 * codebase is epoch-milliseconds or ISO text; this brand exists so a millisecond value can
 * never be silently assigned where DynamoDB expects seconds.
 */
export const epochSecondsSchema = z.number().int().nonnegative().brand<'EpochSeconds'>();

export type EpochSeconds = z.infer<typeof epochSecondsSchema>;

/**
 * Creates a validated EpochSeconds from a number.
 * @throws {z.ZodError} If the value is not a non-negative integer
 */
export function createEpochSeconds(seconds: number): EpochSeconds {
    return epochSecondsSchema.parse(seconds);
}

/**
 * Type guard to check if a value is a valid EpochSeconds.
 */
export function isEpochSeconds(value: unknown): value is EpochSeconds {
    const result = epochSecondsSchema.safeParse(value);
    return result.success;
}
