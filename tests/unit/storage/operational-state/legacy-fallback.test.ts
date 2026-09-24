import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { z } from 'zod';
import { createFakeOperationalStateStore, type FakeOperationalStateStore } from '../../../helpers/fake-operational-state-store';
import { mockLogger } from '../../../setup';
import { bskyNotificationCheckpointSchema } from '@/integrations/bsky/checkpoint/types';
import { discordChannelCheckpointSchema } from '@/integrations/discord/inbox/types';
import { createMemoryPath } from '@/storage/memory-tool/types';
import { createOperationalStateStore, type LegacyStateReader, type OperationalStateKey } from '@/storage/operational-state';
import { legacyStatePath } from '@/storage/operational-state/legacy-fallback';

const schema = z.object({ n: z.number() });
const channelKey: OperationalStateKey = { owner: 'discord', name: 'channels/123/checkpoint' };
const LEGACY_MSG = 'OperationalStateStore: read from legacy /state/services memory row (read-only fallback until checkpoint migration)';

describe('createOperationalStateStore (legacy read-through fallback)', () => {
    let primary: FakeOperationalStateStore;
    let legacyGet: ReturnType<typeof mock<LegacyStateReader['get']>>;

    beforeEach(() => {
        primary = createFakeOperationalStateStore();
        legacyGet = mock<LegacyStateReader['get']>(async () => undefined);
        mockLogger.info.mockClear();
    });

    function store(): ReturnType<typeof createOperationalStateStore> {
        return createOperationalStateStore({ backend: primary, legacyMemoryBackend: { get: legacyGet } });
    }

    test('legacyStatePath maps owner and name onto the legacy /state/services memory path', () => {
        expect(legacyStatePath({ owner: 'bsky', name: 'dm/checkpoint' })).toBe(createMemoryPath('/state/services/bsky/dm/checkpoint'));
    });

    test('a valid primary row is returned without consulting the legacy row', async () => {
        primary.seed(channelKey, { n: 1 });
        await expect(store().read(channelKey, schema)).resolves.toEqual({ status: 'valid', value: { n: 1 } });
        expect(legacyGet).not.toHaveBeenCalled();
    });

    test('a corrupt primary row is returned as invalid and never masked by the legacy row', async () => {
        primary.seedRaw(channelKey, '{nope');
        legacyGet.mockImplementation(async () => ({ content: '{"n":9}' }));
        const read = await store().read(channelKey, schema);
        expect(read.status).toBe('invalid');
        expect((read as { reason: string }).reason).toBe('json');
        expect(legacyGet).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('a primary miss with no legacy row is absent after reading exactly the legacy checkpoint path', async () => {
        await expect(store().read(channelKey, schema)).resolves.toEqual({ status: 'absent' });
        expect(legacyGet).toHaveBeenCalledTimes(1);
        expect(legacyGet).toHaveBeenCalledWith(createMemoryPath('/state/services/discord/channels/123/checkpoint'));
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('a primary miss with a legacy row decodes the legacy content and info-logs the exact payload', async () => {
        legacyGet.mockImplementation(async () => ({ content: '{"n":7}' }));
        await expect(store().read(channelKey, schema)).resolves.toEqual({ status: 'valid', value: { n: 7 } });
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith({
            owner:  'discord',
            name:   'channels/123/checkpoint',
            path:   '/state/services/discord/channels/123/checkpoint',
            status: 'valid',
            msg:    LEGACY_MSG,
        });
    });

    test('reading the same legacy-only key twice logs once, and a different key logs again', async () => {
        legacyGet.mockImplementation(async () => ({ content: '{"n":7}' }));
        const s = store();
        await s.read(channelKey, schema);
        await s.read(channelKey, schema);
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        await s.read({ owner: 'bsky', name: 'dm/checkpoint' }, schema);
        expect(mockLogger.info).toHaveBeenCalledTimes(2);
        expect(mockLogger.info.mock.calls[1]?.[0]).toMatchObject({ owner: 'bsky', name: 'dm/checkpoint', path: '/state/services/bsky/dm/checkpoint' });
    });

    test('a corrupt legacy row is returned as invalid schema and logged with status invalid', async () => {
        legacyGet.mockImplementation(async () => ({ content: '{"n":"x"}' }));
        const read = await store().read(channelKey, schema);
        expect(read.status).toBe('invalid');
        expect((read as { reason: string }).reason).toBe('schema');
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid' }));
    });

    test('put delegates to the primary store with the same arguments and never touches legacy', async () => {
        await store().put(channelKey, { n: 3 });
        expect(primary.put).toHaveBeenCalledTimes(1);
        expect(primary.put).toHaveBeenCalledWith(channelKey, { n: 3 });
        expect(legacyGet).not.toHaveBeenCalled();
    });

    test('listByPrefix delegates to the primary store and returns its values without a legacy read', async () => {
        primary.seed(channelKey, { n: 4 });
        const prefix: OperationalStateKey = { owner: 'discord', name: 'channels/' };
        await expect(store().listByPrefix(prefix, schema)).resolves.toEqual([{ n: 4 }]);
        expect(primary.listByPrefix).toHaveBeenCalledWith(prefix, schema);
        expect(legacyGet).not.toHaveBeenCalled();
    });

    test('a legacy Bluesky notification checkpoint decodes unchanged through its schema', async () => {
        const fixture = {
            service:       'bsky',
            type:          'notification',
            lastSeenAt:    '2026-09-01T10:00:00.000Z',
            processedUris: ['at://did:plc:abc/app.bsky.feed.post/1'],
            updatedAt:     '2026-09-01T10:00:01.000Z',
        };
        legacyGet.mockImplementation(async () => ({ content: JSON.stringify(fixture) }));
        const read: unknown = await store().read({ owner: 'bsky', name: 'notifications/checkpoint' }, bskyNotificationCheckpointSchema);
        expect(read).toEqual({ status: 'valid', value: fixture });
        expect(legacyGet).toHaveBeenCalledWith(createMemoryPath('/state/services/bsky/notifications/checkpoint'));
    });

    test('a legacy Discord channel checkpoint with a handled watermark decodes unchanged through its schema', async () => {
        const fixture = {
            service:           'discord',
            channelId:         '123456789012345678',
            guildId:           '987654321098765432',
            lastSeenAt:        '2026-09-01T10:00:00.000Z',
            lastSeenMessageId: '1111111111111111111',
            updatedAt:         '2026-09-01T10:00:01.000Z',
            handled:           { messageId: '1111111111111111110', at: '2026-09-01T10:00:02.000Z' },
        };
        legacyGet.mockImplementation(async () => ({ content: JSON.stringify(fixture) }));
        const read: unknown = await store().read({ owner: 'discord', name: 'channels/123456789012345678/checkpoint' }, discordChannelCheckpointSchema);
        expect(read).toEqual({ status: 'valid', value: fixture });
    });
});
