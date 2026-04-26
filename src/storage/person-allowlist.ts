import {
    type DynamoDBDocumentClient,
    GetCommand,
    TransactWriteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type ContactBackend, type ContactId, type PlatformType, createContactId } from '@/storage/contacts';

const PK = 'PERSON#ALLOWLIST';
const SK_INDEX  = 'INDEX';
const SK_PREFIX = 'PERSON#';

export interface PersonAllowlistEntry {
    personId: ContactId
    notes?:   string
    addedAt:  string   // ISO timestamp
    addedBy:  string   // 'outbound-approval' | 'discord-command' | 'migration'
}

export class PersonAllowlist {
    private readonly docClient:      DynamoDBDocumentClient;
    private readonly tableName:      string;
    private readonly contactBackend: ContactBackend;

    /** Set of allowed personIds */
    private personIds = new Set<string>();

    /** Reverse map: "{platform}#{normalizedValue}" → ContactId */
    private reverseMap = new Map<string, ContactId>();

    constructor(docClient: DynamoDBDocumentClient, tableName: string, contactBackend: ContactBackend) {
        this.docClient      = docClient;
        this.tableName      = tableName;
        this.contactBackend = contactBackend;
    }

    /** Normalize an identifier value for consistent lookup */
    private normalizeValue(value: string): string {
        // Stryker disable next-line MethodExpression: toLowerCase/toUpperCase are equivalent mutants — normalization is applied symmetrically in both store and lookup paths
        return value.toLowerCase().trim();
    }

    /** Build the reverse map key for a platform+value pair */
    private reverseKey(platform: PlatformType, value: string): string {
        return `${platform}#${this.normalizeValue(value)}`;
    }

    /**
     * Load personIds from DynamoDB INDEX item and build reverse map from contacts.
     * Orphaned personIds (no contact found) are logged and skipped.
     */
    async load(): Promise<void> {
        const result = await this.docClient.send(new GetCommand({
            TableName: this.tableName,
            Key:       { PK, SK: SK_INDEX },
        }));

        const rawSet: Set<string> = result.Item?.personIds instanceof Set
            ? result.Item.personIds as Set<string>
            : new Set<string>();

        this.personIds  = new Set<string>(rawSet);
        this.reverseMap = new Map<string, ContactId>();

        for(const personIdStr of this.personIds) {
            let personId: ContactId;
            try {
                personId = createContactId(personIdStr);
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
                logger.warn({ personIdStr, error, msg: 'PersonAllowlist: invalid personId format in INDEX — skipping' });
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- sequential: building reverse map from contacts one-by-one
            const contact = await this.contactBackend.getContact(personId);
            if(!contact) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
                logger.warn({ personId, msg: 'PersonAllowlist: orphaned personId — no contact found, skipping' });
                continue;
            }
            for(const identifier of contact.identifiers) {
                this.reverseMap.set(this.reverseKey(identifier.platform, identifier.value), personId);
            }
        }

        // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
        logger.info({ count: this.personIds.size, msg: 'PersonAllowlist loaded' });
    }

    /**
     * Check if a platform+value identifier belongs to an allowed person.
     * O(1) — two map/set lookups.
     */
    isAllowed(platform: PlatformType, value: string): boolean {
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

        // Stryker disable StringLiteral,ObjectLiteral,ArrayDeclaration: DynamoDB expression strings, attribute maps, and Set initializers are configuration
        await this.docClient.send(new TransactWriteCommand({
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
                        ExpressionAttributeValues: { ':newId': new Set([personId]) },
                    },
                },
            ],
        }));
        // Stryker restore StringLiteral,ObjectLiteral,ArrayDeclaration

        // Update in-memory state
        this.personIds.add(personId);

        const contact = await this.contactBackend.getContact(personId);
        if(contact) {
            for(const identifier of contact.identifiers) {
                this.reverseMap.set(this.reverseKey(identifier.platform, identifier.value), personId);
            }
        }

        // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
        logger.info({ personId, msg: 'PersonAllowlist: person added' });
    }

    /**
     * Remove a person from the allowlist.
     * Deletes metadata + updates INDEX StringSet, then purges in-memory state.
     */
    async removePerson(personId: ContactId): Promise<void> {
        // Stryker disable StringLiteral,ObjectLiteral,ArrayDeclaration: DynamoDB expression strings, attribute maps, and Set initializers are configuration
        await this.docClient.send(new TransactWriteCommand({
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
        // Stryker restore StringLiteral,ObjectLiteral,ArrayDeclaration

        // Update in-memory state
        this.personIds.delete(personId);
        this.purgeReverseMapEntries(personId);

        // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
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
            for(const identifier of contact.identifiers) {
                this.reverseMap.set(this.reverseKey(identifier.platform, identifier.value), personId);
            }
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
            const result = await this.docClient.send(new QueryCommand({
                TableName:                 this.tableName,
                // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
                KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
                ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
                ExpressionAttributeValues: {
                    ':pk':     PK,
                    ':prefix': SK_PREFIX,
                },
                // Stryker restore StringLiteral,ObjectLiteral
                ExclusiveStartKey: lastEvaluatedKey,
            }));
            items.push(...(result.Items ?? []));
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while(lastEvaluatedKey);

        return items.map((item) => {
            const entry: PersonAllowlistEntry = {
                personId: item.personId as ContactId,
                addedAt:  item.addedAt as string,
                addedBy:  item.addedBy as string,
            };
            if(item.notes !== undefined) {
                entry.notes = item.notes as string;
            }
            return entry;
        });
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
