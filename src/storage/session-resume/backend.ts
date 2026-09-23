import { logger } from '@hughescr/logger';
import { DateTime } from 'luxon';
import { DynamoTableAccess } from '../repositories/base';
import { type SessionId, type SessionResumeItem, sessionResumeItemSchema } from './types';
// eslint-disable-next-line boundaries/dependencies -- type-only import (erased at compile time, no runtime edge): SessionRole is owned solely by src/agent/session/types.ts (plan amendment A1 / P8 gap override (a)); storage must not redeclare it
import type { SessionRole } from '@/agent';

/**
 * Key for the role-keyed session id record, for the two long-lived conductor sessions (P8).
 * The `TASK_SESSION#` prefix is historical (predates the session-resume rename) and is kept
 * unchanged for physical-key compatibility with existing DynamoDB rows.
 */
function roleKey(role: SessionRole): { PK: string, SK: string } {
    const key = `TASK_SESSION#${role}`;
    return { PK: key, SK: key };
}

/**
 * DynamoDB backend for session-resume persistence, keyed by conductor role.
 */
export class SessionResumeBackend extends DynamoTableAccess {
    /**
     * Get the resumable session ID stored for `role`.
     * A malformed stored row is logged and treated as "no stored session" rather than thrown —
     * this is the boot-time resume lookup, which must always degrade to a fresh session.
     * @returns SessionId if found and valid, undefined otherwise
     */
    async getSessionIdForRole(role: SessionRole): Promise<SessionId | undefined> {
        const item = await this.getItem(roleKey(role));
        if(!item) {
            return undefined;
        }
        const parsed = sessionResumeItemSchema.safeParse(item);
        if(!parsed.success) {
            logger.warn({ role, issues: parsed.error.issues }, 'SessionResumeBackend.getSessionIdForRole: stored row failed validation');
            return undefined;
        }
        return parsed.data.sessionId;
    }

    /**
     * Set the resumable session ID for `role`.
     * @param role The conductor role this session id belongs to
     * @param sessionId The session ID to store
     */
    async setSessionIdForRole(role: SessionRole, sessionId: SessionId): Promise<void> {
        const item: SessionResumeItem = {
            ...roleKey(role),
            sessionId,
            updatedAt: DateTime.utc().toISO(),
        };
        await this.putItem(item);
    }

    /**
     * Clear the resumable session ID stored for `role`.
     */
    async clearSessionIdForRole(role: SessionRole): Promise<void> {
        await this.deleteItem(roleKey(role));
    }
}
