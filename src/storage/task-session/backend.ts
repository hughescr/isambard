import { DateTime } from 'luxon';
import { BaseRepository } from '../repositories/base';
import { type SessionId, type TaskSessionItem, createSessionId  } from './types';
// eslint-disable-next-line boundaries/dependencies -- type-only import (erased at compile time, no runtime edge): SessionRole is owned solely by src/agent/session/types.ts (plan amendment A1 / P8 gap override (a)); storage must not redeclare it
import type { SessionRole } from '@/agent';

const SINGLETON_KEY = {
    PK: 'TASK_SESSION#CURRENT',
    SK: 'TASK_SESSION#CURRENT',
};

/** The role-keyed counterpart to {@link SINGLETON_KEY}, for the two long-lived conductor sessions (P8). */
function roleKey(role: SessionRole): { PK: string, SK: string } {
    const key = `TASK_SESSION#${role}`;
    return { PK: key, SK: key };
}

/**
 * DynamoDB backend for task session persistence.
 * Uses singleton pattern - only one "current" session record exists.
 */
export class TaskSessionBackend extends BaseRepository<TaskSessionItem> {
    /**
     * Get the current session ID from DynamoDB.
     * @returns SessionId if found, undefined otherwise
     */
    async getCurrentSessionId(): Promise<SessionId | undefined> {
        const item = await this.getItem<TaskSessionItem>(SINGLETON_KEY);
        if(!item) {
            return undefined;
        }
        return createSessionId(item.sessionId);
    }

    /**
     * Set the current session ID in DynamoDB.
     * @param sessionId The session ID to store
     */
    async setCurrentSessionId(sessionId: SessionId): Promise<void> {
        const item: TaskSessionItem = {
            ...SINGLETON_KEY,
            sessionId,
            updatedAt: DateTime.utc().toISO(),
        };
        await this.putItem(item);
    }

    /**
     * Clear the current session ID from DynamoDB.
     */
    async clearCurrentSessionId(): Promise<void> {
        await this.deleteItem(SINGLETON_KEY);
    }

    /**
     * Get the resumable session ID stored for `role` (the long-lived conductor's own
     * counterpart to {@link getCurrentSessionId}'s one-shot singleton).
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
