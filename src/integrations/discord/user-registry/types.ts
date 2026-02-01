/**
 * User Registry Types
 *
 * Type definitions and Zod schemas for user registry operations.
 */

import { z } from 'zod';
import { userIdSchema } from '../types';

/**
 * User metadata schema for tracking user information.
 * Includes username, display name, and discovery timestamps.
 */
export const userMetadataSchema = z.object({
    /** Discord user ID */
    userId:       userIdSchema,
    /** Discord username (not display name) */
    username:     z.string().min(1),
    /** Discord display name (or global name) */
    displayName:  z.string().min(1),
    /** ISO 8601 timestamp when the user was first discovered */
    discoveredAt: z.iso.datetime(),
    /** ISO 8601 timestamp when the user was last seen active */
    lastSeenAt:   z.iso.datetime(),
    /** ISO 8601 timestamp when the metadata was last updated */
    updatedAt:    z.iso.datetime(),
});

export type UserMetadata = z.infer<typeof userMetadataSchema>;

/**
 * Creates a validated UserMetadata object from unknown data.
 * @throws {z.ZodError} If the data is invalid
 */
export function createUserMetadata(data: unknown): UserMetadata {
    return userMetadataSchema.parse(data);
}

/**
 * Type guard to check if a value is a valid UserMetadata.
 */
export function isUserMetadata(value: unknown): value is UserMetadata {
    const result = userMetadataSchema.safeParse(value);
    return result.success;
}
