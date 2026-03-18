import {
    type DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    UpdateCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';

export interface AllowlistConfig {
    /** DynamoDB partition key for this allowlist */
    pk:         string
    /** Sort key prefix for entries (e.g., 'ADDR#', 'HANDLE#') */
    skPrefix:   string
    /** Name of the StringSet field in the INDEX item */
    indexField: string
    /** Human-readable name for logging */
    name:       string
}

// Stryker disable all: abstract base class — template method hooks tested only via subclasses
export abstract class DynamoAllowlist<TEntry> {
    protected readonly docClient: DynamoDBDocumentClient;
    protected readonly tableName: string;
    protected readonly config:    AllowlistConfig;
    protected cache = new Set<string>();

    constructor(docClient: DynamoDBDocumentClient, tableName: string, config: AllowlistConfig) {
        this.docClient = docClient;
        this.tableName = tableName;
        this.config    = config;
    }

    /** Normalize a key for cache lookup (trim + lowercase) */
    protected normalize(key: string): string {
        return key.trim().toLowerCase();
    }

    /** Extract the raw key from an entry (used for normalize + add/remove) */
    protected abstract getEntryKey(entry: TEntry): string;

    /** Build additional DynamoDB item fields from an entry for PutCommand */
    protected abstract buildItem(entry: TEntry, normalizedKey: string): Record<string, unknown>;

    /** Parse a DynamoDB item into an entry */
    protected abstract parseItem(item: Record<string, unknown>): TEntry;

    /** Called after load() to perform any additional initialization (optional) */
    protected async postLoad(): Promise<void> {
        // Default: no-op. Override in subclass if needed.
    }

    /**
     * Called before addEntry writes to allow pre-add logic (optional).
     * Returns data passed verbatim to postAddCache().
     */
    protected async preAdd(_entry: TEntry, _normalizedKey: string): Promise<unknown> {
        return undefined;
    }

    /**
     * Called after addEntry succeeds to update any additional caches (optional).
     * Receives the value returned by preAdd().
     */
    protected postAddCache(_entry: TEntry, _normalizedKey: string, _preAddData: unknown): void {
        // Default: no-op
    }

    /** Called before removeEntry to prepare data needed for post-remove cache cleanup */
    protected async preRemove(_normalizedKey: string): Promise<unknown> {
        return undefined;
    }

    /** Called after removeEntry succeeds to update any additional caches (optional) */
    protected postRemoveCache(_normalizedKey: string, _preRemoveData: unknown): void {
        // Default: no-op
    }

    async load(): Promise<void> {
        const result = await this.docClient.send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK: this.config.pk, SK: 'INDEX' },
        }));
        this.cache = result.Item?.[this.config.indexField]
            ? new Set<string>(result.Item[this.config.indexField] as Set<string>)
            : new Set<string>();
        await this.postLoad();
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ count: this.cache.size, msg: `${this.config.name} allowlist loaded` });
    }

    isAllowed(key: string): boolean {
        return this.cache.has(this.normalize(key));
    }

    async addEntry(entry: TEntry): Promise<void> {
        const normalizedKey = this.normalize(this.getEntryKey(entry));

        const preAddData = await this.preAdd(entry, normalizedKey);

        // Write metadata item
        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK: this.config.pk,
                SK: `${this.config.skPrefix}${normalizedKey}`,
                ...this.buildItem(entry, normalizedKey),
            },
        }));

        // Add to INDEX StringSet
        const idxAlias = `#${this.config.indexField}`;
        await this.docClient.send(new UpdateCommand({
            TableName:                 this.tableName,
            Key:                       { PK: this.config.pk, SK: 'INDEX' },
            UpdateExpression:          `ADD ${idxAlias} :newKey`,
            ExpressionAttributeNames:  { [idxAlias]: this.config.indexField },
            ExpressionAttributeValues: { ':newKey': new Set([normalizedKey]) },
        }));

        // Update cache
        this.cache.add(normalizedKey);
        this.postAddCache(entry, normalizedKey, preAddData);
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ key: normalizedKey, msg: `Added to ${this.config.name} allowlist` });
    }

    async removeEntry(key: string): Promise<void> {
        const normalizedKey = this.normalize(key);

        const preRemoveData = await this.preRemove(normalizedKey);

        // Delete metadata item
        await this.docClient.send(new DeleteCommand({
            TableName: this.tableName,
            Key:       { PK: this.config.pk, SK: `${this.config.skPrefix}${normalizedKey}` },
        }));

        // Remove from INDEX StringSet
        const idxAlias = `#${this.config.indexField}`;
        await this.docClient.send(new UpdateCommand({
            TableName:                 this.tableName,
            Key:                       { PK: this.config.pk, SK: 'INDEX' },
            UpdateExpression:          `DELETE ${idxAlias} :oldKey`,
            ExpressionAttributeNames:  { [idxAlias]: this.config.indexField },
            ExpressionAttributeValues: { ':oldKey': new Set([normalizedKey]) },
        }));

        // Update cache
        this.cache.delete(normalizedKey);
        this.postRemoveCache(normalizedKey, preRemoveData);
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ key: normalizedKey, msg: `Removed from ${this.config.name} allowlist` });
    }

    async list(): Promise<TEntry[]> {
        const result = await this.docClient.send(new QueryCommand({
            TableName:                 this.tableName,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     this.config.pk,
                ':prefix': this.config.skPrefix,
            },
        }));
        return (result.Items ?? []).map(item => this.parseItem(item as Record<string, unknown>));
    }
}
// Stryker restore all
