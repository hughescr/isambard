import { describe, test, expect, beforeEach } from 'bun:test';
import {
    DynamoDBDocumentClient,
    QueryCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import {
    queryOldEntries,
    deleteOldEntries,
    buildLookupMap
} from '@/scripts/migrate-allowlist';
import { createContactId, type Contact } from '@/storage/contacts';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE_NAME = 'test-table';

beforeEach(() => {
    ddbMock.reset();
});

// ─── queryOldEntries ──────────────────────────────────────────────────────────

describe('queryOldEntries', () => {
    test('queries DynamoDB with correct PK and SK prefix', async () => {
        ddbMock.on(QueryCommand, {
            TableName:                 TABLE_NAME,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: { ':pk': 'EMAIL#ALLOWLIST', ':prefix': 'ADDR#' },
        }).resolves({
            Items: [
                { PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com', email: 'alice@example.com' },
                { PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#bob@example.com', email: 'bob@example.com' },
            ],
        });

        const docClient = DynamoDBDocumentClient.from({} as never);
        const items = await queryOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', 'ADDR#');

        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ email: 'alice@example.com' });
        expect(items[1]).toMatchObject({ email: 'bob@example.com' });
    });

    test('returns empty array when no items found', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const docClient = DynamoDBDocumentClient.from({} as never);
        const items = await queryOldEntries(docClient, TABLE_NAME, 'BSKY#ALLOWLIST', 'HANDLE#');

        expect(items).toHaveLength(0);
    });

    test('returns empty array when Items is undefined', async () => {
        ddbMock.on(QueryCommand).resolves({});

        const docClient = DynamoDBDocumentClient.from({} as never);
        const items = await queryOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', 'ADDR#');

        expect(items).toHaveLength(0);
    });

    test('paginates when LastEvaluatedKey is returned across multiple pages', async () => {
        ddbMock
            .on(QueryCommand, {
                TableName:                 TABLE_NAME,
                ExpressionAttributeValues: { ':pk': 'EMAIL#ALLOWLIST', ':prefix': 'ADDR#' },
            })
            .resolvesOnce({
                Items:            [{ PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com', email: 'alice@example.com' }],
                LastEvaluatedKey: { PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com' },
            })
            .resolvesOnce({
                Items:            [{ PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#bob@example.com', email: 'bob@example.com' }],
                LastEvaluatedKey: undefined,
            });

        const docClient = DynamoDBDocumentClient.from({} as never);
        const items = await queryOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', 'ADDR#');

        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ email: 'alice@example.com' });
        expect(items[1]).toMatchObject({ email: 'bob@example.com' });
        // Second call should include ExclusiveStartKey
        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls).toHaveLength(2);
        expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual({ PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com' });
    });

    test('queries BSKY#ALLOWLIST with HANDLE# prefix', async () => {
        ddbMock.on(QueryCommand, {
            TableName:                 TABLE_NAME,
            KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: { ':pk': 'BSKY#ALLOWLIST', ':prefix': 'HANDLE#' },
        }).resolves({
            Items: [
                { PK: 'BSKY#ALLOWLIST', SK: 'HANDLE#alice.bsky.social', handle: 'alice.bsky.social' },
            ],
        });

        const docClient = DynamoDBDocumentClient.from({} as never);
        const items = await queryOldEntries(docClient, TABLE_NAME, 'BSKY#ALLOWLIST', 'HANDLE#');

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ handle: 'alice.bsky.social' });
    });
});

// ─── deleteOldEntries ─────────────────────────────────────────────────────────

describe('deleteOldEntries', () => {
    test('deletes each entry item and the INDEX item', async () => {
        ddbMock.on(DeleteCommand).resolves({});

        const docClient = DynamoDBDocumentClient.from({} as never);
        const entries = [
            { PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com', email: 'alice@example.com' },
            { PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#bob@example.com', email: 'bob@example.com' },
        ];

        await deleteOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', entries);

        const calls = ddbMock.commandCalls(DeleteCommand);
        // 2 entries + 1 INDEX = 3 deletes
        expect(calls).toHaveLength(3);

        const deletedKeys = calls.map(call => call.args[0].input.Key);
        expect(deletedKeys).toContainEqual({ PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#alice@example.com' });
        expect(deletedKeys).toContainEqual({ PK: 'EMAIL#ALLOWLIST', SK: 'ADDR#bob@example.com' });
        expect(deletedKeys).toContainEqual({ PK: 'EMAIL#ALLOWLIST', SK: 'INDEX' });
    });

    test('deletes only the INDEX item when entries is empty', async () => {
        ddbMock.on(DeleteCommand).resolves({});

        const docClient = DynamoDBDocumentClient.from({} as never);
        await deleteOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', []);

        const calls = ddbMock.commandCalls(DeleteCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.Key).toEqual({ PK: 'EMAIL#ALLOWLIST', SK: 'INDEX' });
    });

    test('deletes BSKY#ALLOWLIST INDEX when provided', async () => {
        ddbMock.on(DeleteCommand).resolves({});

        const docClient = DynamoDBDocumentClient.from({} as never);
        const entries = [
            { PK: 'BSKY#ALLOWLIST', SK: 'HANDLE#alice.bsky.social', handle: 'alice.bsky.social' },
        ];

        await deleteOldEntries(docClient, TABLE_NAME, 'BSKY#ALLOWLIST', entries);

        const calls = ddbMock.commandCalls(DeleteCommand);
        expect(calls).toHaveLength(2);

        const deletedKeys = calls.map(call => call.args[0].input.Key);
        expect(deletedKeys).toContainEqual({ PK: 'BSKY#ALLOWLIST', SK: 'HANDLE#alice.bsky.social' });
        expect(deletedKeys).toContainEqual({ PK: 'BSKY#ALLOWLIST', SK: 'INDEX' });
    });
});

// ─── buildLookupMap ───────────────────────────────────────────────────────────

describe('buildLookupMap', () => {
    test('builds lookup map from contacts with email and bsky identifiers', () => {
        const aliceId = createContactId('alice-smith');
        const bobId = createContactId('bob-jones');

        const contacts: Contact[] = [
            {
                personId:    aliceId,
                displayName: 'Alice Smith',
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky', value: 'alice.bsky.social' },
                ],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
                personId:    bobId,
                displayName: 'Bob Jones',
                identifiers: [
                    { platform: 'email', value: 'Bob@Example.Com' },
                ],
                createdAt: '2026-01-02T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
            },
        ];

        const map = buildLookupMap(contacts);

        expect(map.get('email#alice@example.com')).toBe(aliceId);
        expect(map.get('bsky#alice.bsky.social')).toBe(aliceId);
        expect(map.get('email#bob@example.com')).toBe(bobId);
    });

    test('normalizes identifier values to lowercase+trimmed', () => {
        const aliceId = createContactId('alice');
        const contacts: Contact[] = [
            {
                personId:    aliceId,
                displayName: 'Alice',
                identifiers: [{ platform: 'email', value: '  ALICE@EXAMPLE.COM  ' }],
                createdAt:   '2026-01-01T00:00:00.000Z',
                updatedAt:   '2026-01-01T00:00:00.000Z',
            },
        ];

        const map = buildLookupMap(contacts);

        expect(map.get('email#alice@example.com')).toBe(aliceId);
        expect(map.has('email#  ALICE@EXAMPLE.COM  ')).toBe(false);
    });

    test('returns empty map when no contacts provided', () => {
        const map = buildLookupMap([]);
        expect(map.size).toBe(0);
    });

    test('includes discord and name identifiers too', () => {
        const aliceId = createContactId('alice');
        const contacts: Contact[] = [
            {
                personId:    aliceId,
                displayName: 'Alice',
                identifiers: [
                    { platform: 'name', value: 'Alice Smith' },
                    { platform: 'discord', value: 'alice#1234' },
                ],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        ];

        const map = buildLookupMap(contacts);

        expect(map.get('name#alice smith')).toBe(aliceId);
        expect(map.get('discord#alice#1234')).toBe(aliceId);
    });
});

// ─── Integration: migration handles empty allowlists gracefully ───────────────

describe('migration with empty allowlists', () => {
    test('queryOldEntries + deleteOldEntries handles empty state without errors', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        ddbMock.on(DeleteCommand).resolves({});

        const docClient = DynamoDBDocumentClient.from({} as never);

        const emailEntries = await queryOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', 'ADDR#');
        const bskyEntries = await queryOldEntries(docClient, TABLE_NAME, 'BSKY#ALLOWLIST', 'HANDLE#');

        expect(emailEntries).toHaveLength(0);
        expect(bskyEntries).toHaveLength(0);

        // Should not throw when deleting empty lists
        await deleteOldEntries(docClient, TABLE_NAME, 'EMAIL#ALLOWLIST', emailEntries);
        await deleteOldEntries(docClient, TABLE_NAME, 'BSKY#ALLOWLIST', bskyEntries);

        // 2 INDEX deletes (one per platform)
        const calls = ddbMock.commandCalls(DeleteCommand);
        expect(calls).toHaveLength(2);
    });
});
