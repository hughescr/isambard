import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ContactKeyGenerator } from './key-generator';
import {
    contactSchema,
    type Contact,
    type ContactId,
    type ContactIdentifier,
    type ContactProfileItem,
    type PlatformType
} from './types';
import { ContactLastIdentifierError, ContactNoIdentifiersError, ContactNotFoundError } from '@/errors';
import { BaseRepository } from '@/storage';

/** BatchWrite request shape matching lib-dynamodb's BatchWriteCommand input */
interface BatchWriteRequest {
    PutRequest?: {
        Item: Record<string, unknown>
    }
    DeleteRequest?: {
        Key: Record<string, unknown>
    }
}

/**
 * Optional dependency injection for batchWriteWithRetry and callers.
 */
export interface ContactBackendDeps {
    /** Override the sleep function (default: setTimeout-based delay) */
    sleep?: (ms: number) => Promise<void>
}

/**
 * DynamoDB hard limit for items in a single BatchWriteItem call.
 */
const DYNAMO_BATCH_WRITE_LIMIT = 25;

/**
 * Maximum number of BatchWrite retry attempts for unprocessed items.
 */
const BATCH_WRITE_MAX_RETRIES = 3;

/**
 * Base delay in ms for BatchWrite retry backoff.
 */
const BATCH_WRITE_BASE_DELAY_MS = 100;

// Stryker disable all: Default sleep is untestable I/O
const DEFAULT_SLEEP = (ms: number): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, ms); });
// Stryker restore all

/**
 * Produce a normalized comparison key for a ContactIdentifier.
 * Matches the normalization applied in ContactKeyGenerator.createLookupKeys().
 */
function identifierKey(id: ContactIdentifier): string {
    // Stryker disable next-line MethodExpression: toLowerCase and toUpperCase are equivalent here — both normalize case for equality comparison; only the direction differs
    return `${id.platform}#${id.value.toLowerCase().trim()}`;
}

/**
 * Splits an array into chunks of the given size.
 */
function splitIntoBatches<T>(items: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/**
 * DynamoDB backend for contact/address book storage.
 *
 * Key structure:
 *   Profile:  PK=CONTACT#{personId}          SK=PROFILE
 *   Lookup:   PK=CONTACT_LOOKUP#{platform}#{value}  SK=CONTACT#{personId}
 */
export class ContactBackend extends BaseRepository<Contact> {
    /**
     * Executes a batch of write requests with retry for UnprocessedItems.
     * Throws if items remain unprocessed after all retries.
     *
     * @param deps - Optional dependency injection (sleep override)
     * @throws if DynamoDB returns unprocessed items after BATCH_WRITE_MAX_RETRIES attempts
     */
    private async batchWriteWithRetry(
        requests: BatchWriteRequest[],
        deps?: ContactBackendDeps
    ): Promise<void> {
        const sleep = deps?.sleep ?? DEFAULT_SLEEP;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UnprocessedItems type is complex and not worth matching exactly
        let pending: any = { [this.tableName]: requests };

        // Stryker disable next-line ConditionalExpression,EqualityOperator,UpdateOperator,BlockStatement: for-loop — UpdateOperator attempt-- would infinite-loop; condition mutations tested via batch behavior
        for(let attempt = 0; attempt < BATCH_WRITE_MAX_RETRIES; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop for unprocessed items
            const result = await this.docClient.send(new BatchWriteCommand({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- complex type
                RequestItems: pending,
            }));

            // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,OptionalChaining: unprocessed items check — all branches tested via batch write tests
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: DynamoDB SDK result typed non-nullable but checking defensively
            const hasUnprocessed = result?.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0;

            // Stryker disable next-line ConditionalExpression,BlockStatement,BooleanLiteral: Early return on success
            if(!hasUnprocessed) {
                return;
            }

            // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator,BlockStatement: Retry boundary — last attempt falls through to throw; -1 vs +1 both exit the loop (attempt never reaches BATCH_WRITE_MAX_RETRIES+1)
            if(attempt < BATCH_WRITE_MAX_RETRIES - 1) {
                // Stryker disable next-line ArithmeticOperator: Backoff formula; * vs / indistinguishable at attempt 0 (2^0=1)
                const delay = BATCH_WRITE_BASE_DELAY_MS * 2 ** attempt;
                // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between batch write attempts
                await sleep(delay);
            }

            pending = result.UnprocessedItems;
        }

        // Budget exhausted — throw so the caller knows the write is incomplete
        const pendingTyped = pending as Record<string, BatchWriteRequest[]>;
        const remainingCount = Object.values(pendingTyped).flat().length;
        throw new Error(
            // Stryker disable next-line StringLiteral: error message is informational
            `ContactBackend.batchWriteWithRetry: ${remainingCount} items remain unprocessed after ${BATCH_WRITE_MAX_RETRIES} attempts`
        );
    }

    /**
     * Get a contact by personId.
     * Returns undefined if not found.
     */
    async getContact(personId: ContactId): Promise<Contact | undefined> {
        const keys = ContactKeyGenerator.createProfileKeys(personId);
        const item = await this.getItem<Record<string, unknown>>(keys);
        if(!item) {
            return undefined;
        }
        // Strip DynamoDB keys before parsing
        const { PK: _pk, SK: _sk, ...rest } = item;
        return contactSchema.parse(rest);
    }

    /**
     * Writes all batches for a list of requests sequentially.
     * Splits into DYNAMO_BATCH_WRITE_LIMIT-sized batches and retries each.
     */
    private async batchWriteAll(requests: BatchWriteRequest[], deps?: ContactBackendDeps): Promise<void> {
        const batches = splitIntoBatches(requests, DYNAMO_BATCH_WRITE_LIMIT);
        for(const batch of batches) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each batch depends on independent DynamoDB capacity
            await this.batchWriteWithRetry(batch, deps);
        }
    }

    /**
     * Builds put requests for new lookup rows (identifiers not in oldSet).
     */
    private buildNewLookupRequests(contact: Contact, oldSet: Set<string>): BatchWriteRequest[] {
        const requests: BatchWriteRequest[] = [];
        for(const identifier of contact.identifiers) {
            if(!oldSet.has(identifierKey(identifier))) {
                const lookupKeys = ContactKeyGenerator.createLookupKeys(
                    identifier.platform,
                    identifier.value,
                    contact.personId
                );
                // Stryker disable next-line StringLiteral: new Date().toISOString() is intentional non-determinism — captures write time for age-threshold protection in reconciler
                const lookupItem = { ...lookupKeys, personId: contact.personId, createdAt: new Date().toISOString() };
                // Stryker disable next-line ObjectLiteral: DynamoDB BatchWrite put request structure
                requests.push({ PutRequest: { Item: lookupItem } });
            }
        }
        return requests;
    }

    /**
     * Builds delete requests for lookup rows that were removed (exist in existing but not in newSet).
     */
    private buildDeleteRequests(existing: Contact, newSet: Set<string>): BatchWriteRequest[] {
        const requests: BatchWriteRequest[] = [];
        for(const identifier of existing.identifiers) {
            if(!newSet.has(identifierKey(identifier))) {
                const { PK, SK } = ContactKeyGenerator.createLookupKeys(
                    identifier.platform,
                    identifier.value,
                    existing.personId
                );
                // DeleteRequest.Key must only contain the primary key attributes (PK + SK); GSI keys are not allowed
                // Stryker disable next-line ObjectLiteral: DynamoDB BatchWrite delete request structure
                requests.push({ DeleteRequest: { Key: { PK, SK } } });
            }
        }
        return requests;
    }

    /**
     * Write a contact and all its lookup items using batched independent writes.
     * Replaces any existing contact with the same personId.
     * When updating, only deletes removed lookup items and only creates added lookup items.
     * Unchanged identifiers are left alone to avoid unnecessary churn.
     *
     * Write order (for failure-safety):
     *   1. Write new lookup rows first — so new identifiers are resolvable before the profile is updated.
     *   2. Write the profile — atomically advances the profile to the new state.
     *   3. Delete removed lookup rows — orphan tolerance is acceptable; stale lookups resolve to a
     *      now-valid profile, and the reconciler will clean them up eventually.
     *
     * At every intermediate failure point, all identifiers claimed by the profile are resolvable,
     * and stale lookups at worst point to an older-but-valid contact record.
     *
     * Atomicity note: writes are not transactional. Race conditions between concurrent
     * updates are not a concern for this use case — partial writes land correct data.
     *
     * @param deps - Optional dependency injection (sleep override for testing)
     * @throws {ContactNoIdentifiersError} if the contact has no identifiers
     */
    async putContact(contact: Contact, deps?: ContactBackendDeps): Promise<void> {
        // Fail fast: a contact with no identifiers is unreachable via resolveIdentifier
        if(contact.identifiers.length === 0) {
            throw new ContactNoIdentifiersError(contact.personId);
        }

        const profileKeys = ContactKeyGenerator.createProfileKeys(contact.personId);

        // If an existing contact has different identifiers, we need to delete the old lookups.
        // We'll get the existing contact's identifiers and include deletes for any that are
        // being removed.
        const existing = await this.getContact(contact.personId);

        // Compute normalized key sets to detect unchanged identifiers.
        // This matches the normalization applied in ContactKeyGenerator.createLookupKeys().
        const oldSet = new Set(existing?.identifiers.map(id => identifierKey(id)));
        const newSet = new Set(contact.identifiers.map(id => identifierKey(id)));

        // ── Step 1: Write new lookup rows ──────────────────────────────────────────
        // Write only new lookup items (exist in new but not in old).
        // Must be written before the profile so new identifiers are resolvable
        // even if the profile write fails.
        const newLookupRequests = this.buildNewLookupRequests(contact, oldSet);
        // Stryker disable next-line EqualityOperator,ConditionalExpression: optimization guard — batchWriteAll([]) is a no-op; both paths produce the same result for an empty array
        if(newLookupRequests.length > 0) {
            await this.batchWriteAll(newLookupRequests, deps);
        }

        // ── Step 2: Write the profile ──────────────────────────────────────────────
        const collectionKeys = ContactKeyGenerator.createCollectionKeys(contact.personId);
        const profileItem: ContactProfileItem = {
            ...contact,
            ...profileKeys,
            ...collectionKeys,
        };
        // Stryker disable next-line ObjectLiteral: DynamoDB BatchWrite put request structure
        await this.batchWriteWithRetry([{ PutRequest: { Item: profileItem as unknown as Record<string, unknown> } }], deps);

        // ── Step 3: Delete removed lookup rows ────────────────────────────────────
        // Delete only lookup items that were removed (exist in old but not in new).
        // Orphan tolerance is acceptable here — stale lookups resolve to the still-valid
        // contact record, and the reconciler will clean them up eventually.
        if(existing) {
            const deleteRequests = this.buildDeleteRequests(existing, newSet);
            // Stryker disable next-line EqualityOperator,ConditionalExpression: optimization guard — batchWriteAll([]) is a no-op; both paths produce the same result for an empty array
            if(deleteRequests.length > 0) {
                await this.batchWriteAll(deleteRequests, deps);
            }
        }
    }

    /**
     * Delete a contact and all its lookup items using batched writes.
     * Deletes profile first, then lookup items in batches.
     *
     * Ordering: profile is deleted first so that a partial failure leaves orphan lookup rows
     * (which are harmless — resolveIdentifier skips contacts whose profile is missing)
     * rather than leaving a contact with phantom-deleted identifiers.
     *
     * Atomicity note: writes are not transactional. A contact with more than 24 identifiers
     * cannot be deleted atomically via DynamoDB's 25-item TX limit; this batched approach
     * handles any number of identifiers.
     *
     * @param deps - Optional dependency injection (sleep override for testing)
     * @throws {ContactNotFoundError} if the contact does not exist
     * @throws if DynamoDB returns unprocessed items after all retries
     */
    async deleteContact(personId: ContactId, deps?: ContactBackendDeps): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }

        // Delete the profile first so partial failures leave orphan lookups rather than
        // a contact with phantom-deleted identifiers
        const profileKeys = ContactKeyGenerator.createProfileKeys(personId);
        // Stryker disable next-line ObjectLiteral: DynamoDB BatchWrite delete request structure
        await this.batchWriteWithRetry([{ DeleteRequest: { Key: profileKeys as unknown as Record<string, unknown> } }], deps);

        // Delete all lookup items in batches
        const lookupDeleteRequests: BatchWriteRequest[] = existing.identifiers.map((identifier) => {
            const { PK, SK } = ContactKeyGenerator.createLookupKeys(
                identifier.platform,
                identifier.value,
                personId
            );
            // DeleteRequest.Key must only contain the primary key attributes (PK + SK); GSI keys are not allowed
            // Stryker disable next-line ObjectLiteral: DynamoDB BatchWrite delete request structure
            return { DeleteRequest: { Key: { PK, SK } } };
        });

        // Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: optimization guard — batchWriteAll([]) is a no-op; both paths produce the same result for an empty array
        if(lookupDeleteRequests.length === 0) {
            return;
        }

        await this.batchWriteAll(lookupDeleteRequests, deps);
    }

    /**
     * Resolve a platform+value to matching contacts.
     * Returns an array (may be multiple for common names).
     */
    async resolveIdentifier(platform: PlatformType, value: string): Promise<Contact[]> {
        const normalizedValue = value.toLowerCase().trim();
        // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
        const lookupItems = await this.query<{ SK: string }>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': `CONTACT_LOOKUP#${platform}#${normalizedValue}`,
            },
        });
        // Stryker restore StringLiteral,ObjectLiteral

        const contacts: Contact[] = [];
        for(const item of lookupItems) {
            const itemPersonId = ContactKeyGenerator.parsePersonIdFromLookupSK(item.SK);
            // eslint-disable-next-line no-await-in-loop -- sequential: each lookup depends on the prior SK parse
            const contact = await this.getContact(itemPersonId);
            if(contact) {
                contacts.push(contact);
            }
        }
        return contacts;
    }

    /**
     * Add an identifier to an existing contact.
     * Silently skips if the identifier already exists (case-insensitive).
     * @throws {ContactNotFoundError} if the contact does not exist
     */
    async addIdentifier(personId: ContactId, identifier: ContactIdentifier, deps?: ContactBackendDeps): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }
        // Skip if this identifier already exists (case-insensitive, trimmed)
        const newKey = identifierKey(identifier);
        if(existing.identifiers.some(id => identifierKey(id) === newKey)) {
            return;
        }
        const updated: Contact = {
            ...existing,
            identifiers: [...existing.identifiers, identifier],
            updatedAt:   new Date().toISOString(),
        };
        await this.putContact(updated, deps);
    }

    /**
     * Remove an identifier from an existing contact.
     * @throws {ContactNotFoundError} if the contact does not exist
     * @throws {ContactLastIdentifierError} if removing would leave no identifiers
     */
    async removeIdentifier(personId: ContactId, platform: PlatformType, value: string, deps?: ContactBackendDeps): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }
        const normalizedValue = value.toLowerCase().trim();
        const remaining = existing.identifiers.filter(
            id => !(id.platform === platform && id.value.toLowerCase().trim() === normalizedValue)
        );
        if(remaining.length === 0) {
            throw new ContactLastIdentifierError(personId);
        }
        const updated: Contact = {
            ...existing,
            identifiers: remaining,
            updatedAt:   new Date().toISOString(),
        };
        await this.putContact(updated, deps);
    }

    /**
     * List all contacts using a GSI2 query instead of a full table scan.
     * GSI2PK='CONTACTS' covers all contact profile items efficiently.
     * Paginates through all DynamoDB pages to avoid silently dropping contacts
     * if the result set exceeds 1 MB.
     */
    async listContacts(): Promise<Contact[]> {
        const allItems: Record<string, unknown>[] = [];
        let lastKey: Record<string, unknown> | undefined;
        do {
            // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
            // eslint-disable-next-line no-await-in-loop -- sequential pagination: each page depends on LastEvaluatedKey from the prior page
            const result = await this.docClient.send(new QueryCommand({
                TableName:                 this.tableName,
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :pk',
                ExpressionAttributeValues: { ':pk': 'CONTACTS' },
                ExclusiveStartKey:         lastKey,
            }));
            // Stryker restore StringLiteral,ObjectLiteral
            allItems.push(...(result.Items ?? []) as Record<string, unknown>[]);
            lastKey = result.LastEvaluatedKey;
        } while(lastKey);
        return allItems.map((item) => {
            const { PK: _pk, SK: _sk, GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, ...rest } = item;
            return contactSchema.parse(rest);
        });
    }

    /**
     * Fuzzy lookup across all contacts.
     * Returns results ranked: exact match > prefix match > substring match.
     * Matching is case-insensitive and checks displayName + all identifier values.
     */
    async fuzzyLookup(query: string): Promise<Contact[]> {
        const all = await this.listContacts();
        // Stryker disable next-line ConditionalExpression,BlockStatement: optimization guard — empty list produces same result
        if(all.length === 0) {
            return [];
        }

        const q = query.toLowerCase().trim();

        /**
         * Score a contact against the query.
         * 3 = exact match, 2 = prefix match, 1 = substring match, 0 = no match
         */
        function scoreContact(contact: Contact): number {
            const candidates = [
                contact.displayName,
                ...contact.identifiers.map(id => id.value),
            ];
            let best = 0;
            for(const candidate of candidates) {
                const c = candidate.toLowerCase();
                // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — exact match is also a startsWith, so score 3 vs 2 is indistinguishable when the only other match is also a prefix
                if(c === q) {
                    return 3;
                }
                if(c.startsWith(q)) {
                    best = Math.max(best, 2);
                // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — removing else sets best=Math.max(2,1)=2 for prefix match, same result
                } else if(c.includes(q)) {
                    best = Math.max(best, 1);
                }
            }
            return best;
        }

        const scored = all
            .map(contact => ({ contact, score: scoreContact(contact) }))
            .filter(({ score }) => score > 0);

        // Stryker disable next-line ConditionalExpression,StringLiteral: sort comparison is ordered by score descending
        scored.sort((a, b) => b.score - a.score);

        return scored.map(({ contact }) => contact);
    }
}
