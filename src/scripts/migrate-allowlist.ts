/**
 * One-time migration script: migrates per-platform allowlist entries
 * (EMAIL#ALLOWLIST and BSKY#ALLOWLIST) to the unified person-based
 * allowlist (PERSON#ALLOWLIST).
 *
 * Usage:
 *   DYNAMODB_TABLE=IsambardMemory AWS_REGION=us-west-2 bun run src/scripts/migrate-allowlist.ts
 *
 * Or with SST shell:
 *   sst shell -- bun run src/scripts/migrate-allowlist.ts
 */

/* eslint-disable no-console -- migration script intentionally uses console for output */
/* eslint-disable no-await-in-loop -- sequential migration: each entry depends on prior contacts state */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ContactBackend, createContactId, findOrCreateContact, type Contact, type ContactId } from '@/storage/contacts';
import { PersonAllowlist } from '@/storage/person-allowlist';

/**
 * Query all DynamoDB items with a given PK and SK prefix.
 * Exported for testability.
 */
export async function queryOldEntries(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    pk: string,
    skPrefix: string
): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const result = await docClient.send(new QueryCommand({
            TableName:                 tableName,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: { ':pk': pk, ':prefix': skPrefix },
            ExclusiveStartKey:         lastEvaluatedKey,
        }));
        items.push(...(result.Items ?? []));
        lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while(lastEvaluatedKey);

    return items;
}

/**
 * Delete all entry items (by their SK) plus the INDEX item for a given PK.
 * Exported for testability.
 */
export async function deleteOldEntries(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    pk: string,
    entries: Record<string, unknown>[]
): Promise<void> {
    for(const entry of entries) {
        await docClient.send(new DeleteCommand({
            TableName: tableName,
            Key:       { PK: pk, SK: entry.SK as string },
        }));
    }
    // Delete the INDEX item
    await docClient.send(new DeleteCommand({
        TableName: tableName,
        Key:       { PK: pk, SK: 'INDEX' },
    }));
}

/**
 * Build a lookup map: "{platform}#{normalizedValue}" → ContactId.
 * Normalizes identifier values to lowercase+trimmed.
 * Exported for testability.
 */
export function buildLookupMap(contacts: Contact[]): Map<string, ContactId> {
    const map = new Map<string, ContactId>();
    for(const contact of contacts) {
        for(const identifier of contact.identifiers) {
            const key = `${identifier.platform}#${identifier.value.toLowerCase().trim()}`;
            map.set(key, contact.personId);
        }
    }
    return map;
}

interface MigrationCounts {
    created:   number
    existing:  number
    personIds: Set<string>
}

/** Resolve all email + bsky entries to personIds, creating contacts as needed. */
// Stryker disable all: resolveEntriesToPersonIds calls findOrCreateContact which requires live DynamoDB — untestable in unit tests
async function resolveEntriesToPersonIds(
    emailEntries:  Record<string, unknown>[],
    bskyEntries:   Record<string, unknown>[],
    lookupMap:     Map<string, ContactId>,
    contactBackend: ContactBackend
): Promise<MigrationCounts> {
    const personIds = new Set<string>();
    let created  = 0;
    let existing = 0;

    for(const entry of emailEntries) {
        const email    = (entry.email as string).toLowerCase().trim();
        const found    = lookupMap.get(`email#${email}`);
        let personId: ContactId;
        if(found) {
            personId = found;
            existing++;
        } else {
            const displayName = (entry.name as string | undefined) ?? email;
            personId = await findOrCreateContact(contactBackend, 'email', email, displayName, { notes: 'Migrated from email allowlist' });
            created++;
        }
        personIds.add(personId);
    }

    for(const entry of bskyEntries) {
        const handle = (entry.handle as string).toLowerCase().trim();
        const found  = lookupMap.get(`bsky#${handle}`);
        let personId: ContactId;
        if(found) {
            personId = found;
            existing++;
        } else {
            personId = await findOrCreateContact(contactBackend, 'bsky', handle, handle, { notes: 'Migrated from Bluesky allowlist' });
            created++;
        }
        personIds.add(personId);
    }

    return { created, existing, personIds };
}
// Stryker restore all

/** Verify all entries are reachable via PersonAllowlist.isAllowed(). */
// Stryker disable all: verifyMigration calls personAllowlist.isAllowed with live data — untestable in unit tests
function verifyMigration(
    personAllowlist: PersonAllowlist,
    emailEntries:    Record<string, unknown>[],
    bskyEntries:     Record<string, unknown>[]
): { verified: number, failed: number } {
    let verified = 0;
    let failed   = 0;

    for(const entry of emailEntries) {
        if(personAllowlist.isAllowed('email', entry.email as string)) {
            verified++;
        } else {
            console.error(`VERIFICATION FAILED: email ${entry.email as string} not allowed after migration`);
            failed++;
        }
    }

    for(const entry of bskyEntries) {
        if(personAllowlist.isAllowed('bsky', entry.handle as string)) {
            verified++;
        } else {
            console.error(`VERIFICATION FAILED: bsky handle ${entry.handle as string} not allowed after migration`);
            failed++;
        }
    }

    return { verified, failed };
}
// Stryker restore all

// Stryker disable all: main() requires live DynamoDB, AWS credentials, and SST environment — untestable in unit tests
async function main(): Promise<void> {
    const tableName = process.env.DYNAMODB_TABLE ?? 'IsambardMemory';
    const region    = process.env.AWS_REGION ?? 'us-west-2';

    console.log(`Migrating allowlists in table: ${tableName} (region: ${region})`);

    // Create clients
    const ddbClient = new DynamoDBClient({ region });
    const docClient = DynamoDBDocumentClient.from(ddbClient, {
        marshallOptions: {
            removeUndefinedValues:     true,
            convertClassInstanceToMap: true,
        },
        unmarshallOptions: {
            wrapNumbers: false,
        },
    });

    // Create backends
    const contactBackend  = new ContactBackend(docClient, tableName);
    const personAllowlist = new PersonAllowlist(docClient, tableName, contactBackend);

    // Step 1: Load all contacts and build lookup map
    const contacts = await contactBackend.listContacts();
    console.log(`Loaded ${contacts.length} existing contacts`);
    const lookupMap = buildLookupMap(contacts);

    // Step 2: Query old allowlist entries
    const emailEntries = await queryOldEntries(docClient, tableName, 'EMAIL#ALLOWLIST', 'ADDR#');
    const bskyEntries  = await queryOldEntries(docClient, tableName, 'BSKY#ALLOWLIST', 'HANDLE#');
    console.log(`Found ${emailEntries.length} email allowlist entries`);
    console.log(`Found ${bskyEntries.length} bsky allowlist entries`);

    // Step 3: Map to personIds, creating contacts for unknown entries
    const { created, existing, personIds } = await resolveEntriesToPersonIds(
        emailEntries, bskyEntries, lookupMap, contactBackend
    );

    console.log('\nMigration summary:');
    console.log(`  ${existing} entries matched existing contacts`);
    console.log(`  ${created} new contacts created`);
    console.log(`  ${personIds.size} unique persons to add to allowlist`);

    // Step 4: Load current PersonAllowlist state, then add all persons
    await personAllowlist.load();
    for(const personIdStr of personIds) {
        const personId = createContactId(personIdStr);
        await personAllowlist.addPerson(personId, { addedBy: 'migration' });
    }

    // Step 5: Verify — reload and check isAllowed for every original entry
    await personAllowlist.load();
    const { verified, failed } = verifyMigration(personAllowlist, emailEntries, bskyEntries);

    if(failed > 0) {
        throw new Error(`${failed} verification failures — NOT deleting old entries`);
    }

    console.log(`\nVerification passed: ${verified}/${verified} entries confirmed`);

    // Step 6: Delete old entries
    console.log('Deleting old allowlist entries...');
    await deleteOldEntries(docClient, tableName, 'EMAIL#ALLOWLIST', emailEntries);
    await deleteOldEntries(docClient, tableName, 'BSKY#ALLOWLIST', bskyEntries);
    console.log('Old entries deleted.');

    console.log('\nMigration complete!');
}
// Stryker restore all

// Only run when executed directly (not when imported in tests)
// Stryker disable next-line ConditionalExpression,BlockStatement: import.meta.main guard is untestable — running main() in tests would require live DynamoDB and would cause side effects
if(import.meta.main) {
    await main();
}
