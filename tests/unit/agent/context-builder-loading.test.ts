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
            // Create 9 items to exceed maxStateFullItems (default 8)
            const items = _.times(9, i => ({
                item: {
                    path:           createMemoryPath(`/state/task${i}.md`),
                    content:        'Content ' + i,
                    contentPreview: 'Preview ' + i,
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
            const items = _.times(50, i => ({
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
                maxStateFullItems:    2,
                maxStatePreviewItems: 2,
            });
            const result = await contextBuilder.loadHotState(now);

            expect(result).toContain('...and 46 more state memories (use \'list /state\' to see all)');
        });

        test('should respect maxStateFullItems count', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = _.times(3, i => ({
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
                maxStateFullItems: 2,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should have 2 full content items + 1 preview
            const fullTierItems = (result.match(/\/state\/task\d+\.md:\n/g) ?? []).length;
            expect(fullTierItems).toBe(2);
            expect(result).toContain('- /state/task2.md (2h ago):');
        });

        test('should respect maxStatePreviewItems count', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const items = _.times(40, i => ({
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
                maxStateFullItems:    0, // Force all to preview tier
                maxStatePreviewItems: 5,
            });
            const result = await contextBuilder.loadHotState(now);

            // Should have 5 preview items
            const previewItems = (result.match(/- \/state\/task\d+\.md \(2h ago\):/g) ?? []).length;
            expect(previewItems).toBe(5);
            // And overflow indicator
            expect(result).toContain('...and 35 more state memories');
        });

        test('should truncate items exceeding maxStateItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = _.repeat('x', 3000);

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
            expect(result).toContain(_.repeat('x', 2000));
            expect(result).toContain('[truncated — use \'memory view /state/long.md\' for full content]');
            expect(result).not.toContain(_.repeat('x', 2001));
        });

        test('should not truncate items within maxStateItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const content = _.repeat('x', 500);

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
            const items = _.times(20, i => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     'Content ' + i,
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
            const items = _.times(8, i => ({
                item: {
                    path:        createMemoryPath(`/state/task${i}.md`),
                    content:     'Content ' + i,
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
            const longContent = _.repeat('x', 15000);

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
                ..._.times(9, i => ({
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
                    score: 0.90,
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

            const [, , layerArg, optionsArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string, string, { limit: number }];
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
                items: [{
                    path:        createMemoryPath('/events/old-event'),
                    content:     'Old fallback event',
                    contentType: 'text/plain' as const,
                    tags:        new Set<string>(),
                    metadata:    {},
                    version:     1,
                    createdAt:   '2024-12-01T10:00:00.000Z',
                    updatedAt:   '2024-12-01T10:00:00.000Z',
                }],
            })); // Fallback to old events

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should contain fallback warning
            expect(result).toContain('⚠️ No activity in the last 14 days. Showing older events:');
            expect(result).toContain('Old fallback event');
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
            const event11Lines = _.filter(_.split(result, '\n'), line => _.includes(line, '/events/event11'));
            expect(_.some(event11Lines, line => _.startsWith(line, '- '))).toBe(false);

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
            const previewLines = _.filter(_.split(result, '\n'), line => _.startsWith(_.trim(line), '- /events/'));
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
            const longContent = _.repeat('A', 3000); // Longer than default 2000
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

            // Should contain truncation message
            expect(result).toContain('[truncated — use \'memory view /events/long-event\' for full content]');
            // Content should be truncated to ~2000 chars (plus truncation message)
            const eventSectionMatch = /\/events\/long-event[\s\S]*?\n\n/.exec(result);
            const eventSection = eventSectionMatch?.[0] ?? '';
            // Should be significantly shorter than 3000 chars
            expect(eventSection.length).toBeLessThan(2200);
        });

        test('should respect custom maxEventItemMaxChars option', async () => {
            const longContent = _.repeat('B', 1500);
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
    });

    describe('buildPerchContext', () => {
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
        });

        test('should not include Recent Focus when no state items exist', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Recent Focus');
        });

        test('should not include Recent Events when no events exist', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Recent Events');
        });

        test('should truncate state items exceeding maxStateItemMaxChars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = _.repeat('x', 3000);

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

            expect(result).toContain('[truncated');
            expect(result).not.toContain(_.repeat('x', 3000));
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
                    score: 0.90,
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
            const exactContent = _.repeat('x', 2000); // Exactly 2000 chars

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
            const longContent = _.repeat('y', 3000);

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

            expect(result).toContain('[truncated');
            expect(result).not.toContain(_.repeat('y', 3000));
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

        test('should skip inbox section when emailService is not provided', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            // No emailService passed
            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Inbox');
        });

        test('should include inbox section when emailService provided and unread > 0', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 5, unread: 2 })),
                },
                imap: {
                    listUnread: mock(async () => [
                        { uid: 1, from: { name: 'Alice', address: 'alice@example.com' }, subject: 'Hello', date: new Date('2025-01-15T10:00:00.000Z') },
                        { uid: 2, from: { address: 'bob@example.com' },                  subject: 'World', date: new Date('2025-01-15T11:00:00.000Z') },
                    ]),
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
        });

        test('should skip inbox section when emailService provided but unread === 0', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 5, unread: 0 })),
                },
                imap: {
                    listUnread: mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('## Inbox');
            // listUnread should NOT be called when unread count is 0
            expect(emailService.imap.listUnread).not.toHaveBeenCalled();
        });

        test('should skip inbox section and log warning when emailService throws', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => {
                        throw new Error('DynamoDB timeout');
                    }),
                },
                imap: {
                    listUnread: mock(async () => []),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            // Inbox section is skipped silently
            expect(result).not.toContain('## Inbox');
            // Warning is logged
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('should call listUnread with CleanInbox when unread > 0', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 3, unread: 1 })),
                },
                imap: {
                    listUnread: mock(async () => [
                        { uid: 10, from: { address: 'x@x.com' }, subject: 'Only', date: new Date('2025-01-15T09:00:00.000Z') },
                    ]),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            await contextBuilder.buildPerchContext(now);

            expect(emailService.imap.listUnread).toHaveBeenCalledWith('CleanInbox');
        });

        test('should format inbox UIDs as CleanInbox:UID for agent reference', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 3, unread: 1 })),
                },
                imap: {
                    listUnread: mock(async () => [
                        { uid: 42, from: { address: 'sender@example.com' }, subject: 'Test', date: new Date('2025-01-15T09:00:00.000Z') },
                    ]),
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
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async (_folder: string, flag: string) => {
                        if(flag === '\\SendRejectedByAdmin') {
                            return [99];
                        }
                        return []; // No gave-up drafts — isolate subject to rejection line only
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(async () => ({
                        id:       99,
                        subject:  'Hi there',
                        to:       [{ address: 'bob@example.com' }],
                        metaData: {
                            rejectedAt: '2024-01-01T00:00:00.000Z',
                            reason:     'Inappropriate content',
                        },
                    })),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('Messages You Attempted to Send (Rejected by Admin)');
            expect(result).toContain('bob@example.com');
            // Verify subject appears in rejection line: Subject: "Hi there" (not just anywhere)
            expect(result).toContain('Subject: "Hi there"');
            expect(result).toContain('Inappropriate content');
        });

        test('should skip rejected drafts section when no rejected UIDs', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async () => []),
                },
                wildDuckClient: {
                    getMessage: mock(_.constant(Promise.resolve(null))),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
        });

        test('should skip rejected drafts section when wildDuckClient is not provided', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const mockSearchByFlag = mock(async () => [99]);
            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mockSearchByFlag,
                },
                // no wildDuckClient
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
        });

        test('should skip rejected drafts section when imap has no searchByFlag', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread: mock(async () => []),
                    // no searchByFlag
                },
                wildDuckClient: {
                    getMessage: mock(_.constant(Promise.resolve(null))),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
        });

        test('should skip drafts without rejectedAt in metaData', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async () => [55]),
                },
                wildDuckClient: {
                    getMessage: mock(async () => ({
                        id:       55,
                        subject:  'Test',
                        to:       [{ address: 'alice@example.com' }],
                        metaData: {
                            // no rejectedAt — this is a pending draft
                        },
                    })),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
        });

        test('should log warning and not crash when searchByFlag throws', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async () => {
                        throw new Error('IMAP flag search failed');
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(_.constant(Promise.resolve(null))),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('Messages You Attempted to Send');
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        // DiscordNotifyGaveUp escalation section
        // -------------------------------------------------------------------

        test('should include CRITICAL escalation section when DiscordNotifyGaveUp UIDs present', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            let _searchByFlagCallCount = 0;
            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async (folder: string, flag: string) => {
                        _searchByFlagCallCount++;
                        if(flag === '\\DiscordNotifyGaveUp') {
                            return [101];
                        }
                        return []; // No rejected-by-admin drafts
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(async () => ({
                        id:      101,
                        subject: 'Urgent email',
                        to:      [{ address: 'frank@example.com' }],
                    })),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('CRITICAL');
            expect(result).toContain('frank@example.com');
            expect(result).toContain('Urgent email');
            expect(result).toContain('Drafts:101');
            expect(result).toContain('Craig');
        });

        test('should not include CRITICAL escalation when no DiscordNotifyGaveUp UIDs', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async () => []),
                },
                wildDuckClient: {
                    getMessage: mock(_.constant(Promise.resolve(null))),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).not.toContain('CRITICAL');
        });

        test('should include both rejected and CRITICAL sections when both types of UIDs present', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async (_folder: string, flag: string) => {
                        if(flag === '\\SendRejectedByAdmin') {
                            return [200];
                        }
                        if(flag === '\\DiscordNotifyGaveUp') {
                            return [201];
                        }
                        return [];
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(async (_folder: string, uid: number) => {
                        if(uid === 200) {
                            return {
                                id:       200,
                                subject:  'Rejected email',
                                to:       [{ address: 'grace@example.com' }],
                                metaData: { rejectedAt: '2024-01-01T00:00:00.000Z', reason: 'Off-topic' },
                            };
                        }
                        return {
                            id:      201,
                            subject: 'Failed notify email',
                            to:      [{ address: 'henry@example.com' }],
                        };
                    }),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('Messages You Attempted to Send (Rejected by Admin)');
            expect(result).toContain('grace@example.com');
            expect(result).toContain('CRITICAL');
            expect(result).toContain('henry@example.com');
        });

        test('should use (no subject) fallback for gave-up drafts with no subject', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async (_folder: string, flag: string) => {
                        if(flag === '\\DiscordNotifyGaveUp') {
                            return [300];
                        }
                        return [];
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(async () => ({
                        id: 300,
                        to: [{ address: 'iris@example.com' }],
                        // no subject
                    })),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            expect(result).toContain('CRITICAL');
            expect(result).toContain('(no subject)');
        });

        test('should join multiple to-addresses with comma-space in gave-up section', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async (_folder: string, flag: string) => {
                        if(flag === '\\DiscordNotifyGaveUp') {
                            return [400];
                        }
                        return [];
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(async () => ({
                        id:      400,
                        subject: 'Multi-recipient draft',
                        to:      [{ address: 'alice@example.com' }, { address: 'bob@example.com' }],
                    })),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            // Both addresses must appear joined with ", " (not run together)
            expect(result).toContain('alice@example.com, bob@example.com');
        });

        test('should join both sections with double newline when both are present', async () => {
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const emailService = {
                counterStore: {
                    getCounters: mock(async () => ({ total: 0, unread: 0 })),
                },
                imap: {
                    listUnread:   mock(async () => []),
                    searchByFlag: mock(async (_folder: string, flag: string) => {
                        if(flag === '\\SendRejectedByAdmin') {
                            return [500];
                        }
                        if(flag === '\\DiscordNotifyGaveUp') {
                            return [501];
                        }
                        return [];
                    }),
                },
                wildDuckClient: {
                    getMessage: mock(async (_folder: string, uid: number) => {
                        if(uid === 500) {
                            return {
                                id:       500,
                                subject:  'Rejected subject',
                                to:       [{ address: 'carol@example.com' }],
                                metaData: { rejectedAt: '2024-01-01T00:00:00.000Z', reason: 'Spam' },
                            };
                        }
                        return {
                            id:      501,
                            subject: 'GaveUp subject',
                            to:      [{ address: 'dave@example.com' }],
                        };
                    }),
                },
            };

            const contextBuilder = createContextBuilder({ backend, emailService });
            const result = await contextBuilder.buildPerchContext();

            // Both section headers must be present
            expect(result).toContain('Messages You Attempted to Send (Rejected by Admin)');
            expect(result).toContain('CRITICAL');
            // Sections must be separated by double newline (not concatenated)
            expect(result).toContain('## Messages You Attempted to Send (Rejected by Admin)');
            const rejectedIdx = result.indexOf('## Messages You Attempted to Send (Rejected by Admin)');
            const criticalIdx = result.indexOf('## CRITICAL');
            const between = result.slice(rejectedIdx, criticalIdx);
            expect(between).toContain('\n\n');
        });
    });
});
