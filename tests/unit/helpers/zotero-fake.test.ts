import { describe, expect, test } from 'bun:test';
import { FakeZoteroServer, LIBRARY, TEST_API_KEY } from '../../helpers/zotero-fake';

interface WriteResponse {
    successful: Record<string, unknown>
    failed:     Record<string, { code: number, message: string }>
}

async function createWithAccessDate(accessDate: unknown): Promise<WriteResponse> {
    const server = new FakeZoteroServer();
    const response = await server.fetch(`${LIBRARY}/items`, {
        method:  'POST',
        headers: { 'Zotero-API-Key': TEST_API_KEY, 'Content-Type': 'application/json', 'Zotero-Write-Token': 'a'.repeat(32) },
        body:    JSON.stringify([{ itemType: 'document', title: 'T', ...accessDate === undefined ? {} : { accessDate } }]),
    });
    return response.json() as Promise<WriteResponse>;
}

describe('FakeZoteroServer accessDate validation', () => {
    test.each([
        '2026-09-28',
        '2026-09-28 23:15:51',
        '2026-09-28T23:15:51Z',
        'CURRENT_TIMESTAMP',
        '',
    ])('accepts %p', async (accessDate) => {
        const result = await createWithAccessDate(accessDate);

        expect(result.failed).toEqual({});
        expect(Object.keys(result.successful)).toEqual(['0']);
    });

    test('accepts an item with no accessDate', async () => {
        const result = await createWithAccessDate(undefined);

        expect(result.failed).toEqual({});
    });

    test.each([
        '2026-09-28T23:15:51.133Z',
        '2026-09-28 23:15:51.133',
        '2026-09-28T00:00:00.000Z',
        '28/09/2026',
        'yesterday',
        '2026-09-28 23:15',
    ])('rejects %p with Zotero\'s message', async (accessDate) => {
        const result = await createWithAccessDate(accessDate);

        expect(result.successful).toEqual({});
        expect(result.failed['0']).toEqual({
            code:    400,
            message: `'accessDate' must be in ISO 8601 or UTC 'YYYY-MM-DD[ hh:mm:ss]' format or 'CURRENT_TIMESTAMP' (${accessDate})`,
        });
    });

    test('rejects a non-string accessDate', async () => {
        const result = await createWithAccessDate(20_260_928);

        expect(result.failed['0'].code).toBe(400);
    });

    test('rejects a bad accessDate on an update too, keeping the stored item untouched', async () => {
        const server = new FakeZoteroServer();
        const { key } = server.addItem({ itemType: 'document', title: 'T' });

        const response = await server.fetch(`${LIBRARY}/items`, {
            method:  'POST',
            headers: { 'Zotero-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
            body:    JSON.stringify([{ key, version: 1, itemType: 'document', title: 'T', accessDate: '2026-09-28T23:15:51.133Z' }]),
        });
        const result = await response.json() as WriteResponse;

        expect(result.failed['0']).toMatchObject({ key, code: 400 });
        expect(server.items.get(key)?.data.accessDate).toBeUndefined();
    });
});
