import {
    type DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { CalendarRegistryKeyGenerator, type CalendarRegistryKeys } from './key-generator';
import {
    type CalendarRegistryRecord,
    type CalendarServerEntry
} from './types';
import { withDynamoTimeout } from '@/storage';
import { stripDynamoKeys } from '@/utils';

/**
 * DynamoDB backend for CalDAV calendar registry.
 * Stores per-user calendar server associations with credentials and calendar paths.
 * Also supports a shared record for public calendars available to all users.
 */
export class CalendarRegistryBackend {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly timeoutMs = 10_000
    ) {}

    /**
     * Gets all calendar servers for a user, merging user-specific and shared servers.
     *
     * @param userId - User identifier
     * @returns Combined array of user and shared calendar server entries
     */
    async getAllCalendars(userId: string): Promise<CalendarServerEntry[]> {
        const [userRecord, sharedRecord] = await Promise.all([
            this.getUserRecord(userId),
            this.getSharedRecord(),
        ]);

        const userServers = userRecord?.servers ?? [];
        const sharedServers = sharedRecord?.servers ?? [];
        return [...userServers, ...sharedServers];
    }

    /**
     * Gets the calendar registry record for a specific user.
     *
     * @param userId - User identifier
     * @returns CalendarRegistryRecord or null if not found
     */
    async getUserRecord(userId: string): Promise<CalendarRegistryRecord | null> {
        const keys = CalendarRegistryKeyGenerator.createUserKeys(userId);
        return this.#getRecord(keys);
    }

    /**
     * Gets the shared calendar registry record.
     *
     * @returns CalendarRegistryRecord or null if not found
     */
    async getSharedRecord(): Promise<CalendarRegistryRecord | null> {
        const keys = CalendarRegistryKeyGenerator.createSharedKeys();
        return this.#getRecord(keys);
    }

    /**
     * Adds a server to a user's calendar registry (creates record if needed).
     *
     * @param userId - User identifier
     * @param server - CalendarServerEntry to add
     */
    async addServer(userId: string, server: CalendarServerEntry): Promise<void> {
        const keys = CalendarRegistryKeyGenerator.createUserKeys(userId);
        const existing = await this.#getRecord(keys);
        const now = new Date().toISOString();

        const record: CalendarRegistryRecord = existing
            ? { ...existing, servers: [...existing.servers, server], updatedAt: now }
            : { userId, servers: [server], createdAt: now, updatedAt: now };

        await this.#putRecord(keys, record);
    }

    /**
     * Removes a server from a user's calendar registry.
     *
     * @param userId - User identifier
     * @param serverId - UUID of server to remove
     * @returns true if server was found and removed, false otherwise
     */
    async removeServer(userId: string, serverId: string): Promise<boolean> {
        const keys = CalendarRegistryKeyGenerator.createUserKeys(userId);
        return this.#removeServerFromRecord(keys, serverId);
    }

    /**
     * Removes a single calendar from a user's server.
     * If the calendar was the last one in the server, the server entry is also removed.
     *
     * @param userId - User identifier
     * @param serverId - UUID of the server containing the calendar
     * @param calendarPath - Path of the calendar to remove
     * @returns true if calendar was found and removed, false otherwise
     */
    async removeCalendar(userId: string, serverId: string, calendarPath: string): Promise<boolean> {
        const keys = CalendarRegistryKeyGenerator.createUserKeys(userId);
        return this.#removeCalendarFromRecord(keys, serverId, calendarPath);
    }

    /**
     * Adds a server to the shared calendar registry (creates record if needed).
     *
     * @param server - CalendarServerEntry to add to shared record
     */
    async addSharedServer(server: CalendarServerEntry): Promise<void> {
        const keys = CalendarRegistryKeyGenerator.createSharedKeys();
        const existing = await this.#getRecord(keys);
        const now = new Date().toISOString();

        const record: CalendarRegistryRecord = existing
            ? { ...existing, servers: [...existing.servers, server], updatedAt: now }
            : { userId: 'SHARED', servers: [server], createdAt: now, updatedAt: now };

        await this.#putRecord(keys, record);
    }

    /**
     * Removes a server from the shared calendar registry.
     *
     * @param serverId - UUID of server to remove
     * @returns true if server was found and removed, false otherwise
     */
    async removeSharedServer(serverId: string): Promise<boolean> {
        const keys = CalendarRegistryKeyGenerator.createSharedKeys();
        return this.#removeServerFromRecord(keys, serverId);
    }

    /**
     * Removes a single calendar from a shared server.
     * If the calendar was the last one in the server, the server entry is also removed.
     *
     * @param serverId - UUID of the server containing the calendar
     * @param calendarPath - Path of the calendar to remove
     * @returns true if calendar was found and removed, false otherwise
     */
    async removeSharedCalendar(serverId: string, calendarPath: string): Promise<boolean> {
        const keys = CalendarRegistryKeyGenerator.createSharedKeys();
        return this.#removeCalendarFromRecord(keys, serverId, calendarPath);
    }

    /**
     * List all user IDs that have calendar registrations.
     * Scans for CALCAL# prefix items with SK=CALENDARS, excluding SHARED.
     * Acceptable scan for a personal assistant with very few users (~1-5).
     */
    async listRegisteredUserIds(): Promise<string[]> {
        // Stryker disable StringLiteral,ObjectLiteral: DynamoDB scan configuration — filter expression and attribute values are API config, not behavior
        const command = new ScanCommand({
            TableName:                 this.tableName,
            FilterExpression:          'begins_with(PK, :prefix) AND SK = :sk',
            ExpressionAttributeValues: {
                ':prefix': 'CALCAL#',
                ':sk':     'CALENDARS',
            },
            ProjectionExpression: 'PK',
        });
        // Stryker restore StringLiteral,ObjectLiteral

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            { timeoutMs: this.timeoutMs, operation: 'CalendarRegistry.listRegisteredUserIds' }
        );

        return (result.Items ?? [])
            .map(item => CalendarRegistryKeyGenerator.parseUserId(item.PK as string))
            .filter(id => id !== 'SHARED');
    }

    async #getRecord(keys: CalendarRegistryKeys): Promise<CalendarRegistryRecord | null> {
        const command = new GetCommand({
            TableName: this.tableName,
            Key:       { PK: keys.PK, SK: keys.SK },
        });

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            { timeoutMs: this.timeoutMs, operation: 'CalendarRegistry.getRecord' }
        );

        if(!result.Item) {
            return null;
        }

        return stripDynamoKeys(result.Item) as CalendarRegistryRecord;
    }

    async #putRecord(keys: CalendarRegistryKeys, record: CalendarRegistryRecord): Promise<void> {
        const command = new PutCommand({
            TableName: this.tableName,
            Item:      { ...record, PK: keys.PK, SK: keys.SK },
        });

        await withDynamoTimeout(
            () => this.docClient.send(command),
            { timeoutMs: this.timeoutMs, operation: 'CalendarRegistry.putRecord' }
        );
    }

    async #removeServerFromRecord(keys: CalendarRegistryKeys, serverId: string): Promise<boolean> {
        const existing = await this.#getRecord(keys);
        if(!existing) {
            return false;
        }

        const originalLength = existing.servers.length;
        const updatedServers = existing.servers.filter(s => s.serverId !== serverId);
        if(updatedServers.length === originalLength) {
            return false;
        }

        const now = new Date().toISOString();
        await this.#putRecord(keys, { ...existing, servers: updatedServers, updatedAt: now });
        return true;
    }

    async #removeCalendarFromRecord(
        keys: CalendarRegistryKeys,
        serverId: string,
        calendarPath: string
    ): Promise<boolean> {
        const existing = await this.#getRecord(keys);
        if(!existing) {
            return false;
        }

        const serverIndex = existing.servers.findIndex(s => s.serverId === serverId);
        if(serverIndex === -1) {
            return false;
        }

        const server = existing.servers[serverIndex];
        const originalCalendarLength = server.calendars.length;
        const updatedCalendars = server.calendars.filter(c => c.calendarPath !== calendarPath);
        if(updatedCalendars.length === originalCalendarLength) {
            return false;
        }

        const now = new Date().toISOString();
        const updatedServers: CalendarServerEntry[] = updatedCalendars.length === 0
            ? existing.servers.filter(s => s.serverId !== serverId)
            : existing.servers.map((s, i) => (
                i === serverIndex ? { ...s, calendars: updatedCalendars } : s
            ));

        await this.#putRecord(keys, { ...existing, servers: updatedServers, updatedAt: now });
        return true;
    }
}
