import {
    type DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    UpdateCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import type { AllowlistEntry } from '@/integrations/email/types';

const ALLOWLIST_PK    = 'EMAIL#ALLOWLIST';
const INDEX_SK        = 'INDEX';
const ADDR_SK_PREFIX  = 'ADDR#';

export class EmailAllowlist {
    private readonly docClient: DynamoDBDocumentClient;
    private readonly tableName: string;
    private cache = new Set<string>();

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.docClient = docClient;
        this.tableName = tableName;
    }

    /**
     * Load the allowlist INDEX StringSet into memory. Call at startup.
     * 1 GetItem = 1 RCU.
     */
    async load(): Promise<void> {
        const result = await this.docClient.send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK: ALLOWLIST_PK, SK: INDEX_SK },
        }));
        this.cache = result.Item?.addresses
            ? new Set<string>(result.Item.addresses as Set<string>)
            : new Set<string>();
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ count: this.cache.size, msg: 'Email allowlist loaded' });
    }

    /**
     * Check if an email is on the allowlist. In-memory, 0 RCU.
     * Normalizes email (lowercase, trim) before checking.
     */
    isAllowed(email: string): boolean {
        return this.cache.has(this.normalize(email));
    }

    /**
     * Add an entry to the allowlist. 2 writes:
     * 1. PutItem for ADDR metadata
     * 2. ADD addresses on INDEX
     * Refreshes cache after.
     */
    async addEntry(entry: AllowlistEntry): Promise<void> {
        const normalized = this.normalize(entry.email);

        // Write metadata item
        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK:      ALLOWLIST_PK,
                SK:      `${ADDR_SK_PREFIX}${normalized}`,
                email:   normalized,
                name:    entry.name,
                notes:   entry.notes,
                addedAt: entry.addedAt,
                addedBy: entry.addedBy,
            },
        }));

        // Add to INDEX StringSet
        await this.docClient.send(new UpdateCommand({
            TableName:                 this.tableName,
            Key:                       { PK: ALLOWLIST_PK, SK: INDEX_SK },
            UpdateExpression:          'ADD #addresses :newAddr',
            ExpressionAttributeNames:  { '#addresses': 'addresses' },
            ExpressionAttributeValues: { ':newAddr': new Set([normalized]) },
        }));

        // Refresh cache
        this.cache.add(normalized);
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ email: normalized, msg: 'Added to email allowlist' });
    }

    /**
     * Remove an entry from the allowlist. 2 writes:
     * 1. DeleteItem for ADDR metadata
     * 2. DELETE addresses on INDEX
     * Refreshes cache after.
     */
    async removeEntry(email: string): Promise<void> {
        const normalized = this.normalize(email);

        // Delete metadata item
        await this.docClient.send(new DeleteCommand({
            TableName: this.tableName,
            Key:       { PK: ALLOWLIST_PK, SK: `${ADDR_SK_PREFIX}${normalized}` },
        }));

        // Remove from INDEX StringSet
        await this.docClient.send(new UpdateCommand({
            TableName:                 this.tableName,
            Key:                       { PK: ALLOWLIST_PK, SK: INDEX_SK },
            UpdateExpression:          'DELETE #addresses :oldAddr',
            ExpressionAttributeNames:  { '#addresses': 'addresses' },
            ExpressionAttributeValues: { ':oldAddr': new Set([normalized]) },
        }));

        // Refresh cache
        this.cache.delete(normalized);
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ email: normalized, msg: 'Removed from email allowlist' });
    }

    /**
     * List all entries with full metadata. Query on PK, filter SK begins_with 'ADDR#'.
     * Used for /allowlist list command.
     */
    async list(): Promise<AllowlistEntry[]> {
        const result = await this.docClient.send(new QueryCommand({
            TableName:                 this.tableName,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     ALLOWLIST_PK,
                ':prefix': ADDR_SK_PREFIX,
            },
        }));
        return (result.Items ?? []).map(item => ({
            email:   item.email as string,
            name:    item.name as string | undefined,
            notes:   item.notes as string | undefined,
            addedAt: item.addedAt as string,
            addedBy: item.addedBy as string,
        }));
    }

    private normalize(email: string): string {
        return email.trim().toLowerCase();
    }
}
