/* eslint-disable @typescript-eslint/unbound-method -- Mock functions don't have proper this binding */
/* eslint-disable @typescript-eslint/only-throw-error -- Some tests intentionally throw non-Error values */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { mock } from 'bun:test';
import { noop as _noop } from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, ContentType } from '@/storage/memory-tool/types';
import {
    PathAlreadyExistsError,
    InvalidPathError
} from '@/storage/memory-tool/errors';
import {
    create,
    view,
    delete_memory as deleteMemory,
    insert,
    str_replace as strReplace
} from '@/storage/memory-tool/handlers';

describe('Memory Tool Handlers - Consolidate and Logging', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:   mock(async () => ({})),
            get:      mock(async () => undefined),
            update:   mock(async () => ({})),
            'delete': mock(async () => { /* intentionally empty */ }),
            list:     mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;
    });

    describe('consolidate', () => {
        const consolidateHandler = async (
            backend: MemoryToolBackend,
            params: { source_paths: string[], target_path: string, summary: string, keep_sources?: boolean }
        ): Promise<string> => {
            const { consolidate } = await import('@/storage/memory-tool/handlers');
            return consolidate(backend, params);
        };

        it('should create summary and delete sources', async () => {
            mockBackend.get = mock(async (path: MemoryPath) => {
                if(path === '/test/target.md') {
                    return undefined;
                }
                return {
                    path,
                    content:     'Source content',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                };
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/target.md' as MemoryPath,
                content:     'Summary of sources',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await consolidateHandler(mockBackend, {
                source_paths: ['/test/source1.md', '/test/source2.md'],
                target_path:  '/test/target.md',
                summary:      'Summary of sources',
            });

            expect(result).toContain('consolidated');
            expect(result).toContain('/test/target.md');
            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/target.md',
                content:     'Summary of sources',
                contentType: 'text/markdown',
            });
            expect(mockBackend.delete).toHaveBeenCalledTimes(2);
        });

        it('should keep sources when keep_sources is true', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.create = mock(async () => ({
                path:        '/test/target.md' as MemoryPath,
                content:     'Summary',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await consolidateHandler(mockBackend, {
                source_paths: ['/test/source1.md'],
                target_path:  '/test/target.md',
                summary:      'Summary',
                keep_sources: true,
            });

            expect(result).toContain('consolidated');
            expect(mockBackend.delete).not.toHaveBeenCalled();
        });

        it('should throw PathAlreadyExistsError when target exists', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/target.md' as MemoryPath,
                content:     'Existing content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(consolidateHandler(mockBackend, {
                source_paths: ['/test/source1.md'],
                target_path:  '/test/target.md',
                summary:      'Summary',
            })).rejects.toThrow(PathAlreadyExistsError);
        });

        it('should throw InvalidPathError for invalid target path', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(consolidateHandler(mockBackend, {
                source_paths: ['/test/source1.md'],
                target_path:  'bad-path',
                summary:      'Summary',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should throw InvalidPathError for invalid source paths', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(consolidateHandler(mockBackend, {
                source_paths: ['bad-path'],
                target_path:  '/test/target.md',
                summary:      'Summary',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should log warning with error message when source delete fails', async () => {
            const warnSpy = mock(_noop);
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            const originalWarn = console.warn;
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            console.warn = warnSpy;

            try {
                mockBackend.get = mock(async () => undefined);
                mockBackend.create = mock(async () => ({
                    path:        '/test/target.md' as MemoryPath,
                    content:     'Summary',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                }));
                mockBackend.delete = mock(async () => {
                    throw new Error('Delete error message');
                });

                const result = await consolidateHandler(mockBackend, {
                    source_paths: ['/test/source1.md'],
                    target_path:  '/test/target.md',
                    summary:      'Summary',
                });

                expect(result).toContain('consolidated');
                expect(warnSpy).toHaveBeenCalledTimes(1);
                const warnMessage = warnSpy.mock.calls[0][0] as string;
                expect(warnMessage).toContain('Failed to delete source /test/source1.md during consolidation: Delete error message');
            } finally {
                // eslint-disable-next-line no-console -- Restoring console.warn
                console.warn = originalWarn;
            }
        });

        it('should catch and log non-Error objects thrown during source delete', async () => {
            const warnSpy = mock(_noop);
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            const originalWarn = console.warn;
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            console.warn = warnSpy;

            try {
                mockBackend.get = mock(async () => undefined);
                mockBackend.create = mock(async () => ({
                    path:        '/test/target.md' as MemoryPath,
                    content:     'Summary',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                }));
                mockBackend.delete = mock(async () => {
                    throw 'string error';
                });

                const result = await consolidateHandler(mockBackend, {
                    source_paths: ['/test/source1.md'],
                    target_path:  '/test/target.md',
                    summary:      'Summary',
                });

                expect(result).toContain('consolidated');
                expect(warnSpy).toHaveBeenCalledTimes(1);
                const warnMessage = warnSpy.mock.calls[0][0] as string;
                expect(warnMessage).toContain('string error');
            } finally {
                // eslint-disable-next-line no-console -- Restoring console.warn
                console.warn = originalWarn;
            }
        });
    });

    describe('logging', () => {
        let debugSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            debugSpy = spyOn(logger, 'debug');
        });

        it('should log memory create with path', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            await create(mockBackend, { path: '/test/file.md', file_text: 'content' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: '/test/file.md',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('Memory create:'),
                })
            );
        });

        it('should log memory view with path', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            await view(mockBackend, { path: '/test/file.md' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: '/test/file.md',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('Memory view:'),
                })
            );
        });

        it('should log memory delete with path', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            await deleteMemory(mockBackend, { path: '/test/file.md' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: '/test/file.md',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('Memory delete:'),
                })
            );
        });

        it('should log memory insert with path', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Inserted\nLine 1\nLine 2',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            await insert(mockBackend, { path: '/test/file.md', insert_line: 0, insert_text: 'Inserted' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: '/test/file.md',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('Memory insert:'),
                })
            );
        });

        it('should log memory str_replace with path', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello Universe',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            await strReplace(mockBackend, { path: '/test/file.md', old_str: 'World', new_str: 'Universe' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: '/test/file.md',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('Memory str_replace:'),
                })
            );
        });
    });
});
