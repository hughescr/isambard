import { DateTime } from 'luxon';
import { BaseRepository } from '../repositories/base';
import { type SessionId, type TaskSessionItem, createSessionId  } from './types';
// eslint-disable-next-line boundaries/dependencies -- type-only import (erased at compile time, no runtime edge): SessionRole is owned solely by src/agent/session/types.ts (plan amendment A1 / P8 gap override (a)); storage must not redeclare it
import type { SessionRole } from '@/agent';

/** Key for the role-keyed session id record, for the two long-lived conductor sessions (P8). */
function roleKey(role: SessionRole): { PK: string, SK: string } {
    const key = `TASK_SESSION#${role}`;
    return { PK: key, SK: key };
}

/**
 * DynamoDB backend for task session persistence, keyed by conductor role.
 */
export class TaskSessionBackend extends BaseRepository<TaskSessionItem> {
    /**
     * Get the resumable session ID stored for `role`.
     * @returns SessionId if found, undefined otherwise
     */
    async getSessionIdForRole(role: SessionRole): Promise<SessionId | undefined> {
        const item = await this.getItem<TaskSessionItem>(roleKey(role));
        if(!item) {
            return undefined;
        }
        return createSessionId(item.sessionId);
    }

    /**
     * Set the resumable session ID for `role`.
     * @param role The conductor role this session id belongs to
     * @param sessionId The session ID to store
     */
    async setSessionIdForRole(role: SessionRole, sessionId: SessionId): Promise<void> {
        const item: TaskSessionItem = {
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
