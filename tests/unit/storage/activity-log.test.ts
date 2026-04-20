import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { createActivityLogger, type ActivityLogEntry, type ActivityType } from '../../../src/storage/activity-log';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, ContentType, MemoryToolItemData } from '../../../src/storage/memory-tool/types';

const createMockItem = (overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData => ({
    path:        '/mock/path' as MemoryPath,
    content:     'mock content',
    contentType: 'text/plain' as ContentType,
    metadata:    {},
    createdAt:   '2025-01-01T00:00:00.000Z',
    updatedAt:   '2025-01-01T00:00:00.000Z',
    ...overrides,
});

describe.concurrent('createActivityLogger', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:        mock(async () => createMockItem()),
            get:           mock(async () => undefined),
            update:        mock(async () => createMockItem()),
            'delete':      mock(async () => { /* intentionally empty */ }),
            list:          mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:   mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags:  mock(async () => ({ items: [], nextCursor: undefined })),
            listTagCounts: mock(async () => []),
        } as unknown as MemoryToolBackend;
    });

    test('should create logger with log method', () => {
        const logger = createActivityLogger(mockBackend);
        expect(logger).toBeDefined();
        expect(typeof logger.log).toBe('function');
    });

    describe('path generation', () => {
        test('should call backend.create with path /events/activity/{type}/{timestamp}', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'email-sent', summary: 'Sent an email' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { path: string };
            expect(input.path).toMatch(/^\/events\/activity\/email-sent\//);
        });

        test('should include ISO timestamp with colons/dots replaced by dashes', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'bsky-post-sent', summary: 'Posted to Bluesky' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { path: string };
            // Timestamp part should not contain colons or dots
            const parts = input.path.split('/');
            const timestamp = parts[parts.length - 1] ?? '';
            expect(timestamp).not.toContain(':');
            expect(timestamp).not.toContain('.');
            // Should look like an ISO timestamp with dashes
            expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
        });

        test.each([
            'email-sent',
            'email-rejected',
            'bsky-post-sent',
            'bsky-post-rejected',
            'bsky-dm-sent',
            'bsky-dm-rejected',
            'discord-exchange',
            'perch-start',
            'perch-end',
            'perch-suspend',
            'perch-resume',
            'catchup-start',
            'catchup-complete',
            'catchup-suspend',
        ] satisfies ActivityType[])('should use activity type %s in path', async (activityType) => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: activityType, summary: 'Test' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { path: string };
            expect(input.path).toContain(`/events/activity/${activityType}/`);
        });
    });

    describe('content formatting', () => {
        test('should format content as "[auto] summary" when no details', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'email-sent', summary: 'Sent an email' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { content: string };
            expect(input.content).toBe('[auto] Sent an email');
        });

        test(String.raw`should format content as "[auto] summary\n\ndetails" when details provided`, async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = {
                type:    'discord-exchange',
                summary: 'Chatted with Craig',
                details: 'Discussed project roadmap',
            };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { content: string };
            expect(input.content).toBe('[auto] Chatted with Craig\n\nDiscussed project roadmap');
        });

        test('should use text/plain contentType', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'perch-start', summary: 'Perch session started' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { contentType: string };
            expect(input.contentType).toBe('text/plain');
        });
    });

    describe('tags', () => {
        test('should always include auto-logged and activity type tags', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'bsky-dm-sent', summary: 'Sent a DM' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { tags: Set<string> };
            expect(input.tags).toBeInstanceOf(Set);
            expect(input.tags.has('auto-logged')).toBe(true);
            expect(input.tags.has('bsky-dm-sent')).toBe(true);
        });

        test('should include extra tags from entry.tags', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = {
                type:    'email-sent',
                summary: 'Sent to Alice',
                tags:    ['alice', 'important'],
            };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { tags: Set<string> };
            expect(input.tags.has('alice')).toBe(true);
            expect(input.tags.has('important')).toBe(true);
            expect(input.tags.has('auto-logged')).toBe(true);
            expect(input.tags.has('email-sent')).toBe(true);
        });

        test('should not duplicate auto-logged tag if already in entry.tags', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = {
                type:    'perch-end',
                summary: 'Perch ended',
                tags:    ['auto-logged'],
            };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { tags: Set<string> };
            // Set deduplicates automatically — size should not count auto-logged twice
            const tagArray = [...input.tags];
            expect(tagArray.filter(t => t === 'auto-logged')).toHaveLength(1);
        });

        test('should not duplicate type tag if already in entry.tags', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = {
                type:    'catchup-complete',
                summary: 'Catchup done',
                tags:    ['catchup-complete'],
            };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { tags: Set<string> };
            const tagArray = [...input.tags];
            expect(tagArray.filter(t => t === 'catchup-complete')).toHaveLength(1);
        });

        test('should produce exactly {auto-logged, type} tags when entry.tags is undefined', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'perch-resume', summary: 'Resumed' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { tags: Set<string> };
            expect(input.tags.size).toBe(2);
            expect([...input.tags].toSorted((a, b) => a.localeCompare(b))).toEqual(['auto-logged', 'perch-resume']);
        });

        test('should produce exactly {auto-logged, type} tags when entry.tags is empty array', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'perch-suspend', summary: 'Suspended', tags: [] };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { tags: Set<string> };
            expect(input.tags.size).toBe(2);
            expect([...input.tags].toSorted((a, b) => a.localeCompare(b))).toEqual(['auto-logged', 'perch-suspend']);
        });
    });

    describe('error propagation', () => {
        test('should propagate error from backend.create()', async () => {
            const error = new Error('DynamoDB failure');
            (mockBackend.create as ReturnType<typeof mock>).mockImplementation(async () => {
                throw error;
            });
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'email-sent', summary: 'Test' };

            expect(logger.log(entry)).rejects.toThrow('DynamoDB failure');
        });
    });

    describe('metadata passthrough', () => {
        test('should pass metadata from entry to backend.create()', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = {
                type:     'email-rejected',
                summary:  'Email rejected',
                metadata: { reason: 'spam', recipientCount: 3 },
            };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as { metadata: Record<string, unknown> };
            expect(input.metadata).toEqual({ reason: 'spam', recipientCount: 3 });
        });

        test('should omit metadata key when entry.metadata is undefined', async () => {
            const logger = createActivityLogger(mockBackend);
            const entry: ActivityLogEntry = { type: 'catchup-start', summary: 'Started catchup' };
            await logger.log(entry);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0];
            const input = createCall[0] as Record<string, unknown>;
            expect(input).not.toHaveProperty('metadata');
        });
    });
});
