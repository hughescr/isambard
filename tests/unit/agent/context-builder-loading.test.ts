/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../setup';
import { createContextBuilder } from '../../../src/agent/context-builder';
import { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import { createMemoryPath } from '../../../src/storage/memory-tool/types';

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

    describe('recordAccess', () => {
        test('should update accessCount for a single path', async () => {
            const path = createMemoryPath('/state/task.md');

            backend.get = mock(async () => ({
                path,
                content:     'Test content',
                contentType: 'text/markdown' as const,
                metadata:    { accessCount: 5 },
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Test content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 6, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            expect(backend.update).toHaveBeenCalledWith(
                path,

                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  6,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        test('should initialize accessCount to 1 if not present', async () => {
            const path = createMemoryPath('/state/new.md');

            backend.get = mock(async () => ({
                path,
                content:     'New content',
                contentType: 'text/markdown' as const,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'New content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            expect(backend.update).toHaveBeenCalledWith(
                path,

                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        test('should update multiple paths', async () => {
            const path1 = createMemoryPath('/state/task1.md');
            const path2 = createMemoryPath('/state/task2.md');

            backend.get = mock(async (p: typeof path1) => ({
                path:        p,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { accessCount: 1 },
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path:        path1,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 2, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path1, path2]);

            expect(backend.update).toHaveBeenCalledTimes(2);
        });

        test('should handle empty path array', async () => {
            backend.update = mock(async () => {
                throw new Error('Should not be called');
            });

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw
            await contextBuilder.recordAccess([]);
            expect(backend.update).not.toHaveBeenCalled();
        });

        test('should skip paths that do not exist', async () => {
            const path = createMemoryPath('/state/nonexistent.md');

            backend.get = mock(async () => undefined);
            backend.update = mock(async () => {
                throw new Error('Should not be called');
            });

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw
            await contextBuilder.recordAccess([path]);
            expect(backend.update).not.toHaveBeenCalled();
        });

        test('should handle metadata.accessCount being non-numeric', async () => {
            const path = createMemoryPath('/state/task.md');

            backend.get = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { accessCount: 'invalid' }, // Non-numeric value
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            // Should treat non-numeric as 0 and set to 1
            expect(backend.update).toHaveBeenCalledWith(
                path,

                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        test('should handle item with metadata that has undefined accessCount (optional chaining test)', async () => {
            const path = createMemoryPath('/state/task.md');

            // Metadata exists but doesn't have accessCount property
            backend.get = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { otherField: 'value' }, // accessCount not present
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { otherField: 'value', accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            // Should initialize accessCount to 1 and preserve other metadata
            expect(backend.update).toHaveBeenCalledWith(
                path,

                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        otherField:   'value',
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });
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
            const longContent = _.repeat('x', 3000);

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
            expect(identity).toContain(_.repeat('x', 397) + '...');
            // Should contain overflow note
            expect(identity).toContain("...and 1 total identity memories (use 'list /identity' to see all)");
            // Verify the truncated portion starts correctly
            expect(identity.slice(0, 397)).toBe(_.repeat('x', 397));
        });

        test.each([
            { contentLength: 3000, description: 'exceeding maxIdentityChars', shouldTruncate: true },
            { contentLength: 401, description: 'single character over limit', shouldTruncate: true },
            { contentLength: 400, description: 'exactly at maxIdentityChars', shouldTruncate: false },
            { contentLength: 300, description: 'less than maxIdentityChars', shouldTruncate: false },
        ])('should handle truncation when $description', async ({ contentLength, shouldTruncate }) => {
            const content = _.repeat('x', contentLength);

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
                expect(identity).toContain(_.repeat('x', 397) + '...');
                expect(identity).toContain("...and 1 total identity memories (use 'list /identity' to see all)");
                expect(identity.slice(0, 397)).toBe(_.repeat('x', 397));
            } else {
                expect(identity).toBe(content);
                expect(identity).not.toContain('total identity memories');
            }
        });

        test('should truncate content at exactly maxIdentityChars - 3 characters before ellipsis', async () => {
            // Use content of exactly 403 chars with a budget of 400 chars
            // This ensures the slice at (maxIdentityChars - 3) = 397 is precise
            const content = _.repeat('a', 397) + 'BCDEFG'; // 404 chars

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
            expect(identity).toContain(_.repeat('a', 397) + '...');
            expect(identity).not.toContain('B');
        });

        test('should log identity length including overflow note', async () => {
            const longContent = _.repeat('x', 500);

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
            const longContent = _.repeat('x', 15000); // Way over default limit

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:           createMemoryPath('/state/task1.md'),
                        content:        longContent,
                        contentPreview: 'This is a preview',
                        contentType:    'text/markdown' as const,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-15T10:00:00.000Z',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            // Should use preview format with content truncated to 100 chars
            // formatMemoryPreview uses content (when available) truncated to 100 chars + '...'
            expect(result).toContain(`- /state/task1.md (2h ago): ${_.repeat('x', 100)}...`);
            expect(result).not.toContain(longContent);
        });

        test('should show overflow indicator when items exceed both tiers', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = _.times(100, i => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     _.repeat('x', 200),
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
                maxStateFullTokens:    100,  // Very small to force overflow
                maxStatePreviewTokens: 100,
            });
            const result = await contextBuilder.loadHotState(now);

            expect(result).toContain('...and ');
            expect(result).toContain('more state memories (use \'list /state\' to see all)');
        });

        test('should respect maxStateFullTokens budget', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = _.times(10, i => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     _.repeat('x', 500),
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
                maxStateFullTokens: 200, // 800 chars
            });
            const result = await contextBuilder.loadHotState(now);

            // At 500 chars per item, should fit 1 item in full tier (with path overhead)
            const fullTierItems = (result.match(/\/state\/task\d+\.md:\n/g) ?? []).length;
            expect(fullTierItems).toBeLessThanOrEqual(2);
        });

        test('should respect maxStatePreviewTokens budget', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = _.times(100, i => ({
                item: {
                    path:           createMemoryPath(`/state/task${i}.md`),
                    content:        _.repeat('x', 5000),
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
                maxStateFullTokens:    0, // Force all to preview tier
                maxStatePreviewTokens: 100, // 400 chars total for previews
            });
            const result = await contextBuilder.loadHotState(now);

            // Should have preview tier items
            const previewItems = (result.match(/- \/state\/task\d+\.md \(\d+h ago\):/g) ?? []).length;
            expect(previewItems).toBeGreaterThan(0);
            expect(previewItems).toBeLessThan(100); // Not all items fit
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
            // Item with very long content that won't fit in full tier
            const longContent = _.repeat('x', 15000);

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/preview.md'),
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

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { fullTierCount: 0, previewTierCount: 1, overflowCount: 0, stateLength: result.length },
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
                    score: 0.90,
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadHotState(now);

            // Items should be separated by \n (not \n\n or empty)
            expect(result).toBe('/state/item1.md:\nItem 1\n/state/item2.md:\nItem 2');
        });

        test('should include item in full tier when it exactly fills the budget (boundary test for <=)', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // Item formatted as "/state/x.md:\ny" = 14 chars
            // Set maxStateFullTokens so budget = exactly 14 chars (14/4 = 3.5, use 4 -> 16 chars, too much)
            // Actually: item = "/state/x.md:\ny" = 14 chars. We need budget = 14 -> 14/4 = 3.5 tokens.
            // With integer tokens, let's compute: path="/state/exact.md", content="z" -> "/state/exact.md:\nz" = 19 chars
            // Need budget of exactly 19: 19/4 = 4.75. Not integer.
            // Better approach: use a content length that gives exact multiple of 4.
            // Path "/state/x.md" = 11 chars. ":\n" = 2 chars. Content = "y" = 1 char. Total = 14 chars.
            // maxStateFullTokens=4 -> 16 chars budget. 14 <= 16, fits.
            // maxStateFullTokens=3 -> 12 chars budget. 14 > 12, doesn't fit.
            // For exact boundary: we need formatted.length == budget.
            // Let's use content that makes it exactly 16 chars: "/state/x.md:\nyyy" = 16 chars. Content = "yyy"
            // Then maxStateFullTokens=4 -> 16 chars. 16 <= 16 = true (included in full tier)
            // With mutation to <: 16 < 16 = false (falls to preview tier)

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/x.md'),
                        content:     'yyy',
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
                maxStateFullTokens: 4, // 16 chars = exactly "/state/x.md:\nyyy".length
            });
            const result = await contextBuilder.loadHotState(now);

            // Should be in full tier (full content format), not preview tier
            expect(result).toBe('/state/x.md:\nyyy');
        });

        test('should include item in preview tier when it exactly fills the preview budget (boundary test for <=)', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = _.repeat('x', 15000);
            // Preview for /state/xx.md: "- /state/xx.md (2h ago): " (25) + 100 x's + "..." (3) = 128 chars
            // 128 chars / 4 = 32 tokens exactly

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/xx.md'),
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
                maxStateFullTokens:    0,  // Force everything to preview tier
                maxStatePreviewTokens: 32, // 128 chars = exactly preview string length
            });
            const result = await contextBuilder.loadHotState(now);

            // Should be in preview tier (not overflow)
            expect(result).toContain('- /state/xx.md (2h ago):');
            expect(result).not.toContain('...and');
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

        test('should multiply maxStateFullTokens by CHARS_PER_TOKEN (4) for budget', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // maxStateFullTokens=50 -> should be 200 chars (50*4)
            // If mutation changes * to /, it would be 50/4=12.5 chars
            // Item formatted as "/state/item.md:\nContent" = ~22 chars

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/item.md'),
                        content:     'Content',
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
                maxStateFullTokens: 50, // 200 chars (or 12.5 if mutated to /)
            });
            const result = await contextBuilder.loadHotState(now);

            // With 200 char budget, the ~22-char item should fit in full tier
            expect(result).toBe('/state/item.md:\nContent');
        });

        test('should fill exactly up to maxStateFullTokens budget boundary', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            // maxStateFullTokens=2 -> maxStateFullChars=8. Item "p:\nc" = "/state/a.md:\nc" = 14 chars > 8
            // So even a small item won't fit in a tiny budget

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/a.md'),
                        content:     'c',
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
                maxStateFullTokens: 2, // 8 chars - too small for full tier
            });
            const result = await contextBuilder.loadHotState(now);

            // Should fall through to preview tier since full content doesn't fit
            expect(result).toContain('- /state/a.md');
            expect(result).not.toContain('/state/a.md:\nc');
        });

        test('should track overflow when items exceed both full and preview tiers', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = _.repeat('x', 5000);

            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/overflow.md'),
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
                maxStateFullTokens:    0,  // No full tier budget
                maxStatePreviewTokens: 0,  // No preview tier budget
            });
            const result = await contextBuilder.loadHotState(now);

            // Should show overflow indicator
            expect(result).toContain('...and 1 more state memories');
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ fullTierCount: 0, previewTierCount: 0, overflowCount: 1 }),
                'Hot state loaded'
            );
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
            const items = _.times(50, i => ({
                path:           createMemoryPath(`/users/user123/memory${i}`),
                content:        _.repeat('x', 200),
                contentPreview: _.repeat('x', 100),
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
            const items = _.times(100, i => ({
                path:           createMemoryPath(`/users/user123/memory${i}`),
                content:        _.repeat('x', 200),
                contentPreview: _.repeat('x', 100),
                contentType:    'text/plain' as const,
                metadata:       {},
                version:        1,
                createdAt:      '2025-01-15T10:00:00.000Z',
                updatedAt:      '2025-01-15T10:00:00.000Z',
            }));

            backend.list = mock(async () => ({ items }));

            const contextBuilder = createContextBuilder({
                backend,
                maxUserTokens: 50, // Very small
            });
            const result = await contextBuilder.loadUserMemories('user123', now);

            expect(result).toContain('...and ');
            expect(result).toContain('more user memories (use \'list /users/user123\' to see all)');
        });

        test('should call backend.list with correct path', async () => {
            backend.list = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadUserMemories('alice');

            expect(backend.list).toHaveBeenCalledWith('/users/alice');
        });

        test('should use preview format when content is undefined but contentPreview exists', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Testing edge case where content is undefined (tag index items)
            backend.list = mock(async (): Promise<any> => ({
                items: [{
                    path:           createMemoryPath('/users/user123/note'),
                    content:        undefined, // No full content (tag index item)
                    contentPreview: 'A brief note about the user',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
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

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Testing edge case where both content fields are undefined
            backend.list = mock(async (): Promise<any> => ({
                items: [{
                    path:           createMemoryPath('/users/user123/empty'),
                    content:        undefined,
                    contentPreview: undefined,
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
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
            const lines = _.split(result, '\n');
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain('/users/user123/pref1');
            expect(lines[1]).toContain('/users/user123/pref2');
        });

        test('should log correct memoryCount excluding overflows', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = _.times(50, i => ({
                path:           createMemoryPath(`/users/u1/memory${i}`),
                content:        _.repeat('x', 200),
                contentPreview: _.repeat('x', 100),
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
            const loadedCall = _.find(debugCalls, call =>
                _.isString(call[1]) && call[1] === 'User memories loaded'
            );
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
                        content:        _.repeat('x', 5000),
                        contentPreview: _.repeat('x', 100),
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
            await contextBuilder.loadRecentEvents();
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

            const [, , layerArg, optionsArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string, string, { limit: number }];
            expect(layerArg).toBe('events');
            expect(optionsArg).toEqual({ limit: expectedLimit });
        });

        test('should extract content from results and format with path and age', async () => {
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

            expect(result).toEqual([
                '- /events/event1.md (2h ago): Event 1',
                '- /events/event2.md (1h ago): Event 2',
            ]);
        });

        test('should return empty array when no events found', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents();

            expect(result).toEqual([]);
        });

        test.each([
            { contentLength: 150, description: 'over 100 chars', shouldTruncate: true },
            { contentLength: 100, description: 'exactly 100 chars', shouldTruncate: false },
        ])('should handle event content truncation when $description', async ({ contentLength, shouldTruncate }) => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const content = _.repeat('x', contentLength);

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/test.md'),
                    content,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(5, now);

            expect(result).toHaveLength(1);
            if(shouldTruncate) {
                expect(result[0]).toContain(_.repeat('x', 100) + '...');
                expect(result[0]).not.toContain(_.repeat('x', 101));
            } else {
                expect(result[0]).toBe(`- /events/test.md (2h ago): ${content}`);
                expect(result[0]).not.toContain('...');
            }
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

            // Result should include warning note as first element
            expect(result[0]).toBe('⚠️ No activity in the last 14 days. Showing older events:');
            expect(result[1]).toContain('/events/old-event.md');
            expect(result[1]).toContain('Old event from last month');
            expect(result).toHaveLength(2);
        });

        test('should not add warning note when events found within 14-day window', async () => {
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

            // Should NOT contain warning note
            expect(result[0]).not.toContain('⚠️');
            expect(result[0]).toContain('/events/recent.md');
            expect(result).toHaveLength(1);
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

        test('should not add warning note when fallback also returns empty', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents();

            // Result should be empty with no warning note
            expect(result).toEqual([]);
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

            expect(result).toHaveLength(3);
            // Verify ascending order: oldest first, newest last
            expect(result[0]).toBe('- /events/oldest.md (4h ago): Oldest event');
            expect(result[1]).toBe('- /events/middle.md (2h ago): Middle event');
            expect(result[2]).toBe('- /events/newest.md (1h ago): Newest event');
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

            expect(result).toHaveLength(3); // Warning note + 2 events
            expect(result[0]).toBe('⚠️ No activity in the last 14 days. Showing older events:');
            // After sorting: oldest first
            expect(result[1]).toContain('/events/oldest.md');
            expect(result[2]).toContain('/events/newest.md');
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
            const lines = _.split(result, '\n\n');
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
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString(),
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Recent events]');
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

        test('should format events with dash prefix and newline separator', async () => {
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

            // Events from loadRecentEvents are already prefixed with "- ", joined by newlines
            const eventsSection = /\[Recent events\]\n([\s\S]*?)(?:\n\n|$)/.exec(result);
            expect(eventsSection).toBeTruthy();
            const eventLines = _.split(eventsSection![1], '\n');
            expect(eventLines).toHaveLength(2);
            expect(_.every(eventLines, line => _.startsWith(line, '- '))).toBe(true);
            // Should NOT have double-dash (events are already formatted with "- " prefix)
            expect(_.some(eventLines, line => _.startsWith(line, '- - '))).toBe(false);
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
    });
});
