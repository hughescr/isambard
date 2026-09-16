import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    TransactWriteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../setup';
import { type ContactBackend, createContactId, type Contact } from '@/storage/contacts';
import { PersonAllowlist } from '@/storage/person-allowlist';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE_NAME = 'test-table';

function makeContact(personId: string, identifiers: { platform: string, value: string }[], internal?: Contact['_internal']): Contact {
    return {
        personId:    createContactId(personId),
        displayName: personId,
        identifiers: identifiers as Contact['identifiers'],
        _internal:   internal,
        createdAt:   '2025-01-01T00:00:00.000Z',
        updatedAt:   '2025-01-01T00:00:00.000Z',
    };
}

const ALICE_ID   = createContactId('alice-smith');
const BOB_ID     = createContactId('bob-jones');
const CHARLIE_ID = createContactId('charlie-brown');

const ALICE_CONTACT = makeContact('alice-smith', [
    { platform: 'email', value: 'alice@example.com' },
    { platform: 'bsky', value: '@alice.bsky.social' },
]);

const BOB_CONTACT = makeContact('bob-jones', [
    { platform: 'email', value: 'bob@example.com' },
]);

let mockBackend: ContactBackend;

beforeEach(() => {
    ddbMock.reset();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockBackend = {
        getContact: mock(async (_id: unknown) => undefined as Contact | undefined),
    } as unknown as ContactBackend;
});

function makeAllowlist(): PersonAllowlist {
    return new PersonAllowlist(
        DynamoDBDocumentClient.from({} as never),
        TABLE_NAME,
        mockBackend
    );
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void } {
    let release!: (value: T) => void;
    let fail!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        release = resolve;
        fail = reject;
    });
    return { promise, resolve: release, reject: fail };
}

// ─── load() ──────────────────────────────────────────────────────────────────

describe('PersonAllowlist.load()', () => {
    test('normalizes identifiers without collapsing distinct German sharp-s spellings', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { personIds: new Set([ALICE_ID]) } });
        (mockBackend.getContact as ReturnType<typeof mock>).mockResolvedValue(
            makeContact(ALICE_ID, [{ platform: 'email', value: 'straße@example.com' }])
        );
        const allowlist = makeAllowlist();
        await allowlist.load();
        expect(allowlist.isAllowed('email', 'Straße@example.com')).toBe(true);
        expect(allowlist.isAllowed('email', 'STRASSE@example.com')).toBe(false);
    });
    test('bounds contact reads while allowing queued reads to start as slots free', async () => {
        const ids = Array.from({ length: 10 }, (_, index) => createContactId(`person-${index}`));
        const gates = new Map(ids.map(id => [id, deferred<Contact | undefined>()]));
        const started: string[] = [];
        let active = 0;
        let maximumActive = 0;
        ddbMock.on(GetCommand).resolves({ Item: { personIds: new Set(ids) } });
        (mockBackend.getContact as ReturnType<typeof mock>).mockImplementation((id: string) => {
            started.push(id);
            active++;
            maximumActive = Math.max(maximumActive, active);
            const gate = gates.get(createContactId(id));
            if(!gate) {
                throw new Error(`Missing gate for ${id}`);
            }
            return gate.promise.finally(() => {
                active--;
            });
        });

        const loading = makeAllowlist().load();
        await Bun.sleep(0);
        expect(started).toEqual(ids.slice(0, 8));
        expect(maximumActive).toBe(8);

        gates.get(ids[0])?.resolve(makeContact(ids[0], []));
        await Bun.sleep(0);
        expect(started).toEqual(ids.slice(0, 9));
        gates.get(ids[1])?.resolve(makeContact(ids[1], []));
        await Bun.sleep(0);
        expect(started).toEqual(ids);

        for(const id of ids.slice(2)) {
            gates.get(id)?.resolve(makeContact(id, []));
        }
        await loading;
        expect(maximumActive).toBe(8);
    });

    test('publishes contacts in INDEX order despite reverse completion, preserving last-wins collisions', async () => {
        const alice = deferred<Contact | undefined>();
        const bob = deferred<Contact | undefined>();
        ddbMock.on(GetCommand).resolves({ Item: { personIds: new Set([ALICE_ID, BOB_ID]) } });
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>).mockImplementation((id: string) => {
            return id === ALICE_ID ? alice.promise : bob.promise;
        });

        const allowlist = makeAllowlist();
        const loading = allowlist.load();
        await Bun.sleep(0);
        bob.resolve(makeContact(BOB_ID, [{ platform: 'email', value: 'shared@example.com' }]));
        await Bun.sleep(0);
        expect(allowlist.isAllowed('email', 'shared@example.com')).toBe(false);

        alice.resolve(makeContact(ALICE_ID, [{ platform: 'email', value: 'shared@example.com' }]));
        await loading;
        await allowlist.removePerson(ALICE_ID);
        expect(allowlist.isAllowed('email', 'shared@example.com')).toBe(true);
    });

    test('reports invalid and orphaned entries in INDEX order despite reverse read completion', async () => {
        const alice = deferred<Contact | undefined>();
        const bob = deferred<Contact | undefined>();
        const charlie = deferred<Contact | undefined>();
        ddbMock.on(GetCommand).resolves({ Item: { personIds: new Set([ALICE_ID, 'INVALID ID!!!', BOB_ID, CHARLIE_ID]) } });
        (mockBackend.getContact as ReturnType<typeof mock>).mockImplementation((id: string) => {
            if(id === ALICE_ID) {
                return alice.promise;
            }
            if(id === BOB_ID) {
                return bob.promise;
            }
            return charlie.promise;
        });

        const loading = makeAllowlist().load();
        await Bun.sleep(0);
        charlie.resolve(undefined);
        bob.resolve(undefined);
        alice.resolve(ALICE_CONTACT);
        await loading;

        expect(mockLogger.warn.mock.calls.map(([fields]) => fields)).toMatchObject([
            { personIdStr: 'INVALID ID!!!', msg: 'PersonAllowlist: invalid personId format in INDEX — skipping' },
            { personId: BOB_ID, msg: 'PersonAllowlist: orphaned personId — no contact found, skipping' },
            { personId: CHARLIE_ID, msg: 'PersonAllowlist: orphaned personId — no contact found, skipping' },
        ]);
        expect(mockBackend.getContact).toHaveBeenCalledTimes(3);
    });

    test('publishes only the successful prefix and drains held later reads before the first INDEX-order failure returns', async () => {
        const alice = deferred<Contact | undefined>();
        const bob = deferred<Contact | undefined>();
        const charlie = deferred<Contact | undefined>();
        const dave = deferred<Contact | undefined>();
        const daveId = createContactId('dave-person');
        ddbMock.on(GetCommand).resolves({ Item: { personIds: new Set([ALICE_ID, BOB_ID, CHARLIE_ID, daveId, 'INVALID ID!!!']) } });
        (mockBackend.getContact as ReturnType<typeof mock>).mockImplementation((id: string) => {
            if(id === ALICE_ID) {
                return alice.promise;
            }
            if(id === BOB_ID) {
                return bob.promise;
            }
            if(id === CHARLIE_ID) {
                return charlie.promise;
            }
            return dave.promise;
        });

        const allowlist = makeAllowlist();
        let settled = false;
        const loading = allowlist.load()
            .then(() => {
                settled = true;
                return undefined;
            })
            .catch((error: unknown) => {
                settled = true;
                return error;
            });
        await Bun.sleep(0);
        dave.reject(new Error('later failure'));
        alice.resolve(ALICE_CONTACT);
        await Bun.sleep(0);
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(settled).toBe(false);

        const firstFailure = new Error('first INDEX-order failure');
        bob.reject(firstFailure);
        await Bun.sleep(0);
        expect(settled).toBe(false);
        charlie.resolve(makeContact(CHARLIE_ID, [{ platform: 'email', value: 'charlie@example.com' }]));
        expect(await loading).toBe(firstFailure);
        expect(allowlist.isAllowed('email', 'charlie@example.com')).toBe(false);
        expect(mockLogger.warn).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({ msg: 'PersonAllowlist loaded' }));
    });

    test('loads personIds from INDEX and builds reverse map from contacts', async () => {
        ddbMock.on(GetCommand, {
            TableName: TABLE_NAME,
            Key:       { PK: 'PERSON#ALLOWLIST', SK: 'INDEX' },
        }).resolves({
            Item: { personIds: new Set([ALICE_ID, BOB_ID]) },
        });

        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockImplementation(async (id: unknown) => {
                if(id === ALICE_ID) {
                    return ALICE_CONTACT;
                }
                if(id === BOB_ID) {
                    return BOB_CONTACT;
                }
                return undefined;
            });

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(true);
        expect(allowlist.isPersonAllowed(BOB_ID)).toBe(true);
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(true);
        expect(allowlist.isAllowed('email', 'bob@example.com')).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith({
            count: 2,
            msg:   'PersonAllowlist loaded',
        });
    });

    test('handles empty INDEX — personIds and reverseMap both empty', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(false);
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
    });

    test('handles INDEX item with empty personIds field', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { PK: 'PERSON#ALLOWLIST', SK: 'INDEX' },
        });

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(false);
    });

    test('logs warning and skips when INDEX contains an invalid personId format', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID, 'INVALID ID!!!']) },
        });

        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockImplementation(async (id: unknown) => {
                if(id === ALICE_ID) {
                    return ALICE_CONTACT;
                }
                return undefined;
            });

        const allowlist = makeAllowlist();
        // Should not throw even with invalid personId
        await allowlist.load();

        // Alice is still loaded
        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(true);
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        // The getContact mock should only be called for ALICE_ID (invalid entry is skipped before getContact)
        const getContactCalls = (mockBackend.getContact as ReturnType<typeof mock>).mock.calls;
        const calledIds = getContactCalls.map(([id]) => id);
        expect(calledIds).not.toContain('INVALID ID!!!');
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            personIdStr: 'INVALID ID!!!',
        }));
    });

    test('logs warning and skips when contact not found for a personId (orphaned entry)', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID, 'orphaned-person']) },
        });

        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockImplementation(async (id: unknown) => {
                if(id === ALICE_ID) {
                    return ALICE_CONTACT;
                }
                return undefined;
            });

        const allowlist = makeAllowlist();
        // Should not throw even with orphaned personId
        await allowlist.load();

        // Alice is still loaded
        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(true);
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            personId: createContactId('orphaned-person'),
        }));
    });
});

// ─── isAllowed() ─────────────────────────────────────────────────────────────

describe('PersonAllowlist.isAllowed()', () => {
    test.each([
        ['returns true when identifier maps to an allowed person', 'email', 'alice@example.com', true],
        ['returns false for unknown identifier', 'email', 'unknown@example.com', false],
        ['does not index a discord identifier when _internal.discordUserId is absent', 'discord', '481231231231231234', false],
    ] as const)('%s', async (_name, platform, identifier, expected) => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed(platform, identifier)).toBe(expected);
    });

    test('returns false before load() is called (empty cache)', () => {
        const allowlist = makeAllowlist();
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
    });

    test('is case-insensitive (normalizes input)', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed('email', 'ALICE@EXAMPLE.COM')).toBe(true);
        expect(allowlist.isAllowed('email', '  alice@example.com  ')).toBe(true);
    });

    test('works for different platforms (email and bsky)', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(true);
        // Wrong platform for this value
        expect(allowlist.isAllowed('discord', 'alice@example.com')).toBe(false);
    });

    test('matches a Discord snowflake user id against _internal.discordUserId', async () => {
        const daveContact = makeContact('dave-jones', [
            { platform: 'discord', value: 'dave#1234' },
        ], { discordUserId: '481231231231231234' });

        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockImplementation(async (id: unknown) => (id === ALICE_ID ? daveContact : undefined));

        const allowlist = makeAllowlist();
        await allowlist.load();

        // Both the username identifier and the internal snowflake id resolve under 'discord'
        expect(allowlist.isAllowed('discord', 'dave#1234')).toBe(true);
        expect(allowlist.isAllowed('discord', '481231231231231234')).toBe(true);
        expect(allowlist.isAllowed('discord', '000000000000000000')).toBe(false);
    });
});

// ─── isPersonAllowed() ───────────────────────────────────────────────────────

describe('PersonAllowlist.isPersonAllowed()', () => {
    test('returns true for an allowed personId', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(true);
    });

    test('returns false for a non-allowed personId', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isPersonAllowed(BOB_ID)).toBe(false);
    });
});

// ─── addPerson() ─────────────────────────────────────────────────────────────

describe('PersonAllowlist.addPerson()', () => {
    test('writes DynamoDB items (TransactWriteCommand) and updates in-memory state', async () => {
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.addPerson(ALICE_ID, { addedBy: 'outbound-approval' });

        const txCalls = ddbMock.commandCalls(TransactWriteCommand);
        expect(txCalls).toHaveLength(1);
        const transactItems = (txCalls[0]?.args[0].input.TransactItems) ?? [];
        expect(transactItems).toHaveLength(2);

        // First item: Put the person entry
        expect(transactItems[0]).toMatchObject({
            Put: {
                TableName: TABLE_NAME,
                Item:      {
                    PK:       'PERSON#ALLOWLIST',
                    SK:       `PERSON#${ALICE_ID}`,
                    personId: ALICE_ID,
                    addedBy:  'outbound-approval',
                },
            },
        });
        expect((transactItems[0] as { Put: { Item: Record<string, unknown> } }).Put.Item.addedAt).toBeDefined();

        // Second item: Update the INDEX StringSet
        expect(transactItems[1]).toMatchObject({
            Update: {
                TableName:                 TABLE_NAME,
                Key:                       { PK: 'PERSON#ALLOWLIST', SK: 'INDEX' },
                UpdateExpression:          'ADD #personIds :newId',
                ExpressionAttributeNames:  { '#personIds': 'personIds' },
                ExpressionAttributeValues: { ':newId': new Set([ALICE_ID]) },
            },
        });
        expect([...(transactItems[1]?.Update?.ExpressionAttributeValues?.[':newId'] as Set<string>)]).toEqual([ALICE_ID]);

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
            personId: ALICE_ID,
            msg:      'PersonAllowlist: person added',
        }));
    });

    test('after addPerson, isAllowed returns true for that person\'s identifiers', async () => {
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.addPerson(ALICE_ID, { addedBy: 'outbound-approval', notes: 'trusted' });

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(true);
    });

    test('handles case where contact not found — still adds to personIds set', async () => {
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(undefined);

        const allowlist = makeAllowlist();
        await allowlist.addPerson(ALICE_ID, { addedBy: 'discord-command' });

        // personIds updated even though contact not found
        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(true);
        // reverseMap has no entries (contact not found)
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
    });

    test('after addPerson, isAllowed returns true for that person\'s _internal.discordUserId', async () => {
        const daveContact = makeContact('dave-jones', [
            { platform: 'email', value: 'dave@example.com' },
        ], { discordUserId: '481231231231231234' });
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(daveContact);

        const allowlist = makeAllowlist();
        await allowlist.addPerson(createContactId('dave-jones'), { addedBy: 'outbound-approval' });

        expect(allowlist.isAllowed('discord', '481231231231231234')).toBe(true);
    });
});

// ─── removePerson() ──────────────────────────────────────────────────────────

describe('PersonAllowlist.removePerson()', () => {
    test('deletes DynamoDB items atomically (TransactWriteCommand) and updates in-memory state', async () => {
        // Load with Alice allowed
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);
        ddbMock.on(TransactWriteCommand).resolves({});

        const allowlist = makeAllowlist();
        await allowlist.load();

        await allowlist.removePerson(ALICE_ID);

        const txCalls = ddbMock.commandCalls(TransactWriteCommand);
        expect(txCalls).toHaveLength(1);
        const transactItems = (txCalls[0]?.args[0].input.TransactItems) ?? [];
        expect(transactItems).toHaveLength(2);

        // First item: Delete the person entry
        expect(transactItems[0]).toMatchObject({
            Delete: {
                TableName: TABLE_NAME,
                Key:       { PK: 'PERSON#ALLOWLIST', SK: `PERSON#${ALICE_ID}` },
            },
        });

        // Second item: Update the INDEX StringSet
        expect(transactItems[1]).toMatchObject({
            Update: {
                TableName:                 TABLE_NAME,
                Key:                       { PK: 'PERSON#ALLOWLIST', SK: 'INDEX' },
                UpdateExpression:          'DELETE #personIds :oldId',
                ExpressionAttributeNames:  { '#personIds': 'personIds' },
                ExpressionAttributeValues: { ':oldId': new Set([ALICE_ID]) },
            },
        });
        expect([...(transactItems[1]?.Update?.ExpressionAttributeValues?.[':oldId'] as Set<string>)]).toEqual([ALICE_ID]);

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(false);
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
            personId: ALICE_ID,
            msg:      'PersonAllowlist: person removed',
        }));
    });

    test('after removePerson, isAllowed returns false for that person\'s identifiers', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);
        ddbMock.on(TransactWriteCommand).resolves({});

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);

        await allowlist.removePerson(ALICE_ID);

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(false);
    });

    test('purges all reverse map entries for that person', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID, BOB_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockImplementation(async (id: unknown) => {
                if(id === ALICE_ID) {
                    return ALICE_CONTACT;
                }
                if(id === BOB_ID) {
                    return BOB_CONTACT;
                }
                return undefined;
            });
        ddbMock.on(TransactWriteCommand).resolves({});

        const allowlist = makeAllowlist();
        await allowlist.load();

        await allowlist.removePerson(ALICE_ID);

        // Alice's entries purged
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(false);
        // Bob's entry still present
        expect(allowlist.isAllowed('email', 'bob@example.com')).toBe(true);
    });

    test('does not retain removed identifiers when the person is added again', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { personIds: new Set([ALICE_ID]) } });
        (mockBackend.getContact as ReturnType<typeof mock>).mockResolvedValue(ALICE_CONTACT);
        ddbMock.on(TransactWriteCommand).resolves({});

        const allowlist = makeAllowlist();
        await allowlist.load();
        await allowlist.removePerson(ALICE_ID);

        (mockBackend.getContact as ReturnType<typeof mock>).mockResolvedValue(makeContact('alice-smith', [
            { platform: 'email', value: 'new-alice@example.com' },
        ]));
        await allowlist.addPerson(ALICE_ID, { addedBy: 'test' });

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
        expect(allowlist.isAllowed('email', 'new-alice@example.com')).toBe(true);
    });
});

// ─── refreshPerson() ─────────────────────────────────────────────────────────

describe('PersonAllowlist.refreshPerson()', () => {
    test('rebuilds reverse map for an allowed person (e.g., after identifier added)', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        // Initial load: Alice has only email
        const aliceInitial = makeContact('alice-smith', [
            { platform: 'email', value: 'alice@example.com' },
        ]);
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(aliceInitial);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(false);

        // Now Alice has bsky identifier added
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        await allowlist.refreshPerson(ALICE_ID);

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(true);
    });

    test('does nothing for a non-allowed person', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        // refreshPerson on a non-allowed person should not throw or add entries
        await allowlist.refreshPerson(ALICE_ID);

        expect(allowlist.isPersonAllowed(ALICE_ID)).toBe(false);
        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(false);
    });

    test('does not call getContact for a non-allowed person', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        const allowlist = makeAllowlist();
        await allowlist.load();

        const getContactMock = mockBackend.getContact as ReturnType<typeof mock>;
        getContactMock.mockClear();

        // ALICE_ID is not in personIds (empty load), so getContact should NOT be called
        await allowlist.refreshPerson(ALICE_ID);

        expect(getContactMock).not.toHaveBeenCalled();
    });

    test('handles removed identifiers — old entry purged, new entry absent', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        // Initial: Alice has email + bsky
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(true);

        // After refresh: Alice's bsky removed
        const aliceUpdated = makeContact('alice-smith', [
            { platform: 'email', value: 'alice@example.com' },
        ]);
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(aliceUpdated);

        await allowlist.refreshPerson(ALICE_ID);

        expect(allowlist.isAllowed('email', 'alice@example.com')).toBe(true);
        expect(allowlist.isAllowed('bsky', '@alice.bsky.social')).toBe(false);
    });

    test('picks up a newly-added _internal.discordUserId on refresh', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { personIds: new Set([ALICE_ID]) },
        });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.load();

        expect(allowlist.isAllowed('discord', '481231231231231234')).toBe(false);

        const aliceWithDiscordId = makeContact('alice-smith', ALICE_CONTACT.identifiers, { discordUserId: '481231231231231234' });
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(aliceWithDiscordId);

        await allowlist.refreshPerson(ALICE_ID);

        expect(allowlist.isAllowed('discord', '481231231231231234')).toBe(true);
    });
});

// ─── list() ──────────────────────────────────────────────────────────────────

describe('PersonAllowlist.list()', () => {
    test('returns parsed entries from DynamoDB query', async () => {
        const aliceEntry = {
            PK:       'PERSON#ALLOWLIST',
            SK:       `PERSON#${ALICE_ID}`,
            personId: ALICE_ID,
            notes:    'trusted partner',
            addedAt:  '2026-01-01T00:00:00.000Z',
            addedBy:  'discord-command',
        };
        const bobEntry = {
            PK:       'PERSON#ALLOWLIST',
            SK:       `PERSON#${BOB_ID}`,
            personId: BOB_ID,
            addedAt:  '2026-01-02T00:00:00.000Z',
            addedBy:  'outbound-approval',
        };

        ddbMock.on(QueryCommand, {
            TableName: TABLE_NAME,
        }).resolves({
            Items: [aliceEntry, bobEntry],
        });

        const allowlist = makeAllowlist();
        const entries = await allowlist.list();

        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
            personId: ALICE_ID,
            notes:    'trusted partner',
            addedAt:  '2026-01-01T00:00:00.000Z',
            addedBy:  'discord-command',
        });
        expect(entries[1]).toMatchObject({
            personId: BOB_ID,
            addedAt:  '2026-01-02T00:00:00.000Z',
            addedBy:  'outbound-approval',
        });
        // Bob has no notes — key should not be present on the object at all
        expect(entries[1]?.notes).toBeUndefined();
        expect('notes' in (entries[1] ?? {})).toBe(false);
    });

    test('uses correct QueryCommand key expression', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = makeAllowlist();
        await allowlist.list();

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls).toHaveLength(1);
        expect(queryCalls[0]?.args[0].input).toMatchObject({
            TableName:                 TABLE_NAME,
            KeyConditionExpression:    expect.stringContaining('begins_with') as string,
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: expect.objectContaining({
                ':pk': 'PERSON#ALLOWLIST',
            }) as Record<string, unknown>,
        });
    });

    test('paginates through multiple pages of results', async () => {
        const aliceEntry = {
            PK:       'PERSON#ALLOWLIST',
            SK:       `PERSON#${ALICE_ID}`,
            personId: ALICE_ID,
            addedAt:  '2026-01-01T00:00:00.000Z',
            addedBy:  'discord-command',
        };
        const bobEntry = {
            PK:       'PERSON#ALLOWLIST',
            SK:       `PERSON#${BOB_ID}`,
            personId: BOB_ID,
            addedAt:  '2026-01-02T00:00:00.000Z',
            addedBy:  'outbound-approval',
        };

        // First page returns Alice with a LastEvaluatedKey
        ddbMock.on(QueryCommand)
            .resolvesOnce({
                Items:            [aliceEntry],
                LastEvaluatedKey: { PK: 'PERSON#ALLOWLIST', SK: `PERSON#${ALICE_ID}` },
            })
            // Second page returns Bob with no LastEvaluatedKey
            .resolvesOnce({
                Items: [bobEntry],
            });

        const allowlist = makeAllowlist();
        const entries   = await allowlist.list();

        // Both pages combined
        expect(entries).toHaveLength(2);
        expect(entries[0]?.personId).toBe(ALICE_ID);
        expect(entries[1]?.personId).toBe(BOB_ID);

        // Two separate QueryCommand calls were made
        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls).toHaveLength(2);

        // Second call uses ExclusiveStartKey from first page
        expect(queryCalls[1]?.args[0].input.ExclusiveStartKey).toMatchObject({
            PK: 'PERSON#ALLOWLIST',
            SK: `PERSON#${ALICE_ID}`,
        });
    });

    test('skips a corrupt row (invalid personId) and returns remaining valid entries', async () => {
        const aliceEntry = {
            PK:       'PERSON#ALLOWLIST',
            SK:       `PERSON#${ALICE_ID}`,
            personId: ALICE_ID,
            addedAt:  '2026-01-01T00:00:00.000Z',
            addedBy:  'discord-command',
        };
        const corruptEntry = {
            PK:       'PERSON#ALLOWLIST',
            SK:       'PERSON#INVALID ID!!!',
            personId: 'INVALID ID!!!',
            addedAt:  '2026-01-02T00:00:00.000Z',
            addedBy:  'discord-command',
        };

        ddbMock.on(QueryCommand).resolves({
            Items: [aliceEntry, corruptEntry],
        });

        const allowlist = makeAllowlist();
        // Should not throw
        const entries = await allowlist.list();

        // Valid row is returned
        expect(entries).toHaveLength(1);
        expect(entries[0]?.personId).toBe(ALICE_ID);

        // Corrupt row is omitted and a warning is logged
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        const [warnArg] = mockLogger.warn.mock.calls[0] as [Record<string, unknown>];
        expect(warnArg.personIdStr).toBe('INVALID ID!!!');
        expect(warnArg.msg).toContain('invalid personId format in row');
    });

    test('skips all corrupt rows and returns empty array when every row is corrupt', async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [
                { PK: 'PERSON#ALLOWLIST', SK: 'PERSON#BAD1', personId: 'BAD VALUE!!!', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'discord-command' },
                { PK: 'PERSON#ALLOWLIST', SK: 'PERSON#BAD2', personId: '',             addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'discord-command' },
            ],
        });

        const allowlist = makeAllowlist();
        const entries = await allowlist.list();

        expect(entries).toHaveLength(0);
        expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
});

// ─── addPerson() notes field ──────────────────────────────────────────────────

describe('PersonAllowlist.addPerson() notes', () => {
    test('includes notes when provided', async () => {
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.addPerson(ALICE_ID, { notes: 'approved via email', addedBy: 'outbound-approval' });

        const txCalls = ddbMock.commandCalls(TransactWriteCommand);
        const putItem = (txCalls[0]?.args[0].input.TransactItems![0] as { Put: { Item: Record<string, unknown> } }).Put.Item;
        expect(putItem.notes).toBe('approved via email');
    });

    test('omits notes when not provided', async () => {
        ddbMock.on(TransactWriteCommand).resolves({});
        (mockBackend.getContact as ReturnType<typeof mock>)
            .mockResolvedValue(ALICE_CONTACT);

        const allowlist = makeAllowlist();
        await allowlist.addPerson(CHARLIE_ID, { addedBy: 'discord-command' });

        const txCalls = ddbMock.commandCalls(TransactWriteCommand);
        const putItem = (txCalls[0]?.args[0].input.TransactItems![0] as { Put: { Item: Record<string, unknown> } }).Put.Item;
        // notes key must be absent entirely — not just undefined — to avoid spurious DynamoDB null attribute
        expect('notes' in putItem).toBe(false);
    });
});
