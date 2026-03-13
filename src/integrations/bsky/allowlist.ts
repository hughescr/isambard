import {
    type DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    UpdateCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';

const ALLOWLIST_PK      = 'BSKY#ALLOWLIST';
const INDEX_SK          = 'INDEX';
const HANDLE_SK_PREFIX  = 'HANDLE#';

export interface BskyAllowlistEntry {
    handle:  string     // normalized: trim + lowercase
    did?:    string     // permanent AT Protocol identifier (handles can change)
    notes?:  string
    addedAt: string     // ISO timestamp
    addedBy: string     // 'outbound-approval' | 'discord-command'
}

export class BskyAllowlist {
    private readonly docClient: DynamoDBDocumentClient;
    private readonly tableName: string;
    private handleCache = new Set<string>();
    private didCache    = new Set<string>();

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.docClient = docClient;
        this.tableName = tableName;
    }

    /**
     * Load the allowlist caches into memory. Call at startup.
     * 1 GetItem for the handle INDEX + 1 Query for DID values.
     */
    async load(): Promise<void> {
        // Load handle cache from INDEX StringSet
        const indexResult = await this.docClient.send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK: ALLOWLIST_PK, SK: INDEX_SK },
        }));
        this.handleCache = indexResult.Item?.handles
            ? new Set<string>(indexResult.Item.handles as Set<string>)
            : new Set<string>();

        // Load DID cache from all HANDLE# metadata items
        const handleResult = await this.docClient.send(new QueryCommand({
            TableName:                 this.tableName,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     ALLOWLIST_PK,
                ':prefix': HANDLE_SK_PREFIX,
            },
        }));
        // Stryker disable ConditionalExpression: `did !== undefined` guard — equivalent mutant; undefined is never a valid DID string so adding undefined to Set is observable only via isAllowed(undefined), which is not a realistic call
        this.didCache = new Set<string>(
            (handleResult.Items ?? [])
                .map(item => item.did as string | undefined)
                .filter((did): did is string => did !== undefined && did !== '')
        );
        // Stryker restore ConditionalExpression

        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ handleCount: this.handleCache.size, didCount: this.didCache.size, msg: 'Bsky allowlist loaded' });
    }

    /**
     * Check if a handle or DID is on the allowlist. In-memory, 0 RCU.
     * Normalizes handles (lowercase, trim) before checking.
     * DIDs are checked case-sensitively.
     */
    isAllowed(handleOrDid: string): boolean {
        return this.handleCache.has(this.normalize(handleOrDid)) || this.didCache.has(handleOrDid);
    }

    /**
     * Add an entry to the allowlist. 2 writes:
     * 1. PutItem for HANDLE metadata
     * 2. ADD handles on INDEX
     * Refreshes caches after.
     */
    async addEntry(entry: BskyAllowlistEntry): Promise<void> {
        const normalized = this.normalize(entry.handle);

        // Write metadata item
        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK:      ALLOWLIST_PK,
                SK:      `${HANDLE_SK_PREFIX}${normalized}`,
                handle:  normalized,
                did:     entry.did,
                notes:   entry.notes,
                addedAt: entry.addedAt,
                addedBy: entry.addedBy,
            },
        }));

        // Add to INDEX StringSet
        await this.docClient.send(new UpdateCommand({
            TableName:                 this.tableName,
            Key:                       { PK: ALLOWLIST_PK, SK: INDEX_SK },
            UpdateExpression:          'ADD #handles :newHandle',
            ExpressionAttributeNames:  { '#handles': 'handles' },
            ExpressionAttributeValues: { ':newHandle': new Set([normalized]) },
        }));

        // Refresh caches
        this.handleCache.add(normalized);
        if(entry.did !== undefined && entry.did !== '') {
            this.didCache.add(entry.did);
        }
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ handle: normalized, msg: 'Added to Bsky allowlist' });
    }

    /**
     * Remove an entry from the allowlist. 2 writes:
     * 1. DeleteItem for HANDLE metadata
     * 2. DELETE handles on INDEX
     * Refreshes caches after.
     */
    async removeEntry(handle: string): Promise<void> {
        const normalized = this.normalize(handle);

        // Fetch metadata to get DID before deleting
        const existing = await this.docClient.send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK: ALLOWLIST_PK, SK: `${HANDLE_SK_PREFIX}${normalized}` },
        }));
        const did = existing.Item?.did as string | undefined;

        // Delete metadata item
        await this.docClient.send(new DeleteCommand({
            TableName: this.tableName,
            Key:       { PK: ALLOWLIST_PK, SK: `${HANDLE_SK_PREFIX}${normalized}` },
        }));

        // Remove from INDEX StringSet
        await this.docClient.send(new UpdateCommand({
            TableName:                 this.tableName,
            Key:                       { PK: ALLOWLIST_PK, SK: INDEX_SK },
            UpdateExpression:          'DELETE #handles :oldHandle',
            ExpressionAttributeNames:  { '#handles': 'handles' },
            ExpressionAttributeValues: { ':oldHandle': new Set([normalized]) },
        }));

        // Refresh caches
        this.handleCache.delete(normalized);
        // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutants — `did !== undefined` guard only matters for undefined (not a valid DID); `did !== ''` mutation to 'Stryker was here!' is equivalent because empty string is never in the cache
        if(did !== undefined && did !== '') {
            this.didCache.delete(did);
        }
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ handle: normalized, msg: 'Removed from Bsky allowlist' });
    }

    /**
     * List all entries with full metadata. Query on PK, filter SK begins_with 'HANDLE#'.
     * Used for /bsky-allowlist list command.
     */
    async list(): Promise<BskyAllowlistEntry[]> {
        const result = await this.docClient.send(new QueryCommand({
            TableName:                 this.tableName,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     ALLOWLIST_PK,
                ':prefix': HANDLE_SK_PREFIX,
            },
        }));
        return (result.Items ?? []).map(item => ({
            handle:  item.handle as string,
            did:     item.did as string | undefined,
            notes:   item.notes as string | undefined,
            addedAt: item.addedAt as string,
            addedBy: item.addedBy as string,
        }));
    }

    private normalize(handle: string): string {
        return handle.trim().toLowerCase();
    }
}
