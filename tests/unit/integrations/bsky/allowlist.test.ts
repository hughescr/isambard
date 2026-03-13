import { describe, test, expect, beforeEach } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    UpdateCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { BskyAllowlist, type BskyAllowlistEntry } from '@/integrations/bsky/allowlist';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE_NAME = 'test-table';

beforeEach(() => {
    ddbMock.reset();
});

describe('BskyAllowlist.load()', () => {
    test('populates handle cache from INDEX item', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:      'BSKY#ALLOWLIST',
                SK:      'INDEX',
                handles: new Set(['alice.bsky.social', 'bob.bsky.social']),
            },
        });
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('alice.bsky.social')).toBe(true);
        expect(allowlist.isAllowed('bob.bsky.social')).toBe(true);
        expect(allowlist.isAllowed('charlie.bsky.social')).toBe(false);
    });

    test('populates DID cache from HANDLE# query results', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     'did:plc:abc123',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#bob.bsky.social',
                    handle:  'bob.bsky.social',
                    did:     'did:plc:def456',
                    addedAt: '2026-01-02T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('did:plc:abc123')).toBe(true);
        expect(allowlist.isAllowed('did:plc:def456')).toBe(true);
        expect(allowlist.isAllowed('did:plc:unknown')).toBe(false);
    });

    test('handles missing INDEX item (empty handle cache)', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
        // Verify the empty fallback creates an empty cache (no phantom entries)
        expect(allowlist.isAllowed('stryker was here')).toBe(false);
    });

    test('handles INDEX item with absent handles field', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK: 'BSKY#ALLOWLIST',
                SK: 'INDEX',
                // handles field absent
            },
        });
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        // All handles must be absent — including possible Stryker mutations
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
        expect(allowlist.isAllowed('Stryker was here')).toBe(false);
    });

    test('handles HANDLE# items with no DID field', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    // no did field
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('did:plc:anything')).toBe(false);
    });

    test('excludes HANDLE# items with empty-string DID from didCache', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     '',  // empty string — must be excluded from didCache
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        // Empty-string DID must NOT be treated as a valid cache entry
        expect(allowlist.isAllowed('')).toBe(false);
        expect(allowlist.isAllowed('did:plc:anything')).toBe(false);
    });

    test('sends GetCommand with correct PK/SK key for INDEX', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        const getCalls = ddbMock.commandCalls(GetCommand);
        expect(getCalls).toHaveLength(1);
        expect(getCalls[0]?.args[0].input).toMatchObject({
            TableName: TABLE_NAME,
            Key:       { PK: 'BSKY#ALLOWLIST', SK: 'INDEX' },
        });
    });

    test('sends QueryCommand to load HANDLE# items for DID cache', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls).toHaveLength(1);
        expect(queryCalls[0]?.args[0].input).toMatchObject({
            TableName:                 TABLE_NAME,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     'BSKY#ALLOWLIST',
                ':prefix': 'HANDLE#',
            },
        });
    });
});

describe('BskyAllowlist.isAllowed()', () => {
    test('returns false for unknown handle before load', () => {
        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        expect(allowlist.isAllowed('unknown.bsky.social')).toBe(false);
    });

    test('normalizes handle (case and trim) before checking', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:      'BSKY#ALLOWLIST',
                SK:      'INDEX',
                handles: new Set(['alice.bsky.social']),
            },
        });
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('  ALICE.BSKY.SOCIAL  ')).toBe(true);
        expect(allowlist.isAllowed('Alice.Bsky.Social')).toBe(true);
    });

    test('matches by DID (case-sensitive, no normalization)', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     'did:plc:Abc123',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        // DIDs are case-sensitive
        expect(allowlist.isAllowed('did:plc:Abc123')).toBe(true);
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(false);
    });

    test('returns false when neither handle nor DID matches', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:      'BSKY#ALLOWLIST',
                SK:      'INDEX',
                handles: new Set(['alice.bsky.social']),
            },
        });
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     'did:plc:abc123',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('bob.bsky.social')).toBe(false);
        expect(allowlist.isAllowed('did:plc:unknown')).toBe(false);
    });
});

describe('BskyAllowlist.addEntry()', () => {
    test('sends PutCommand and UpdateCommand, updates handle cache', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const entry: BskyAllowlistEntry = {
            handle:  'alice.bsky.social',
            notes:   'Test user',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        };

        await allowlist.addEntry(entry);

        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls).toHaveLength(1);
        expect(putCalls[0]?.args[0].input).toMatchObject({
            TableName: TABLE_NAME,
            Item:      {
                PK:      'BSKY#ALLOWLIST',
                SK:      'HANDLE#alice.bsky.social',
                handle:  'alice.bsky.social',
                notes:   'Test user',
                addedAt: '2026-01-01T00:00:00Z',
                addedBy: 'admin',
            },
        });

        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0]?.args[0].input).toMatchObject({
            TableName:                TABLE_NAME,
            Key:                      { PK: 'BSKY#ALLOWLIST', SK: 'INDEX' },
            UpdateExpression:         'ADD #handles :newHandle',
            ExpressionAttributeNames: { '#handles': 'handles' },
        });
        expect(updateCalls[0]?.args[0].input.ExpressionAttributeValues?.[':newHandle']).toEqual(
            new Set(['alice.bsky.social'])
        );

        expect(allowlist.isAllowed('alice.bsky.social')).toBe(true);
    });

    test('with DID — stores DID in metadata and updates didCache', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const entry: BskyAllowlistEntry = {
            handle:  'alice.bsky.social',
            did:     'did:plc:abc123',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        };

        await allowlist.addEntry(entry);

        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls[0]?.args[0].input.Item?.did).toBe('did:plc:abc123');

        // DID cache should be updated
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(true);
    });

    test('without DID — didCache not polluted', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        await allowlist.addEntry({
            handle:  'alice.bsky.social',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });

        // 'undefined' should NOT appear as a valid DID
        expect(allowlist.isAllowed('undefined')).toBe(false);
    });

    test('with empty-string DID — didCache not polluted', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        await allowlist.addEntry({
            handle:  'alice.bsky.social',
            did:     '',   // empty string — must not be added to didCache
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });

        // Empty string must NOT be treated as a valid DID cache entry
        expect(allowlist.isAllowed('')).toBe(false);
    });

    test('normalizes handle before storing', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        await allowlist.addEntry({
            handle:  '  ALICE.BSKY.SOCIAL  ',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });

        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls[0]?.args[0].input.Item?.handle).toBe('alice.bsky.social');
        expect(putCalls[0]?.args[0].input.Item?.SK).toBe('HANDLE#alice.bsky.social');
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(true);
    });
});

describe('BskyAllowlist.removeEntry()', () => {
    test('sends GetCommand, DeleteCommand and UpdateCommand, updates caches', async () => {
        ddbMock.on(GetCommand)
            .resolvesOnce({
                Item: {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'INDEX',
                    handles: new Set(['alice.bsky.social', 'bob.bsky.social']),
                },
            })
            .resolvesOnce({
                Item: {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     'did:plc:abc123',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            });
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     'did:plc:abc123',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(true);
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(true);

        await allowlist.removeEntry('alice.bsky.social');

        const deleteCalls = ddbMock.commandCalls(DeleteCommand);
        expect(deleteCalls).toHaveLength(1);
        expect(deleteCalls[0]?.args[0].input).toMatchObject({
            TableName: TABLE_NAME,
            Key:       { PK: 'BSKY#ALLOWLIST', SK: 'HANDLE#alice.bsky.social' },
        });

        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0]?.args[0].input).toMatchObject({
            TableName:                TABLE_NAME,
            Key:                      { PK: 'BSKY#ALLOWLIST', SK: 'INDEX' },
            UpdateExpression:         'DELETE #handles :oldHandle',
            ExpressionAttributeNames: { '#handles': 'handles' },
        });
        expect(updateCalls[0]?.args[0].input.ExpressionAttributeValues?.[':oldHandle']).toEqual(
            new Set(['alice.bsky.social'])
        );

        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(false);
        expect(allowlist.isAllowed('bob.bsky.social')).toBe(true);
    });

    test('normalizes handle before removing', async () => {
        ddbMock.on(GetCommand)
            .resolvesOnce({
                Item: {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'INDEX',
                    handles: new Set(['alice.bsky.social']),
                },
            })
            .resolvesOnce({
                Item: {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            });
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        await allowlist.removeEntry('  ALICE.BSKY.SOCIAL  ');

        const deleteCalls = ddbMock.commandCalls(DeleteCommand);
        expect(deleteCalls[0]?.args[0].input.Key?.SK).toBe('HANDLE#alice.bsky.social');
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
    });

    test('sends GetCommand with correct PK/SK to fetch DID before deleting', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:      'BSKY#ALLOWLIST',
                SK:      'HANDLE#alice.bsky.social',
                handle:  'alice.bsky.social',
                did:     'did:plc:abc123',
                addedAt: '2026-01-01T00:00:00Z',
                addedBy: 'admin',
            },
        });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        await allowlist.removeEntry('alice.bsky.social');

        const getCalls = ddbMock.commandCalls(GetCommand);
        expect(getCalls).toHaveLength(1);
        expect(getCalls[0]?.args[0].input).toMatchObject({
            TableName: TABLE_NAME,
            Key:       { PK: 'BSKY#ALLOWLIST', SK: 'HANDLE#alice.bsky.social' },
        });
    });

    test('removes entry with empty-string DID (didCache cleanup skips empty DID)', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:      'BSKY#ALLOWLIST',
                SK:      'HANDLE#alice.bsky.social',
                handle:  'alice.bsky.social',
                did:     '',   // empty string — must not be treated as valid DID
                addedAt: '2026-01-01T00:00:00Z',
                addedBy: 'admin',
            },
        });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        // Should not throw even with empty-string DID
        await allowlist.removeEntry('alice.bsky.social');
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
    });

    test('removes entry with no DID (cache cleanup skips DID)', async () => {
        ddbMock.on(GetCommand)
            .resolvesOnce({
                Item: {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'INDEX',
                    handles: new Set(['alice.bsky.social']),
                },
            })
            .resolvesOnce({
                Item: {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    // no did field
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
            });
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        await allowlist.removeEntry('alice.bsky.social');

        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
        // Should not have thrown — DID-less removal is fine
    });
});

describe('BskyAllowlist.list()', () => {
    test('queries all HANDLE items and maps to BskyAllowlistEntry[]', async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#alice.bsky.social',
                    handle:  'alice.bsky.social',
                    did:     'did:plc:abc123',
                    notes:   'Test user',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
                {
                    PK:      'BSKY#ALLOWLIST',
                    SK:      'HANDLE#bob.bsky.social',
                    handle:  'bob.bsky.social',
                    addedAt: '2026-01-02T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const result = await allowlist.list();

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            handle:  'alice.bsky.social',
            did:     'did:plc:abc123',
            notes:   'Test user',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });
        expect(result[1]).toEqual({
            handle:  'bob.bsky.social',
            did:     undefined,
            notes:   undefined,
            addedAt: '2026-01-02T00:00:00Z',
            addedBy: 'admin',
        });

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls).toHaveLength(1);
        expect(queryCalls[0]?.args[0].input).toMatchObject({
            TableName:                 TABLE_NAME,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: {
                ':pk':     'BSKY#ALLOWLIST',
                ':prefix': 'HANDLE#',
            },
        });
    });

    test('returns empty array when no entries', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const result = await allowlist.list();

        expect(result).toEqual([]);
    });
});

describe('Cache consistency', () => {
    test('after addEntry, isAllowed returns true; after removeEntry, returns false', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:      'BSKY#ALLOWLIST',
                SK:      'HANDLE#alice.bsky.social',
                handle:  'alice.bsky.social',
                did:     'did:plc:abc123',
                addedAt: '2026-01-01T00:00:00Z',
                addedBy: 'admin',
            },
        });
        ddbMock.on(DeleteCommand).resolves({});

        const allowlist = new BskyAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(false);

        await allowlist.addEntry({
            handle:  'alice.bsky.social',
            did:     'did:plc:abc123',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(true);
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(true);

        await allowlist.removeEntry('alice.bsky.social');
        expect(allowlist.isAllowed('alice.bsky.social')).toBe(false);
        expect(allowlist.isAllowed('did:plc:abc123')).toBe(false);
    });
});
