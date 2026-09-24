import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createContextBuilder, type CalendarService } from '../../../src/agent/context-builder';
import { createAtUri, createCid, type BlueskyClient } from '../../../src/integrations/bsky';
import type { BskyRejectionBackend } from '../../../src/integrations/bsky/rejection-backend';
import type { CalDAVClient, CalendarRegistryBackend, CalendarEventsResult, CalendarServerEntry } from '../../../src/integrations/caldav';
import type { ServiceHealthRegistry } from '../../../src/services';
import { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { ListResult } from '../../../src/storage/memory-tool/backend-query';
import { createMemoryPath, type MemoryToolItemData } from '../../../src/storage/memory-tool/types';
import { mockLogger } from '../../setup';

describe('createContextBuilder loading methods', () => {
    let mockDocClient: DynamoDBDocumentClient;
    let backend: MemoryToolBackend;

    beforeEach(() => {
        // Reset logger mocks
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();

        mockDocClient = {} as DynamoDBDocumentClient;
        backend = new MemoryToolBackend(mockDocClient, 'test-table');
    });

    afterEach(() => {
        setSystemTime();
    });

    describe('loadCoreIdentity', () => {
        test('should return empty string when no identity items exist', async () => {
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const identity = await contextBuilder.loadCoreIdentity();

            expect(identity).toBe('');
            // Verify logger was called with correct message
            expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Loading core identity...' });
            expect(mockLogger.debug).toHaveBeenCalledWith({ identityLength: 0 }, 'Core identity loaded');
        });

        test('should join identity items with double newlines', async () => {
            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/item1.md'),
                        content:     'First identity',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/identity/item2.md'),
                        content:     'Second identity',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const identity = await contextBuilder.loadCoreIdentity();

            // Should join with \n\n, not empty string
            expect(identity).toBe('First identity\n\nSecond identity');
            // Verify NOT joined with empty string
            expect(identity).not.toBe('First identitySecond identity');
            // Verify logger was called with correct message
            expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Loading core identity...' });
            expect(mockLogger.debug).toHaveBeenCalledWith({ identityLength: 31 }, 'Core identity loaded');
        });

        test('should truncate content with ellipsis and overflow note when exceeding maxIdentityChars', async () => {
            const longContent = 'x'.repeat(3000);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/long.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Should contain truncated content (397 x's + '...')
            expect(identity).toContain(`${'x'.repeat(397)}...`);
            // Should contain overflow note
            expect(identity).toContain("...and 1 total identity memories (use 'list /identity' to see all)");
            // Verify the truncated portion starts correctly
            expect(identity.slice(0, 397)).toBe('x'.repeat(397));
        });

        test.each([
            { contentLength: 3000, description: 'exceeding maxIdentityChars', shouldTruncate: true },
            { contentLength: 401, description: 'single character over limit', shouldTruncate: true },
            { contentLength: 400, description: 'exactly at maxIdentityChars', shouldTruncate: false },
            { contentLength: 300, description: 'less than maxIdentityChars', shouldTruncate: false },
        ])('should handle truncation when $description', async ({ contentLength, shouldTruncate }) => {
            const content = 'x'.repeat(contentLength);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/test.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            if(shouldTruncate) {
                // Truncated content: 397 x's + '...' + overflow note
                expect(identity).toContain(`${'x'.repeat(397)}...`);
                expect(identity).toContain("...and 1 total identity memories (use 'list /identity' to see all)");
                expect(identity.slice(0, 397)).toBe('x'.repeat(397));
            } else {
                expect(identity).toBe(content);
                expect(identity).not.toContain('total identity memories');
            }
        });

        test('should truncate content at exactly maxIdentityChars - 3 characters before ellipsis', async () => {
            // Use content of exactly 403 chars with a budget of 400 chars
            // This ensures the slice at (maxIdentityChars - 3) = 397 is precise
            const content = `${'a'.repeat(397)}BCDEFG`; // 404 chars

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/test.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Should have exactly 397 a's followed by '...' (not 'BCDEFG')
            expect(identity).toContain(`${'a'.repeat(397)}...`);
            expect(identity).not.toContain('B');
        });

        test('should log identity length including overflow note', async () => {
            const longContent = 'x'.repeat(500);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/test.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Logger should log the full length including overflow note
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { identityLength: identity.length },
                'Core identity loaded'
            );
            // Length must be > 400 because of overflow note appended
            expect(identity.length).toBeGreaterThan(400);
        });
    });

    describe('loadHotState', () => {
        test('should return empty string when no state items exist', async () => {
            backend.getStateItemsScored = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState();

            expect(result).toBe('');
            expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Loading hot state...' });
            expect(mockLogger.debug).toHaveBeenCalledWith({ fullTierCount: 0, previewTierCount: 0, overflowCount: 0, stateLength: 0 }, 'Hot state loaded');
        });

        test('should format items with full content in full tier', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/task1.md'),
                        content:     'Current task details',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            expect(result).toContain('/state/task1.md:\nCurrent task details');
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { fullTierCount: 1, previewTierCount: 0, overflowCount: 0, stateLength: result.length },
                'Hot state loaded'
            );
        });

        test('should use preview format for items that overflow full tier', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // Create 9 items to exceed maxStateFullItems (default 8)
            const items = Array.from({ length: 9 }, (_, i) => ({
                item: {
                    path:           createMemoryPath(`/state/task${i}.md`),
                    content:        `Content ${i}`,
                    contentPreview: `Preview ${i}`,
                    contentType:    'text/markdown' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                },
                score: 1 - i * 0.1,
            }));

            backend.getStateItemsScored = mock(async () => items);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            // First 8 should be full content format
            expect(result).toContain('/state/task0.md:\nContent 0');
            expect(result).toContain('/state/task7.md:\nContent 7');
            // 9th should be preview format
            expect(result).toContain('- /state/task8.md (2h ago): Content 8');
        });

        test('should show overflow indicator when items exceed both tiers', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 50 }, (_, i) => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     'x'.repeat(200),
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                score: 1 - i * 0.01,
            }));

            backend.getStateItemsScored = mock(async () => items);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems:    2,
                maxStatePreviewItems: 2,
            });
            const result = await contextBuilder.loadHotState(now);

            expect(result).toContain('...and 46 more state memories (use \'list /state\' to see all)');
        });

        test('should respect maxStateFullItems count', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 3 }, (_, i) => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     'x'.repeat(500),
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                score: 1 - i * 0.1,
            }));

            backend.getStateItemsScored = mock(async () => items);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems: 2,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should have 2 full content items + 1 preview
            const fullTierItems = (result.match(/\/state\/task\d+\.md:\n/g) ?? []).length;
            expect(fullTierItems).toBe(2);
            expect(result).toContain('/state/task0.md:');
            expect(result).toContain('- /state/task2.md (2h ago):');
            expect(result.indexOf('/state/task0.md:')).toBeLessThan(result.indexOf('- /state/task2.md (2h ago):'));
        });

        test('should respect maxStatePreviewItems count', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 40 }, (_, i) => ({
                item: {
                    path:           createMemoryPath(`/state/task${i}.md`),
                    content:        'x'.repeat(5000),
                    contentPreview: `Preview ${i}`,
                    contentType:    'text/markdown' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                },
                score: 1 - i * 0.01,
            }));

            backend.getStateItemsScored = mock(async () => items);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems:    0, // Force all to preview tier
                maxStatePreviewItems: 5,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should have 5 preview items
            const previewItems = (result.match(/- \/state\/task\d+\.md \(2h ago\):/g) ?? []).length;
            expect(previewItems).toBe(5);
            // And overflow indicator
            expect(result).toContain('...and 35 more state memories');
            expect(result).toContain('- /state/task4.md (2h ago):');
            expect(result.indexOf('- /state/task4.md (2h ago):')).toBeLessThan(result.indexOf('...and 35 more state memories'));
        });

        test('should truncate items exceeding maxStateItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = 'x'.repeat(3000);

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/long.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateItemMaxChars: 2000,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should be truncated to 2000 chars with truncation message
            expect(result).toContain('x'.repeat(2000));
            expect(result).toContain('[truncated — use \'memory view /state/long.md\' for full content]');
            expect(result).not.toContain('x'.repeat(2001));
        });

        test('should not truncate items within maxStateItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const content = 'x'.repeat(2000);

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/short.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateItemMaxChars: 2000,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should NOT be truncated
            expect(result).toBe(`/state/short.md:\n${content}`);
            expect(result).not.toContain('[truncated');
        });

        test('should break early when both tiers are full', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 20 }, (_, i) => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     `Content ${i}`,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                score: 1 - i * 0.05,
            }));

            backend.getStateItemsScored = mock(async () => items);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems:    2,
                maxStatePreviewItems: 3,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should have 2 full + 3 preview = 5 shown, 15 overflow
            expect(result).toContain('/state/task0.md:\nContent 0');
            expect(result).toContain('/state/task1.md:\nContent 1');
            expect(result).toContain('- /state/task2.md (2h ago): Content 2');
            expect(result).toContain('- /state/task3.md (2h ago): Content 3');
            expect(result).toContain('- /state/task4.md (2h ago): Content 4');
            expect(result).toContain('...and 15 more state memories');
        });

        test('should include all items when count exactly equals maxStateFullItems', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 8 }, (_, i) => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     `Content ${i}`,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                score: 1 - i * 0.1,
            }));

            backend.getStateItemsScored = mock(async () => items);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems: 8,
            });
            const result = await contextBuilder.loadHotState(now);

            // All 8 should be in full tier, 0 preview, 0 overflow
            const fullTierItems = (result.match(/\/state\/task\d+\.md:\n/g) ?? []).length;
            expect(fullTierItems).toBe(8);
            expect(result).not.toContain('- /state/task');
            expect(result).not.toContain('...and');
        });

        test('should render full items when preview tier is disabled', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => [{
                item: {
                    path:        createMemoryPath('/state/only.md'),
                    content:     'Full content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                score: 1,
            }]);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems:    1,
                maxStatePreviewItems: 0,
            });
            const result = await contextBuilder.loadHotState(now);

            expect(result).toBe('/state/only.md:\nFull content');
        });

        test('should order items by sigmoid score (highest first)', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/high-score.md'),
                        content:     'High score item',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/low-score.md'),
                        content:     'Low score item',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.25,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            // High score should appear before low score
            const highIndex = result.indexOf('High score item');
            const lowIndex = result.indexOf('Low score item');
            expect(highIndex).toBeLessThan(lowIndex);
        });

        test('should pass { now } options to getStateItemsScored', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadHotState(now);

            expect(backend.getStateItemsScored).toHaveBeenCalledWith({ now });
        });

        test('should log debug with correct tier counts', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/full.md'),
                        content:     'Short',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { fullTierCount: 1, previewTierCount: 0, overflowCount: 0, stateLength: result.length },
                'Hot state loaded'
            );
        });

        test('should track preview tier count correctly', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // Item with very long content that will be truncated in full tier
            const longContent = 'x'.repeat(15_000);

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/truncated.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
                // 9 more items to push first one beyond full tier
                ...Array.from({ length: 9 }, (_, i) => ({
                    item: {
                        path:        createMemoryPath(`/state/item${i}.md`),
                        content:     'Content',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.9 - i * 0.05,
                })),
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateFullItems: 8,
            });
            const result = await contextBuilder.loadHotState(now);

            // First 8 in full tier, last 2 in preview tier
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { fullTierCount: 8, previewTierCount: 2, overflowCount: 0, stateLength: result.length },
                'Hot state loaded'
            );
        });

        test('should use newline separator between sections', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/item1.md'),
                        content:     'Item 1',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/item2.md'),
                        content:     'Item 2',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.9,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            // Items should be separated by \n (not \n\n or empty)
            expect(result).toBe('/state/item1.md:\nItem 1\n/state/item2.md:\nItem 2');
        });

        test('should include item in user memories when it exactly fills the budget (boundary test for <=)', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // Format: "- /users/u/p (2h ago): Content"
            // "- /users/u/p (2h ago): Content" = 30 chars
            // But Content is < 100 chars so no truncation.
            // Actually, let me compute: "- /users/u/p (2h ago): c" = 24 chars
            // Need budget = 24. 24/4 = 6 tokens.

            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/u/p'),
                    content:        'c',
                    contentPreview: 'c',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 6, // 24 chars = "- /users/u/p (2h ago): c".length
            });
            const result = await contextBuilder.loadUserMemories('u', now);

            // Should include the item (exactly fits)
            expect(result).toBe('- /users/u/p (2h ago): c');
            expect(result).not.toContain('...and');
        });
    });

    describe('loadStateTopSet', () => {
        test('returns [] when no state items exist', async () => {
            backend.getStateItemsScored = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadStateTopSet();

            expect(result).toEqual([]);
        });

        test('maps items to {path, contentFingerprint} in score order, deriving the fingerprint from content', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/a.md'),
                        content:     'A',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        createdAt:   '2025-01-15T09:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.9,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/b.md'),
                        content:     'B',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        createdAt:   '2025-01-15T08:00:00.000Z',
                        updatedAt:   '2025-01-15T09:00:00.000Z',
                    },
                    score: 0.5,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadStateTopSet(now);

            expect(result).toEqual([
                { path: createMemoryPath('/state/a.md'), contentFingerprint: Bun.hash('A').toString() },
                { path: createMemoryPath('/state/b.md'), contentFingerprint: Bun.hash('B').toString() },
            ]);
        });

        test('two items with identical content produce the same fingerprint even when updatedAt differs (a read-only access bump must not register as a content change)', async () => {
            // Two independent backends (rather than reassigning one backend's method between two
            // awaited calls) so neither call risks racing the other's mock.
            const backendAtFirstTouch = new MemoryToolBackend(mockDocClient, 'test-table');
            backendAtFirstTouch.getStateItemsScored = mock(async () => [{
                item: {
                    path: createMemoryPath('/state/a.md'), content: 'unchanged content', contentType: 'text/markdown' as const, metadata: {}, createdAt: '2025-01-15T09:00:00.000Z', updatedAt: '2025-01-15T10:00:00.000Z',
                },
                score: 0.9,
            }]);
            const backendAfterReadOnlyAccess = new MemoryToolBackend(mockDocClient, 'test-table');
            backendAfterReadOnlyAccess.getStateItemsScored = mock(async () => [{
                item: {
                    path: createMemoryPath('/state/a.md'), content: 'unchanged content', contentType: 'text/markdown' as const, metadata: {}, createdAt: '2025-01-15T09:00:00.000Z', updatedAt: '2025-01-15T11:30:00.000Z',
                },
                score: 0.9,
            }]);

            const [firstResult, secondResult] = await Promise.all([
                createContextBuilder({ backend: backendAtFirstTouch }).loadStateTopSet(),
                createContextBuilder({ backend: backendAfterReadOnlyAccess }).loadStateTopSet(),
            ]);

            expect(firstResult[0]?.contentFingerprint).toBe(secondResult[0]?.contentFingerprint);
        });

        test('passes the default maxStateFullItems + maxStatePreviewItems cap (38) as maxItems, along with now', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const getStateItemsScored = mock(async () => []);
            backend.getStateItemsScored = getStateItemsScored;

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadStateTopSet(now);

            expect(getStateItemsScored).toHaveBeenCalledWith({ now, maxItems: 38 });
        });

        test('custom maxStateFullItems/maxStatePreviewItems options change the cap', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const getStateItemsScored = mock(async () => []);
            backend.getStateItemsScored = getStateItemsScored;

            const contextBuilder = createContextBuilder({ backend, maxStateFullItems: 3, maxStatePreviewItems: 5 });
            await contextBuilder.loadStateTopSet(now);

            expect(getStateItemsScored).toHaveBeenCalledWith({ now, maxItems: 8 });
        });

        test('defaults now to the current time when not provided', async () => {
            const getStateItemsScored = mock(async () => []);
            backend.getStateItemsScored = getStateItemsScored;

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadStateTopSet();

            expect(getStateItemsScored).toHaveBeenCalledWith({ now: expect.any(Date), maxItems: 38 });
        });
    });

    describe('loadCalendarAgenda', () => {
        const fakeServer: CalendarServerEntry = {
            serverId:    '00000000-0000-0000-0000-000000000001' as CalendarServerEntry['serverId'],
            description: 'Test server',
            serverUrl:   'https://cal.example.com',
            username:    'user',
            password:    'pass',
            calendars:   [{ calendarPath: '/calendars/main/', label: 'Main' }],
        };

        const fakeEvent = {
            uid:           'evt-001',
            summary:       'Team meeting',
            time:          { kind: 'timed' as const, start: new Date('2026-03-18T10:00:00Z'), end: new Date('2026-03-18T11:00:00Z') },
            calendarLabel: 'Main',
            status:        'confirmed' as const,
        };

        let mockCalDAVClient: CalDAVClient;
        let mockCalendarRegistry: CalendarRegistryBackend;

        beforeEach(() => {
            mockCalDAVClient = {
                getContextEvents: mock(async (): Promise<CalendarEventsResult> => ({ events: [fakeEvent], failed: [] })),
            } as unknown as CalDAVClient;

            mockCalendarRegistry = {
                getAllCalendars:       mock(async () => [fakeServer]),
                listRegisteredUserIds: mock(async () => []),
            } as unknown as CalendarRegistryBackend;
        });

        test('returns [] when no calendarService is configured', async () => {
            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadCalendarAgenda('user123', new Date('2026-03-18T10:00:00Z'));

            expect(result).toEqual([]);
            // Distinguishes the early-return guard from the fallthrough case: without a
            // calendarService, #fetchCalendarEvents would throw on `this.#calendarService!.registry`
            // and the catch block would log a warning en route to the same [] result.
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('returns [] when the user has no registered calendar servers', async () => {
            mockCalendarRegistry.getAllCalendars = mock(async () => []);
            const calendarService: CalendarService = { client: mockCalDAVClient, registry: mockCalendarRegistry };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.loadCalendarAgenda('user123', new Date('2026-03-18T10:00:00Z'));

            expect(result).toEqual([]);
            expect(mockCalDAVClient.getContextEvents).not.toHaveBeenCalled();
        });

        test('returns the fetched events for the user', async () => {
            const calendarService: CalendarService = { client: mockCalDAVClient, registry: mockCalendarRegistry };
            const now = new Date('2026-03-18T10:00:00Z');

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.loadCalendarAgenda('user123', now);

            expect(result).toEqual([fakeEvent]);
            expect(mockCalendarRegistry.getAllCalendars).toHaveBeenCalledWith('user123');
            expect(mockCalDAVClient.getContextEvents).toHaveBeenCalledWith([fakeServer], now);
        });

        test('returns [] and logs a warning when registry.getAllCalendars throws', async () => {
            mockCalendarRegistry.getAllCalendars = mock(async () => {
                throw new Error('DynamoDB timeout');
            });
            const calendarService: CalendarService = { client: mockCalDAVClient, registry: mockCalendarRegistry };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.loadCalendarAgenda('user123', new Date('2026-03-18T10:00:00Z'));

            expect(result).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), userId: 'user123' }),
                'Failed to load calendar agenda'
            );
        });

        test('returns [] and logs a warning when client.getContextEvents throws', async () => {
            mockCalDAVClient.getContextEvents = mock(async () => {
                throw new Error('CalDAV connection failed');
            });
            const calendarService: CalendarService = { client: mockCalDAVClient, registry: mockCalendarRegistry };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.loadCalendarAgenda('user123', new Date('2026-03-18T10:00:00Z'));

            expect(result).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), userId: 'user123' }),
                'Failed to load calendar agenda'
            );
        });

        test('does not affect #buildCalendarSection: the failed-note behavior still renders after the refactor', async () => {
            mockCalDAVClient.getContextEvents = mock(async (): Promise<CalendarEventsResult> => ({
                events: [fakeEvent],
                failed: [{ uid: 'bad-recurring', reason: 'malformed RRULE' }],
            }));
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const calendarService: CalendarService = { client: mockCalDAVClient, registry: mockCalendarRegistry };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain("couldn't be parsed");
        });
    });

    describe('loadUserMemories', () => {
        test('should return empty string when no user memories exist', async () => {
            backend.list = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserMemories('user123');

            expect(result).toBe('');
            expect(backend.list).toHaveBeenCalledWith('/users/user123');
            expect(mockLogger.debug).toHaveBeenCalledWith({ userId: 'user123' }, 'Loading user memories');
            expect(mockLogger.debug).toHaveBeenCalledWith({ userId: 'user123', memoryCount: 0, overflowCount: 0 }, 'User memories loaded');
        });

        test('should format items with path, age, and content preview', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.list = mock(async () => ({
                items: [
                    {
                        path:           createMemoryPath('/users/user123/preference'),
                        content:        'Prefers dark mode',
                        contentPreview: 'Prefers dark mode',
                        contentType:    'text/plain' as const,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-15T10:00:00.000Z',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserMemories('user123', now);

            expect(result).toContain('- /users/user123/preference (2h ago): Prefers dark mode');
        });

        test('should respect maxUserTokens budget', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 50 }, (_, i) => ({
                path:           createMemoryPath(`/users/user123/memory${i}`),
                content:        'x'.repeat(200),
                contentPreview: 'x'.repeat(100),
                contentType:    'text/plain' as const,
                metadata:       {},
                version:        1,
                createdAt:      '2025-01-15T10:00:00.000Z',
                updatedAt:      '2025-01-15T10:00:00.000Z',
            }));

            backend.list = mock(async () => ({ items }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 100, // 400 chars
            });
            const result = await contextBuilder.loadUserMemories('user123', now);

            // Should not include all 50 items
            const itemCount = (result.match(/- \/users\/user123\/memory\d+/g) ?? []).length;
            expect(itemCount).toBeLessThan(50);
        });

        test('should show overflow indicator when items exceed budget', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 100 }, (_, i) => ({
                path:           createMemoryPath(`/users/user123/memory${i}`),
                content:        'x'.repeat(200),
                contentPreview: 'x'.repeat(100),
                contentType:    'text/plain' as const,
                metadata:       {},
                version:        1,
                createdAt:      '2025-01-15T10:00:00.000Z',
                updatedAt:      '2025-01-15T10:00:00.000Z',
            }));

            backend.list = mock(async () => ({ items }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 100, // Includes at least one preview, but not all 100
            });
            const result = await contextBuilder.loadUserMemories('user123', now);

            expect(result).toContain('...and ');
            expect(result).toContain('more user memories (use \'list /users/user123\' to see all)');
            expect(result).toContain('- /users/user123/memory0');
            expect(result.indexOf('- /users/user123/memory0')).toBeLessThan(result.indexOf('more user memories'));
        });

        test('should call backend.list with correct path', async () => {
            backend.list = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadUserMemories('alice');

            expect(backend.list).toHaveBeenCalledWith('/users/alice');
        });

        test('should use preview format when content is undefined but contentPreview exists', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.list = mock(async (): Promise<ListResult<MemoryToolItemData>> => ({
                items: [{
                    path:           createMemoryPath('/users/user123/note'),
                    content:        undefined as unknown as string, // No full content (tag index item)
                    contentPreview: 'A brief note about the user',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserMemories('user123', now);

            // Should use preview format since no full content
            expect(result).toContain('[preview] A brief note about the user... (memory view /users/user123/note for full)');
        });

        test('should use no-content format when both content and contentPreview are undefined', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.list = mock(async (): Promise<ListResult<MemoryToolItemData>> => ({
                items: [{
                    path:           createMemoryPath('/users/user123/empty'),
                    content:        undefined as unknown as string,
                    contentPreview: undefined,
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserMemories('user123', now);

            expect(result).toContain('[no content]');
        });

        test('should multiply maxUserTokens by CHARS_PER_TOKEN (4) for budget', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // maxUserTokens=50 -> should be 200 chars (50*4)
            // If mutation changes * to /, it would be 50/4=12.5 chars
            // Item formatted as "- /users/u1/pref (2h ago): Content" = ~34 chars

            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/u1/pref'),
                    content:        'Content',
                    contentPreview: 'Content',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 50, // 200 chars (or 12.5 if mutated to /)
            });
            const result = await contextBuilder.loadUserMemories('u1', now);

            // With 200 char budget, the ~34-char item should fit
            expect(result).toContain('- /users/u1/pref (2h ago): Content');
            // No overflow indicator
            expect(result).not.toContain('...and');
        });

        test('should use newline separator between memory items', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.list = mock(async () => ({
                items: [
                    {
                        path:           createMemoryPath('/users/user123/pref1'),
                        content:        'Pref 1',
                        contentPreview: 'Pref 1',
                        contentType:    'text/plain' as const,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-15T10:00:00.000Z',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                    },
                    {
                        path:           createMemoryPath('/users/user123/pref2'),
                        content:        'Pref 2',
                        contentPreview: 'Pref 2',
                        contentType:    'text/plain' as const,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-15T10:00:00.000Z',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserMemories('user123', now);

            // Items should be separated by \n
            const lines = result.split('\n');
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain('/users/user123/pref1');
            expect(lines[1]).toContain('/users/user123/pref2');
        });

        test('should log correct memoryCount excluding overflows', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = Array.from({ length: 50 }, (_, i) => ({
                path:           createMemoryPath(`/users/u1/memory${i}`),
                content:        'x'.repeat(200),
                contentPreview: 'x'.repeat(100),
                contentType:    'text/plain' as const,
                metadata:       {},
                version:        1,
                createdAt:      '2025-01-15T10:00:00.000Z',
                updatedAt:      '2025-01-15T10:00:00.000Z',
            }));

            backend.list = mock(async () => ({ items }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 100, // 400 chars - very small
            });
            await contextBuilder.loadUserMemories('u1', now);

            // Should have logged with memoryCount < 50 and overflowCount > 0
            const debugCalls = mockLogger.debug.mock.calls as [Record<string, unknown>, string][];
            const loadedCall = debugCalls.find(call =>
                typeof call[1] === 'string' && call[1] === 'User memories loaded');
            expect(loadedCall).toBeTruthy();
            const logObj = loadedCall![0] as { memoryCount: number, overflowCount: number };
            expect(logObj.memoryCount).toBeLessThan(50);
            expect(logObj.overflowCount).toBeGreaterThan(0);
            expect(logObj.memoryCount + logObj.overflowCount).toBe(50);
        });

        test('should track overflow items separately when budget exceeded', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.list = mock(async () => ({
                items: [
                    {
                        path:           createMemoryPath('/users/u1/mem1'),
                        content:        'x'.repeat(5000),
                        contentPreview: 'x'.repeat(100),
                        contentType:    'text/plain' as const,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-15T10:00:00.000Z',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 0, // 0 chars budget
            });
            const result = await contextBuilder.loadUserMemories('u1', now);

            // Should show overflow indicator
            expect(result).toContain('...and 1 more user memories');
        });
    });

    describe('loadRecentEvents', () => {
        test('should call searchByTimeRange with 14-day window', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });

            const beforeCall = Date.now();
            const result = await contextBuilder.loadRecentEvents();
            const afterCall = Date.now();

            expect(backend.searchByTimeRange).toHaveBeenCalledTimes(1);

            // Capture the arguments passed to searchByTimeRange
            const [startTimeArg, endTimeArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string];
            const startTime = new Date(startTimeArg);
            const endTime = new Date(endTimeArg);

            // Verify the time window is approximately 14 days (336 hours) (within tolerance for test execution time)
            const diffMs = endTime.getTime() - startTime.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            expect(diffHours).toBeCloseTo(336, 0);

            // Verify endTime is approximately "now" (within test execution window)
            expect(endTime.getTime()).toBeGreaterThanOrEqual(beforeCall);
            expect(endTime.getTime()).toBeLessThanOrEqual(afterCall + 1000); // Allow 1s tolerance

            // Verify result structure
            expect(result.items).toEqual([]);
            expect(result.isFallback).toBe(false);

            // Verify logger was called
            expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Loading recent events' });
            expect(mockLogger.debug).toHaveBeenCalledWith({ eventCount: 0 }, 'Recent events loaded');
        });

        test('should verify 14-day calculation uses multiplication not division', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents();

            const [startTimeArg, endTimeArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string];
            const startTime = new Date(startTimeArg);
            const endTime = new Date(endTimeArg);

            // Calculate the actual difference in milliseconds
            const diffMs = endTime.getTime() - startTime.getTime();

            // If mutation changes 14 * 24 * 60 * 60 * 1000 to 14 / 24 * 60 * 60 * 1000:
            // 14 / 24 = 0.583..., then * 60 = 35, then * 60 = 2100, then * 1000 = 2100000ms = 35 minutes
            // So we need to ensure the difference is much larger than 35 minutes
            expect(diffMs).toBeGreaterThan(24 * 60 * 60 * 1000); // Must be more than 1 day

            // And it should be close to 14 days (1209600000 ms)
            const expectedMs = 14 * 24 * 60 * 60 * 1000;
            expect(diffMs).toBeGreaterThan(expectedMs - 1000); // Within 1 second
            expect(diffMs).toBeLessThan(expectedMs + 1000);
        });

        test.each([
            { limit: undefined, expectedLimit: 50, description: 'default limit' },
            { limit: 10, expectedLimit: 10, description: 'custom limit' },
        ])('should pass $description to backend', async ({ limit, expectedLimit }) => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents(limit);

            const callArgs = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string, string, { limit: number }];
            const [layerArg, optionsArg] = [callArgs[2], callArgs[3]];
            expect(layerArg).toBe('events');
            expect(optionsArg).toEqual({ limit: expectedLimit });
        });

        test('should return raw items with metadata', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event1.md'),
                    content:     'Event 1',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                {
                    path:        createMemoryPath('/events/event2.md'),
                    content:     'Event 2',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T11:00:00.000Z',
                    updatedAt:   '2025-01-15T11:00:00.000Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(5, now);

            expect(result.items).toHaveLength(2);
            expect(result.items[0].path).toBe(createMemoryPath('/events/event1.md'));
            expect(result.items[0].content).toBe('Event 1');
            expect(result.items[1].path).toBe(createMemoryPath('/events/event2.md'));
            expect(result.items[1].content).toBe('Event 2');
            expect(result.isFallback).toBe(false);
        });

        test('should return empty result when no events found', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents();

            expect(result.items).toEqual([]);
            expect(result.isFallback).toBe(false);
        });

        test('should fallback to listByLayer when no events in 14-day window', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            // searchByTimeRange returns empty (no events in 14 days)
            backend.searchByTimeRange = mock(async () => []);

            // listByLayer returns older events
            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/events/old-event.md'),
                        content:     'Old event from last month',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2024-12-01T00:00:00.000Z',
                        updatedAt:   '2024-12-01T00:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(50, now);

            // Should have called listByLayer as fallback
            expect(backend.listByLayer).toHaveBeenCalledWith('events', { limit: 50 });

            // Result should have isFallback = true and raw items
            expect(result.isFallback).toBe(true);
            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe(createMemoryPath('/events/old-event.md'));
            expect(result.items[0].content).toBe('Old event from last month');
        });

        test('should have isFallback=false when events found within 14-day window', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/recent.md'),
                    content:     'Recent event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(50, now);

            // Should have isFallback = false
            expect(result.isFallback).toBe(false);
            expect(result.items).toHaveLength(1);
            expect(result.items[0].path).toBe(createMemoryPath('/events/recent.md'));
        });

        test('should not call listByLayer when events found within 14-day window', async () => {
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/recent.md'),
                    content:     'Recent event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);

            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents();

            // listByLayer should NOT have been called
            expect(backend.listByLayer).not.toHaveBeenCalled();
        });

        test('should have isFallback=false when fallback also returns empty', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents();

            // Result should be empty with isFallback = false
            expect(result.items).toEqual([]);
            expect(result.isFallback).toBe(false);
        });

        test('should pass limit to listByLayer in fallback', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents(25);

            expect(backend.listByLayer).toHaveBeenCalledWith('events', { limit: 25 });
        });

        test('should sort events by updatedAt ascending (oldest first, newest last)', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            // Events returned from backend in random order (not sorted)
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/newest.md'),
                    content:     'Newest event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T11:00:00.000Z',
                    updatedAt:   '2025-01-15T11:00:00.000Z', // 1h ago (newest)
                },
                {
                    path:        createMemoryPath('/events/oldest.md'),
                    content:     'Oldest event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T08:00:00.000Z',
                    updatedAt:   '2025-01-15T08:00:00.000Z', // 4h ago (oldest)
                },
                {
                    path:        createMemoryPath('/events/middle.md'),
                    content:     'Middle event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z', // 2h ago (middle)
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(50, now);

            expect(result.items).toHaveLength(3);
            // Verify ascending order: oldest first, newest last
            expect(result.items[0].path).toBe(createMemoryPath('/events/oldest.md'));
            expect(result.items[0].updatedAt).toBe('2025-01-15T08:00:00.000Z');
            expect(result.items[1].path).toBe(createMemoryPath('/events/middle.md'));
            expect(result.items[1].updatedAt).toBe('2025-01-15T10:00:00.000Z');
            expect(result.items[2].path).toBe(createMemoryPath('/events/newest.md'));
            expect(result.items[2].updatedAt).toBe('2025-01-15T11:00:00.000Z');
        });

        test('should sort fallback results by updatedAt ascending', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            // Primary search returns empty (triggers fallback)
            backend.searchByTimeRange = mock(async () => []);

            // Fallback returns unsorted items
            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/events/newest.md'),
                        content:     'Newest',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2024-12-15T00:00:00.000Z',
                        updatedAt:   '2024-12-15T00:00:00.000Z', // Newest (1 month ago)
                    },
                    {
                        path:        createMemoryPath('/events/oldest.md'),
                        content:     'Oldest',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2024-11-15T00:00:00.000Z',
                        updatedAt:   '2024-11-15T00:00:00.000Z', // Oldest (2 months ago)
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(50, now);

            expect(result.items).toHaveLength(2);
            expect(result.isFallback).toBe(true);
            // After sorting: oldest first
            expect(result.items[0].path).toBe(createMemoryPath('/events/oldest.md'));
            expect(result.items[1].path).toBe(createMemoryPath('/events/newest.md'));
        });
    });

    describe('loadRecentEventsSince', () => {
        const makeEventItem = (path: string, updatedAt: string): MemoryToolItemData => ({
            path:        createMemoryPath(path),
            content:     `Event at ${updatedAt}`,
            contentType: 'text/plain' as const,
            metadata:    {},
            createdAt:   updatedAt,
            updatedAt,
        });

        test('calls backend.searchSince with correct startTime from windowMs', async () => {
            const now = new Date('2025-06-01T12:00:00.000Z');
            const windowMs = 2 * 60 * 60 * 1000; // 2 hours
            const expectedStart = new Date(now.getTime() - windowMs).toISOString();

            backend.searchSince = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEventsSince(windowMs, 10, now);

            expect(backend.searchSince).toHaveBeenCalledWith(
                expectedStart,
                'events',
                { limit: 10 }
            );
        });

        test('returns items array directly from searchSince', async () => {
            const now = new Date('2025-06-01T12:00:00.000Z');
            const items = [
                makeEventItem('/events/activity/perch-end/ts1', '2025-06-01T10:00:00.000Z'),
                makeEventItem('/events/conversation/ts2', '2025-06-01T11:00:00.000Z'),
            ];

            backend.searchSince = mock(async () => items);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEventsSince(2 * 60 * 60 * 1000, 10, now);

            expect(result).toEqual(items);
        });

        test('returns empty array when searchSince returns empty', async () => {
            backend.searchSince = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEventsSince(2 * 60 * 60 * 1000, 10);

            expect(result).toEqual([]);
        });

        test('uses current time when now is not provided', async () => {
            const before = Date.now();
            backend.searchSince = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEventsSince(2 * 60 * 60 * 1000, 5);

            const after = Date.now();
            const searchSinceMock = backend.searchSince as ReturnType<typeof mock>;
            const calledWith = searchSinceMock.mock.calls[0][0] as string;
            const calledStartMs = new Date(calledWith).getTime();
            // The start time should be approximately (now - 2h)
            expect(calledStartMs).toBeGreaterThanOrEqual(before - 2 * 60 * 60 * 1000);
            expect(calledStartMs).toBeLessThanOrEqual(after - 2 * 60 * 60 * 1000 + 100);
        });
    });

    describe('loadUserTimezone', () => {
        test('should return timezone content when found', async () => {
            backend.get = mock(async () => ({
                path:        createMemoryPath('/users/user123/timezone'),
                content:     'America/Los_Angeles',
                contentType: 'text/plain' as const,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserTimezone('user123');

            expect(backend.get).toHaveBeenCalledWith(createMemoryPath('/users/user123/timezone'));
            expect(result).toBe('America/Los_Angeles');
        });

        test('should return undefined when timezone not found', async () => {
            backend.get = mock(async () => undefined);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserTimezone('user-no-tz');

            expect(result).toBeUndefined();
            // Verify logger was called with correct message
            expect(mockLogger.debug).toHaveBeenCalledWith({ userId: 'user-no-tz' }, 'User timezone not found');
        });
    });

    describe('buildUserMessagePrefix', () => {
        test('includes an unavailable-service-health summary in the composed prefix', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const healthRegistry = {
                buildStatusSummary: mock(() => '- discord: offline'),
            } as unknown as ServiceHealthRegistry;

            const contextBuilder = createContextBuilder({ backend, healthRegistry });
            const result = await contextBuilder.buildUserMessagePrefix('user-health');

            expect(result).toContain('## Service Status');
            expect(result).toContain('- discord: offline');
            expect(result).toContain('\n\n## Service Status\n');
        });

        test('omits service status when every service is healthy', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const healthRegistry = { buildStatusSummary: mock(() => undefined) } as unknown as ServiceHealthRegistry;
            const result = await createContextBuilder({ backend, healthRegistry }).buildUserMessagePrefix('user-health');
            expect(result).not.toContain('## Service Status');
            expect(result.trim().split('\n\n')).toHaveLength(1);
        });

        test('should include time header as first section', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            // Add at least one memory so we get non-empty result
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/test'),
                    content:        'test',
                    contentPreview: 'test',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('## Current Time');
            // Time header should be first
            const lines = result.split('\n\n');
            expect(lines[0]).toContain('## Current Time');
        });

        test('should include time header even when no other context available', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user-empty');

            // Time header is always included even with no other context
            expect(result).toContain('## Current Time');
            expect(result).toMatch(/\n\n$/);
            expect(result.trim().split('\n\n')).toHaveLength(1);
            expect(backend.searchByTimeRange).toHaveBeenCalledWith(
                expect.any(String), expect.any(String), 'events', { limit: 50 }
            );
        });

        test('should not include [About this user] section when no user memories exist', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/task.md'),
                        content:     'Ensures non-empty result',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user-no-memories');

            // Should NOT contain [About this user] when no user memories
            expect(result).not.toContain('[About this user]');
            // But should still have other content
            expect(result).toContain('[Current state]');
        });

        test('should not include [Current state] section when no hot state exists', async () => {
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/pref'),
                    content:        'Ensures non-empty result',
                    contentPreview: 'Ensures non-empty result',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should NOT contain [Current state] when no hot state
            expect(result).not.toContain('[Current state]');
            // But should still have user memories
            expect(result).toContain('[About this user]');
        });

        test('should not include [Recent events] section when no events exist', async () => {
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/pref'),
                    content:        'Ensures non-empty result',
                    contentPreview: 'Ensures non-empty result',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should NOT contain [Recent events] when no events
            expect(result).not.toContain('[Recent events]');
            // But should still have user memories
            expect(result).toContain('[About this user]');
        });

        test('should include hot state section when loadHotState returns content', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/task.md'),
                        content:     'Current task',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Current state]');
            expect(result).toContain('Current task');
        });

        test('should include recent events section when events exist', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event1.md'),
                    content:     'Event content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Recent events]');
            // Should have full content format with path, age, and content
            expect(result).toContain('/events/event1.md');
            expect(result).toContain('Event content');
        });

        test('should include user memories section with correct format', async () => {
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/pref'),
                    content:        'Likes cats',
                    contentPreview: 'Likes cats',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // User memories section should contain [About this user] with the memory content
            expect(result).toContain('[About this user]');
            expect(result).toContain('Likes cats');
        });

        test('should format events with full content and double-newline separator', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/e1.md'),
                    content:     'First event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString(),
                },
                {
                    path:        createMemoryPath('/events/e2.md'),
                    content:     'Second event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString(),
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Events should have full content format with path and content
            const eventsSection = /\[Recent events\]\n([\s\S]*?)(?:\n\n## |$)/.exec(result);
            expect(eventsSection).toBeTruthy();
            // Events separated by double newlines
            expect(eventsSection![1]).toContain('/events/e1.md');
            expect(eventsSection![1]).toContain('First event');
            expect(eventsSection![1]).toContain('/events/e2.md');
            expect(eventsSection![1]).toContain('Second event');
            // Check double-newline separator exists between events
            expect(eventsSection![1]).toMatch(/First event\n\n\/events\/e2\.md[\s\S]*Second event/);
        });

        test('should join all sections with double newlines and add trailing newlines', async () => {
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/pref'),
                    content:        'User memory',
                    contentPreview: 'User memory',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/task.md'),
                        content:     'State content',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/e1.md'),
                    content:     'Event',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString(),
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should have double newline between sections
            expect(result).toContain('[About this user]');
            expect(result).toContain('[Current state]');
            expect(result).toContain('[Recent events]');
            expect(result.indexOf('[About this user]')).toBeLessThan(result.indexOf('[Current state]'));
            expect(result.indexOf('[Current state]')).toBeLessThan(result.indexOf('[Recent events]'));
            // Should end with \n\n
            expect(result).toMatch(/\n\n$/);
        });

        test('should pass userTimezone to formatTimeHeader', async () => {
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/test'),
                    content:        'test',
                    contentPreview: 'test',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123', 'America/Los_Angeles');

            // Should contain user timezone in the header
            expect(result).toContain('America/Los_Angeles');
        });

        test('should include fallback warning when isFallback is true', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []); // No recent events
            backend.listByLayer = mock(async () => ({
                items: Array.from({ length: 11 }, (_, index) => ({
                    path:           createMemoryPath(`/events/old-event-${index}`),
                    content:        `Old fallback event ${index}`,
                    contentPreview: `Old fallback event ${index}`,
                    contentType:    'text/plain' as const,
                    tags:           new Set<string>(),
                    metadata:       {},
                    version:        1,
                    createdAt:      new Date(Date.UTC(2024, 11, 1, index)).toISOString(),
                    updatedAt:      new Date(Date.UTC(2024, 11, 1, index)).toISOString(),
                })),
            })); // Fallback to old events

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            const warningIndex = result.indexOf('⚠️ No activity in the last 14 days. Showing older events:');
            const olderEventIndex = result.indexOf('- /events/old-event-0');
            expect(warningIndex).toBeGreaterThanOrEqual(0);
            expect(olderEventIndex).toBeGreaterThan(warningIndex);
        });

        test('should NOT include fallback warning when isFallback is false', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [{
                path:        createMemoryPath('/events/recent-event'),
                content:     'Recent event within 14 days',
                contentType: 'text/plain' as const,
                tags:        new Set<string>(),
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-14T10:00:00.000Z',
                updatedAt:   '2025-01-14T10:00:00.000Z',
            }]); // Recent events - not a fallback
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should NOT contain fallback warning
            expect(result).not.toContain('⚠️ No activity in the last 14 days');
            expect(result).toContain('Recent event within 14 days');
        });

        test('should call summarizer when provided and remaining events exist', async () => {
            const mockSummarizer = mock(async () => [{
                startTime: '2025-01-15T10:00:00.000Z',
                endTime:   '2025-01-15T11:00:00.000Z',
                count:     5,
                summary:   'Batch summary from summarizer',
            }]);

            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                // Return more events than maxEventFullItems (default 10)
                Array.from({ length: 15 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i} content`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({
                backend,
                summarizeEventBatches: mockSummarizer,
            });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should call summarizer for remaining events
            expect(mockSummarizer).toHaveBeenCalled();
            expect(result).toContain('Batch summary from summarizer');
            // Should NOT use preview format when summarizer is provided
            expect(result).not.toContain('- /events/event10');
        });

        test('should fall back to preview format when summarizer throws error', async () => {
            const mockSummarizer = mock(async () => {
                throw new Error('LLM failure');
            });

            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                // Return more events than maxEventFullItems (default 10)
                Array.from({ length: 15 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i} content`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({
                backend,
                summarizeEventBatches: mockSummarizer,
            });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should call summarizer (which throws error)
            expect(mockSummarizer).toHaveBeenCalled();
            // Should log warning
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    msg: 'Event summarization failed, falling back to preview format',
                })
            );
            // Should fall back to preview format for older events instead of crashing
            expect(result).toContain('- /events/event0');
            expect(result).toContain('- /events/event4');
            // Should NOT contain batch summary (summarizer failed)
            expect(result).not.toContain('Batch summary from summarizer');
            // Should still contain newest 10 full-content events (event5-event14)
            expect(result).toContain('Event 5 content');
            expect(result).toContain('Event 14 content');
        });

        test('should NOT call summarizer when provided but no remaining events exist', async () => {
            const mockSummarizer = mock(async () => [{
                startTime: '2025-01-15T10:00:00.000Z',
                endTime:   '2025-01-15T11:00:00.000Z',
                count:     5,
                summary:   'Batch summary from summarizer',
            }]);

            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                // Return exactly maxEventFullItems (default 10) - no remaining
                Array.from({ length: 10 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i} content`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({
                backend,
                summarizeEventBatches: mockSummarizer,
            });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should NOT call summarizer when no remaining events
            expect(mockSummarizer).not.toHaveBeenCalled();
            expect(result).not.toContain('Batch summary from summarizer');
        });

        test('should use preview format when summarizer not provided and remaining events exist', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                // Return more events than maxEventFullItems (default 10)
                Array.from({ length: 15 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i} content`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            // NO summarizer provided
            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should show older events in preview format, newest in full
            // Newest 10 should be full content (event5-event14)
            expect(result).toContain('Event 5 content');
            expect(result).toContain('Event 14 content');
            // Oldest 5 should be in preview format (event0-event4)
            expect(result).toContain('- /events/event0');
            expect(result).toContain('- /events/event4');
        });

        test('should correctly split events into full and remaining items', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                Array.from({ length: 12 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i} content`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend, maxEventFullItems: 5 });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Newest 5 should be full display (event7-event11, since array is ascending)
            expect(result).toContain('/events/event7');
            expect(result).toContain('Event 7 content');
            expect(result).toContain('/events/event11');
            expect(result).toContain('Event 11 content');

            // Older events should be in preview format (event0-event6)
            expect(result).toContain('- /events/event0');
            expect(result).toContain('- /events/event6');

            // Verify event11 (newest) is NOT in preview format (should be full display)
            const event11Lines = result.split('\n').filter(line => line.includes('/events/event11'));
            expect(event11Lines.some(line => line.startsWith('- '))).toBe(false);

            // Verify the split is correct by checking full display format for event11
            expect(result).toMatch(/\/events\/event11 \([^)]+\):\nEvent 11 content/);
            // And preview format for event6 (older)
            expect(result).toMatch(/^- \/events\/event6/m);
        });

        test('should handle exactly maxEventFullItems events without remaining items', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                Array.from({ length: 5 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i} content`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend, maxEventFullItems: 5 });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // All 5 should be full display
            expect(result).toContain('Event 0 content');
            expect(result).toContain('Event 4 content');

            // Should NOT have any preview format items (no lines starting with "- /events/")
            const previewLines = result.split('\n').filter(line => line.trim().startsWith('- /events/'));
            expect(previewLines).toHaveLength(0);
        });

        test('should correctly slice events array at maxEventFullItems boundary', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                // Return 11 events (maxEventFullItems=10, so 10 full + 1 remaining)
                Array.from({ length: 11 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i}`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Newest 10 events should be full display (event1-event10)
            expect(result).toContain('/events/event1 (');
            expect(result).toContain('Event 1');
            expect(result).toContain('/events/event10 (');
            expect(result).toContain('Event 10');

            // Event 0 (oldest) should be preview format only
            expect(result).toContain('- /events/event0');
            // Verify event 0 is NOT in full display format
            expect(result).not.toMatch(/\/events\/event0 \([^)]+\):\nEvent 0/);
        });

        test('should handle empty remainingItems (no else-if branch execution)', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () =>
                // Return exactly 10 events (maxEventFullItems=10, no remaining)
                Array.from({ length: 10 }, (_, i) => ({
                    path:        createMemoryPath(`/events/event${i}`),
                    content:     `Event ${i}`,
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   new Date(Date.UTC(2025, 0, 15, 10 + i)).toISOString(),
                }))
            );
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // All 10 events should be full display
            expect(result).toContain('Event 0');
            expect(result).toContain('Event 9');
            // No preview format lines
            expect(result).not.toMatch(/^- \/events\//m);
        });

        test('should truncate event content when it exceeds maxEventItemMaxChars', async () => {
            const retainedPrefix = 'EVENT-FULL-PREFIX-7x3';
            const longContent = `${retainedPrefix}${'A'.repeat(3000)}`; // Longer than default 2000
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/long-event'),
                    content:     longContent,
                    contentType: 'text/markdown' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // The full-event view must preserve the leading content as well as its retrieval marker.
            // A reversed String#slice(max, 0) keeps the marker but drops this prefix.
            expect(result).toContain(retainedPrefix);
            expect(result).toContain('[truncated — use \'memory view /events/long-event\' for full content]');
            // Content should be truncated to ~2000 chars (plus truncation message)
            const eventSectionMatch = /\/events\/long-event[\s\S]*?\n\n/.exec(result);
            const eventSection = eventSectionMatch?.[0] ?? '';
            // Should be significantly shorter than 3000 chars
            expect(eventSection.length).toBeLessThan(2200);
        });

        test('should respect custom maxEventItemMaxChars option', async () => {
            const longContent = 'B'.repeat(1500);
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/custom-event'),
                    content:     longContent,
                    contentType: 'text/markdown' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend, maxEventItemMaxChars: 1000 });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should be truncated at custom limit
            expect(result).toContain('[truncated — use \'memory view /events/custom-event\' for full content]');
        });

        test('keeps event content at the exact character limit in user and perch contexts', async () => {
            const content = 'E'.repeat(100);
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [{
                path:        createMemoryPath('/events/exact-limit'),
                content,
                contentType: 'text/plain' as const,
                tags:        new Set<string>(),
                metadata:    {},
                createdAt:   '2025-01-15T10:00:00.000Z',
                updatedAt:   '2025-01-15T10:00:00.000Z',
            }]);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const builder = createContextBuilder({ backend, maxEventItemMaxChars: 100 });
            const user = await builder.buildUserMessagePrefix('user123');
            const perch = await builder.buildPerchContext();
            expect(user).toContain('/events/exact-limit (');
            expect(user).toContain(`:\n${content}`);
            expect(perch).toContain(`:\n${content}`);
            expect(user).not.toContain('[truncated');
            expect(perch).not.toContain('[truncated');
        });
    });

    describe('buildPerchContext', () => {
        test('orders every populated documented section after its predecessor', async () => {
            const now = new Date('2026-03-18T10:00:00.000Z');
            backend.getStateItemsScored = mock(async () => [{
                item: {
                    path:        createMemoryPath('/state/order.md'), content:     'State order marker', contentType: 'text/markdown' as const, metadata:    {}, version:     1,
                    createdAt:   '2026-03-18T08:00:00.000Z', updatedAt:   '2026-03-18T08:00:00.000Z',
                },
                score: 1,
            }]);
            backend.searchByTimeRange = mock(async () => [{
                path:        createMemoryPath('/events/order.md'), content:     'Event order marker', contentType: 'text/markdown' as const, metadata:    {}, version:     1,
                createdAt:   '2026-03-18T09:00:00.000Z', updatedAt:   '2026-03-18T09:00:00.000Z',
            }]);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const calendarService = {
                registry: {
                    listRegisteredUserIds: mock(async () => ['order-user']),
                    getAllCalendars:       mock(async () => [{ serverId: 'server', description: 'Order', serverUrl: 'https://calendar.example', username: 'user', password: 'pass', calendars: [{ calendarPath: '/order', label: 'Order' }] }]),
                },
                client: {
                    getContextEvents: mock(async () => ({ events: [{ uid: 'calendar-order', summary: 'Calendar order marker', time: { kind: 'timed', start: new Date('2026-03-18T11:00:00.000Z'), end: new Date('2026-03-18T12:00:00.000Z') }, calendarLabel: 'Order', status: 'confirmed' as const }], failed: [] })),
                },
            } as unknown as CalendarService;
            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 1, unseen: 1 })),
                    listMessages:     mock(async () => [{ id: 1, from: { address: 'order@example.com' }, subject: 'Inbox order marker', date: '2026-03-18T09:00:00.000Z' }]),
                    searchByKeyword:  mock(async (_folder: string, keyword: string) => (keyword === 'SendRejectedByAdmin' ? [2] : [])),
                    getMessage:       mock(async () => ({ id: 2, subject: 'Rejected order marker', to: [{ address: 'recipient@example.com' }], metaData: { rejectedAt: '2026-03-18T09:30:00.000Z', reason: 'Order test' } })),
                },
            };
            const bskyDMService = { client: {
                ownHandle:         'izzy.bsky.social',
                listConversations: mock(async () => ({ conversations: [{ id: 'order-convo', rev: '1', members: [{ did: 'did:plc:izzy', handle: 'izzy.bsky.social' }, { did: 'did:plc:other', handle: 'other.bsky.social' }], muted: false, unreadCount: 1 }], cursor: undefined })),
            } as unknown as BlueskyClient };
            const bskyRejectionBackend = { listRejections: mock(async () => [{ type: 'dm' as const, uuid: 'order-rejection', text: 'Rejected Bluesky order marker', recipientHandles: ['other.bsky.social'], convoId: 'order-convo', reason: 'Order test', rejectedAt: '2026-03-18T09:45:00.000Z' }]) } as unknown as BskyRejectionBackend;

            const result = await createContextBuilder({ backend, calendarService, emailService, bskyDMService, bskyRejectionBackend }).buildPerchContext(now);
            const orderedHeadings = ['## Current Time', '## Recent Focus', '## Recent Events', '## Calendar', '## Inbox', '## Messages You Attempted to Send (Rejected by Admin)', '## Bluesky DMs', '## Rejected Bluesky Posts/DMs'];
            for(let index = 1; index < orderedHeadings.length; index++) {
                expect(result.indexOf(orderedHeadings[index])).toBeGreaterThan(result.indexOf(orderedHeadings[index - 1]));
            }
        });

        test('includes an unavailable-service-health summary in perch context', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const healthRegistry = {
                buildStatusSummary: mock(() => '- email: offline'),
            } as unknown as ServiceHealthRegistry;

            const contextBuilder = createContextBuilder({ backend, healthRegistry });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('## Service Status');
            expect(result).toContain('- email: offline');
            expect(result).toContain('\n\n## Service Status\n');
        });

        test('should include time header', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('## Current Time');
        });

        test('should include top 3 state memories under Recent Focus', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/project.md'),
                        content:     'Working on memory system redesign',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/mood.md'),
                        content:     'Focused and curious',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T09:00:00.000Z',
                        updatedAt:   '2025-01-15T09:00:00.000Z',
                    },
                    score: 0.85,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/creative.md'),
                        content:     'Exploring consciousness-as-process thesis',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T08:00:00.000Z',
                        updatedAt:   '2025-01-15T08:00:00.000Z',
                    },
                    score: 0.75,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/fourth.md'),
                        content:     'This should NOT appear',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T07:00:00.000Z',
                        updatedAt:   '2025-01-15T07:00:00.000Z',
                    },
                    score: 0.65,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            expect(result).toContain('## Recent Focus');
            expect(result).toContain('/state/project.md');
            expect(result).toContain('Working on memory system redesign');
            expect(result).toContain('/state/mood.md');
            expect(result).toContain('Focused and curious');
            expect(result).toContain('/state/creative.md');
            expect(result).toContain('Exploring consciousness-as-process thesis');
            expect(result).toContain('## Recent Focus\n/state/project.md:\nWorking on memory system redesign\n\n/state/mood.md:\nFocused and curious');
            expect(backend.getStateItemsScored).toHaveBeenCalledWith({ now });
            // Fourth item should NOT be included (only top 3)
            expect(result).not.toContain('/state/fourth.md');
            expect(result).not.toContain('This should NOT appear');
        });

        test('should include up to 5 recent events under Recent Events', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/e1.md'),
                    content:     'Event 1 content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
                {
                    path:        createMemoryPath('/events/e2.md'),
                    content:     'Event 2 content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T11:00:00.000Z',
                    updatedAt:   '2025-01-15T11:00:00.000Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            expect(result).toContain('## Recent Events');
            expect(result).toContain('/events/e1.md');
            expect(result).toContain('Event 1 content');
            expect(result).toContain('/events/e2.md');
            expect(result).toContain('Event 2 content');
            expect(result).toContain('## Recent Events\n/events/e1.md (2h ago):\nEvent 1 content\n\n/events/e2.md (1h ago):\nEvent 2 content');
        });

        // These four cases share identical setup (no data feeding the section, no
        // optional service passed) and only differ in which section header must be
        // absent from the result; parameterized per sonarjs/parameterized-tests.
        test.each([
            { section: '## Recent Focus', description: 'no state items exist' },
            { section: '## Recent Events', description: 'no events exist' },
            { section: '## Inbox', description: 'emailService is not provided' },
            { section: '## Bluesky DMs', description: 'bskyDMService is not provided' },
        ])('should not include $section when $description', async ({ section }) => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain(section);
        });

        test('should truncate state items exceeding maxStateItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const retainedPrefix = 'PERCH-STATE-PREFIX-7x3';
            const longContent = `${retainedPrefix}${'x'.repeat(3000)}`;

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/long.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            // Perch state must keep the leading content before its full-memory marker.
            // A reversed String#slice(max, 0) leaves only the marker.
            expect(result).toContain(retainedPrefix);
            expect(result).toContain('[truncated — use \'memory view /state/long.md\' for full content]');
            expect(result).not.toContain('x'.repeat(3000));
        });

        test('should include all state items when exactly at perchStateCount boundary', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/item1.md'),
                        content:     'State item 1 content',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/item2.md'),
                        content:     'State item 2 content',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.9,
                },
                {
                    item: {
                        path:        createMemoryPath('/state/item3.md'),
                        content:     'State item 3 content',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.85,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            // All 3 items should appear (perchStateCount boundary)
            expect(result).toContain('State item 1 content');
            expect(result).toContain('State item 2 content');
            expect(result).toContain('State item 3 content');
            // Should have Recent Focus section
            expect(result).toContain('## Recent Focus');
        });

        test('should NOT truncate content exactly at maxStateItemMaxChars boundary', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const exactContent = 'x'.repeat(2000); // Exactly 2000 chars

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/exact.md'),
                        content:     exactContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            // Should NOT be truncated (test the > vs >= boundary)
            expect(result).not.toContain('[truncated');
            expect(result).toContain(exactContent);
        });

        test('should end with trailing double newline', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toMatch(/\n\n$/);
        });

        test('should call loadRecentEvents with limit of 5', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.buildPerchContext();

            // loadRecentEvents should be called with limit=5
            expect(backend.searchByTimeRange).toHaveBeenCalledTimes(1);
            // The limit parameter is passed through to searchByTimeRange as options.limit
            const call = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as unknown[];
            const options = call[3] as { limit: number };
            expect(options.limit).toBe(5);
        });

        test('should truncate event content exceeding maxEventItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const retainedPrefix = 'PERCH-EVENT-PREFIX-7x3';
            const longContent = `${retainedPrefix}${'y'.repeat(3000)}`;

            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/long-event.md'),
                    content:     longContent,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            // Perch events must preserve the leading event content before the retrieval marker.
            // A reversed String#slice(max, 0) leaves only the marker.
            expect(result).toContain(retainedPrefix);
            expect(result).toContain('[truncated — use \'memory view /events/long-event.md\' for full content]');
            expect(result).not.toContain('y'.repeat(3000));
        });

        test('should NOT truncate event content within maxEventItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const shortContent = 'Short event content that fits';

            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/short-event.md'),
                    content:     shortContent,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(now);

            expect(result).not.toContain('[truncated');
            expect(result).toContain(shortContent);
        });

        // -------------------------------------------------------------------
        // Email inbox section (emailService DI)
        // -------------------------------------------------------------------

        // 'should skip inbox section when emailService is not provided' is covered by
        // the parameterized "should not include $section when $description" test above.

        test('should include inbox section when emailService provided and unread > 0', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 5, unseen: 2 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => [
                        { id: 1, from: { name: 'Alice', address: 'alice@example.com' }, subject: 'Hello', date: '2025-01-15T10:00:00.000Z' },
                        { id: 2, from: { address: 'bob@example.com' },                  subject: 'World', date: '2025-01-15T11:00:00.000Z' },
                    ]),
                    searchByKeyword: mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext(now);

            expect(result).toContain('## Inbox');
            expect(result).toContain('2 unread');
            // Sender with name uses "Name <address>" format
            expect(result).toContain('Alice <alice@example.com>');
            // Sender without name uses plain address
            expect(result).toContain('bob@example.com');
            expect(result).toContain('Hello');
            expect(result).toContain('World');
            // UIDs must appear in CleanInbox:UID format for agent to reference them
            expect(result).toContain('CleanInbox:1');
            expect(result).toContain('CleanInbox:2');
            expect(result).toContain('## Inbox\nYou have mail (2 unread):\n- [CleanInbox:1]');
            expect(result).toContain('- [CleanInbox:1] From: Alice <alice@example.com> | Subject: Hello | 2h ago\n- [CleanInbox:2] From: bob@example.com | Subject: World | 1h ago');
        });

        test('reports the mailbox unseen count rather than the number of loaded message summaries', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 5, unseen: 3 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => [{ id: 1, from: { address: 'alice@example.com' }, subject: 'Hello', date: '2025-01-15T10:00:00.000Z' }]),
                    searchByKeyword:  mock(async () => []),
                },
            };

            const result = await createContextBuilder({ backend, emailService }).buildPerchContext(new Date('2025-01-15T12:00:00.000Z'));

            expect(result).toContain('You have mail (3 unread)');
        });

        test('should skip inbox section when emailService provided but unread === 0', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 5, unseen: 0 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => []),
                    searchByKeyword:  mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Inbox');
            // listMessages should NOT be called when unread count is 0
            expect(emailService.wildDuckClient.listMessages).not.toHaveBeenCalled();
        });

        test('should skip inbox section and log warning when emailService throws', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => {
                        throw new Error('WildDuck timeout');
                    }),
                    getMessage:      mock(() => Promise.resolve(null)),
                    listMessages:    mock(async () => []),
                    searchByKeyword: mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            // Inbox section is skipped silently
            expect(result).not.toContain('## Inbox');
            // Warning is logged
            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: expect.objectContaining({ message: 'WildDuck timeout' }),
                msg:   'Email inbox fetch failed, skipping inbox section',
            });
        });

        test('should call listMessages with CleanInbox when unread > 0', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 3, unseen: 1 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => [
                        { id: 10, from: { address: 'x@x.com' }, subject: 'Only', date: '2025-01-15T09:00:00.000Z' },
                    ]),
                    searchByKeyword: mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            await contextBuilder.buildPerchContext(now);

            expect(emailService.wildDuckClient.getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(emailService.wildDuckClient.listMessages).toHaveBeenCalledWith('CleanInbox', { unseen: true });
        });

        test('should format inbox UIDs as CleanInbox:UID for agent reference', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 3, unseen: 1 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => [
                        { id: 42, from: { address: 'sender@example.com' }, subject: 'Test', date: '2025-01-15T09:00:00.000Z' },
                    ]),
                    searchByKeyword: mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext(now);

            // Must contain the CleanInbox:UID reference for agent to use with getEmailContent
            expect(result).toContain('CleanInbox:42');
        });

        // Rejected draft context section
        // -------------------------------------------------------------------

        test('should include rejected drafts section when rejected UIDs and reasons are present', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 0, unseen: 0 })),
                    getMessage:       mock(async () => ({
                        id:       99,
                        subject:  'Hi there',
                        to:       [{ address: 'bob@example.com' }],
                        metaData: {
                            rejectedAt: '2024-01-01T00:00:00.000Z',
                            reason:     'Inappropriate content',
                        },
                    })),
                    listMessages:    mock(async () => []),
                    searchByKeyword: mock(async (_folder: string, keyword: string) => {
                        if(keyword === 'SendRejectedByAdmin') {
                            return [99];
                        }
                        return []; // No gave-up drafts — isolate subject to rejection line only
                    }),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('Messages You Attempted to Send (Rejected by Admin)');
            expect(result).toContain('bob@example.com');
            // Verify subject appears in rejection line: Subject: "Hi there" (not just anywhere)
            expect(result).toContain('Subject: "Hi there"');
            expect(result).toContain('Inappropriate content');
            expect(emailService.wildDuckClient.searchByKeyword).toHaveBeenCalledTimes(1);
            expect(emailService.wildDuckClient.searchByKeyword).toHaveBeenCalledWith('Drafts', 'SendRejectedByAdmin');
        });

        test('should skip rejected drafts section when no rejected UIDs', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 0, unseen: 0 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => []),
                    searchByKeyword:  mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
            expect(result.trim().split('\n\n')).toHaveLength(1);
        });

        test('should skip drafts without rejectedAt in metaData', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 0, unseen: 0 })),
                    getMessage:       mock(async () => ({
                        id:       55,
                        subject:  'Test',
                        to:       [{ address: 'alice@example.com' }],
                        metaData: {
                            // no rejectedAt — this is a pending draft
                        },
                    })),
                    listMessages:    mock(async () => []),
                    searchByKeyword: mock(async (_folder: string, keyword: string) => {
                        return keyword === 'SendRejectedByAdmin' ? [55] : [];
                    }),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
        });

        test('should log warning and not crash when searchByKeyword throws', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 0, unseen: 0 })),
                    getMessage:       mock(() => Promise.resolve(null)),
                    listMessages:     mock(async () => []),
                    searchByKeyword:  mock(async () => {
                        throw new Error('WildDuck keyword search failed');
                    }),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: expect.objectContaining({ message: 'WildDuck keyword search failed' }),
                msg: 'Failed to load rejected draft context',
            });
        });

        test('should log warning and not crash when getMessage rejects after a successful UID search', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                wildDuckClient: {
                    getMailboxCounts: mock(async () => ({ total: 0, unseen: 0 })),
                    getMessage:       mock(() => Promise.reject(new Error('WildDuck getMessage failed'))),
                    listMessages:     mock(async () => []),
                    searchByKeyword:  mock(async (_folder: string, keyword: string) => {
                        return keyword === 'SendRejectedByAdmin' ? [99] : [];
                    }),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: expect.objectContaining({ message: 'WildDuck getMessage failed' }),
                msg: 'Failed to load rejected draft context',
            });
        });

        // -------------------------------------------------------------------
        // Bluesky DM section (bskyDMService DI)
        // -------------------------------------------------------------------

        // 'should skip DM section when bskyDMService is not provided' is covered by
        // the parameterized "should not include $section when $description" test above.

        test('should skip DM section when no unread conversations', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockBskyClient = {
                listConversations: mock(async (): Promise<{ conversations: [], cursor: undefined }> => ({ conversations: [], cursor: undefined })),
                ownHandle:         'izzy.bsky.social',
            } as unknown as BlueskyClient;

            const bskyDMService = { client: mockBskyClient };
            const contextBuilder = createContextBuilder({ backend, bskyDMService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Bluesky DMs');
        });

        test('should include DM section with formatted unread counts', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockBskyClient = {
                listConversations: mock(async () => ({
                    conversations: [
                        {
                            id:      'convo1',
                            rev:     '1',
                            members: [
                                { did: 'did:plc:izzy',  handle: 'izzy.bsky.social' },
                                { did: 'did:plc:craig', handle: 'craig.rungie.com' },
                            ],
                            muted:       false,
                            unreadCount: 1,
                        },
                        {
                            id:      'convo2',
                            rev:     '2',
                            members: [
                                { did: 'did:plc:izzy',  handle: 'izzy.bsky.social' },
                                { did: 'did:plc:fred',  handle: 'fred.bsky.social' },
                                { did: 'did:plc:craig', handle: 'craig.rungie.com' },
                            ],
                            muted:       false,
                            unreadCount: 2,
                        },
                    ],
                    cursor: undefined,
                })),
                ownHandle: 'izzy.bsky.social',
            } as unknown as BlueskyClient;

            const bskyDMService = { client: mockBskyClient };
            const contextBuilder = createContextBuilder({ backend, bskyDMService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('## Bluesky DMs');
            expect(result).toContain('You have 3 DMs');
            expect(result).toContain('1 in the conversation with craig.rungie.com');
            expect(result).toContain('2 in the conversation with fred.bsky.social, craig.rungie.com');
            expect(result).toContain('1 in the conversation with craig.rungie.com; 2 in the conversation with fred.bsky.social, craig.rungie.com');
            expect(mockBskyClient.listConversations).toHaveBeenCalledWith(undefined, undefined, 'unread');
        });

        test('should show N+ count and hint when listConversations returns a cursor, and only call once', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockBskyClient = {
                listConversations: mock(async () => ({
                    conversations: [
                        {
                            id:      'convo1',
                            rev:     '1',
                            members: [
                                { did: 'did:plc:izzy',  handle: 'izzy.bsky.social' },
                                { did: 'did:plc:alice', handle: 'alice.bsky.social' },
                            ],
                            muted:       false,
                            unreadCount: 2,
                        },
                    ],
                    cursor: 'page2cursor',
                })),
                ownHandle: 'izzy.bsky.social',
            } as unknown as BlueskyClient;

            const bskyDMService = { client: mockBskyClient };
            const contextBuilder = createContextBuilder({ backend, bskyDMService });
            const result = await contextBuilder.buildPerchContext();

            expect(mockBskyClient.listConversations).toHaveBeenCalledTimes(1);
            expect(result).toContain('## Bluesky DMs');
            expect(result).toContain('You have 2+ DMs');
            expect(result).toContain('2 in the conversation with alice.bsky.social');
            expect(result).toContain('More conversations available');
        });

        test('should filter out own handle from member list', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockBskyClient = {
                listConversations: mock(async () => ({
                    conversations: [
                        {
                            id:      'convo1',
                            rev:     '1',
                            members: [
                                { did: 'did:plc:izzy',  handle: 'izzy.bsky.social' },
                                { did: 'did:plc:craig', handle: 'craig.rungie.com' },
                            ],
                            muted:       false,
                            unreadCount: 3,
                        },
                    ],
                    cursor: undefined,
                })),
                ownHandle: 'izzy.bsky.social',
            } as unknown as BlueskyClient;

            const bskyDMService = { client: mockBskyClient };
            const contextBuilder = createContextBuilder({ backend, bskyDMService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('## Bluesky DMs');
            // Own handle should not appear in the member list
            expect(result).not.toContain('izzy.bsky.social');
            expect(result).toContain('craig.rungie.com');
        });

        test('should skip DM section and log warning when listConversations throws', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockBskyClient = {
                listConversations: mock(async () => {
                    throw new Error('Bluesky API error');
                }),
                ownHandle: 'izzy.bsky.social',
            } as unknown as BlueskyClient;

            const bskyDMService = { client: mockBskyClient };
            const contextBuilder = createContextBuilder({ backend, bskyDMService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Bluesky DMs');
            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: expect.objectContaining({ message: 'Bluesky API error' }),
                msg:   'Bluesky DM fetch failed, skipping DM section',
            });
        });

        test('should include DM section in buildPerchContext output when unread DMs exist', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockBskyClient = {
                listConversations: mock(async () => ({
                    conversations: [
                        {
                            id:      'convo1',
                            rev:     '1',
                            members: [
                                { did: 'did:plc:izzy', handle: 'izzy.bsky.social' },
                                { did: 'did:plc:user', handle: 'someone.bsky.social' },
                            ],
                            muted:       false,
                            unreadCount: 5,
                        },
                    ],
                    cursor: undefined,
                })),
                ownHandle: 'izzy.bsky.social',
            } as unknown as BlueskyClient;

            const bskyDMService = { client: mockBskyClient };
            const contextBuilder = createContextBuilder({ backend, bskyDMService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('## Bluesky DMs');
            expect(result).toContain('You have 5 DMs');
            expect(result).toContain('5 in the conversation with someone.bsky.social');
        });

        // -------------------------------------------------------------------
        // Rejected Bluesky posts/DMs section (bskyRejectionBackend DI)
        // -------------------------------------------------------------------

        test('should include rejected Bluesky section when rejections exist', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockRejectionBackend = {
                listRejections: mock(async (): Promise<BskyRejectionBackend['listRejections'] extends () => Promise<infer T> ? T : never> => [{
                    type:         'reply' as const,
                    uuid:         'test-uuid-reply-1',
                    text:         'Great post!',
                    targetHandle: 'someone.bsky.social',
                    reply:        { parent: { uri: createAtUri('at://parent'), cid: createCid('bafyreparent') } },
                    reason:       'Too generic',
                    rejectedAt:   '2026-03-22T15:30:00.000Z',
                }]),
            } as unknown as BskyRejectionBackend;

            const builder = createContextBuilder({
                backend,
                bskyRejectionBackend: mockRejectionBackend,
            });

            const result = await builder.buildPerchContext();

            expect(result).toContain('## Rejected Bluesky Posts/DMs');
            expect(result).toContain('Too generic');
            expect(result).toContain('someone.bsky.social');
            expect(result).toContain('at://parent');
            expect(result).toContain('- **Reply rejected** (2026-03-22T15:30:00.000Z) uuid: test-uuid-reply-1\n  Reason: Too generic\n  To: @someone.bsky.social\n  parentUri: at://parent\n  parentCid: bafyreparent\n  Text: Great post!');
        });

        test('should omit rejected Bluesky section when no rejections', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockRejectionBackend = {
                listRejections: mock(async () => []),
            } as unknown as BskyRejectionBackend;

            const builder = createContextBuilder({
                backend,
                bskyRejectionBackend: mockRejectionBackend,
            });

            const result = await builder.buildPerchContext();

            expect(result).not.toContain('Rejected Bluesky');
        });

        test('should omit rejected Bluesky section when backend not configured', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const builder = createContextBuilder({ backend });

            const result = await builder.buildPerchContext();

            expect(result).not.toContain('Rejected Bluesky');
        });

        test('should omit rejected Bluesky section when listRejections throws', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockRejectionBackend = {
                listRejections: mock(async () => { throw new Error('DynamoDB timeout'); }),
            } as unknown as BskyRejectionBackend;

            const builder = createContextBuilder({
                backend,
                bskyRejectionBackend: mockRejectionBackend,
            });

            const result = await builder.buildPerchContext();

            expect(result).not.toContain('Rejected Bluesky');
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: expect.any(Error),
                msg: 'Failed to load rejected Bluesky posts context',
            });
        });

        test('should include DM rejection with recipients and convoId', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockRejectionBackend = {
                listRejections: mock(async () => [{
                    type:             'dm' as const,
                    uuid:             'test-uuid-dm-1',
                    text:             'Hey there',
                    recipientHandles: ['alice.bsky.social'],
                    convoId:          'convo-123',
                    reason:           'Not appropriate',
                    rejectedAt:       '2026-03-22T16:00:00.000Z',
                }]),
            } as unknown as BskyRejectionBackend;

            const builder = createContextBuilder({
                backend,
                bskyRejectionBackend: mockRejectionBackend,
            });

            const result = await builder.buildPerchContext();

            expect(result).toContain('DM rejected');
            expect(result).toContain('alice.bsky.social');
            expect(result).toContain('convo-123');
            expect(result).toContain('- **DM rejected** (2026-03-22T16:00:00.000Z) uuid: test-uuid-dm-1\n  Reason: Not appropriate\n  Recipients: ["alice.bsky.social"]\n  convoId: convo-123\n  Text: Hey there');
        });

        test('separates distinct rejected posts so each reason stays with its post', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));
            const bskyRejectionBackend = {
                listRejections: mock(async () => [
                    { type: 'dm', uuid: 'first', text: 'First text', recipientHandles: ['alice'], convoId: 'one', reason: 'First reason', rejectedAt: '2026-03-22T16:00:00.000Z' },
                    { type: 'dm', uuid: 'second', text: 'Second text', recipientHandles: ['bob'], convoId: 'two', reason: 'Second reason', rejectedAt: '2026-03-22T17:00:00.000Z' },
                ]),
            } as unknown as BskyRejectionBackend;
            const result = await createContextBuilder({ backend, bskyRejectionBackend }).buildPerchContext();
            expect(result).toContain('  Text: First text\n\n- **DM rejected** (2026-03-22T17:00:00.000Z) uuid: second');
        });

        test('should include rootUri and rootCid when present in reply rejection', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockRejectionBackend = {
                listRejections: mock(async () => [{
                    type:         'reply' as const,
                    uuid:         'test-uuid-reply-2',
                    text:         'Great post!',
                    targetHandle: 'someone.bsky.social',
                    reply:        {
                        parent: { uri: createAtUri('at://parent'), cid: createCid('bafyreparent') },
                        root:   { uri: createAtUri('at://root'), cid: createCid('bafyreroot') },
                    },
                    reason:     'Off topic',
                    rejectedAt: '2026-03-22T15:30:00.000Z',
                }]),
            } as unknown as BskyRejectionBackend;

            const builder = createContextBuilder({
                backend,
                bskyRejectionBackend: mockRejectionBackend,
            });

            const result = await builder.buildPerchContext();

            expect(result).toContain('rootUri: at://root');
            expect(result).toContain('rootCid: bafyreroot');
        });
    });
});
