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
            // Verify content before ellipsis is correct
            expect(_.slice(identity, 0, 397).join('')).toBe(_.repeat('x', 397));
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
                expect(identity.length).toBe(400);
                expect(_.endsWith(identity, '...')).toBe(true);
                expect(identity.slice(0, -3)).toBe(_.repeat('x', 397));
            } else {
                expect(identity).toBe(content);
                expect(identity).not.toContain('...');
            }
        });
    });

    describe('loadRecentContext', () => {
        test('should load recent context with correct tag format and limit', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/recent1.md',
                        memoryPath:     '/state/recent1.md',
                        layer:          'state',
                        updatedAt:      '2025-01-01T00:00:00Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: 'Recent memory 1',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(backend.searchByTags).toHaveBeenCalledWith(new Set(['user:user123']), undefined, { limit: 3 });
            expect(context).toEqual(['- /state/recent1.md (2w ago): [preview] Recent memory 1... (memory view /state/recent1.md for full)']);
            // Verify logger was called with correct messages
            expect(mockLogger.debug).toHaveBeenCalledWith({ userId: 'user123' }, 'Loading user context');
            expect(mockLogger.debug).toHaveBeenCalledWith({ userId: 'user123', memoryCount: 1 }, 'User context loaded');
        });

        test.each([
            { limit: undefined, expectedLimit: 3, description: 'default limit' },
            { limit: 10, expectedLimit: 10, description: 'custom limit' },
        ])('should use $description', async ({ limit, expectedLimit }) => {
            backend.searchByTags = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('user123', limit);

            expect(backend.searchByTags).toHaveBeenCalledWith(new Set(['user:user123']), undefined, { limit: expectedLimit });
        });

        test('should return empty array when no items found', async () => {
            backend.searchByTags = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-empty');

            expect(context).toEqual([]);
        });

        test('should extract content from all returned items', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#user:user-multi',
                        SK:             'PATH#/state/item1.md',
                        memoryPath:     '/state/item1.md',
                        layer:          'state',
                        updatedAt:      '2025-01-01T00:00:00Z',
                        tags:           new Set(['user:user-multi']),
                        contentPreview: 'Memory 1',
                    },
                    {
                        PK:             'TAG#user:user-multi',
                        SK:             'PATH#/state/item2.md',
                        memoryPath:     '/state/item2.md',
                        layer:          'state',
                        updatedAt:      '2025-01-01T00:00:00Z',
                        tags:           new Set(['user:user-multi']),
                        contentPreview: 'Memory 2',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-multi', 3, now);

            expect(context).toEqual([
                '- /state/item1.md (2w ago): [preview] Memory 1... (memory view /state/item1.md for full)',
                '- /state/item2.md (2w ago): [preview] Memory 2... (memory view /state/item2.md for full)',
            ]);
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

    describe('loadRecentContext - formatting', () => {
        test.each([
            { contentLength: 150, description: 'over 100 chars', shouldTruncate: true },
            { contentLength: 100, description: 'exactly 100 chars', shouldTruncate: false },
        ])('should handle content truncation when $description', async ({ contentLength, shouldTruncate: _shouldTruncate }) => {
            const now = new Date('2025-01-15T12:00:00.000Z');
            const content = _.repeat('x', contentLength);

            backend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/test.md',
                        memoryPath:     '/state/test.md',
                        layer:          'state',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: content.slice(0, 100),
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            // TagIndexItem only has contentPreview (max 100 chars), so always shows preview format
            expect(result[0]).toBe(`- /state/test.md (2h ago): [preview] ${content.slice(0, 100)}... (memory view /state/test.md for full)`);
        });

        test('should handle TagIndexItem (contentPreview present)', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/gsi2-item.md',
                        memoryPath:     '/state/gsi2-item.md',
                        layer:          'state',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: 'This is a preview from tag index...',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe('- /state/gsi2-item.md (2h ago): [preview] This is a preview from tag index...... (memory view /state/gsi2-item.md for full)');
        });

        test('should handle contentPreview undefined', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Simulating edge case where preview is undefined
            backend.searchByTags = mock(async (): Promise<any> => ({
                items: [
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/no-content.md',
                        memoryPath:     '/state/no-content.md',
                        layer:          'state',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: undefined,
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe('- /state/no-content.md (2h ago): [no content]');
        });

        test('should use contentPreview from TagIndexItem', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/full-content.md',
                        memoryPath:     '/state/full-content.md',
                        layer:          'state',
                        updatedAt:      '2025-01-15T10:00:00.000Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: 'This is just a preview',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe('- /state/full-content.md (2h ago): [preview] This is just a preview... (memory view /state/full-content.md for full)');
            expect(result[0]).toContain('[preview]');
        });

        test('should format multiple context items with correct timestamps', async () => {
            const now = new Date('2025-01-15T12:00:00.000Z');

            backend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/task1.md',
                        memoryPath:     '/state/task1.md',
                        layer:          'state',
                        updatedAt:      '2025-01-15T11:00:00.000Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: 'First task',
                    },
                    {
                        PK:             'TAG#user:user123',
                        SK:             'PATH#/state/task2.md',
                        memoryPath:     '/state/task2.md',
                        layer:          'state',
                        updatedAt:      '2025-01-14T12:00:00.000Z',
                        tags:           new Set(['user:user123']),
                        contentPreview: 'Second task',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.loadRecentContext('user123', 3, now);

            expect(result).toEqual([
                '- /state/task1.md (1h ago): [preview] First task... (memory view /state/task1.md for full)',
                '- /state/task2.md (1d ago): [preview] Second task... (memory view /state/task2.md for full)',
            ]);
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
        test('should include user memories section when user has memories', async () => {
            backend.searchByTags = mock(async (tags: Set<string>) => {
                if(tags.has('user:user123')) {
                    return {
                        items: [
                            {
                                PK:             'TAG#user:user123',
                                SK:             'PATH#/state/item1.md',
                                memoryPath:     '/state/item1.md',
                                layer:          'state',
                                updatedAt:      new Date().toISOString(),
                                tags:           new Set(['user:user123']),
                                contentPreview: 'User memory 1',
                            },
                        ],
                    };
                }
                return { items: [] };
            });
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[About this user]');
        });

        test('should return empty string when no context available', async () => {
            backend.searchByTags = mock(async () => ({ items: [] }));
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user-empty');

            expect(result).toBe('');
        });

        test('should include bot activities when botUserId provided and has memories', async () => {
            backend.searchByTags = mock(async (tags: Set<string>) => {
                if(tags.has('user:bot123')) {
                    return {
                        items: [
                            {
                                PK:             'TAG#user:bot123',
                                SK:             'PATH#/state/bot-activity.md',
                                memoryPath:     '/state/bot-activity.md',
                                layer:          'state',
                                updatedAt:      new Date().toISOString(),
                                tags:           new Set(['user:bot123']),
                                contentPreview: 'Bot activity',
                            },
                        ],
                    };
                }
                return { items: [] };
            });
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123', 'bot123');

            expect(result).toContain('[Your recent activities]');
        });

        test('should not include bot activities when botUserId is undefined', async () => {
            backend.searchByTags = mock(async () => ({ items: [] }));
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).not.toContain('[Your recent activities]');
        });

        test('should include recent events section', async () => {
            backend.searchByTags = mock(async () => ({ items: [] }));
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event1.md'),
                    content:     'Recent event',
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
        });

        test('should join sections with double newlines and add trailing newlines', async () => {
            // Return memories for user AND events
            backend.searchByTags = mock(async (tags: Set<string>) => {
                if(tags.has('user:user123')) {
                    return {
                        items: [{
                            PK:             'TAG#user:user123',
                            SK:             'PATH#/state/item1.md',
                            memoryPath:     '/state/item1.md',
                            layer:          'state',
                            updatedAt:      new Date().toISOString(),
                            tags:           new Set(['user:user123']),
                            contentPreview: 'Memory',
                        }],
                    };
                }
                return { items: [] };
            });
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
            expect(result).toContain('\n\n[Recent events]');
            // Should end with double newline
            expect(result).toMatch(/\n\n$/);
        });

        test('should format user memories with "- " prefix and full content', async () => {
            backend.searchByTags = mock(async (tags: Set<string>) => {
                if(tags.has('user:user123')) {
                    return {
                        items: [
                            {
                                PK:             'TAG#user:user123',
                                SK:             'PATH#/state/item1.md',
                                memoryPath:     '/state/item1.md',
                                layer:          'state',
                                updatedAt:      new Date().toISOString(),
                                tags:           new Set(['user:user123']),
                                contentPreview: 'User preference: dark mode',
                            },
                            {
                                PK:             'TAG#user:user123',
                                SK:             'PATH#/state/item2.md',
                                memoryPath:     '/state/item2.md',
                                layer:          'state',
                                updatedAt:      new Date().toISOString(),
                                tags:           new Set(['user:user123']),
                                contentPreview: 'Favorite color: blue',
                            },
                        ],
                    };
                }
                return { items: [] };
            });
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should contain section header
            expect(result).toContain('[About this user]');
            // Extract just the items under the section (between header and next section or end)
            const sectionMatch = /\[About this user\]\n([\s\S]*?)(?:\n\n|$)/.exec(result);
            expect(sectionMatch).toBeTruthy();
            const items = _.split(sectionMatch?.[1] ?? '', '\n');
            // Should have 2 items separated by newlines
            expect(items).toHaveLength(2);
            // Every item should start with "- - " (first dash is from _map, second is from loadRecentContext)
            expect(_.every(items, item => _.startsWith(item, '- - '))).toBe(true);
            // Should contain both paths
            expect(result).toContain('/state/item1.md');
            expect(result).toContain('/state/item2.md');
            // Should NOT contain "undefined"
            expect(result).not.toContain('undefined');
        });

        test('should format bot activities with "- " prefix and full content', async () => {
            backend.searchByTags = mock(async (tags: Set<string>) => {
                if(tags.has('user:bot123')) {
                    return {
                        items: [
                            {
                                PK:             'TAG#user:bot123',
                                SK:             'PATH#/state/task1.md',
                                memoryPath:     '/state/task1.md',
                                layer:          'state',
                                updatedAt:      new Date().toISOString(),
                                tags:           new Set(['user:bot123']),
                                contentPreview: 'Completed database migration',
                            },
                            {
                                PK:             'TAG#user:bot123',
                                SK:             'PATH#/state/task2.md',
                                memoryPath:     '/state/task2.md',
                                layer:          'state',
                                updatedAt:      new Date().toISOString(),
                                tags:           new Set(['user:bot123']),
                                contentPreview: 'Updated API documentation',
                            },
                        ],
                    };
                }
                return { items: [] };
            });
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123', 'bot123');

            // Should contain section header
            expect(result).toContain('[Your recent activities]');
            // Extract just the items under the section
            const sectionMatch = /\[Your recent activities\]\n([\s\S]*?)(?:\n\n|$)/.exec(result);
            expect(sectionMatch).toBeTruthy();
            const items = _.split(sectionMatch?.[1] ?? '', '\n');
            // Should have 2 items separated by newlines
            expect(items).toHaveLength(2);
            // Every item should start with "- - " (first dash is from _map, second is from loadRecentContext)
            expect(_.every(items, item => _.startsWith(item, '- - '))).toBe(true);
            // Should contain both paths
            expect(result).toContain('/state/task1.md');
            expect(result).toContain('/state/task2.md');
            // Should NOT contain "undefined"
            expect(result).not.toContain('undefined');
        });

        test('should format recent events with "- " prefix and full content', async () => {
            backend.searchByTags = mock(async () => ({ items: [] }));
            backend.searchByTimeRange = mock(async () => [
                {
                    path:        createMemoryPath('/events/event1.md'),
                    content:     'User logged in from new device',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString(),
                },
                {
                    path:        createMemoryPath('/events/event2.md'),
                    content:     'Password changed successfully',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString(),
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should contain section header
            expect(result).toContain('[Recent events]');
            // Extract just the items under the section
            const sectionMatch = /\[Recent events\]\n([\s\S]*?)(?:\n\n|$)/.exec(result);
            expect(sectionMatch).toBeTruthy();
            const items = _.split(sectionMatch?.[1] ?? '', '\n');
            // Should have 2 items separated by newlines
            expect(items).toHaveLength(2);
            // Every item should start with "- - " (first dash is from _map, second is from loadRecentEvents)
            expect(_.every(items, item => _.startsWith(item, '- - '))).toBe(true);
            // Should contain both events
            expect(result).toContain('/events/event1.md');
            expect(result).toContain('/events/event2.md');
            // Should NOT contain "undefined"
            expect(result).not.toContain('undefined');
        });

        test('should not include bot activities section when bot has no memories', async () => {
            backend.searchByTags = mock(async () => ({ items: [] }));
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123', 'bot-no-memories');

            // Should NOT contain the bot activities section header when bot has no memories
            expect(result).not.toContain('[Your recent activities]');
        });
    });
});
