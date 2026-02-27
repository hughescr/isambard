import { DateTime } from 'luxon';
import { BaseRepository } from '../repositories/base';
import { type SessionId, type TaskSessionItem, createSessionId  } from './types';

const SINGLETON_KEY = {
    PK: 'TASK_SESSION#CURRENT',
    SK: 'TASK_SESSION#CURRENT',
};

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
}
