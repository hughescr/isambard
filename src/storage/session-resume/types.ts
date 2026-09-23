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
 * DynamoDB item structure for session-resume records.
 * Role-keyed: one record per conductor role, PK=SK=`TASK_SESSION#<role>` (see
 * {@link import('./backend').SessionResumeBackend}'s `roleKey()` — the `TASK_SESSION#` prefix
 * is kept for physical-key compatibility with existing rows, not because this is a singleton).
 */
export interface SessionResumeItem extends Record<string, unknown> {
    PK:        string       // TASK_SESSION#<role>
    SK:        string       // TASK_SESSION#<role>
    sessionId: string
    updatedAt: string  // ISO 8601
}
