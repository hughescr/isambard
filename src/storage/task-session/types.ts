import { z } from 'zod';

/**
 * SessionId is a branded type representing a Claude Agent SDK session UUID.
 */
export const sessionIdSchema = z
    .string()
    .check(z.uuid({ error: 'Session ID must be a valid UUID' }))
    .brand<'SessionId'>();

export type SessionId = z.infer<typeof sessionIdSchema>;

/**
 * Creates a validated SessionId from a string.
 * @throws {z.ZodError} If the session ID is invalid
 */
export function createSessionId(id: string): SessionId {
    return sessionIdSchema.parse(id);
}

/**
 * Type guard to check if a value is a valid SessionId.
 */
export function isSessionId(value: unknown): value is SessionId {
    const result = sessionIdSchema.safeParse(value);
    return result.success;
}

/**
 * DynamoDB item structure for task session tracking.
 * Uses singleton pattern: one record for the "current" session.
 */
export interface TaskSessionItem extends Record<string, unknown> {
    PK:        string       // TASK_SESSION#CURRENT
    SK:        string       // TASK_SESSION#CURRENT
    sessionId: string
    updatedAt: string  // ISO 8601
}
