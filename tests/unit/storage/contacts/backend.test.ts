import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    QueryCommand,
    BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { ErrorCode, ContactNoIdentifiersError } from '@/errors';
import { ContactBackend } from '@/storage/contacts/backend';
import {
    type Contact,
    type ContactId,
    type ContactIdentifier
} from '@/storage/contacts/types';

const PERSON_ID   = 'alice-smith' as ContactId;
const PERSON_ID_2 = 'bob-jones' as ContactId;

const ALICE: Contact = {
    personId:    PERSON_ID,
    displayName: 'Alice Smith',
    identifiers: [
        { platform: 'email', value: 'alice@example.com' },
        { platform: 'discord', value: 'alice#1234' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
};

const BOB: Contact = {
    personId:    PERSON_ID_2,
    displayName: 'Bob Jones',
    identifiers: [
        { platform: 'email', value: 'bob@example.com' },
    ],
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-16T00:00:00.000Z',
};

/** Helper: build a "found" DynamoDB GetItem response for a contact */
function contactGetResponse(contact: Contact): { Item: Record<string, unknown> } {
    return {
        Item: {
            PK:     `CONTACT#${contact.personId}`,
            SK:     'PROFILE',
            GSI2PK: 'CONTACTS',
            GSI2SK: `CONTACT#${contact.personId}`,
            ...contact,
        },
    };
}

/** Helper: build a query result item for listContacts (includes GSI2 keys) */
function contactQueryItem(contact: Contact): Record<string, unknown> {
    return {
        PK:     `CONTACT#${contact.personId}`,
        SK:     'PROFILE',
        GSI2PK: 'CONTACTS',
        GSI2SK: `CONTACT#${contact.personId}`,
        ...contact,
    };
}

/** Helper: build an "empty" DynamoDB GetItem response */
function notFound(): Record<string, never> {
    return {};
}

/** Helper: build an array of n distinct email identifiers */
function makeIdentifiers(n: number): ContactIdentifier[] {
    return Array.from({ length: n }, (_, i): ContactIdentifier => ({
        platform: 'email',
        value:    `user${i}@example.com`,
    }));
}

/** The base delay value from batchWriteWithRetry (100ms) */
const BATCH_WRITE_BASE_DELAY_MS = 100;

/** Injected sleep mock — resolves immediately, no real timers */
const mockSleep = mock(async (_ms: number): Promise<void> => undefined);

describe('ContactBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: ContactBackend;

    beforeEach(() => {
        ddbMock  = mockClient(DynamoDBDocumentClient);
        backend  = new ContactBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        mockSleep.mockReset();
        ddbMock.restore();
    });

    // ======================================================================
    // getContact
    // ======================================================================
    describe('getContact', () => {
        test('returns Contact when found', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));

            const result = await backend.getContact(PERSON_ID);

            expect(result).toEqual(ALICE);
            // PK/SK must NOT be on the result
            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
        });

        test('returns undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            const result = await backend.getContact(PERSON_ID);

            expect(result).toBeUndefined();
        });

        test('queries with correct PK and SK', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            await backend.getContact(PERSON_ID);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toMatchObject({
                TableName: 'TestTable',
                Key:       { PK: 'CONTACT#alice-smith', SK: 'PROFILE' },
            });
        });

        test('returns contact with _internal field preserved', async () => {
            const contactWithInternal: Contact = {
                ...ALICE,
                _internal: { discordUserId: '987654321', bskyDid: 'did:plc:abc123' },
            };
            ddbMock.on(GetCommand).resolves(contactGetResponse(contactWithInternal));

            const result = await backend.getContact(PERSON_ID);

            expect(result?._internal).toEqual({ discordUserId: '987654321', bskyDid: 'did:plc:abc123' });
        });
    });

    // ======================================================================
    // putContact — zero identifiers guard
    // ======================================================================
    describe('putContact (zero identifiers)', () => {
        test('throws ContactNoIdentifiersError when identifiers array is empty', async () => {
            // Zod schema requires min(1) so we cast to bypass schema for this test
            const contactZero = {
                ...ALICE,
                identifiers: [] as unknown as Contact['identifiers'],
            };
            ddbMock.on(GetCommand).resolves(notFound());

            expect(
                backend.putContact(contactZero)
            ).rejects.toBeInstanceOf(ContactNoIdentifiersError);
        });

        test('thrown error has correct code for empty identifiers', async () => {
            const contactZero = {
                ...ALICE,
                identifiers: [] as unknown as Contact['identifiers'],
            };
            ddbMock.on(GetCommand).resolves(notFound());

            expect(
                backend.putContact(contactZero)
            ).rejects.toMatchObject({
                code:    ErrorCode.CONTACT_NO_IDENTIFIERS,
                context: { personId: PERSON_ID },
            });
        });

        test('throws before any DynamoDB call when identifiers are empty', async () => {
            const contactZero = {
                ...ALICE,
                identifiers: [] as unknown as Contact['identifiers'],
            };
            // No GetCommand mock needed — guard fires before DB access
            expect(
                backend.putContact(contactZero)
            ).rejects.toBeInstanceOf(ContactNoIdentifiersError);

            expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
            expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
        });

        test('succeeds with exactly 1 identifier', async () => {
            const contact1: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
            };
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            expect(backend.putContact(contact1)).resolves.toBeUndefined();
        });
    });

    // ======================================================================
    // putContact — new contact (batched writes)
    // ======================================================================
    describe('putContact (new contact)', () => {
        test('issues BatchWriteCommand with profile and lookup items', async () => {
            // First GetCommand returns not-found (new contact, no old lookups to delete)
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(1);

            // Collect all request items across all BatchWrite calls
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );

            // 1 profile Put + 2 lookup Puts (for 2 identifiers)
            expect(allItems).toHaveLength(3);
        });

        test('writes lookup items before the profile item (new-lookup-first ordering)', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            // With 2 new lookups (< 25 limit), they are written in batch 1;
            // profile is written separately in batch 2.
            // First batch must contain lookup items, not the profile.
            const firstBatchItems = bwCalls[0]?.args[0].input.RequestItems?.TestTable ?? [];
            expect(firstBatchItems.every(item => item.PutRequest?.Item?.SK !== 'PROFILE')).toBe(true);
        });

        test('writes profile item after lookup items (new-lookup-first ordering)', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            // Profile is written in its own separate batch after lookups
            const profileBatch = bwCalls.find((call) => {
                const items = call.args[0].input.RequestItems?.TestTable ?? [];
                return items.some(item => item.PutRequest?.Item?.SK === 'PROFILE');
            });
            expect(profileBatch).toBeDefined();
            // Profile batch index must be > 0 (not the first batch)
            const profileBatchIndex = bwCalls.indexOf(profileBatch!);
            expect(profileBatchIndex).toBeGreaterThan(0);
        });

        test('writes profile item with correct PK/SK and GSI2 keys', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(
                item => item.PutRequest?.Item?.SK === 'PROFILE'
            );
            expect(profilePut?.PutRequest?.Item).toMatchObject({
                PK:          'CONTACT#alice-smith',
                SK:          'PROFILE',
                GSI2PK:      'CONTACTS',
                GSI2SK:      'CONTACT#alice-smith',
                personId:    'alice-smith',
                displayName: 'Alice Smith',
            });
        });

        test('writes lookup items with correct PK/SK', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const lookupItems = allItems.filter(
                item => item.PutRequest?.Item?.SK !== 'PROFILE'
            );

            const emailLookup = lookupItems.find(
                item => (item.PutRequest?.Item?.PK as string | undefined)?.includes('email')
            );
            expect(emailLookup?.PutRequest?.Item).toMatchObject({
                PK:       'CONTACT_LOOKUP#email#alice@example.com',
                SK:       'CONTACT#alice-smith',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#alice-smith#email#alice@example.com',
                personId: 'alice-smith',
            });

            const discordLookup = lookupItems.find(
                item => (item.PutRequest?.Item?.PK as string | undefined)?.includes('discord')
            );
            expect(discordLookup?.PutRequest?.Item).toMatchObject({
                PK:       'CONTACT_LOOKUP#discord#alice#1234',
                SK:       'CONTACT#alice-smith',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#alice-smith#discord#alice#1234',
                personId: 'alice-smith',
            });
        });

        test('normalizes email to lowercase in lookup key', async () => {
            const contactWithUpperEmail: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'ALICE@EXAMPLE.COM' }],
            };
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(contactWithUpperEmail);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const emailLookup = allItems.find(
                item => item.PutRequest?.Item?.SK !== 'PROFILE'
            );
            expect(emailLookup?.PutRequest?.Item?.PK).toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('succeeds with 24 identifiers (new contact) — no longer limited by transaction size', async () => {
            const contact24: Contact = { ...ALICE, identifiers: makeIdentifiers(24) };
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            expect(backend.putContact(contact24)).resolves.toBeUndefined();

            // Should have issued BatchWriteCommand calls (24 lookups + 1 profile = 25 items, split into batches)
            expect(ddbMock.commandCalls(BatchWriteCommand).length).toBeGreaterThanOrEqual(1);
        });

        test('succeeds with 25 identifiers (new contact) — exceeds old transaction limit but fine for BatchWrite', async () => {
            const contact25: Contact = { ...ALICE, identifiers: makeIdentifiers(25) };
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            expect(backend.putContact(contact25)).resolves.toBeUndefined();

            // 25 lookups + 1 profile = 26 items → needs 2 BatchWrite calls
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ======================================================================
    // putContact — update existing contact
    // ======================================================================
    describe('putContact (update existing contact)', () => {
        test('issues Delete only for removed identifiers when adding a new one', async () => {
            // Existing contact has 2 identifiers; new one adds a 3rd (email + discord unchanged)
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            const updatedAlice: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'discord', value: 'alice#1234' },
                    { platform: 'bsky', value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(updatedAlice);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );

            // email + discord unchanged (no delete/put for them); bsky is new (1 put);
            // + 1 profile put = 2 total. No deletes.
            expect(allItems).toHaveLength(2);

            const deletes = allItems.filter(item => item.DeleteRequest !== undefined);
            expect(deletes).toHaveLength(0);

            const puts = allItems.filter(item => item.PutRequest !== undefined);
            expect(puts).toHaveLength(2);
        });

        test('issues no extra operations when identifiers are unchanged', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            // Same identifiers as ALICE, only notes changed
            await backend.putContact({ ...ALICE, updatedAt: '2026-02-01T00:00:00.000Z' });

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );

            // Only the profile put — no deletes, no lookup puts
            expect(allItems).toHaveLength(1);
            const deletes = allItems.filter(item => item.DeleteRequest !== undefined);
            expect(deletes).toHaveLength(0);
        });

        test('issues Delete for removed identifier and Put for added identifier', async () => {
            // Existing: [email, discord]. New: [email, bsky]. discord removed, bsky added, email unchanged.
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            const partialUpdate: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email',   value: 'alice@example.com' },
                    { platform: 'bsky',    value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(partialUpdate);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );

            // 1 put (bsky lookup) + 1 profile put + 1 delete (discord) = 3 total; email is unchanged
            expect(allItems).toHaveLength(3);

            const deletes = allItems.filter(item => item.DeleteRequest !== undefined);
            expect(deletes).toHaveLength(1);
            expect(deletes[0]?.DeleteRequest?.Key).toEqual({
                PK: 'CONTACT_LOOKUP#discord#alice#1234',
                SK: 'CONTACT#alice-smith',
            });

            const lookupPuts = allItems.filter(
                item => item.PutRequest !== undefined && item.PutRequest.Item?.SK !== 'PROFILE'
            );
            expect(lookupPuts).toHaveLength(1);
            expect(lookupPuts[0]?.PutRequest?.Item).toMatchObject({
                PK:       'CONTACT_LOOKUP#bsky#alice.bsky.social',
                SK:       'CONTACT#alice-smith',
                personId: 'alice-smith',
            });
        });

        test('new lookup row is written before profile row (ordering invariant)', async () => {
            // Existing: [email]. New: [email, bsky]. bsky added, email unchanged.
            ddbMock.on(GetCommand).resolves(contactGetResponse({ ...ALICE, identifiers: [{ platform: 'email', value: 'alice@example.com' }] }));
            ddbMock.on(BatchWriteCommand).resolves({});

            const updated: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(updated);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            // First BatchWrite call must be the new lookup (bsky), not the profile
            const firstBatchItems = bwCalls[0]?.args[0].input.RequestItems?.TestTable ?? [];
            expect(firstBatchItems).toHaveLength(1);
            expect(firstBatchItems[0]?.PutRequest?.Item?.PK).toBe('CONTACT_LOOKUP#bsky#alice.bsky.social');
        });

        test('old lookup row is deleted after profile row (ordering invariant)', async () => {
            // Existing: [email, discord]. New: [email]. discord removed.
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            const emailOnly: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
                updatedAt:   '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(emailOnly);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            // With no new lookups: first batch = profile; second batch = delete(discord)
            expect(bwCalls.length).toBeGreaterThanOrEqual(2);

            // First call must be the profile put (no new lookups, so profile goes first)
            const firstBatchItems = bwCalls[0]?.args[0].input.RequestItems?.TestTable ?? [];
            expect(firstBatchItems[0]?.PutRequest?.Item?.SK).toBe('PROFILE');

            // Last call must contain the delete for discord
            const lastBatchItems = bwCalls[bwCalls.length - 1]?.args[0].input.RequestItems?.TestTable ?? [];
            const discordDelete = lastBatchItems.find(item => item.DeleteRequest?.Key?.PK === 'CONTACT_LOOKUP#discord#alice#1234');
            expect(discordDelete).toBeDefined();
        });

        test('delete items for removed lookups use correct keys', async () => {
            // Existing: [email, discord]. New: [email only]. discord is removed.
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            const emailOnly: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
                updatedAt:   '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(emailOnly);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const deletes = allItems.filter(item => item.DeleteRequest !== undefined);

            // Only discord should be deleted; email is unchanged
            expect(deletes).toHaveLength(1);
            expect(deletes[0]?.DeleteRequest?.Key).toEqual({
                PK: 'CONTACT_LOOKUP#discord#alice#1234',
                SK: 'CONTACT#alice-smith',
            });
        });

        test('treats identifier as unchanged when existing value has uppercase letters', async () => {
            // Existing: [email with uppercase value]. New: [same email lowercase] + [bsky].
            // The email identifier should be recognized as unchanged (case-insensitive comparison).
            const existingWithUpperEmail: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'ALICE@EXAMPLE.COM' }],
            };
            ddbMock.on(GetCommand).resolves(contactGetResponse(existingWithUpperEmail));
            ddbMock.on(BatchWriteCommand).resolves({});

            const newContact: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(newContact);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );

            // email is unchanged (case-insensitive match); only bsky is new → 1 profile + 1 bsky put
            expect(allItems).toHaveLength(2);
            const deletes = allItems.filter(item => item.DeleteRequest !== undefined);
            expect(deletes).toHaveLength(0);
        });

        test('treats identifier as unchanged when existing value has leading/trailing whitespace', async () => {
            // Existing: [email with surrounding whitespace]. New: [trimmed email] + [bsky].
            // The email identifier should be recognized as unchanged (trimmed comparison).
            const existingWithSpacedEmail: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: '  alice@example.com  ' }],
            };
            ddbMock.on(GetCommand).resolves(contactGetResponse(existingWithSpacedEmail));
            ddbMock.on(BatchWriteCommand).resolves({});

            const newContact: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(newContact);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );

            // email is unchanged (trimmed match); only bsky is new → 1 profile + 1 bsky put
            expect(allItems).toHaveLength(2);
            const deletes = allItems.filter(item => item.DeleteRequest !== undefined);
            expect(deletes).toHaveLength(0);
        });
    });

    // ======================================================================
    // putContact — batch splitting
    // ======================================================================
    describe('putContact (batch splitting)', () => {
        test('splits 24→24 replacement into multiple batches (would have failed under old TX limit)', async () => {
            // Old behavior: 24 deletes + 1 profile put + 24 new puts = 49 items → ValidationException
            // New behavior: batched, all succeed
            const oldContact: Contact = { ...ALICE, identifiers: makeIdentifiers(24) };
            const newContact: Contact = { ...ALICE, identifiers: makeIdentifiers(24).map((id, i) => ({
                ...id, value: `new${i}@example.com`,
            })) };

            ddbMock.on(GetCommand).resolves(contactGetResponse(oldContact));
            ddbMock.on(BatchWriteCommand).resolves({});

            expect(backend.putContact(newContact)).resolves.toBeUndefined();

            // 24 new lookups + 1 profile put + 24 deletes = 49 items → at least 2 batches
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(2);

            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            expect(allItems).toHaveLength(49);
        });

        test('each batch contains at most 25 items', async () => {
            const contact24: Contact = { ...ALICE, identifiers: makeIdentifiers(24) };
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(contact24);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            for(const call of bwCalls) {
                const items = call.args[0].input.RequestItems?.TestTable ?? [];
                expect(items.length).toBeLessThanOrEqual(25);
            }
        });
    });

    // ======================================================================
    // putContact — partial batch failure / UnprocessedItems retry with deps.sleep
    // ======================================================================
    describe('putContact (partial batch failure)', () => {
        test('propagates error when BatchWriteCommand throws', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).rejects(new Error('DynamoDB unavailable'));

            expect(backend.putContact(ALICE)).rejects.toThrow();
        });

        test('retries when BatchWriteCommand returns UnprocessedItems on first call — uses injected sleep', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            // First call returns unprocessed items; second call succeeds
            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [
                            { PutRequest: { Item: { PK: 'CONTACT#alice-smith', SK: 'PROFILE' } } },
                        ],
                    },
                })
                .resolves({});

            await backend.putContact(ALICE, { sleep: mockSleep });

            // Must have issued at least 2 BatchWriteCommand calls (original + retry)
            expect(ddbMock.commandCalls(BatchWriteCommand).length).toBeGreaterThanOrEqual(2);
            // Sleep must have been called for the retry backoff (100ms * 2^0 = 100ms)
            expect(mockSleep).toHaveBeenCalledWith(BATCH_WRITE_BASE_DELAY_MS);
        });

        test('throws after all retries exhausted if UnprocessedItems persist — uses injected sleep', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            // Always return unprocessed items — never succeeds
            ddbMock.on(BatchWriteCommand).resolves({
                UnprocessedItems: {
                    TestTable: [
                        { PutRequest: { Item: { PK: 'CONTACT#alice-smith', SK: 'PROFILE' } } },
                    ],
                },
            });

            expect(backend.putContact(ALICE, { sleep: mockSleep })).rejects.toThrow();
        });

        test('new lookup rows remain intact when profile write fails', async () => {
            // Scenario: new lookup writes (batch 1) succeed; profile write (batch 2) fails.
            // The new lookup rows should still be in DynamoDB — callers can detect the partial
            // failure and retry the profile write safely.
            ddbMock.on(GetCommand).resolves(notFound());

            let batchCallCount = 0;
            ddbMock.on(BatchWriteCommand).callsFake(async () => {
                batchCallCount++;
                if(batchCallCount === 1) {
                    // First call: new lookup rows batch — succeeds
                    return {};
                }
                // Second call: profile write — fails
                throw new Error('DynamoDB failure on profile write');
            });

            expect(backend.putContact(ALICE, { sleep: mockSleep })).rejects.toThrow('DynamoDB failure on profile write');

            // First BatchWrite call (lookup rows) must have succeeded
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(2);

            // First call items must be lookup rows (not profile)
            const firstCallItems = bwCalls[0]?.args[0].input.RequestItems?.TestTable ?? [];
            expect(firstCallItems.every(item => item.PutRequest?.Item?.SK !== 'PROFILE')).toBe(true);
        });

        test('profile and new lookup rows remain when delete-old-lookups batch fails', async () => {
            // Scenario: new lookup write succeeds, profile write succeeds, delete-old-lookups fails.
            // Profile + new identifiers remain intact — stale old lookup just orphaned temporarily.
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));

            // Update: replace discord with bsky; email unchanged
            const updated: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };

            let batchCallCount = 0;
            ddbMock.on(BatchWriteCommand).callsFake(async () => {
                batchCallCount++;
                if(batchCallCount === 1) {
                    // First call: new bsky lookup — succeeds
                    return {};
                }
                if(batchCallCount === 2) {
                    // Second call: profile put — succeeds
                    return {};
                }
                // Third call: delete old discord lookup — fails
                throw new Error('DynamoDB failure on delete');
            });

            expect(backend.putContact(updated, { sleep: mockSleep })).rejects.toThrow('DynamoDB failure on delete');

            // Verify the write ordering — calls 1 and 2 succeeded (new lookup + profile)
            expect(batchCallCount).toBeGreaterThanOrEqual(3);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            // First call: new bsky lookup put
            const firstItems = bwCalls[0]?.args[0].input.RequestItems?.TestTable ?? [];
            expect(firstItems[0]?.PutRequest?.Item?.PK).toBe('CONTACT_LOOKUP#bsky#alice.bsky.social');

            // Second call: profile put
            const secondItems = bwCalls[1]?.args[0].input.RequestItems?.TestTable ?? [];
            expect(secondItems[0]?.PutRequest?.Item?.SK).toBe('PROFILE');
        });
    });

    // ======================================================================
    // deleteContact
    // ======================================================================
    describe('deleteContact', () => {
        test('deletes profile first then all lookup items via BatchWriteCommand', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID);

            // Should NOT use TransactWriteCommand
            // Profile is deleted in first call, then 2 lookup items in another batch
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(1);

            // All requests should be DeleteRequest
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            expect(allItems.every(item => item.DeleteRequest !== undefined)).toBe(true);

            // 1 profile delete + 2 lookup deletes = 3 total
            expect(allItems).toHaveLength(3);
        });

        test('profile delete is issued first (first batch call deletes profile)', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            // First BatchWrite call must contain the profile delete
            const firstCallItems = bwCalls[0]?.args[0].input.RequestItems?.TestTable ?? [];
            const profileDelete = firstCallItems.find(item => item.DeleteRequest?.Key?.SK === 'PROFILE');
            expect(profileDelete?.DeleteRequest?.Key).toEqual({
                PK: 'CONTACT#alice-smith',
                SK: 'PROFILE',
            });
        });

        test('lookup deletes use correct keys', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const lookupDeletes = allItems.filter(item => item.DeleteRequest?.Key?.SK !== 'PROFILE');

            expect(lookupDeletes).toHaveLength(2);
            const keys = lookupDeletes.map(item => item.DeleteRequest?.Key?.PK as string);
            expect(keys).toContain('CONTACT_LOOKUP#email#alice@example.com');
            expect(keys).toContain('CONTACT_LOOKUP#discord#alice#1234');
        });

        test('throws ContactNotFoundError when contact does not exist', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            expect(backend.deleteContact(PERSON_ID)).rejects.toMatchObject({
                code:    ErrorCode.CONTACT_NOT_FOUND,
                context: { personId: PERSON_ID },
            });
        });

        test('throws with Error instance', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            expect(backend.deleteContact(PERSON_ID)).rejects.toBeInstanceOf(Error);
        });

        test('handles 30 identifiers across multiple batches', async () => {
            const bigContact: Contact = { ...ALICE, identifiers: makeIdentifiers(30) };
            ddbMock.on(GetCommand).resolves(contactGetResponse(bigContact));
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID);

            // 1 profile delete (batch 1) + 30 lookup deletes (needs 2 more batches of ≤25) = 3 BatchWrite calls
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(2);

            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            // 1 profile + 30 lookups = 31 total delete requests
            expect(allItems).toHaveLength(31);
            expect(allItems.every(item => item.DeleteRequest !== undefined)).toBe(true);

            // Each batch must be ≤25
            for(const call of bwCalls) {
                const items = call.args[0].input.RequestItems?.TestTable ?? [];
                expect(items.length).toBeLessThanOrEqual(25);
            }
        });

        test('accepts deps.sleep parameter and passes it to batchWriteWithRetry', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID, { sleep: mockSleep });

            // Sleep should not have been called when everything succeeds on first try
            expect(mockSleep).not.toHaveBeenCalled();
        });
    });

    // ======================================================================
    // resolveIdentifier
    // ======================================================================
    describe('resolveIdentifier', () => {
        test('returns contacts matching the identifier', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{ PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith' }],
            });
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));

            const result = await backend.resolveIdentifier('email', 'alice@example.com');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(ALICE);
        });

        test('normalizes value to lowercase for lookup', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.resolveIdentifier('email', 'ALICE@EXAMPLE.COM');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk'])
                .toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('trims whitespace from value for lookup', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.resolveIdentifier('email', '  alice@example.com  ');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk'])
                .toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('returns empty array when no matches', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.resolveIdentifier('email', 'nobody@example.com');

            expect(result).toEqual([]);
        });

        test('returns multiple contacts when multiple lookups match', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'CONTACT_LOOKUP#name#alice', SK: 'CONTACT#alice-smith' },
                    { PK: 'CONTACT_LOOKUP#name#alice', SK: 'CONTACT#alice-jones' },
                ],
            });
            // Return different contacts for different GetCommand calls
            const aliceJones: Contact = { ...BOB, personId: 'alice-jones' as ContactId, displayName: 'Alice Jones' };
            ddbMock.on(GetCommand)
                .resolvesOnce(contactGetResponse(ALICE))
                .resolvesOnce(contactGetResponse(aliceJones));

            const result = await backend.resolveIdentifier('name', 'alice');

            expect(result).toHaveLength(2);
        });

        test('skips missing contacts gracefully', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{ PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith' }],
            });
            // Contact has been deleted but lookup still exists
            ddbMock.on(GetCommand).resolves(notFound());

            const result = await backend.resolveIdentifier('email', 'alice@example.com');

            expect(result).toEqual([]);
        });
    });

    // ======================================================================
    // addIdentifier
    // ======================================================================
    describe('addIdentifier', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        test('adds identifier and saves updated contact', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-02-01T12:00:00.000Z'));

            await backend.addIdentifier(PERSON_ID, { platform: 'bsky', value: 'alice.bsky.social' });

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(1);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');

            expect(profilePut?.PutRequest?.Item?.identifiers).toEqual([
                { platform: 'email', value: 'alice@example.com' },
                { platform: 'discord', value: 'alice#1234' },
                { platform: 'bsky', value: 'alice.bsky.social' },
            ]);
            expect(profilePut?.PutRequest?.Item?.updatedAt).toBe('2026-02-01T12:00:00.000Z');
        });

        test('throws ContactNotFoundError when contact does not exist', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            expect(
                backend.addIdentifier(PERSON_ID, { platform: 'bsky', value: 'alice.bsky.social' })
            ).rejects.toMatchObject({
                code:    ErrorCode.CONTACT_NOT_FOUND,
                context: { personId: PERSON_ID },
            });
        });

        test('silently skips if identifier already exists (case-insensitive)', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));

            await backend.addIdentifier(PERSON_ID, { platform: 'email', value: 'Alice@Example.com' });

            // No BatchWriteCommand should be issued — the identifier already exists
            expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
        });
    });

    // ======================================================================
    // removeIdentifier
    // ======================================================================
    describe('removeIdentifier', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        test('removes matching identifier and saves updated contact', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-02-01T12:00:00.000Z'));

            await backend.removeIdentifier(PERSON_ID, 'discord', 'alice#1234');

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(1);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');

            expect(profilePut?.PutRequest?.Item?.identifiers).toEqual([
                { platform: 'email', value: 'alice@example.com' },
            ]);
        });

        test('matches identifier case-insensitively', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            // Remove 'alice@example.com' using uppercase
            await backend.removeIdentifier(PERSON_ID, 'email', 'ALICE@EXAMPLE.COM');

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');

            expect(profilePut?.PutRequest?.Item?.identifiers).toEqual([
                { platform: 'discord', value: 'alice#1234' },
            ]);
        });

        test('trims whitespace from value when matching identifier', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            // Value with leading/trailing whitespace should still match
            await backend.removeIdentifier(PERSON_ID, 'email', '  alice@example.com  ');

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');

            expect(profilePut?.PutRequest?.Item?.identifiers).toEqual([
                { platform: 'discord', value: 'alice#1234' },
            ]);
        });

        test('trims whitespace from stored identifier value when matching', async () => {
            const contactWithSpacedValue: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'name', value: '  Alice Smith  ' },
                    { platform: 'email', value: 'alice@example.com' },
                ],
            };
            ddbMock.on(GetCommand).resolves(contactGetResponse(contactWithSpacedValue));
            ddbMock.on(BatchWriteCommand).resolves({});

            // Remove the name identifier using trimmed value
            await backend.removeIdentifier(PERSON_ID, 'name', 'alice smith');

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');

            expect(profilePut?.PutRequest?.Item?.identifiers).toEqual([
                { platform: 'email', value: 'alice@example.com' },
            ]);
        });

        test('throws ContactNotFoundError when contact does not exist', async () => {
            ddbMock.on(GetCommand).resolves(notFound());

            expect(
                backend.removeIdentifier(PERSON_ID, 'email', 'alice@example.com')
            ).rejects.toMatchObject({
                code:    ErrorCode.CONTACT_NOT_FOUND,
                context: { personId: PERSON_ID },
            });
        });

        test('throws ContactLastIdentifierError when removing the only identifier', async () => {
            const singleIdentifier: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
            };
            ddbMock.on(GetCommand).resolves(contactGetResponse(singleIdentifier));

            expect(
                backend.removeIdentifier(PERSON_ID, 'email', 'alice@example.com')
            ).rejects.toMatchObject({
                code:    ErrorCode.CONTACT_LAST_IDENTIFIER,
                context: { personId: PERSON_ID },
            });
        });

        test('does not remove identifier if platform matches but value does not', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(BatchWriteCommand).resolves({});

            // Try to remove email with wrong value — both email identifiers remain
            await backend.removeIdentifier(PERSON_ID, 'email', 'wrong@example.com');

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');
            // Both identifiers remain
            expect(profilePut?.PutRequest?.Item?.identifiers).toHaveLength(2);
        });

        test('only removes identifier matching both platform and value', async () => {
            // Contact has same value on two platforms — only the targeted platform+value is removed
            const contactWithSameValue: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice' },
                    { platform: 'name',  value: 'alice' },
                ],
            };
            ddbMock.on(GetCommand).resolves(contactGetResponse(contactWithSameValue));
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.removeIdentifier(PERSON_ID, 'email', 'alice');

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profilePut = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');

            // Only the email identifier is removed; name identifier with same value stays
            expect(profilePut?.PutRequest?.Item?.identifiers).toEqual([
                { platform: 'name', value: 'alice' },
            ]);
        });
    });

    // ======================================================================
    // listContacts
    // ======================================================================
    describe('listContacts', () => {
        test('returns all contacts from GSI2 query', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    contactQueryItem(ALICE),
                    contactQueryItem(BOB),
                ],
            });

            const result = await backend.listContacts();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(ALICE);
            expect(result[1]).toEqual(BOB);
            // PK/SK/GSI2 keys must not be present on the returned Contact objects
            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('SK');
            expect(result[0]).not.toHaveProperty('GSI2PK');
            expect(result[0]).not.toHaveProperty('GSI2SK');
        });

        test('returns empty array when no contacts exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.listContacts();

            expect(result).toEqual([]);
        });

        test('uses GSI2 query with correct index and key condition', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listContacts();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.TableName).toBe('TestTable');
            expect(calls[0].args[0].input.IndexName).toBe('GSI2');
            expect(calls[0].args[0].input.KeyConditionExpression).toBe('GSI2PK = :pk');
            expect(calls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
                ':pk': 'CONTACTS',
            });
        });

        test('handles undefined Items gracefully', async () => {
            ddbMock.on(QueryCommand).resolves({});

            const result = await backend.listContacts();

            expect(result).toEqual([]);
        });

        test('handles paginated query results', async () => {
            ddbMock.on(QueryCommand)
                .resolvesOnce({
                    Items:            [contactQueryItem(ALICE)],
                    LastEvaluatedKey: { PK: 'CONTACT#alice-smith', SK: 'PROFILE', GSI2PK: 'CONTACTS', GSI2SK: 'CONTACT#alice-smith' },
                })
                .resolvesOnce({
                    Items: [contactQueryItem(BOB)],
                });

            const contacts = await backend.listContacts();

            expect(contacts).toHaveLength(2);
            expect(contacts[0]).toEqual(ALICE);
            expect(contacts[1]).toEqual(BOB);
            // Verify QueryCommand was called twice
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
            // Verify ExclusiveStartKey was passed on second call
            expect(ddbMock.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
                PK: 'CONTACT#alice-smith', SK: 'PROFILE', GSI2PK: 'CONTACTS', GSI2SK: 'CONTACT#alice-smith',
            });
        });

        test('single-page query with no LastEvaluatedKey calls QueryCommand once', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    contactQueryItem(ALICE),
                    contactQueryItem(BOB),
                ],
                // No LastEvaluatedKey — single page
            });

            const contacts = await backend.listContacts();

            expect(contacts).toHaveLength(2);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
        });

        test('first call passes no ExclusiveStartKey', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listContacts();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0]?.args[0].input.ExclusiveStartKey).toBeUndefined();
        });
    });

    // ======================================================================
    // fuzzyLookup
    // ======================================================================
    describe('fuzzyLookup', () => {
        beforeEach(() => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    contactQueryItem(ALICE),
                    contactQueryItem(BOB),
                ],
            });
        });

        test('returns exact match first', async () => {
            const result = await backend.fuzzyLookup('alice@example.com');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(ALICE);
        });

        test('matches displayName exactly', async () => {
            const result = await backend.fuzzyLookup('Alice Smith');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(ALICE);
        });

        test('case-insensitive matching', async () => {
            const result = await backend.fuzzyLookup('ALICE SMITH');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(ALICE);
        });

        test('returns prefix match when no exact match', async () => {
            const result = await backend.fuzzyLookup('alice');

            // alice is a prefix match on 'Alice Smith' and 'alice@example.com'
            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toEqual(ALICE);
        });

        test('returns substring match', async () => {
            const result = await backend.fuzzyLookup('smith');

            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toEqual(ALICE);
        });

        test('trims whitespace from query', async () => {
            const result = await backend.fuzzyLookup('  Alice Smith  ');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(ALICE);
        });

        test('returns empty array when nothing matches', async () => {
            const result = await backend.fuzzyLookup('nonexistent');

            expect(result).toEqual([]);
        });

        test('returns empty array when no contacts exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.fuzzyLookup('alice');

            expect(result).toEqual([]);
        });

        test('ranks exact matches above prefix matches', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    contactQueryItem({ ...ALICE, identifiers: [{ platform: 'name', value: 'alice' }] }),
                    contactQueryItem({ ...BOB,   identifiers: [{ platform: 'email', value: 'alice@example.com' }] }),
                ],
            });

            // 'alice' is exact on alice-smith name, prefix on bob's email
            const result = await backend.fuzzyLookup('alice');

            expect(result).toHaveLength(2);
            // Exact match must come first
            expect(result[0]?.personId).toBe('alice-smith' as ContactId);
        });

        test('ranks prefix matches above substring matches', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    contactQueryItem({ ...ALICE, displayName: 'the-alice-prefix',  identifiers: [{ platform: 'email', value: 'notmatching@example.com' }] }),
                    contactQueryItem({ ...BOB,   displayName: 'Alice Starts Here', identifiers: [{ platform: 'email', value: 'bob@example.com' }] }),
                ],
            });

            const result = await backend.fuzzyLookup('alice');

            expect(result).toHaveLength(2);
            // Prefix match must come first (bob has display name starting with 'alice')
            expect(result[0]?.personId).toBe('bob-jones' as ContactId);
            expect(result[1]?.personId).toBe('alice-smith' as ContactId);
        });
    });

    // ======================================================================
    // Fix 1: createdAt written to lookup rows
    // ======================================================================
    describe('Fix 1: lookup rows include createdAt', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        test('lookup items written by putContact include a createdAt ISO timestamp', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const lookupItems = allItems.filter(
                item => item.PutRequest?.Item?.SK !== 'PROFILE'
            );

            // Every lookup item must have exactly the frozen timestamp
            for(const item of lookupItems) {
                expect(item.PutRequest?.Item?.createdAt).toBe('2026-05-01T12:00:00.000Z');
            }
        });

        test('profile item written by putContact does NOT receive a createdAt from the lookup path', async () => {
            // Profile createdAt comes from the Contact object, not the lookup writer
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const profileItem = allItems.find(item => item.PutRequest?.Item?.SK === 'PROFILE');
            // Profile createdAt must equal the Contact's createdAt (passed through), not a fresh timestamp
            expect(profileItem?.PutRequest?.Item?.createdAt).toBe(ALICE.createdAt);
        });

        test('createdAt round-trips through persistence: written value is the frozen timestamp', async () => {
            // Regression test: write a lookup via putContact with a fixed fake clock.
            // Verify the exact createdAt value flows through the BatchWrite payload.
            // The frozen timestamp also confirms the row would be "young" relative to real time
            // (i.e., a freshly written row's stamp is a recent ISO string under fake clock).
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(BatchWriteCommand).resolves({});

            await backend.putContact(ALICE);

            // Extract the written createdAt timestamp from the email lookup item
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(
                call => call.args[0].input.RequestItems?.TestTable ?? []
            );
            const emailLookupItem = allItems.find(item =>
                item.PutRequest?.Item?.SK !== 'PROFILE'
                && (item.PutRequest?.Item?.PK as string | undefined)?.includes('email')
            );

            // Exact match: fake clock ensures deterministic output
            expect(emailLookupItem?.PutRequest?.Item?.createdAt).toBe('2026-05-01T12:00:00.000Z');
        });
    });
});
