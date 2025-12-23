import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { mock } from 'bun:test';
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
    delete_memory,
    insert,
    str_replace,
    rename
} from '@/storage/memory-tool/handlers';

describe('Memory Tool Handlers', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:  mock(async () => ({})),
            get:     mock(async () => undefined),
            update:  mock(async () => ({})),
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- Mock function
            delete:  mock(async () => {}),
            list:    mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;
    });

    describe('create', () => {
        it('should create a new memory and return success message', async () => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Test mocking
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
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Test mocking
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
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Test mocking
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
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Testing promise rejection
            await expect(create(mockBackend, {
                path:      'no-leading-slash',
                file_text: 'content',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should convert ZodError to InvalidPathError with detailed message', async () => {
            try {
                await create(mockBackend, {
                    path:      'invalid//path',
                    file_text: 'content',
                });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(InvalidPathError);
                expect((error as InvalidPathError).message).toContain('invalid//path');
                // Verify the error message contains validation failure details
                expect((error as InvalidPathError).message).toContain('must start with /');
            }
        });

        it('should extract and join multiple ZodError messages with comma separator', async () => {
            // Path that violates multiple rules: no leading slash AND double slashes
            try {
                await create(mockBackend, {
                    path:      'no-slash//double',
                    file_text: 'content',
                });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(InvalidPathError);
                const errorMessage = (error as InvalidPathError).message;
                // Should contain both error messages joined with ', '
                expect(errorMessage).toContain('must start with /');
                expect(errorMessage).toContain('cannot contain double slashes');
                expect(errorMessage).toContain(', ');
            }
        });

        it('should propagate non-ZodError from schema validation', async () => {
            // Spy on memoryPathSchema.parse to throw a non-ZodError
            const customError = new Error('Unexpected validation error');
            const parseSpy = spyOn(memoryPathSchema, 'parse').mockImplementation(() => {
                throw customError;
            });

            try {
                await create(mockBackend, {
                    path:      '/test/file.md',
                    file_text: 'content',
                });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                // Should propagate the non-ZodError as-is, not wrap it
                expect(error).toBe(customError);
                expect(error).not.toBeInstanceOf(InvalidPathError);
            } finally {
                parseSpy.mockRestore();
            }
        });

        it('should propagate PathAlreadyExistsError from backend', async () => {
            mockBackend.create = mock(async () => {
                throw new PathAlreadyExistsError('/test/file.md');
            });

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
            const lines = result.split('\n');
            expect(lines.length).toBeGreaterThan(2); // "Directory contents:" + at least 2 files
            expect(lines.some(line => line.includes('file1.md'))).toBe(true);
            expect(lines.some(line => line.includes('file2.txt'))).toBe(true);
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

            await expect(view(mockBackend, { path: '/nonexistent' }))
                .rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            await expect(view(mockBackend, { path: 'bad-path' }))
                .rejects.toThrow(InvalidPathError);
        });
    });

    describe('delete_memory', () => {
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
            mockBackend.delete = mock(async () => {});

            const result = await delete_memory(mockBackend, { path: '/test/file.md' });

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
            mockBackend.delete = mock(async () => {});

            const result = await delete_memory(mockBackend, { path: '/test/dir' });

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
            mockBackend.delete = mock(async () => {});

            const result = await delete_memory(mockBackend, { path: '/' });

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
            mockBackend.delete = mock(async () => {});

            const result = await delete_memory(mockBackend, { path: '/memories/old' });

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
            mockBackend.delete = mock(async () => {});

            const result = await delete_memory(mockBackend, { path: '/test/dir' });

            expect(result).toBe('Recursively deleted 3 memories under /test/dir');
            expect(mockBackend.delete).toHaveBeenCalledTimes(3);
        });

        it('should log warning when individual file delete fails in directory', async () => {
            const warnSpy = mock(() => {});
            const originalWarn = console.warn;
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
                mockBackend.delete = mock(async (path: MemoryPath) => {
                    callCount++;
                    if(callCount === 2) {
                        throw new Error('Delete failed');
                    }
                });

                const result = await delete_memory(mockBackend, { path: '/test/dir' });

                expect(result).toContain('1 memories');
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0][0]).toContain('Failed to delete');
                expect(warnSpy.mock.calls[0][0]).toContain('file2.txt');
            } finally {
                console.warn = originalWarn;
            }
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({ items: [], nextCursor: undefined }));

            await expect(delete_memory(mockBackend, { path: '/nonexistent' }))
                .rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            await expect(delete_memory(mockBackend, { path: '' }))
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

            await expect(insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: -1,
                insert_text: 'Text',
            })).rejects.toThrow(InvalidLineNumberError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            await expect(insert(mockBackend, {
                path:        '/nonexistent',
                insert_line: 1,
                insert_text: 'Text',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            await expect(insert(mockBackend, {
                path:        'bad//path',
                insert_line: 1,
                insert_text: 'Text',
            })).rejects.toThrow(InvalidPathError);
        });
    });

    describe('str_replace', () => {
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

            const result = await str_replace(mockBackend, {
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

            await expect(str_replace(mockBackend, {
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

            await expect(str_replace(mockBackend, {
                path:    '/test/file.md',
                old_str: 'Hello World',
                new_str: 'Replacement',
            })).rejects.toThrow(TextNotUniqueError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            await expect(str_replace(mockBackend, {
                path:    '/nonexistent',
                old_str: 'text',
                new_str: 'replacement',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            await expect(str_replace(mockBackend, {
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
            mockBackend.delete = mock(async () => {});

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
            const warnSpy = mock(() => {});
            const originalWarn = console.warn;
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
                console.warn = originalWarn;
            }
        });

        it('should throw PathNotFoundError when source path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

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

            await expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/existing.md',
            })).rejects.toThrow(PathAlreadyExistsError);
        });

        it('should throw InvalidPathError for invalid source path', async () => {
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

            await expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: 'bad-path',
            })).rejects.toThrow(InvalidPathError);
        });
    });
});
