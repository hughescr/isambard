import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    ScanCommand,
    TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { ErrorCode } from '@/errors';
import { ContactBackend } from '@/storage/contacts/backend';
import {
    type Contact,
    type ContactId
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
            PK: `CONTACT#${contact.personId}`,
            SK: 'PROFILE',
            ...contact,
        },
    };
}

/** Helper: build an "empty" DynamoDB GetItem response */
function notFound(): Record<string, never> {
    return {};
}

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
        jest.useRealTimers();
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
    // putContact — new contact
    // ======================================================================
    describe('putContact (new contact)', () => {
        test('issues TransactWriteCommand with profile and lookup items', async () => {
            // First GetCommand returns not-found (new contact, no old lookups to delete)
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            expect(txCalls).toHaveLength(1);
            const items = txCalls[0].args[0].input.TransactItems!;

            // 1 profile Put + 2 lookup Puts (for 2 identifiers)
            expect(items).toHaveLength(3);
        });

        test('writes profile item with correct PK/SK', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');
            expect(profilePut?.Put?.Item).toMatchObject({
                PK:          'CONTACT#alice-smith',
                SK:          'PROFILE',
                personId:    'alice-smith',
                displayName: 'Alice Smith',
            });
        });

        test('writes lookup items with correct PK/SK', async () => {
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.putContact(ALICE);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const lookupItems = items.filter(item => item.Put?.Item?.SK !== 'PROFILE');

            const emailLookup = lookupItems.find(
                item => (item.Put?.Item?.PK as string | undefined)?.includes('email')
            );
            expect(emailLookup?.Put?.Item).toMatchObject({
                PK:       'CONTACT_LOOKUP#email#alice@example.com',
                SK:       'CONTACT#alice-smith',
                personId: 'alice-smith',
            });

            const discordLookup = lookupItems.find(
                item => (item.Put?.Item?.PK as string | undefined)?.includes('discord')
            );
            expect(discordLookup?.Put?.Item).toMatchObject({
                PK:       'CONTACT_LOOKUP#discord#alice#1234',
                SK:       'CONTACT#alice-smith',
                personId: 'alice-smith',
            });
        });

        test('normalizes email to lowercase in lookup key', async () => {
            const contactWithUpperEmail: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'ALICE@EXAMPLE.COM' }],
            };
            ddbMock.on(GetCommand).resolves(notFound());
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.putContact(contactWithUpperEmail);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const emailLookup = items.find(
                item => item.Put?.Item?.SK !== 'PROFILE'
            );
            expect(emailLookup?.Put?.Item?.PK).toBe('CONTACT_LOOKUP#email#alice@example.com');
        });
    });

    // ======================================================================
    // putContact — update existing contact
    // ======================================================================
    describe('putContact (update existing contact)', () => {
        test('issues Delete only for removed identifiers when adding a new one', async () => {
            // Existing contact has 2 identifiers; new one adds a 3rd (email + discord unchanged)
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

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

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            expect(txCalls).toHaveLength(1);
            const items = txCalls[0].args[0].input.TransactItems!;

            // email + discord unchanged (no delete/put for them); bsky is new (1 put);
            // + 1 profile put = 2 total. No deletes.
            expect(items).toHaveLength(2);

            const deletes = items.filter(item => item.Delete !== undefined);
            expect(deletes).toHaveLength(0);

            const puts = items.filter(item => item.Put !== undefined);
            expect(puts).toHaveLength(2);
        });

        test('issues no extra operations when identifiers are unchanged', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            // Same identifiers as ALICE, only notes changed
            await backend.putContact({ ...ALICE, updatedAt: '2026-02-01T00:00:00.000Z' });

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;

            // Only the profile put — no deletes, no lookup puts
            expect(items).toHaveLength(1);
            const deletes = items.filter(item => item.Delete !== undefined);
            expect(deletes).toHaveLength(0);
        });

        test('issues Delete for removed identifier and Put for added identifier', async () => {
            // Existing: [email, discord]. New: [email, bsky]. discord removed, bsky added, email unchanged.
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            const partialUpdate: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email',   value: 'alice@example.com' },
                    { platform: 'bsky',    value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(partialUpdate);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            expect(txCalls).toHaveLength(1);
            const items = txCalls[0].args[0].input.TransactItems!;

            // 1 delete (discord) + 1 profile put + 1 put (bsky) = 3 total; email is unchanged
            expect(items).toHaveLength(3);

            const deletes = items.filter(item => item.Delete !== undefined);
            expect(deletes).toHaveLength(1);
            expect(deletes[0]?.Delete?.Key).toEqual({
                PK: 'CONTACT_LOOKUP#discord#alice#1234',
                SK: 'CONTACT#alice-smith',
            });

            const lookupPuts = items.filter(
                item => item.Put !== undefined && item.Put.Item?.SK !== 'PROFILE'
            );
            expect(lookupPuts).toHaveLength(1);
            expect(lookupPuts[0]?.Put?.Item).toMatchObject({
                PK:       'CONTACT_LOOKUP#bsky#alice.bsky.social',
                SK:       'CONTACT#alice-smith',
                personId: 'alice-smith',
            });
        });

        test('delete items for removed lookups use correct keys', async () => {
            // Existing: [email, discord]. New: [email only]. discord is removed.
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            const emailOnly: Contact = {
                ...ALICE,
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
                updatedAt:   '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(emailOnly);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const deletes = items.filter(item => item.Delete !== undefined);

            // Only discord should be deleted; email is unchanged
            expect(deletes).toHaveLength(1);
            expect(deletes[0]?.Delete?.Key).toEqual({
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
            ddbMock.on(TransactWriteCommand).resolves({});

            const newContact: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(newContact);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;

            // email is unchanged (case-insensitive match); only bsky is new → 1 profile + 1 bsky put
            expect(items).toHaveLength(2);
            const deletes = items.filter(item => item.Delete !== undefined);
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
            ddbMock.on(TransactWriteCommand).resolves({});

            const newContact: Contact = {
                ...ALICE,
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: 'alice.bsky.social' },
                ],
                updatedAt: '2026-02-01T00:00:00.000Z',
            };
            await backend.putContact(newContact);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;

            // email is unchanged (trimmed match); only bsky is new → 1 profile + 1 bsky put
            expect(items).toHaveLength(2);
            const deletes = items.filter(item => item.Delete !== undefined);
            expect(deletes).toHaveLength(0);
        });
    });

    // ======================================================================
    // deleteContact
    // ======================================================================
    describe('deleteContact', () => {
        test('deletes profile and all lookup items atomically', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            expect(txCalls).toHaveLength(1);
            const items = txCalls[0].args[0].input.TransactItems!;

            // 1 profile delete + 2 lookup deletes
            expect(items).toHaveLength(3);
            expect(items.every(item => item.Delete !== undefined)).toBe(true);
        });

        test('profile delete uses correct key', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.deleteContact(PERSON_ID);

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profileDelete = items.find(item => item.Delete?.Key?.SK === 'PROFILE');
            expect(profileDelete?.Delete?.Key).toEqual({
                PK: 'CONTACT#alice-smith',
                SK: 'PROFILE',
            });
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
    });

    // ======================================================================
    // resolveIdentifier
    // ======================================================================
    describe('resolveIdentifier', () => {
        test('returns contacts matching the identifier', async () => {
            // Query returns a lookup item — import QueryCommand dynamically (already mocked in setup)
            const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
            ddbMock.on(QueryCommand).resolves({
                Items: [{ PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith' }],
            });
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));

            const result = await backend.resolveIdentifier('email', 'alice@example.com');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(ALICE);
        });

        test('normalizes value to lowercase for lookup', async () => {
            const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.resolveIdentifier('email', 'ALICE@EXAMPLE.COM');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk'])
                .toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('trims whitespace from value for lookup', async () => {
            const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.resolveIdentifier('email', '  alice@example.com  ');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk'])
                .toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('returns empty array when no matches', async () => {
            const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.resolveIdentifier('email', 'nobody@example.com');

            expect(result).toEqual([]);
        });

        test('returns multiple contacts when multiple lookups match', async () => {
            const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
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
            const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
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
        test('adds identifier and saves updated contact', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-02-01T12:00:00.000Z'));

            await backend.addIdentifier(PERSON_ID, { platform: 'bsky', value: 'alice.bsky.social' });

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            expect(txCalls).toHaveLength(1);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');

            expect(profilePut?.Put?.Item?.identifiers).toEqual([
                { platform: 'email', value: 'alice@example.com' },
                { platform: 'discord', value: 'alice#1234' },
                { platform: 'bsky', value: 'alice.bsky.social' },
            ]);
            expect(profilePut?.Put?.Item?.updatedAt).toBe('2026-02-01T12:00:00.000Z');
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

            // No TransactWriteCommand should be issued — the identifier already exists
            expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
        });
    });

    // ======================================================================
    // removeIdentifier
    // ======================================================================
    describe('removeIdentifier', () => {
        test('removes matching identifier and saves updated contact', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-02-01T12:00:00.000Z'));

            await backend.removeIdentifier(PERSON_ID, 'discord', 'alice#1234');

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            expect(txCalls).toHaveLength(1);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');

            expect(profilePut?.Put?.Item?.identifiers).toEqual([
                { platform: 'email', value: 'alice@example.com' },
            ]);
        });

        test('matches identifier case-insensitively', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            // Remove 'alice@example.com' using uppercase
            await backend.removeIdentifier(PERSON_ID, 'email', 'ALICE@EXAMPLE.COM');

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');

            expect(profilePut?.Put?.Item?.identifiers).toEqual([
                { platform: 'discord', value: 'alice#1234' },
            ]);
        });

        test('trims whitespace from value when matching identifier', async () => {
            ddbMock.on(GetCommand).resolves(contactGetResponse(ALICE));
            ddbMock.on(TransactWriteCommand).resolves({});

            // Value with leading/trailing whitespace should still match
            await backend.removeIdentifier(PERSON_ID, 'email', '  alice@example.com  ');

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');

            expect(profilePut?.Put?.Item?.identifiers).toEqual([
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
            ddbMock.on(TransactWriteCommand).resolves({});

            // Remove the name identifier using trimmed value
            await backend.removeIdentifier(PERSON_ID, 'name', 'alice smith');

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');

            expect(profilePut?.Put?.Item?.identifiers).toEqual([
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
            ddbMock.on(TransactWriteCommand).resolves({});

            // Try to remove email with wrong value — both email identifiers remain
            await backend.removeIdentifier(PERSON_ID, 'email', 'wrong@example.com');

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');
            // Both identifiers remain
            expect(profilePut?.Put?.Item?.identifiers).toHaveLength(2);
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
            ddbMock.on(TransactWriteCommand).resolves({});

            await backend.removeIdentifier(PERSON_ID, 'email', 'alice');

            const txCalls = ddbMock.commandCalls(TransactWriteCommand);
            const items = txCalls[0].args[0].input.TransactItems!;
            const profilePut = items.find(item => item.Put?.Item?.SK === 'PROFILE');

            // Only the email identifier is removed; name identifier with same value stays
            expect(profilePut?.Put?.Item?.identifiers).toEqual([
                { platform: 'name', value: 'alice' },
            ]);
        });
    });

    // ======================================================================
    // listContacts
    // ======================================================================
    describe('listContacts', () => {
        test('returns all contacts from scan', async () => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { PK: 'CONTACT#alice-smith', SK: 'PROFILE', ...ALICE },
                    { PK: 'CONTACT#bob-jones',   SK: 'PROFILE', ...BOB },
                ],
            });

            const result = await backend.listContacts();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(ALICE);
            expect(result[1]).toEqual(BOB);
            // PK/SK must not be present
            expect(result[0]).not.toHaveProperty('PK');
            expect(result[0]).not.toHaveProperty('SK');
        });

        test('returns empty array when no contacts exist', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            const result = await backend.listContacts();

            expect(result).toEqual([]);
        });

        test('uses correct scan filter', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.listContacts();

            const calls = ddbMock.commandCalls(ScanCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.TableName).toBe('TestTable');
            expect(calls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
                ':pkPrefix': 'CONTACT#',
                ':sk':       'PROFILE',
            });
        });

        test('handles undefined Items gracefully', async () => {
            ddbMock.on(ScanCommand).resolves({});

            const result = await backend.listContacts();

            expect(result).toEqual([]);
        });

        test('handles paginated scan results', async () => {
            ddbMock.on(ScanCommand)
                .resolvesOnce({
                    Items:            [{ PK: 'CONTACT#alice-smith', SK: 'PROFILE', ...ALICE }],
                    LastEvaluatedKey: { PK: 'CONTACT#alice-smith', SK: 'PROFILE' },
                })
                .resolvesOnce({
                    Items: [{ PK: 'CONTACT#bob-jones', SK: 'PROFILE', ...BOB }],
                });

            const contacts = await backend.listContacts();

            expect(contacts).toHaveLength(2);
            expect(contacts[0]).toEqual(ALICE);
            expect(contacts[1]).toEqual(BOB);
            // Verify ScanCommand was called twice
            expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
            // Verify ExclusiveStartKey was passed on second call
            expect(ddbMock.commandCalls(ScanCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
                PK: 'CONTACT#alice-smith',
                SK: 'PROFILE',
            });
        });

        test('single-page scan with no LastEvaluatedKey calls ScanCommand once', async () => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { PK: 'CONTACT#alice-smith', SK: 'PROFILE', ...ALICE },
                    { PK: 'CONTACT#bob-jones',   SK: 'PROFILE', ...BOB },
                ],
                // No LastEvaluatedKey — single page
            });

            const contacts = await backend.listContacts();

            expect(contacts).toHaveLength(2);
            expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
        });

        test('first call passes no ExclusiveStartKey', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.listContacts();

            const calls = ddbMock.commandCalls(ScanCommand);
            expect(calls[0]?.args[0].input.ExclusiveStartKey).toBeUndefined();
        });
    });

    // ======================================================================
    // fuzzyLookup
    // ======================================================================
    describe('fuzzyLookup', () => {
        beforeEach(() => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { PK: 'CONTACT#alice-smith', SK: 'PROFILE', ...ALICE },
                    { PK: 'CONTACT#bob-jones',   SK: 'PROFILE', ...BOB },
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
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            const result = await backend.fuzzyLookup('alice');

            expect(result).toEqual([]);
        });

        test('ranks exact matches above prefix matches', async () => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    {
                        PK:          'CONTACT#alice-smith',
                        SK:          'PROFILE',
                        ...ALICE,
                        identifiers: [{ platform: 'name', value: 'alice' }],
                    },
                    {
                        PK:          'CONTACT#bob-jones',
                        SK:          'PROFILE',
                        ...BOB,
                        identifiers: [{ platform: 'email', value: 'alice@example.com' }],
                    },
                ],
            });

            // 'alice' is exact on alice-smith name, prefix on bob's email
            const result = await backend.fuzzyLookup('alice');

            expect(result).toHaveLength(2);
            // Exact match must come first
            expect(result[0]?.personId).toBe('alice-smith' as ContactId);
        });

        test('ranks prefix matches above substring matches', async () => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    {
                        PK:          'CONTACT#alice-smith',
                        SK:          'PROFILE',
                        ...ALICE,
                        displayName: 'the-alice-prefix',  // substring 'alice'
                        identifiers: [{ platform: 'email', value: 'notmatching@example.com' }],
                    },
                    {
                        PK:          'CONTACT#bob-jones',
                        SK:          'PROFILE',
                        ...BOB,
                        displayName: 'Alice Starts Here',  // prefix 'alice'
                        identifiers: [{ platform: 'email', value: 'bob@example.com' }],
                    },
                ],
            });

            const result = await backend.fuzzyLookup('alice');

            expect(result).toHaveLength(2);
            // Prefix match must come first (bob has display name starting with 'alice')
            expect(result[0]?.personId).toBe('bob-jones' as ContactId);
            expect(result[1]?.personId).toBe('alice-smith' as ContactId);
        });
    });
});
