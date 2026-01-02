/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../setup';
import { createContextBuilder } from '../../../src/agent/context-builder';
import { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import { createMemoryPath } from '../../../src/storage/memory-tool/types';

describe.concurrent('createContextBuilder loading methods', () => {
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
        });

        test('should truncate content with ellipsis when exceeding maxIdentityChars', async () => {
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

            // Should be truncated to maxChars - 3 + '...'
            expect(_.size(identity)).toBe(400);
            expect(_.endsWith(identity, '...')).toBe(true);
            // Verify exactly 3 chars for ellipsis
            expect(_.slice(identity, -3).join('')).toBe('...');
        });

        test('should use exactly slice(0, maxIdentityChars - 3) for truncation', async () => {
            const content = _.repeat('y', 500);

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

            // Verify exact truncation: slice(0, 397) + '...'
            expect(identity.length).toBe(400);
            const contentPart = identity.slice(0, -3);
            expect(contentPart.length).toBe(397);
            expect(contentPart).toBe(_.repeat('y', 397));
        });

        test('should NOT truncate when content equals maxIdentityChars exactly', async () => {
            const content = _.repeat('z', 400);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/exact.md'),
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

            // Should NOT add ellipsis when exactly at limit
            expect(identity).toBe(content);
            expect(identity).not.toContain('...');
        });

        test('should NOT truncate when content is less than maxIdentityChars', async () => {
            const content = _.repeat('w', 300);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/short.md'),
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

            // Should return content as-is
            expect(identity).toBe(content);
            expect(identity).not.toContain('...');
        });

        test('should handle single character over limit (boundary test)', async () => {
            const content = _.repeat('a', 401);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/boundary.md'),
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

            // Even 1 char over should trigger truncation
            expect(_.size(identity)).toBe(400);
            expect(_.endsWith(identity, '...')).toBe(true);
        });

        test('should extract content from each item correctly', async () => {
            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/a.md'),
                        content:     'Content A',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/identity/b.md'),
                        content:     'Content B',
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

            // Verify each item's content is extracted
            expect(identity).toContain('Content A');
            expect(identity).toContain('Content B');
        });

        test('should log when loading core identity starts', async () => {
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadCoreIdentity();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    msg: 'Loading core identity...',
                })
            );
        });

        test('should log identityLength: 0 when no identity items exist', async () => {
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadCoreIdentity();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    identityLength: 0,
                    msg:            'Core identity loaded',
                })
            );
        });

        test('should log identityLength matching result length when items exist', async () => {
            const content = 'Test identity content';

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

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadCoreIdentity();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    identityLength: result.length,
                    msg:            'Core identity loaded',
                })
            );
        });
    });

    describe('loadRecentContext', () => {
        test('should load recent context for a specific user', async () => {
            const userId = 'user123';
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/recent1.md'),
                        content:     'Recent memory 1',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext(userId, 3, now);

            expect(backend.searchByTag).toHaveBeenCalledWith('user:user123', undefined, { limit: 3 });
            expect(context).toEqual(['- /state/recent1.md (2w ago): Recent memory 1']);
        });

        test('should use default limit of 3', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('user456');

            expect(backend.searchByTag).toHaveBeenCalledWith('user:user456', undefined, { limit: 3 });
        });

        test('should use custom limit when provided', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('user789', 10);

            expect(backend.searchByTag).toHaveBeenCalledWith('user:user789', undefined, { limit: 10 });
        });

        test('should format user tag correctly in search', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('test-user');

            // Verify exact tag format: "user:${userId}"
            expect(backend.searchByTag).toHaveBeenCalledWith('user:test-user', undefined, { limit: 3 });
        });

        test('should extract content from all returned items', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/item1.md'),
                        content:     'Memory 1',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/state/item2.md'),
                        content:     'Memory 2',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/state/item3.md'),
                        content:     'Memory 3',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-multi', 3, now);

            expect(context).toEqual([
                '- /state/item1.md (2w ago): Memory 1',
                '- /state/item2.md (2w ago): Memory 2',
                '- /state/item3.md (2w ago): Memory 3',
            ]);
            expect(context.length).toBe(3);
        });

        test('should return empty array when no items found', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-empty');

            expect(context).toEqual([]);
        });

        test('should map each item to formatted string with path and content', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/a.md'),
                        content:     'Content A',
                        contentType: 'text/markdown' as const,
                        metadata:    { extra: 'data' },
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-map', 3, now);

            // Should contain formatted string with path and content
            expect(context).toEqual(['- /state/a.md (2w ago): Content A']);
        });

        test('should log when loading user context starts', async () => {
            const userId = 'test-user-log';

            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext(userId);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId,
                    msg: 'Loading user context',
                })
            );
        });

        test('should log userId and memoryCount when user context loaded', async () => {
            const userId = 'test-user-loaded';

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/mem1.md'),
                        content:     'Memory 1',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/state/mem2.md'),
                        content:     'Memory 2',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext(userId);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId,
                    memoryCount: 2,
                    msg:         'User context loaded',
                })
            );
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

        test('should pass limit to backend with default value of 50', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents();

            // Check the options argument (4th parameter)
            const [, , , optionsArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string, string, { limit: number }];
            expect(optionsArg).toEqual({ limit: 50 });
        });

        test('should pass custom limit to backend', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents(10);

            const [, , , optionsArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string, string, { limit: number }];
            expect(optionsArg).toEqual({ limit: 10 });
        });

        test('should pass events layer to backend', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents();

            // Check the layer argument (3rd parameter)
            const [, , layerArg] = (backend.searchByTimeRange as ReturnType<typeof mock>).mock.calls[0] as [string, string, string];
            expect(layerArg).toBe('events');
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
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents();

            expect(result).toEqual([]);
        });

        test('should format as string not object', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event.md'),
                    content:     'My Event Content',
                    contentType: 'text/markdown' as const,
                    metadata:    { important: true },
                    version:     1,
                    createdAt:   '2025-01-15T10:00:00.000Z',
                    updatedAt:   '2025-01-15T10:00:00.000Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentEvents(5, now);

            // Should contain formatted string, not object
            expect(result).toHaveLength(1);
            expect(result[0]).toBe('- /events/event.md (2h ago): My Event Content');
            // Verify it's a string not an object
            expect(typeof result[0]).toBe('string');
        });

        test('should log when loading recent events starts', async () => {
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] })); // Mock fallback

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    msg: 'Loading recent events',
                })
            );
        });

        test('should log eventCount when recent events loaded', async () => {
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event1.md'),
                    content:     'Event 1',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/events/event2.md'),
                    content:     'Event 2',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/events/event3.md'),
                    content:     'Event 3',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentEvents();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventCount: 3,
                    msg:        'Recent events loaded',
                })
            );
        });

        test('should format events with path, age, and content preview', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event1.md'),
                    content:     'Event content here',
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
            expect(result[0]).toBe('- /events/event1.md (2h ago): Event content here');
        });

        test('should truncate event content at 100 chars with ellipsis', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = _.repeat('x', 150);

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/long.md'),
                    content:     longContent,
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
            // Format: "- /events/long.md (2h ago): " + 100 chars + "..."
            expect(result[0]).toContain(_.repeat('x', 100) + '...');
            expect(result[0]).not.toContain(_.repeat('x', 101));
        });

        test('should not truncate event content at exactly 100 chars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const exactContent = _.repeat('y', 100);

            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/exact.md'),
                    content:     exactContent,
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
            expect(result[0]).toBe(`- /events/exact.md (2h ago): ${exactContent}`);
            expect(result[0]).not.toContain('...');
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

    describe('loadRecentContext - new format', () => {
        test('should format context with path, age, and content preview', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/task.md'),
                        content:     'Working on feature',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe('- /state/task.md (2h ago): Working on feature');
        });

        test('should truncate context content at 100 chars with ellipsis', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const longContent = _.repeat('a', 150);

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/long.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toContain(_.repeat('a', 100) + '...');
            expect(result[0]).not.toContain(_.repeat('a', 101));
        });

        test('should not truncate context content at exactly 100 chars', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const exactContent = _.repeat('b', 100);

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/exact.md'),
                        content:     exactContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(`- /state/exact.md (2h ago): ${exactContent}`);
            expect(result[0]).not.toContain('...');
        });

        test('should format multiple context items correctly', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/task1.md'),
                        content:     'First task',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T11:00:00.000Z',
                        updatedAt:   '2025-01-15T11:00:00.000Z',
                    },
                    {
                        path:        createMemoryPath('/state/task2.md'),
                        content:     'Second task',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-14T12:00:00.000Z',
                        updatedAt:   '2025-01-14T12:00:00.000Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(2);
            expect(result[0]).toBe('- /state/task1.md (1h ago): First task');
            expect(result[1]).toBe('- /state/task2.md (1d ago): Second task');
        });

        test('should use current time when now parameter not provided', async () => {
            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/recent.md'),
                        content:     'Recent content',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   new Date(Date.now() - 30000).toISOString(),
                        updatedAt:   new Date(Date.now() - 30000).toISOString(),
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123');

            expect(result).toHaveLength(1);
            // Should contain "now" for very recent items
            expect(result[0]).toMatch(/- \/state\/recent\.md \(now\): Recent content/);
        });
    });

    describe('loadUserTimezone', () => {
        test('should return timezone content when found', async () => {
            const userId = 'user123';

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
            const result = await contextBuilder.loadUserTimezone(userId);

            expect(result).toBe('America/Los_Angeles');
        });

        test('should return undefined when timezone not found', async () => {
            const userId = 'user-no-tz';

            backend.get = mock(async () => undefined);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserTimezone(userId);

            expect(result).toBeUndefined();
        });

        test('should construct correct path from userId', async () => {
            const userId = 'test-user-path';

            backend.get = mock(async () => undefined);

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadUserTimezone(userId);

            expect(backend.get).toHaveBeenCalledWith(createMemoryPath('/users/test-user-path/timezone'));
        });

        test('should log debug message when timezone not found', async () => {
            const userId = 'user-log-test';

            backend.get = mock(async () => undefined);

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadUserTimezone(userId);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId,
                    msg: 'User timezone not found',
                })
            );
        });

        test('should not log "not found" when timezone is found', async () => {
            const userId = 'user-found';

            backend.get = mock(async () => ({
                path:        createMemoryPath('/users/user-found/timezone'),
                content:     'Europe/London',
                contentType: 'text/plain' as const,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadUserTimezone(userId);

            // Should not have called debug with 'User timezone not found'
            const notFoundCalls = _.filter(
                mockLogger.debug.mock.calls,
                (call: unknown[]) =>
                    _.isObject(call[0])
                    && call[0] !== null
                    && 'msg' in call[0]
                    && (call[0] as { msg: string }).msg === 'User timezone not found'
            );
            expect(notFoundCalls).toHaveLength(0);
        });

        test('should handle different timezone formats', async () => {
            const userId = 'user-tz-format';

            backend.get = mock(async () => ({
                path:        createMemoryPath('/users/user-tz-format/timezone'),
                content:     'Asia/Tokyo',
                contentType: 'text/plain' as const,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadUserTimezone(userId);

            expect(result).toBe('Asia/Tokyo');
        });
    });
});
