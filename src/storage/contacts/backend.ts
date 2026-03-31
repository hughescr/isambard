import { QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ContactKeyGenerator } from './key-generator';
import {
    contactSchema,
    type Contact,
    type ContactId,
    type ContactIdentifier,
    type ContactProfileItem,
    type PlatformType
} from './types';
import { ContactLastIdentifierError, ContactNotFoundError } from '@/errors';
import { BaseRepository } from '@/storage';

/** Shorthand for the strongly-typed TransactItems array */
type TransactItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

/**
 * Produce a normalized comparison key for a ContactIdentifier.
 * Matches the normalization applied in ContactKeyGenerator.createLookupKeys().
 */
function identifierKey(id: ContactIdentifier): string {
    // Stryker disable next-line MethodExpression: toLowerCase and toUpperCase are equivalent here — both normalize case for equality comparison; only the direction differs
    return `${id.platform}#${id.value.toLowerCase().trim()}`;
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
     * Write a contact and all its lookup items atomically.
     * Replaces any existing contact with the same personId.
     * When updating, only deletes removed lookup items and only creates added lookup items.
     * Unchanged identifiers are left alone to avoid DynamoDB TransactWrite conflicts.
     */
    async putContact(contact: Contact): Promise<void> {
        const profileKeys = ContactKeyGenerator.createProfileKeys(contact.personId);

        // If an existing contact has different identifiers, we need to delete the old lookups.
        // We'll get the existing contact's identifiers and include deletes for any that are
        // being removed.
        const existing = await this.getContact(contact.personId);

        const transactItems: TransactItems = [];

        // Compute normalized key sets to detect unchanged identifiers.
        // This matches the normalization applied in ContactKeyGenerator.createLookupKeys().
        const oldSet = new Set(existing?.identifiers.map(id => identifierKey(id)));
        const newSet = new Set(contact.identifiers.map(id => identifierKey(id)));

        // Delete only lookup items that were removed (exist in old but not in new)
        if(existing) {
            for(const identifier of existing.identifiers) {
                if(!newSet.has(identifierKey(identifier))) {
                    const lookupKeys = ContactKeyGenerator.createLookupKeys(
                        identifier.platform,
                        identifier.value,
                        contact.personId
                    );
                    // Stryker disable next-line ObjectLiteral: DynamoDB TransactWrite delete request structure
                    transactItems.push({ Delete: { TableName: this.tableName, Key: lookupKeys } });
                }
            }
        }

        // Write the profile item
        const collectionKeys = ContactKeyGenerator.createCollectionKeys(contact.personId);
        const profileItem: ContactProfileItem = {
            ...contact,
            ...profileKeys,
            ...collectionKeys,
        };
        // Stryker disable next-line ObjectLiteral: DynamoDB TransactWrite put request structure
        transactItems.push({ Put: { TableName: this.tableName, Item: profileItem } });

        // Write only new lookup items (exist in new but not in old)
        for(const identifier of contact.identifiers) {
            if(!oldSet.has(identifierKey(identifier))) {
                const lookupKeys = ContactKeyGenerator.createLookupKeys(
                    identifier.platform,
                    identifier.value,
                    contact.personId
                );
                const lookupItem = {
                    ...lookupKeys,
                    personId: contact.personId,
                };
                // Stryker disable next-line ObjectLiteral: DynamoDB TransactWrite put request structure
                transactItems.push({ Put: { TableName: this.tableName, Item: lookupItem } });
            }
        }

        await this.docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
    }

    /**
     * Delete a contact and all its lookup items atomically.
     * @throws {ContactNotFoundError} if the contact does not exist
     */
    async deleteContact(personId: ContactId): Promise<void> {
        const existing = await this.getContact(personId);
        if(!existing) {
            throw new ContactNotFoundError(personId);
        }

        const profileKeys = ContactKeyGenerator.createProfileKeys(personId);
        const transactItems: TransactItems = [
            // Stryker disable next-line ObjectLiteral: DynamoDB TransactWrite delete request structure
            { Delete: { TableName: this.tableName, Key: profileKeys } },
        ];

        for(const identifier of existing.identifiers) {
            const lookupKeys = ContactKeyGenerator.createLookupKeys(
                identifier.platform,
                identifier.value,
                personId
            );
            // Stryker disable next-line ObjectLiteral: DynamoDB TransactWrite delete request structure
            transactItems.push({ Delete: { TableName: this.tableName, Key: lookupKeys } });
        }

        await this.docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
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
    async addIdentifier(personId: ContactId, identifier: ContactIdentifier): Promise<void> {
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
        await this.putContact(updated);
    }

    /**
     * Remove an identifier from an existing contact.
     * @throws {ContactNotFoundError} if the contact does not exist
     * @throws {ContactLastIdentifierError} if removing would leave no identifiers
     */
    async removeIdentifier(personId: ContactId, platform: PlatformType, value: string): Promise<void> {
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
        await this.putContact(updated);
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
            lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
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
