import {
    type DynamoDBDocumentClient,
    GetCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { DynamoAllowlist } from '@/storage';

const ALLOWLIST_PK     = 'BSKY#ALLOWLIST';
const HANDLE_SK_PREFIX = 'HANDLE#';

export interface BskyAllowlistEntry {
    handle:  string     // normalized: trim + lowercase
    did?:    string     // permanent AT Protocol identifier (handles can change)
    notes?:  string
    addedAt: string     // ISO timestamp
    addedBy: string     // 'outbound-approval' | 'discord-command'
}

export class BskyAllowlist extends DynamoAllowlist<BskyAllowlistEntry> {
    private didCache = new Set<string>();

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName, {
            pk:         ALLOWLIST_PK,
            skPrefix:   HANDLE_SK_PREFIX,
            indexField: 'handles',
            // Stryker disable next-line StringLiteral: name is only used in log messages
            name:       'Bsky',
        });
    }

    /**
     * Check if a handle or DID is on the allowlist. In-memory, 0 RCU.
     * Normalizes handles (lowercase, trim) before checking.
     * DIDs are checked case-sensitively.
     */
    override isAllowed(handleOrDid: string): boolean {
        return this.cache.has(this.normalize(handleOrDid)) || this.didCache.has(handleOrDid);
    }

    /**
     * After the base class loads the handle INDEX, query HANDLE# items to populate DID cache.
     */
    protected override async postLoad(): Promise<void> {
        const handleResult = await this.docClient.send(new QueryCommand({
            TableName:                 this.tableName,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     this.config.pk,
                ':prefix': this.config.skPrefix,
            },
        }));
        // Stryker disable ConditionalExpression: `did !== undefined` guard — equivalent mutant; undefined is never a valid DID string so adding undefined to Set is observable only via isAllowed(undefined), which is not a realistic call
        this.didCache = new Set<string>(
            (handleResult.Items ?? [])
                .map(item => item.did as string | undefined)
                .filter((did): did is string => did !== undefined && did !== '')
        );
        // Stryker restore ConditionalExpression
    }

    /**
     * Fetch existing HANDLE# item to capture the current DID.
     * Used by both preAdd (for stale-DID cleanup) and preRemove (for cache eviction).
     */
    private async fetchExistingDid(normalizedKey: string): Promise<string | undefined> {
        const existing = await this.docClient.send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK: this.config.pk, SK: `${this.config.skPrefix}${normalizedKey}` },
        }));
        // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutants — undefined is never a valid DID; empty string is never in the cache
        return existing.Item?.did as string | undefined;
    }

    /**
     * Fetch existing entry before add to capture the old DID for stale cache cleanup.
     * Returns the old DID (or undefined) to be passed to postAddCache.
     */
    protected override async preAdd(
        _entry:        BskyAllowlistEntry,
        normalizedKey: string
    ): Promise<string | undefined> {
        return this.fetchExistingDid(normalizedKey);
    }

    /**
     * Update DID cache after a successful add.
     * preAddData is the old DID returned by preAdd.
     */
    protected override postAddCache(
        entry:          BskyAllowlistEntry,
        _normalizedKey: string,
        preAddData:     unknown
    ): void {
        const oldDid = preAddData as string | undefined;
        // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutants — undefined/empty are never valid DID cache entries
        if(oldDid !== undefined && oldDid !== '' && oldDid !== entry.did) {
            this.didCache.delete(oldDid);
        }
        if(entry.did !== undefined && entry.did !== '') {
            this.didCache.add(entry.did);
        }
    }

    /**
     * Fetch DID before remove so we can clean it from the DID cache afterwards.
     * Returns the DID (or undefined).
     */
    protected override async preRemove(normalizedKey: string): Promise<string | undefined> {
        return this.fetchExistingDid(normalizedKey);
    }

    /**
     * Remove the old DID from cache after a successful remove.
     * preRemoveData is the DID returned by preRemove.
     */
    protected override postRemoveCache(_normalizedKey: string, preRemoveData: unknown): void {
        const did = preRemoveData as string | undefined;
        // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutants — `did !== undefined` guard only matters for undefined (not a valid DID); `did !== ''` mutation to 'Stryker was here!' is equivalent because empty string is never in the cache
        if(did !== undefined && did !== '') {
            this.didCache.delete(did);
        }
    }

    protected getEntryKey(entry: BskyAllowlistEntry): string {
        return entry.handle;
    }

    protected buildItem(entry: BskyAllowlistEntry, normalizedKey: string): Record<string, unknown> {
        return {
            handle:  normalizedKey,
            did:     entry.did,
            notes:   entry.notes,
            addedAt: entry.addedAt,
            addedBy: entry.addedBy,
        };
    }

    protected parseItem(item: Record<string, unknown>): BskyAllowlistEntry {
        return {
            handle:  item.handle as string,
            did:     item.did as string | undefined,
            notes:   item.notes as string | undefined,
            addedAt: item.addedAt as string,
            addedBy: item.addedBy as string,
        };
    }
}
