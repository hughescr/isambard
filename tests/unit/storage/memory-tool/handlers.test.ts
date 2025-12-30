/* eslint-disable @typescript-eslint/unbound-method -- Mock functions don't have proper this binding */
/* eslint-disable @typescript-eslint/only-throw-error -- Some tests intentionally throw non-Error values */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { mock } from 'bun:test';
import { split as _split, some as _some, includes as _includes, noop as _noop, repeat as _repeat } from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, ContentType } from '@/storage/memory-tool/types';
import { memoryPathSchema } from '@/storage/memory-tool/types';
import {
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError,
    TextNotUniqueError,
    InvalidLineNumberError
} from '@/storage/memory-tool/errors';
import {
    create,
    view,
    delete_memory as deleteMemory,
    insert,
    str_replace as strReplace,
    rename
} from '@/storage/memory-tool/handlers';

describe('Memory Tool Handlers', () => {
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

    describe('create', () => {
        it('should create a new memory and return success message', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const result = await create(mockBackend, {
                path:      '/test/file.md',
                file_text: 'Hello World',
            });

            expect(result).toContain('successfully created');
            expect(result).toContain('/test/file.md');
            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/file.md',
                content:     'Hello World',
                contentType: 'text/markdown',
            });
        });

        it('should detect content type from path extension', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/test/file.txt' as MemoryPath,
                content:     'Plain text',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            await create(mockBackend, {
                path:      '/test/file.txt',
                file_text: 'Plain text',
            });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/file.txt',
                content:     'Plain text',
                contentType: 'text/plain',
            });
        });

        it('should detect application/json content type for .json files', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/test/data.json' as MemoryPath,
                content:     '{"key": "value"}',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            await create(mockBackend, {
                path:      '/test/data.json',
                file_text: '{"key": "value"}',
            });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/data.json',
                content:     '{"key": "value"}',
                contentType: 'application/json',
            });
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(create(mockBackend, {
                path:      'no-leading-slash',
                file_text: 'content',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should convert ZodError to InvalidPathError with detailed message', async () => {
            const promise = create(mockBackend, {
                path:      'invalid//path',
                file_text: 'content',
            });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow(InvalidPathError);
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow('invalid//path');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow('must start with /');
        });

        it('should extract and join multiple ZodError messages with comma separator', async () => {
            // Path that violates multiple rules: no leading slash AND double slashes
            const promise = create(mockBackend, {
                path:      'no-slash//double',
                file_text: 'content',
            });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow(InvalidPathError);
            // Should contain both error messages joined with ', '
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow('must start with /');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow('cannot contain double slashes');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(promise).rejects.toThrow(', ');
        });

        it('should propagate non-ZodError from schema validation', async () => {
            // Spy on memoryPathSchema.parse to throw a non-ZodError
            const customError = new Error('Unexpected validation error');
            const parseSpy = spyOn(memoryPathSchema, 'parse').mockImplementation(() => {
                throw customError;
            });

            try {
                const promise = create(mockBackend, {
                    path:      '/test/file.md',
                    file_text: 'content',
                });

                // Should propagate the non-ZodError as-is, not wrap it in InvalidPathError
                // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
                await expect(promise).rejects.toThrow(customError);
                // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
                await expect(promise).rejects.not.toThrow(InvalidPathError);
            } finally {
                parseSpy.mockRestore();
            }
        });

        it('should propagate PathAlreadyExistsError from backend', async () => {
            mockBackend.create = mock(async () => {
                throw new PathAlreadyExistsError('/test/file.md');
            });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(create(mockBackend, {
                path:      '/test/file.md',
                file_text: 'content',
            })).rejects.toThrow(PathAlreadyExistsError);
        });
    });

    describe('view', () => {
        it('should return content with line numbers for a file', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const result = await view(mockBackend, { path: '/test/file.md' });

            expect(result).toContain('1:Line 1');
            expect(result).toContain('2:Line 2');
            expect(result).toContain('3:Line 3');
            expect(result).toContain('\n');
        });

        it('should return content with line range when view_range is provided', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3\nLine 4',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const result = await view(mockBackend, {
                path:       '/test/file.md',
                view_range: [2, 3],
            });

            expect(result).toContain('2:Line 2');
            expect(result).toContain('3:Line 3');
            expect(result).not.toContain('1:Line 1');
            expect(result).not.toContain('4:Line 4');
        });

        it('should format lines with range starting at line 1', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const result = await view(mockBackend, {
                path:       '/test/file.md',
                view_range: [1, 2],
            });

            expect(result).toContain('1:Line 1');
            expect(result).toContain('2:Line 2');
            expect(result).not.toContain('3:Line 3');
        });

        it('should format lines with range at end of file', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3\nLine 4',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const result = await view(mockBackend, {
                path:       '/test/file.md',
                view_range: [3, 4],
            });

            expect(result).toContain('3:Line 3');
            expect(result).toContain('4:Line 4');
            expect(result).not.toContain('1:Line 1');
            expect(result).not.toContain('2:Line 2');
        });

        it('should handle range extending beyond file length', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3\nLine 4',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const result = await view(mockBackend, {
                path:       '/test/file.md',
                view_range: [2, 100],
            });

            expect(result).toContain('2:Line 2');
            expect(result).toContain('3:Line 3');
            expect(result).toContain('4:Line 4');
            expect(result).not.toContain('1:Line 1');
        });

        it('should list directory contents when path is a directory', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/test/dir/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/test/dir/file2.txt' as MemoryPath,
                        content:     'content2',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await view(mockBackend, { path: '/test/dir' });

            expect(result).toContain('file1.md');
            expect(result).toContain('file2.txt');
            expect(result).toContain('text/markdown');
            expect(result).toContain('text/plain');
            // Critical: verify items are joined with newline, not empty string
            expect(result).toContain('\n');
            // Verify the actual structure: file1 line, newline, file2 line
            const lines = _split(result, '\n');
            expect(lines.length).toBeGreaterThan(2); // "Directory contents:" + at least 2 files
            expect(_some(lines, line => _includes(line, 'file1.md'))).toBe(true);
            expect(_some(lines, line => _includes(line, 'file2.txt'))).toBe(true);
            // Verify file entries are on separate lines with proper format (file on one line, content type nearby)
            expect(result).toMatch(/file1\.md[^\n]*\n[^\n]*file2\.txt/);
        });

        it('should handle root path "/" by listing with empty parent path', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await view(mockBackend, { path: '/' });

            expect(result).toContain('file1.md');
            expect(mockBackend.list).toHaveBeenCalledWith('');
        });

        it('should use non-root path as parentPath when listing directory', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/memories/test/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await view(mockBackend, { path: '/memories/test' });

            expect(result).toContain('file1.md');
            // Critical: verify the path itself is used, not empty string
            expect(mockBackend.list).toHaveBeenCalledWith('/memories/test');
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({ items: [], nextCursor: undefined }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(view(mockBackend, { path: '/nonexistent' }))
                .rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(view(mockBackend, { path: 'bad-path' }))
                .rejects.toThrow(InvalidPathError);
        });
    });

    describe('deleteMemory', () => {
        it('should delete a single file', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.list = mock(async () => ({ items: [], nextCursor: undefined }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await deleteMemory(mockBackend, { path: '/test/file.md' });

            expect(result).toContain('deleted');
            expect(result).toContain('/test/file.md');
            expect(mockBackend.delete).toHaveBeenCalledWith('/test/file.md');
        });

        it('should recursively delete directory contents', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/test/dir/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/test/dir/file2.txt' as MemoryPath,
                        content:     'content2',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await deleteMemory(mockBackend, { path: '/test/dir' });

            expect(result).toContain('2 memories');
            expect(mockBackend.delete).toHaveBeenCalledTimes(2);
        });

        it('should handle root path "/" by listing with empty parent path for delete', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await deleteMemory(mockBackend, { path: '/' });

            expect(result).toContain('1 memories');
            expect(mockBackend.list).toHaveBeenCalledWith('');
            expect(mockBackend.delete).toHaveBeenCalledTimes(1);
        });

        it('should use non-root path as parentPath when deleting directory', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/memories/old/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await deleteMemory(mockBackend, { path: '/memories/old' });

            expect(result).toContain('1 memories');
            // Critical: verify the path itself is used, not empty string
            expect(mockBackend.list).toHaveBeenCalledWith('/memories/old');
            expect(mockBackend.delete).toHaveBeenCalledTimes(1);
        });

        it('should report exact delete count for multiple files', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/test/dir/file1.md' as MemoryPath,
                        content:     'content1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/test/dir/file2.txt' as MemoryPath,
                        content:     'content2',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/test/dir/file3.md' as MemoryPath,
                        content:     'content3',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await deleteMemory(mockBackend, { path: '/test/dir' });

            expect(result).toBe('Recursively deleted 3 memories under /test/dir');
            expect(mockBackend.delete).toHaveBeenCalledTimes(3);
        });

        it('should log warning when individual file delete fails in directory', async () => {
            const warnSpy = mock(_noop);
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            const originalWarn = console.warn;
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            console.warn = warnSpy;

            try {
                mockBackend.get = mock(async () => undefined);
                mockBackend.list = mock(async () => ({
                    items: [
                        {
                            path:        '/test/dir/file1.md' as MemoryPath,
                            content:     'content1',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},
                            version:     1,
                            createdAt:   '2025-01-01T00:00:00.000Z',
                            updatedAt:   '2025-01-01T00:00:00.000Z',
                        },
                        {
                            path:        '/test/dir/file2.txt' as MemoryPath,
                            content:     'content2',
                            contentType: 'text/plain' as ContentType,
                            metadata:    {},
                            version:     1,
                            createdAt:   '2025-01-01T00:00:00.000Z',
                            updatedAt:   '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                let callCount = 0;
                mockBackend.delete = mock(async (_path: MemoryPath) => {
                    callCount++;
                    if(callCount === 2) {
                        throw new Error('Delete failed');
                    }
                });

                const result = await deleteMemory(mockBackend, { path: '/test/dir' });

                expect(result).toContain('1 memories');
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0][0]).toContain('Failed to delete');
                expect(warnSpy.mock.calls[0][0]).toContain('file2.txt');
            } finally {
                // eslint-disable-next-line no-console -- Restoring console.warn
                console.warn = originalWarn;
            }
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({ items: [], nextCursor: undefined }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(deleteMemory(mockBackend, { path: '/nonexistent' }))
                .rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(deleteMemory(mockBackend, { path: '' }))
                .rejects.toThrow(InvalidPathError);
        });
    });

    describe('insert', () => {
        it('should insert text at the specified line', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nInserted\nLine 3',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            const result = await insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: 2,
                insert_text: 'Inserted',
            });

            expect(result).toContain('inserted at line 2');
            expect(mockBackend.update).toHaveBeenCalledWith('/test/file.md', {
                content: 'Line 1\nLine 2\nInserted\nLine 3',
            });
        });

        it('should insert at line 0 to prepend content', async () => {
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
                content:     'Prepended\nLine 1\nLine 2',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            const result = await insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: 0,
                insert_text: 'Prepended',
            });

            expect(result).toContain('inserted at line 0');
            expect(mockBackend.update).toHaveBeenCalledWith('/test/file.md', {
                content: 'Prepended\nLine 1\nLine 2',
            });
        });

        it('should insert at lines.length to append content', async () => {
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
                content:     'Line 1\nLine 2\nAppended',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            const result = await insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: 2, // lines.length for "Line 1\nLine 2"
                insert_text: 'Appended',
            });

            expect(result).toContain('inserted at line 2');
            expect(mockBackend.update).toHaveBeenCalledWith('/test/file.md', {
                content: 'Line 1\nLine 2\nAppended',
            });
        });

        it('should throw InvalidLineNumberError for line number beyond content', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: 10,
                insert_text: 'Text',
            })).rejects.toThrow(InvalidLineNumberError);
        });

        it('should throw InvalidLineNumberError for negative line numbers', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: -1,
                insert_text: 'Text',
            })).rejects.toThrow(InvalidLineNumberError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(insert(mockBackend, {
                path:        '/nonexistent',
                insert_line: 1,
                insert_text: 'Text',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(insert(mockBackend, {
                path:        'bad//path',
                insert_line: 1,
                insert_text: 'Text',
            })).rejects.toThrow(InvalidPathError);
        });
    });

    describe('strReplace', () => {
        it('should replace unique text occurrence', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello World\nGoodbye World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello Universe\nGoodbye World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            const result = await strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: 'Hello World',
                new_str: 'Hello Universe',
            });

            expect(result).toContain('replaced');
            expect(mockBackend.update).toHaveBeenCalledWith('/test/file.md', {
                content: 'Hello Universe\nGoodbye World',
            });
        });

        it('should throw TextNotFoundError when text is not found', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: 'Not Found',
                new_str: 'Replacement',
            })).rejects.toThrow(TextNotFoundError);
        });

        it('should throw TextNotUniqueError when text appears multiple times', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello World\nHello World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: 'Hello World',
                new_str: 'Replacement',
            })).rejects.toThrow(TextNotUniqueError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(strReplace(mockBackend, {
                path:    '/nonexistent',
                old_str: 'text',
                new_str: 'replacement',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(strReplace(mockBackend, {
                path:    'invalid',
                old_str: 'text',
                new_str: 'replacement',
            })).rejects.toThrow(InvalidPathError);
        });
    });

    describe('rename', () => {
        it('should rename a memory by copying and deleting', async () => {
            mockBackend.get = mock(async (path: MemoryPath) => {
                if(path === '/test/old.md') {
                    return {
                        path:        '/test/old.md' as MemoryPath,
                        content:     'Content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    { key: 'value' },
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    };
                }
                return undefined;
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/new.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    { key: 'value' },
                version:     1,
                createdAt:   '2025-01-01T00:00:01.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
                tags:        ['tag1'],
            }));
            mockBackend.delete = mock(async () => { /* intentionally empty */ });

            const result = await rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/new.md',
            });

            expect(result).toContain('renamed');
            expect(result).toContain('/test/old.md');
            expect(result).toContain('/test/new.md');
            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/new.md',
                content:     'Content',
                contentType: 'text/markdown',
                metadata:    { key: 'value' },
                tags:        ['tag1'],
            });
            expect(mockBackend.delete).toHaveBeenCalledWith('/test/old.md');
        });

        it('should log warning when cleanup delete fails after rename', async () => {
            const warnSpy = mock(_noop);
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            const originalWarn = console.warn;
            // eslint-disable-next-line no-console -- Testing console.warn behavior
            console.warn = warnSpy;

            try {
                mockBackend.get = mock(async (path: MemoryPath) => {
                    if(path === '/test/old.md') {
                        return {
                            path:        '/test/old.md' as MemoryPath,
                            content:     'Content',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},
                            version:     1,
                            createdAt:   '2025-01-01T00:00:00.000Z',
                            updatedAt:   '2025-01-01T00:00:00.000Z',
                        };
                    }
                    return undefined;
                });
                mockBackend.create = mock(async () => ({
                    path:        '/test/new.md' as MemoryPath,
                    content:     'Content',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:01.000Z',
                    updatedAt:   '2025-01-01T00:00:01.000Z',
                }));
                mockBackend.delete = mock(async () => {
                    throw new Error('Cleanup failed');
                });

                const result = await rename(mockBackend, {
                    path:     '/test/old.md',
                    new_path: '/test/new.md',
                });

                expect(result).toContain('renamed');
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0][0]).toContain('Failed to delete original');
                expect(warnSpy.mock.calls[0][0]).toContain('/test/old.md');
            } finally {
                // eslint-disable-next-line no-console -- Restoring console.warn
                console.warn = originalWarn;
            }
        });

        it('should throw PathNotFoundError when source path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(rename(mockBackend, {
                path:     '/nonexistent',
                new_path: '/test/new.md',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw PathAlreadyExistsError when destination path exists', async () => {
            mockBackend.get = mock(async (path: MemoryPath) => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/existing.md',
            })).rejects.toThrow(PathAlreadyExistsError);
        });

        it('should throw InvalidPathError for invalid source path', async () => {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(rename(mockBackend, {
                path:     'bad-path',
                new_path: '/test/new.md',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should throw InvalidPathError for invalid destination path', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/old.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: 'bad-path',
            })).rejects.toThrow(InvalidPathError);
        });
    });

    describe('search', () => {
        const searchHandler = async (
            backend: MemoryToolBackend,
            params: { tags?: string[], layer?: string, time_range?: { start: string, end: string }, limit?: number }
        ): Promise<string> => {
            const { search } = await import('@/storage/memory-tool/handlers');
            return search(backend, params as Parameters<typeof search>[1]);
        };

        it('should search by single tag', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'This is a note with some content that is longer than 100 characters to test preview truncation behavior',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain('/state/note.md');
            expect(result).toContain('This is a note with some content');
            expect(mockBackend.searchByTag).toHaveBeenCalledWith('tag1', undefined, { limit: undefined });
        });

        it('should search with multiple tags using AND logic', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1', 'tag2'] });

            expect(result).toContain('/state/note1.md');
            expect(result).not.toContain('/state/note2.md');
        });

        it('should not filter when exactly one tag provided', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            // Both items should be included since we only have one tag
            expect(result).toContain('/state/note1.md');
            expect(result).toContain('/state/note2.md');
        });

        it('should filter with three tags using AND logic', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2', 'tag3'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1', 'tag2', 'tag3'] });

            expect(result).toContain('/state/note1.md');
            expect(result).not.toContain('/state/note2.md');
        });

        it('should search by time range', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/log.md' as MemoryPath,
                    content:     'Event log',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T00:00:00.000Z',
                    updatedAt:   '2025-01-15T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain('/events/log.md');
            expect(mockBackend.searchByTimeRange).toHaveBeenCalledWith(
                '2025-01-10T00:00:00.000Z',
                '2025-01-20T00:00:00.000Z',
                undefined,
                { limit: undefined }
            );
        });

        it('should search by layer only', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { layer: 'identity' });

            expect(result).toContain('/identity/core.md');
            expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { limit: undefined });
        });

        it('should truncate content preview to 100 characters', async () => {
            const longContent = _repeat('A', 200);
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/long.md' as MemoryPath,
                        content:     longContent,
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain(_repeat('A', 100));
            expect(result).toContain('...');
            expect(result).not.toContain(_repeat('A', 101));
        });

        it('should return "No results found" when search returns empty', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['nonexistent'] });

            expect(result).toContain('No results found');
        });

        it('should return "No results found" when no search criteria provided', async () => {
            // Set up spies to verify backend methods are NOT called
            mockBackend.searchByTag = mock(async () => ({ items: [], nextCursor: undefined }));
            mockBackend.searchByTimeRange = mock(async () => []);
            mockBackend.listByLayer = mock(async () => ({ items: [], nextCursor: undefined }));

            const result = await searchHandler(mockBackend, {});

            expect(result).toBe('No results found');
            // Verify backend search methods were NOT called since no criteria provided
            expect(mockBackend.searchByTag).not.toHaveBeenCalled();
            expect(mockBackend.searchByTimeRange).not.toHaveBeenCalled();
            expect(mockBackend.listByLayer).not.toHaveBeenCalled();
        });

        it('should return "No results found" when layer search returns empty', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { layer: 'identity' });

            expect(result).toBe('No results found');
        });

        it('should use empty tag array as no tags', async () => {
            const result = await searchHandler(mockBackend, { tags: [] });

            expect(result).toBe('No results found');
        });

        it('should not truncate content preview at exactly 100 characters', async () => {
            const exactContent = _repeat('A', 100);
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/exact.md' as MemoryPath,
                        content:     exactContent,
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain(_repeat('A', 100));
            expect(result).not.toContain('...');
        });

        it('should join search results with double newline', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Content 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Content 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain('\n\n');
            expect(result).toContain('note1.md');
            expect(result).toContain('note2.md');
        });

        it('should apply limit parameter', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'], limit: 5 });

            expect(result).toContain('/state/note1.md');
            expect(mockBackend.searchByTag).toHaveBeenCalledWith('tag1', undefined, { limit: 5 });
        });

        it('should pass undefined limit to searchByTimeRange when limit not specified', async () => {
            mockBackend.searchByTimeRange = mock(async () => []);

            await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(mockBackend.searchByTimeRange).toHaveBeenCalledWith(
                '2025-01-10T00:00:00.000Z',
                '2025-01-20T00:00:00.000Z',
                undefined,
                { limit: undefined }
            );
        });
    });

    describe('recall', () => {
        const recallHandler = async (
            backend: MemoryToolBackend,
            params: { max_items?: number, include_layers?: string[] }
        ): Promise<string> => {
            const { recall } = await import('@/storage/memory-tool/handlers');
            return recall(backend, params as Parameters<typeof recall>[1]);
        };

        it('should return auto-load items grouped by layer', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity');
            expect(result).toContain('state');
            expect(result).toContain('/identity/core.md');
            expect(result).toContain('/state/current.md');
            expect(result).toContain('Core identity');
            expect(result).toContain('Current state');
        });

        it('should filter layers based on include_layers parameter', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, { include_layers: ['identity'] });

            expect(result).toContain('identity');
            expect(result).toContain('/identity/core.md');
            expect(result).not.toContain('state');
            expect(result).not.toContain('/state/current.md');
        });

        it('should skip empty layers', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity');
            expect(result).not.toContain('state:');
            expect(result).not.toContain('events:');
        });

        it('should return empty message when no items', async () => {
            mockBackend.getAutoLoadItems = mock(async () => []);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('No auto-load memories found');
        });

        it('should pass max_items to getAutoLoadItems', async () => {
            mockBackend.getAutoLoadItems = mock(async () => []);

            await recallHandler(mockBackend, { max_items: 50 });

            expect(mockBackend.getAutoLoadItems).toHaveBeenCalledWith({
                maxIdentityItems: 50,
                maxStateItems:    50,
            });
        });

        it('should group items by "other" when layer is null', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/unknown.md' as MemoryPath,
                    content:     'Unknown layer',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('other:');
            expect(result).toContain('/unknown.md');
        });

        it('should include "other" layer items when include_layers is not specified', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/unknown.md' as MemoryPath,
                    content:     'Unknown layer',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('other:');
        });

        it('should join layer sections with double newline', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('\n\n');
            expect(result).toContain('identity:');
            expect(result).toContain('state:');
        });

        it('should join layer items with single newline', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/identity/secondary.md' as MemoryPath,
                    content:     'Secondary identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity:\n  /identity/core.md\n    Core identity\n  /identity/secondary.md');
        });

        it('should filter out "other" layer when include_layers is specified', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/unknown.md' as MemoryPath,
                    content:     'Unknown',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, { include_layers: ['identity'] });

            expect(result).toContain('identity:');
            expect(result).toContain('/identity/core.md');
            // "other" layer should still be included even when include_layers is specified
            expect(result).toContain('other:');
            expect(result).toContain('/unknown.md');
        });

        it('should skip truly empty layer with zero items', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity:');
            // State and events layers should be completely absent, not shown as empty
            expect(result).not.toContain('state:');
            expect(result).not.toContain('events:');
            // Verify result doesn't contain multiple empty sections
            const sections = _split(result, '\n\n');
            expect(sections.length).toBe(1); // Only identity section
        });
    });

    describe('list_by_layer', () => {
        const listByLayerHandler = async (
            backend: MemoryToolBackend,
            params: { layer: string, include_content?: boolean, limit?: number }
        ): Promise<string> => {
            const { list_by_layer } = await import('@/storage/memory-tool/handlers');
            return list_by_layer(backend, params as Parameters<typeof list_by_layer>[1]);
        };

        it('should list items by layer without content', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            expect(result).toContain('/identity/core.md');
            expect(result).not.toContain('Core identity');
            expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { limit: undefined });
        });

        it('should include content with line numbers when requested', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Line 1\nLine 2\nLine 3',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity', include_content: true });

            expect(result).toContain('/identity/core.md');
            expect(result).toContain('1:Line 1');
            expect(result).toContain('2:Line 2');
            expect(result).toContain('3:Line 3');
        });

        it('should apply limit parameter', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'Note',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'state', limit: 10 });

            expect(result).toContain('/state/note.md');
            expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', { limit: 10 });
        });

        it('should return empty message when no items found', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            expect(result).toContain('No items found');
        });

        it('should join items with double newline when include_content is false', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/identity/secondary.md' as MemoryPath,
                        content:     'Secondary',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            expect(result).toBe('/identity/core.md\n\n/identity/secondary.md');
        });
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

    describe('search query building and logging', () => {
        let debugSpy: ReturnType<typeof spyOn>;

        const searchHandler = async (
            backend: MemoryToolBackend,
            params: { tags?: string[], layer?: string, time_range?: { start: string, end: string }, limit?: number }
        ): Promise<string> => {
            const { search } = await import('@/storage/memory-tool/handlers');
            return search(backend, params as Parameters<typeof search>[1]);
        };

        beforeEach(() => {
            debugSpy = spyOn(logger, 'debug');
        });

        it('should log search with tags joined by comma as query', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'Note content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2'],
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { tags: ['tag1', 'tag2'] });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'tag1,tag2',
                    resultCount: 1,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with layer as query when no tags provided', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { layer: 'identity' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'identity',
                    resultCount: 1,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with time_range as query when no tags or layer provided', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/log.md' as MemoryPath,
                    content:     'Event log',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T00:00:00.000Z',
                    updatedAt:   '2025-01-15T00:00:00.000Z',
                },
            ]);

            await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'time_range',
                    resultCount: 1,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with empty query and zero results when no criteria provided', async () => {
            await searchHandler(mockBackend, {});

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       '',
                    resultCount: 0,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log correct result count in search', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note3.md' as MemoryPath,
                        content:     'Note 3',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'tag1',
                    resultCount: 3,
                    msg:         'Memory search: "tag1" (3 results)',
                })
            );
        });
    });
});
