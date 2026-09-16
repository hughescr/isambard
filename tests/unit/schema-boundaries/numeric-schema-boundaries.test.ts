import { describe, expect, test } from 'bun:test';
import { channelIdSchema, userIdSchema } from '@/agent/types';
import { calendarEntrySchema, calendarRegistryRecordSchema, calendarServerEntrySchema } from '@/integrations/caldav/calendar-registry/types';
import { channelMetadataSchema } from '@/integrations/discord/channel-registry/types';
import { discordMessageContextSchema, messageIdSchema } from '@/integrations/discord/types';
import { outboxItemSchema } from '@/services/outbox/types';
import { contactIdSchema, contactIdentifierSchema, contactSchema } from '@/storage/contacts/types';
import { memoryToolItemSchema } from '@/storage/memory-tool/types';

const uuid = '00000000-0000-4000-8000-000000000001';
const timestamp = '2025-01-24T10:00:00.000Z';
const calendarEntry = { calendarPath: 'x', label: 'x' };
const server = {
    serverId: uuid, description: 'x', serverUrl: 'https://example.com', username: 'x', password: 'x', calendars: [calendarEntry],
};
const contactIdentifier = { platform: 'email', value: 'x' };
const contact = {
    personId: 'alice', displayName: 'x', identifiers: [contactIdentifier], _internal: undefined, createdAt: timestamp, updatedAt: timestamp,
};
const memory = {
    path: '/x', content: 'x', contentType: 'text/plain', metadata: {}, createdAt: timestamp, updatedAt: timestamp,
};
const outbox = {
    id: uuid, createdAt: timestamp, type: 'agent_response', service: 'discord', destination: 'x', payload: {}, priority: 'low', dedupeKey: 'x', progress: {}, epoch: 0,
};

describe('public numeric schema boundaries', () => {
    test.each([
        ['channelIdSchema', channelIdSchema, 'x'],
        ['userIdSchema', userIdSchema, 'x'],
        ['messageIdSchema', messageIdSchema, 'x'],
        ['calendarEntry.calendarPath', calendarEntrySchema, { ...calendarEntry, calendarPath: 'x' }],
        ['calendarEntry.label', calendarEntrySchema, { ...calendarEntry, label: 'x' }],
        ['calendarServerEntry.description', calendarServerEntrySchema, { ...server, description: 'x' }],
        ['calendarServerEntry.username', calendarServerEntrySchema, { ...server, username: 'x' }],
        ['calendarRegistryRecord.userId', calendarRegistryRecordSchema, { userId: 'x', servers: [], createdAt: timestamp, updatedAt: timestamp }],
        ['channelMetadata.channelName', channelMetadataSchema, { channelId: 'x', guildId: 'DM', channelName: 'x', discoveredAt: timestamp, lastSeenAt: timestamp, updatedAt: timestamp }],
        ['discordMessageContext.messageId', discordMessageContextSchema, { guildId: 'x', channelId: 'x', userId: 'x', messageId: 'x', content: '', timestamp, botUserId: 'x' }],
        ['contactIdentifier.value', contactIdentifierSchema, { ...contactIdentifier, value: 'x' }],
        ['contactIdentifier.value max', contactIdentifierSchema, { ...contactIdentifier, value: 'x'.repeat(500) }],
        ['contactId max', contactIdSchema, 'x'.repeat(100)],
        ['contact.displayName', contactSchema, { ...contact, displayName: 'x' }],
        ['contact.displayName max', contactSchema, { ...contact, displayName: 'x'.repeat(200) }],
        ['memory.content', memoryToolItemSchema, { ...memory, content: 'x' }],
        ['memory.content max', memoryToolItemSchema, { ...memory, content: 'x'.repeat(300_000) }],
        ['memory.contentPreview max', memoryToolItemSchema, { ...memory, contentPreview: 'x'.repeat(100) }],
    ])('accepts %s at its documented boundary', (_name, schema, value) => {
        expect(schema.safeParse(value).success).toBe(true);
    });

    test.each([
        ['outbox.epoch zero', { ...outbox, epoch: 0 }, true],
        ['outbox.epoch negative', { ...outbox, epoch: -1 }, false],
    ])('checks %s', (_name, value, expected) => {
        expect(outboxItemSchema.safeParse(value).success).toBe(expected);
    });

    test.each([
        ['memory.content over max', { ...memory, content: 'x'.repeat(300_001) }],
        ['memory.contentPreview over max', { ...memory, contentPreview: 'x'.repeat(101) }],
    ])('rejects %s', (_name, value) => {
        expect(memoryToolItemSchema.safeParse(value).success).toBe(false);
    });
});
