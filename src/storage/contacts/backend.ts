import { type BatchWriteCommandInput, type BatchWriteCommandOutput, BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import pLimit from 'p-limit';
import { z } from 'zod';
import { ContactKeyGenerator } from './key-generator';
import {
    contactIdentifierKey,
    contactSchema,
    type Contact,
    type ContactIdentifier,
    type ContactIdentifierKey,
    type ContactProfileItem,
    type PersonId,
    type PlatformType
} from './types';
import { BatchWriteExhaustedError, ContactLastIdentifierError, ContactNoIdentifiersError, ContactNotFoundError } from '@/errors';
import { DynamoTableAccess } from '@/storage';

const skOnlyRowSchema = z.object({ SK: z.string() });

/** Native SDK request and retry response shapes. */
type BatchWriteRequest = NonNullable<NonNullable<BatchWriteCommandInput['RequestItems']>[string]>[number];
type BatchWriteItems = NonNullable<BatchWriteCommandInput['RequestItems']>;

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

/** Bound independent writes and contact fetches to avoid overwhelming DynamoDB. */
const CONTACT_IO_CONCURRENCY = 4;

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Splits an array into chunks of the given size.
 */
function splitIntoBatches<T>(items: T[], size: number): T[][] {
    // Stryker disable next-line llm: binding slice is identical here; the sole caller passes an integer size, and multiplication order is equivalent.
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/**
 * DynamoDB backend for contact/address book storage.
 *
 * Key structure:
 *   Profile:  PK=CONTACT#{personId}          SK=PROFILE
 *   Lookup:   PK and SK from ContactKeyGenerator.createLookupKeys (identifier → personId)
 */
export class ContactBackend extends DynamoTableAccess {
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
        // Stryker disable next-line llm: deps.sleep is always a function or undefined, so ?? and || are equivalent here.
        const sleep = deps?.sleep ?? DEFAULT_SLEEP;
        let pending: BatchWriteItems = { [this.tableName]: requests };

        for(let attempt = 0; attempt < BATCH_WRITE_MAX_RETRIES; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop for unprocessed items
            const result: BatchWriteCommandOutput = await this.docClient.send(new BatchWriteCommand({
                RequestItems: pending,
            }));

            const hasUnprocessed = result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0;

            if(!hasUnprocessed) {
                return;
            }

            if(attempt < BATCH_WRITE_MAX_RETRIES - 1) {
                const delay = BATCH_WRITE_BASE_DELAY_MS * 2 ** attempt;
                // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between batch write attempts
                await sleep(delay);
            }

            const nextPending: BatchWriteItems = {};
            for(const table of Object.keys(result.UnprocessedItems ?? {})) {
                const unprocessed = result.UnprocessedItems?.[table];
                if(unprocessed !== undefined) {
                    nextPending[table] = unprocessed;
                }
            }
            // Stryker disable next-line llm: nextPending and UnprocessedItems are structurally identical for a valid DynamoDB response.
            pending = nextPending;
        }

        // Budget exhausted — throw so the caller knows the write is incomplete
        // Stryker disable next-line llm: pending values are defined arrays by construction, so the optional fallback is unreachable.
        const remainingCount = Object.values(pending).reduce((count, items) => count + items.length, 0);
        throw new BatchWriteExhaustedError('ContactBackend.batchWriteWithRetry', remainingCount, BATCH_WRITE_MAX_RETRIES);
    }

    /**
     * Get a contact by personId.
     * Returns undefined if not found.
     */
    async getContact(personId: PersonId): Promise<Contact | undefined> {
        const keys = ContactKeyGenerator.createProfileKeys(personId);
        const item = await this.getItem(keys);
        if(!item) {
            return undefined;
        }
        // Strip DynamoDB keys before parsing
        const { PK: _pk, SK: _sk, ...rest } = item;
        return contactSchema.parse(rest);
    }

    /** Splits requests at DynamoDB's hard limit and writes independent batches with bounded concurrency. */
    private async batchWriteAll(requests: BatchWriteRequest[], deps?: ContactBackendDeps): Promise<void> {
        const batches = splitIntoBatches(requests, DYNAMO_BATCH_WRITE_LIMIT);
        const limit = pLimit(CONTACT_IO_CONCURRENCY);
        const outcomes = await Promise.allSettled(batches.map(batch =>
            limit(async () => this.batchWriteWithRetry(batch, deps))
        ));
        for(const outcome of outcomes) {
            if(outcome.status === 'rejected') {
                throw outcome.reason;
            }
        }
    }

    /**
     * Builds put requests for new lookup rows (identifiers not in oldSet).
     */
    private buildNewLookupRequests(contact: Contact, oldSet: Set<ContactIdentifierKey>): BatchWriteRequest[] {
        const requests: BatchWriteRequest[] = [];
        // Stryker disable next-line llm: Contact.identifiers is a required array (putContact already read its length), so the nullish fallback is unreachable.
        for(const identifier of contact.identifiers) {
            if(!oldSet.has(contactIdentifierKey(identifier.platform, identifier.value))) {
                const lookupKeys = ContactKeyGenerator.createLookupKeys(
                    // Stryker disable next-line llm: ContactIdentifier.platform is a required enum value.
                    identifier.platform,
                    // Stryker disable next-line llm: createLookupKeys already lowercases identifier values.
                    identifier.value,
                    contact.personId
                );
                const lookupItem = { ...lookupKeys, personId: contact.personId, createdAt: new Date().toISOString() };
                requests.push({ PutRequest: { Item: lookupItem } });
            }
        }
        return requests;
    }

    /**
     * Builds delete requests for lookup rows that were removed (exist in existing but not in newSet).
     */
    private buildDeleteRequests(existing: Contact, newSet: Set<ContactIdentifierKey>): BatchWriteRequest[] {
        const requests: BatchWriteRequest[] = [];
        // Stryker disable next-line llm: existing comes from getContact's contactSchema.parse, so every identifier has a required platform.
        for(const identifier of existing.identifiers) {
            if(!newSet.has(contactIdentifierKey(identifier.platform, identifier.value))) {
                const { PK, SK } = ContactKeyGenerator.createLookupKeys(
                    identifier.platform,
                    identifier.value,
                    existing.personId
                );
                // DeleteRequest.Key must only contain the primary key attributes (PK + SK); GSI keys are not allowed
                // Stryker disable next-line llm: DynamoDB key property declaration order is unobservable.
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
        // Stryker disable next-line llm: an array length cannot be negative, so === 0 and <= 0 are equivalent.
        if(contact.identifiers.length === 0) {
            throw new ContactNoIdentifiersError(contact.personId);
        }

        const profileKeys = ContactKeyGenerator.createProfileKeys(contact.personId);

        // If an existing contact has different identifiers, we need to delete the old lookups.
        // We'll get the existing contact's identifiers and include deletes for any that are
        // being removed.
        const existing = await this.getContact(contact.personId);

        // Compute normalized key sets to detect unchanged identifiers; contactIdentifierKey is the
        // same equivalence ContactKeyGenerator.createLookupKeys() persists.
        // Stryker disable next-line llm: Set treats undefined as empty, and map does not mutate its source, making both rewrites inert.
        const oldSet = new Set(existing?.identifiers.map(id => contactIdentifierKey(id.platform, id.value)));
        const newSet = new Set(contact.identifiers.map(id => contactIdentifierKey(id.platform, id.value)));

        // ── Step 1: Write new lookup rows ──────────────────────────────────────────
        // Write only new lookup items (exist in new but not in old).
        // Must be written before the profile so new identifiers are resolvable
        // even if the profile write fails.
        const newLookupRequests = this.buildNewLookupRequests(contact, oldSet);
        await this.batchWriteAll(newLookupRequests, deps);

        // ── Step 2: Write the profile ──────────────────────────────────────────────
        const collectionKeys = ContactKeyGenerator.createCollectionKeys(contact.personId);
        const profileItem: ContactProfileItem = {
            ...contact,
            ...profileKeys,
            ...collectionKeys,
        };
        await this.batchWriteWithRetry([{ PutRequest: { Item: { ...profileItem } } }], deps);

        // ── Step 3: Delete removed lookup rows ────────────────────────────────────
        // Delete only lookup items that were removed (exist in old but not in new).
        // Orphan tolerance is acceptable here — stale lookups resolve to the still-valid
        // contact record, and the reconciler will clean them up eventually.
        if(existing) {
            const deleteRequests = this.buildDeleteRequests(existing, newSet);
            await this.batchWriteAll(deleteRequests, deps);
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
    async deleteContact(personId: PersonId, deps?: ContactBackendDeps): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }

        // Delete the profile first so partial failures leave orphan lookups rather than
        // a contact with phantom-deleted identifiers
        const profileKeys = ContactKeyGenerator.createProfileKeys(personId);
        // Stryker disable next-line llm: profileKeys is a fresh {PK, SK} object used once, so spreading it or passing it directly produces identical input.
        await this.batchWriteWithRetry([{ DeleteRequest: { Key: { ...profileKeys } } }], deps);

        // Delete all lookup items in batches
        const lookupDeleteRequests: BatchWriteRequest[] = existing.identifiers.map((identifier) => {
            const { PK, SK } = ContactKeyGenerator.createLookupKeys(
                identifier.platform,
                identifier.value,
                personId
            );
            // DeleteRequest.Key must only contain the primary key attributes (PK + SK); GSI keys are not allowed
            return { DeleteRequest: { Key: { PK, SK } } };
        });

        await this.batchWriteAll(lookupDeleteRequests, deps);
    }

    /**
     * Resolve a platform+value to matching contacts.
     * Returns an array (may be multiple for common names).
     */
    async resolveIdentifier(platform: PlatformType, value: string): Promise<Contact[]> {
        const lookupItems = await this.query({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': ContactKeyGenerator.createLookupPK(platform, value),
            },
        });

        const limit = pLimit(CONTACT_IO_CONCURRENCY);
        const contacts = await Promise.all(lookupItems.map((item) => {
            const { SK } = skOnlyRowSchema.parse(item);
            const personId = ContactKeyGenerator.parsePersonIdFromLookupSK(SK);
            return limit(async () => this.getContact(personId));
        }));
        return contacts.filter((contact): contact is Contact => contact !== undefined);
    }

    /**
     * Add an identifier to an existing contact.
     * Silently skips if the identifier already exists (case-insensitive).
     * @throws {ContactNotFoundError} if the contact does not exist
     */
    async addIdentifier(personId: PersonId, identifier: ContactIdentifier, deps?: ContactBackendDeps): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }
        // Skip if this identifier already exists (case-insensitive, trimmed)
        const newKey = contactIdentifierKey(identifier.platform, identifier.value);
        if(existing.identifiers.some(id => contactIdentifierKey(id.platform, id.value) === newKey)) {
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
    async removeIdentifier(personId: PersonId, platform: PlatformType, value: string, deps?: ContactBackendDeps): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }
        // Same platform and same normalized value, as one key: no PlatformType contains '#'.
        const target = contactIdentifierKey(platform, value);
        const remaining = existing.identifiers.filter(
            id => contactIdentifierKey(id.platform, id.value) !== target
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
            // eslint-disable-next-line no-await-in-loop -- sequential pagination: each page depends on LastEvaluatedKey from the prior page
            const result = await this.docClient.send(new QueryCommand({
                TableName:                 this.tableName,
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :pk',
                ExpressionAttributeValues: { ':pk': 'CONTACTS' },
                ExclusiveStartKey:         lastKey,
            }));
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
            // Stryker disable next-line NumberLiteralValue: an unmatched score is filtered out whether initialized to 0 or -1.
            let best = 0;
            for(const candidate of candidates) {
                const c = candidate.toLowerCase();
                // Stryker disable next-line llm: c and q are strings, so strict and loose equality are equivalent.
                if(c === q) {
                    // Stryker disable next-line NumberLiteralValue: only rank is observable, and both 3 and 4 rank above the other tiers.
                    return 3;
                }
                // Stryker disable next-line llm: q is already lowercase, so lowercasing it again is inert.
                if(c.startsWith(q)) {
                    best = Math.max(best, 2);
                } else if(
                    // Stryker disable next-line llm: q is already lowercase, so lowercasing it again is inert.
                    c.includes(q)
                ) {
                    best = Math.max(best, 1);
                }
            }
            return best;
        }

        const scored = all
            .map(contact => ({ contact, score: scoreContact(contact) }))
            .filter(({ score }) => score > 0);

        scored.sort((a, b) => b.score - a.score);

        return scored.map(({ contact }) => contact);
    }
}
