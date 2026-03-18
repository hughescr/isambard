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
import { EmailAllowlist } from '@/integrations/email/allowlist';
import type { AllowlistEntry } from '@/integrations/email/types';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE_NAME = 'test-table';

beforeEach(() => {
    ddbMock.reset();
});

describe('EmailAllowlist.load()', () => {
    test('populates cache from INDEX item', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:        'EMAIL#ALLOWLIST',
                SK:        'INDEX',
                addresses: new Set(['alice@example.com', 'bob@example.com']),
            },
        });

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('alice@example.com')).toBe(true);
        expect(allowlist.isAllowed('bob@example.com')).toBe(true);
        expect(allowlist.isAllowed('charlie@example.com')).toBe(false);
    });

    test('handles missing INDEX item (empty cache)', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('alice@example.com')).toBe(false);
        // Verify the empty fallback creates an empty cache (no phantom entries)
        expect(allowlist.isAllowed('stryker was here')).toBe(false);
    });

    test('sends GetCommand with correct PK/SK key', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        const getCalls = ddbMock.commandCalls(GetCommand);
        expect(getCalls).toHaveLength(1);
        expect(getCalls[0]?.args[0].input).toMatchObject({
            TableName: TABLE_NAME,
            Key:       { PK: 'EMAIL#ALLOWLIST', SK: 'INDEX' },
        });
    });

    test('handles INDEX item with empty addresses field', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK: 'EMAIL#ALLOWLIST',
                SK: 'INDEX',
                // addresses field absent
            },
        });

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        // All emails must be absent — including possible Stryker mutations
        expect(allowlist.isAllowed('alice@example.com')).toBe(false);
        expect(allowlist.isAllowed('Stryker was here')).toBe(false);
    });
});

describe('EmailAllowlist.isAllowed()', () => {
    test('returns false for unknown email before load', () => {
        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        expect(allowlist.isAllowed('unknown@example.com')).toBe(false);
    });

    test('normalizes email (case and trim) before checking', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:        'EMAIL#ALLOWLIST',
                SK:        'INDEX',
                addresses: new Set(['alice@example.com']),
            },
        });

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        expect(allowlist.isAllowed('  ALICE@EXAMPLE.COM  ')).toBe(true);
        expect(allowlist.isAllowed('Alice@Example.Com')).toBe(true);
    });
});

describe('EmailAllowlist.addEntry()', () => {
    test('sends PutCommand and UpdateCommand, updates cache', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const entry: AllowlistEntry = {
            email:   'alice@example.com',
            name:    'Alice',
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
                PK:      'EMAIL#ALLOWLIST',
                SK:      'ADDR#alice@example.com',
                email:   'alice@example.com',
                name:    'Alice',
                notes:   'Test user',
                addedAt: '2026-01-01T00:00:00Z',
                addedBy: 'admin',
            },
        });

        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0]?.args[0].input).toMatchObject({
            TableName:                TABLE_NAME,
            Key:                      { PK: 'EMAIL#ALLOWLIST', SK: 'INDEX' },
            UpdateExpression:         'ADD #addresses :newKey',
            ExpressionAttributeNames: { '#addresses': 'addresses' },
        });
        expect(updateCalls[0]?.args[0].input.ExpressionAttributeValues?.[':newKey']).toEqual(
            new Set(['alice@example.com'])
        );

        expect(allowlist.isAllowed('alice@example.com')).toBe(true);
    });

    test('normalizes email before storing', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const entry: AllowlistEntry = {
            email:   '  ALICE@EXAMPLE.COM  ',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        };

        await allowlist.addEntry(entry);

        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls[0]?.args[0].input.Item?.email).toBe('alice@example.com');
        expect(putCalls[0]?.args[0].input.Item?.SK).toBe('ADDR#alice@example.com');
        expect(allowlist.isAllowed('alice@example.com')).toBe(true);
    });
});

describe('EmailAllowlist.removeEntry()', () => {
    test('sends DeleteCommand and UpdateCommand, updates cache', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:        'EMAIL#ALLOWLIST',
                SK:        'INDEX',
                addresses: new Set(['alice@example.com', 'bob@example.com']),
            },
        });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();
        expect(allowlist.isAllowed('alice@example.com')).toBe(true);

        await allowlist.removeEntry('alice@example.com');

        const deleteCalls = ddbMock.commandCalls(DeleteCommand);
        expect(deleteCalls).toHaveLength(1);
        expect(deleteCalls[0]?.args[0].input).toMatchObject({
            TableName: TABLE_NAME,
            Key:       { PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com' },
        });

        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0]?.args[0].input).toMatchObject({
            TableName:                TABLE_NAME,
            Key:                      { PK: 'EMAIL#ALLOWLIST', SK: 'INDEX' },
            UpdateExpression:         'DELETE #addresses :oldKey',
            ExpressionAttributeNames: { '#addresses': 'addresses' },
        });
        expect(updateCalls[0]?.args[0].input.ExpressionAttributeValues?.[':oldKey']).toEqual(
            new Set(['alice@example.com'])
        );

        expect(allowlist.isAllowed('alice@example.com')).toBe(false);
        expect(allowlist.isAllowed('bob@example.com')).toBe(true);
    });

    test('normalizes email before removing', async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                PK:        'EMAIL#ALLOWLIST',
                SK:        'INDEX',
                addresses: new Set(['alice@example.com']),
            },
        });
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );
        await allowlist.load();

        await allowlist.removeEntry('  ALICE@EXAMPLE.COM  ');

        const deleteCalls = ddbMock.commandCalls(DeleteCommand);
        expect(deleteCalls[0]?.args[0].input.Key?.SK).toBe('ADDR#alice@example.com');
        expect(allowlist.isAllowed('alice@example.com')).toBe(false);
    });
});

describe('EmailAllowlist.list()', () => {
    test('queries all ADDR items and maps to AllowlistEntry[]', async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [
                {
                    PK:      'EMAIL#ALLOWLIST',
                    SK:      'ADDR#alice@example.com',
                    email:   'alice@example.com',
                    name:    'Alice',
                    notes:   'Test user',
                    addedAt: '2026-01-01T00:00:00Z',
                    addedBy: 'admin',
                },
                {
                    PK:      'EMAIL#ALLOWLIST',
                    SK:      'ADDR#bob@example.com',
                    email:   'bob@example.com',
                    addedAt: '2026-01-02T00:00:00Z',
                    addedBy: 'admin',
                },
            ],
        });

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        const result = await allowlist.list();

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            email:   'alice@example.com',
            name:    'Alice',
            notes:   'Test user',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });
        expect(result[1]).toEqual({
            email:   'bob@example.com',
            name:    undefined,
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
                ':pk':     'EMAIL#ALLOWLIST',
                ':prefix': 'ADDR#',
            },
        });
    });

    test('returns empty array when no entries', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const allowlist = new EmailAllowlist(
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
        ddbMock.on(DeleteCommand).resolves({});

        const allowlist = new EmailAllowlist(
            DynamoDBDocumentClient.from({} as never),
            TABLE_NAME
        );

        expect(allowlist.isAllowed('alice@example.com')).toBe(false);

        await allowlist.addEntry({
            email:   'alice@example.com',
            addedAt: '2026-01-01T00:00:00Z',
            addedBy: 'admin',
        });
        expect(allowlist.isAllowed('alice@example.com')).toBe(true);

        await allowlist.removeEntry('alice@example.com');
        expect(allowlist.isAllowed('alice@example.com')).toBe(false);
    });
});
