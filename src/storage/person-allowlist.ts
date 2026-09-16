import {
    type DynamoDBDocumentClient,
    GetCommand,
    TransactWriteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import pLimit from 'p-limit';
import { type DynamoDBClientHolder, resolveDocClientGetter } from './client-holder';
import { type Contact, type ContactBackend, type ContactId, type PlatformType, createContactId } from '@/storage/contacts';

const PK = 'PERSON#ALLOWLIST';
const SK_INDEX  = 'INDEX';
const SK_PREFIX = 'PERSON#';
const ALLOWLIST_READ_CONCURRENCY = 8;

export interface PersonAllowlistEntry {
    personId: ContactId
    notes?:   string
    addedAt:  string   // ISO timestamp
    addedBy:  string   // 'outbound-approval' | 'discord-command' | 'migration'
}

export class PersonAllowlist {
    private readonly getDocClient:   () => DynamoDBDocumentClient;
    private readonly tableName:      string;
    private readonly contactBackend: ContactBackend;

    /** Set of allowed personIds */
    private personIds = new Set<string>();

    /** Reverse map: "{platform}#{normalizedValue}" → ContactId */
    private reverseMap = new Map<string, ContactId>();

    constructor(docClientOrHolder: DynamoDBDocumentClient | DynamoDBClientHolder, tableName: string, contactBackend: ContactBackend) {
        this.getDocClient   = resolveDocClientGetter(docClientOrHolder);
        this.tableName      = tableName;
        this.contactBackend = contactBackend;
    }

    /** Normalize an identifier value for consistent lookup */
    private normalizeValue(value: string): string {
        return value.toLowerCase().trim();
    }

    /** Build the reverse map key for a platform+value pair */
    private reverseKey(platform: PlatformType, value: string): string {
        return `${platform}#${this.normalizeValue(value)}`;
    }

    /**
     * Add reverse map entries for one contact: every platform+value identifier,
     * plus (when present) the Discord snowflake user id from `_internal.discordUserId`
     * indexed under the 'discord' platform alongside the username-keyed identifier.
     * This lets `isAllowed('discord', <id-or-username>)` match either space.
     */
    private indexContact(contact: Contact, personId: ContactId): void {
        // Stryker disable next-line llm: contact.identifiers is z.array(...).min(1) — never null/undefined by schema, so `|| []` is a type-guaranteed no-op
        for(const identifier of contact.identifiers) {
            // Stryker disable next-line llm: identifier.value is a non-empty z.string() and reverseKey() already normalizes via .trim() internally, so a pre-trim here is idempotent and unobservable
            this.reverseMap.set(this.reverseKey(identifier.platform, identifier.value), personId);
        }
        if(contact._internal?.discordUserId) {
            // Stryker disable next-line llm: reached only when the enclosing `contact._internal?.discordUserId` guard is truthy, which already guarantees contact._internal is non-null — the optional chain here is equivalent
            this.reverseMap.set(this.reverseKey('discord', contact._internal.discordUserId), personId);
        }
    }

    /**
     * Load personIds from DynamoDB INDEX item and build reverse map from contacts.
     * Orphaned personIds (no contact found) are logged and skipped.
     */
    async load(): Promise<void> {
        const result = await this.getDocClient().send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK, SK: SK_INDEX },
        }));

        const rawSet: Set<string> = result.Item?.personIds instanceof Set
            ? result.Item.personIds as Set<string>
            : new Set<string>();

        this.personIds  = new Set<string>(rawSet);
        // Stryker disable next-line llm: generic type arguments are erased, so both forms construct the same empty Map.
        this.reverseMap = new Map<string, ContactId>();

        const limit = pLimit(ALLOWLIST_READ_CONCURRENCY);
        const outstanding: Promise<unknown>[] = [];
        const reads = [...this.personIds].map((personIdStr) => {
            let personId: ContactId;
            try {
                personId = createContactId(personIdStr);
            } catch (error) {
                return { kind: 'invalid', personIdStr, error } as const;
            }

            // Each outcome resolves even on a read error, so later completions cannot reject unobserved.
            // Stryker disable next-line llm: personId is the unchanged result of parsing this same personIdStr, so reparsing it is unobservable.
            const outcome = limit(() => this.contactBackend.getContact(personId))
                .then(contact => ({ status: 'fulfilled', contact } as const))
                .catch((error: unknown) => ({ status: 'rejected', error } as const));
            // Stryker disable next-line ArrayMethodSwap: this array is only awaited for completion as a whole, so insertion order is unobservable.
            outstanding.push(outcome);
            return { kind: 'read', personId, outcome } as const;
        });

        try {
            for(const read of reads) {
                if(read.kind === 'invalid') {
                    logger.warn({ personIdStr: read.personIdStr, error: read.error, msg: 'PersonAllowlist: invalid personId format in INDEX — skipping' });
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop -- Publish completed reads in INDEX order while remote reads overlap; collisions remain last-wins.
                const outcome = await read.outcome;
                if(outcome.status === 'rejected') {
                    throw outcome.error;
                }
                if(!outcome.contact) {
                    logger.warn({ personId: read.personId, msg: 'PersonAllowlist: orphaned personId — no contact found, skipping' });
                    continue;
                }
                this.indexContact(outcome.contact, read.personId);
            }
        } catch (error) {
            // A failed prefix must not publish later entries, but all queued reads finish before load returns.
            // Stryker disable next-line PromiseCombinatorSwap: every outstanding promise has a rejection handler and therefore resolves.
            await Promise.all(outstanding);
            throw error;
        }

        logger.info({ count: this.personIds.size, msg: 'PersonAllowlist loaded' });
    }

    /**
     * Check if a platform+value identifier belongs to an allowed person.
     * O(1) — two map/set lookups.
     */
    isAllowed(platform: PlatformType, value: string): boolean {
        // Stryker disable next-line llm: personId is only tested for falsiness, so a missing map value is indistinguishable from an empty string.
        const personId = this.reverseMap.get(this.reverseKey(platform, value));
        if(!personId) {
            return false;
        }
        return this.personIds.has(personId);
    }

    /**
     * Check if a personId is directly allowed.
     */
    isPersonAllowed(personId: ContactId): boolean {
        return this.personIds.has(personId);
    }

    /**
     * Add a person to the allowlist.
     * Writes metadata + updates INDEX StringSet, then updates in-memory state.
     * If the contact is not found, still adds to personIds (reverseMap will be empty for them).
     */
    async addPerson(personId: ContactId, opts: { notes?: string, addedBy: string }): Promise<void> {
        const item: Record<string, unknown> = {
            PK,
            SK:      `${SK_PREFIX}${personId}`,
            personId,
            addedAt: new Date().toISOString(),
            addedBy: opts.addedBy,
        };
        if(opts.notes !== undefined) {
            item.notes = opts.notes;
        }

        await this.getDocClient().send(new TransactWriteCommand({
            TransactItems: [
                {
                    Put: {
                        TableName: this.tableName,
                        Item:      item,
                    },
                },
                {
                    Update: {
                        TableName:                 this.tableName,
                        Key:                       { PK, SK: SK_INDEX },
                        UpdateExpression:          'ADD #personIds :newId',
                        ExpressionAttributeNames:  { '#personIds': 'personIds' },
                        // Stryker disable next-line llm: Set construction dedups duplicate elements — new Set([id]) and new Set([id, id]) are indistinguishable in size/content/marshalling
                        ExpressionAttributeValues: { ':newId': new Set([personId]) },
                    },
                },
            ],
        }));

        // Update in-memory state
        this.personIds.add(personId);

        const contact = await this.contactBackend.getContact(personId);
        if(contact) {
            this.indexContact(contact, personId);
        }

        logger.info({ personId, msg: 'PersonAllowlist: person added' });
    }

    /**
     * Remove a person from the allowlist.
     * Deletes metadata + updates INDEX StringSet, then purges in-memory state.
     */
    async removePerson(personId: ContactId): Promise<void> {
        await this.getDocClient().send(new TransactWriteCommand({
            TransactItems: [
                {
                    Delete: {
                        TableName: this.tableName,
                        Key:       { PK, SK: `${SK_PREFIX}${personId}` },
                    },
                },
                {
                    Update: {
                        TableName:                 this.tableName,
                        Key:                       { PK, SK: SK_INDEX },
                        UpdateExpression:          'DELETE #personIds :oldId',
                        ExpressionAttributeNames:  { '#personIds': 'personIds' },
                        ExpressionAttributeValues: { ':oldId': new Set([personId]) },
                    },
                },
            ],
        }));

        // Update in-memory state
        this.personIds.delete(personId);
        this.purgeReverseMapEntries(personId);

        logger.info({ personId, msg: 'PersonAllowlist: person removed' });
    }

    /**
     * Rebuild reverse map entries for a person (e.g., after their identifiers changed).
     * If not in personIds, just purges existing entries (no-op if already absent).
     */
    async refreshPerson(personId: ContactId): Promise<void> {
        // Always purge stale entries first
        this.purgeReverseMapEntries(personId);

        if(!this.personIds.has(personId)) {
            return;
        }

        const contact = await this.contactBackend.getContact(personId);
        if(contact) {
            this.indexContact(contact, personId);
        }
    }

    /**
     * List all allowed person entries from DynamoDB.
     */
    async list(): Promise<PersonAllowlistEntry[]> {
        const items: Record<string, unknown>[] = [];
        let lastEvaluatedKey: Record<string, unknown> | undefined;

        do {
            // eslint-disable-next-line no-await-in-loop -- sequential pagination required by DynamoDB
            const result = await this.getDocClient().send(new QueryCommand({
                TableName:                 this.tableName,
                KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
                ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
                ExpressionAttributeValues: {
                    ':pk':     PK,
                    ':prefix': SK_PREFIX,
                },
                ExclusiveStartKey: lastEvaluatedKey,
            }));
            // Stryker disable next-line llm: Items is array-or-undefined, and arrays are always truthy, making ?? and || equivalent.
            items.push(...(result.Items ?? []));
            // Stryker disable next-line llm: adding ?? undefined cannot affect the truthiness check that is this value’s only observation.
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while(lastEvaluatedKey);

        const entries: PersonAllowlistEntry[] = [];
        for(const item of items) {
            let personId: ContactId;
            try {
                personId = createContactId(item.personId as string);
            } catch (error) {
                logger.warn({ personIdStr: item.personId, tableName: this.tableName, error, msg: 'PersonAllowlist.list(): invalid personId format in row — skipping' });
                continue;
            }
            const entry: PersonAllowlistEntry = {
                personId,
                addedAt: item.addedAt as string,
                addedBy: item.addedBy as string,
            };
            if(item.notes !== undefined) {
                entry.notes = item.notes as string;
            }
            entries.push(entry);
        }
        return entries;
    }

    /** Remove all reverseMap entries that point to the given personId */
    private purgeReverseMapEntries(personId: ContactId): void {
        for(const [key, id] of this.reverseMap) {
            if(id === personId) {
                this.reverseMap.delete(key);
            }
        }
    }
}
