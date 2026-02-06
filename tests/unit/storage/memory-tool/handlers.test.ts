/* eslint-disable @typescript-eslint/unbound-method -- Mock functions don't have proper this binding */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { mock } from 'bun:test';
import { split as _split, some as _some, includes as _includes, repeat as _repeat } from 'lodash';
import { mockLogger } from '../../../setup';
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
    rename,
    search
} from '@/storage/memory-tool/handlers';

describe('Memory Tool Handlers', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();

        mockBackend = {
            create:            mock(async () => ({})),
            get:               mock(async () => undefined),
            update:            mock(async () => ({})),
            'delete':          mock(async () => { /* intentionally empty */ }),
            list:              mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTag:       mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:       mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTimeRange: mock(async () => []),
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

        it.each([
            ['text/plain', '/test/file.txt', 'Plain text'],
            ['application/json', '/test/data.json', '{"key": "value"}'],
        ])('should detect %s content type from path extension', async (expectedType, path, content) => {
            mockBackend.create = mock(async () => ({
                path:        path as MemoryPath,
                content:     content,
                contentType: expectedType as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            await create(mockBackend, {
                path:      path,
                file_text: content,
            });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        path,
                content:     content,
                contentType: expectedType,
            });
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            expect(create(mockBackend, {
                path:      'no-leading-slash',
                file_text: 'content',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should convert ZodError to InvalidPathError with detailed message', async () => {
            const promise = create(mockBackend, {
                path:      'invalid//path',
                file_text: 'content',
            });

            expect(promise).rejects.toThrow(InvalidPathError);
            expect(promise).rejects.toThrow('invalid//path');
            expect(promise).rejects.toThrow('must start with /');
        });

        it('should extract and join multiple ZodError messages with comma separator', async () => {
            // Path that violates multiple rules: no leading slash AND double slashes
            const promise = create(mockBackend, {
                path:      'no-slash//double',
                file_text: 'content',
            });

            expect(promise).rejects.toThrow(InvalidPathError);
            // Should contain both error messages joined with ', '
            expect(promise).rejects.toThrow('must start with /');
            expect(promise).rejects.toThrow('cannot contain double slashes');
            expect(promise).rejects.toThrow(', ');
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
                expect(promise).rejects.toThrow(customError);
                expect(promise).rejects.not.toThrow(InvalidPathError);
            } finally {
                parseSpy.mockRestore();
            }
        });

        it('should propagate PathAlreadyExistsError from backend', async () => {
            mockBackend.create = mock(async () => {
                throw new PathAlreadyExistsError('/test/file.md');
            });

            expect(create(mockBackend, {
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
            // Critical: verify lines are properly separated by newlines (kills StringLiteral mutant on join)
            expect(result).toMatch(/1:Line 1\n2:Line 2\n3:Line 3/);
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

            expect(view(mockBackend, { path: '/nonexistent' }))
                .rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            expect(view(mockBackend, { path: 'bad-path' }))
                .rejects.toThrow(InvalidPathError);
        });

        it('should include file header with path and timestamp', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-13T10:00:00.000Z',
                updatedAt:   '2025-01-13T10:00:00.000Z',
            }));

            const result = await view(mockBackend, { path: '/test/file.md' });

            // Should include file header with path and timestamp
            expect(result).toContain('File: /test/file.md');
            expect(result).toContain('2025-01-13T10:00:00.000Z');
            // Should still have line-numbered content
            expect(result).toContain('1:Line 1');
            expect(result).toContain('2:Line 2');
        });

        it('should show relative time in file header', async () => {
            // Use a date that's 2 days before now
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            const updatedAt = twoDaysAgo.toISOString();

            mockBackend.get = mock(async () => ({
                path:        '/test/recent.md' as MemoryPath,
                content:     'Recent content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   updatedAt,
                updatedAt:   updatedAt,
            }));

            const result = await view(mockBackend, { path: '/test/recent.md' });

            // Should include relative time indicator
            expect(result).toContain('2 days ago');
            expect(result).toContain('File: /test/recent.md');
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
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    path:  '/test/dir/file2.txt',
                    error: 'Delete failed',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:   expect.stringContaining('Failed to delete'),
                })
            );
        });

        it('should report both success and failures in return message when some deletes fail', async () => {
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
                        path:        '/test/dir/file3.json' as MemoryPath,
                        content:     'content3',
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            mockBackend.delete = mock(async (path: MemoryPath) => {
                // Fail for file2.txt and file3.json
                if(path === '/test/dir/file2.txt' || path === '/test/dir/file3.json') {
                    throw new Error('Delete failed');
                }
            });

            const result = await deleteMemory(mockBackend, { path: '/test/dir' });

            // Should report both success count and failed paths
            expect(result).toContain('1 memories'); // Success count
            expect(result).toContain('Failed to delete 2 items'); // Failure count
            expect(result).toContain('/test/dir/file2.txt'); // Failed path 1
            expect(result).toContain('/test/dir/file3.json'); // Failed path 2

            // CRITICAL: Verify the exact separator is ', ' (comma-space), not just comma or empty string
            // This kills the mutant that changes failedPaths.join(', ') to failedPaths.join('')
            expect(result).toContain('/test/dir/file2.txt, /test/dir/file3.json');
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.list = mock(async () => ({ items: [], nextCursor: undefined }));

            expect(deleteMemory(mockBackend, { path: '/nonexistent' }))
                .rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            expect(deleteMemory(mockBackend, { path: '' }))
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

        it.each([
            [0, 'Prepended', 'Prepended\nLine 1\nLine 2', 'prepend'],
            [2, 'Appended', 'Line 1\nLine 2\nAppended', 'append'],
        ])('should insert at line %i to %s content', async (insertLine, text, expectedContent) => {
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
                content:     expectedContent,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:01.000Z',
            }));

            const result = await insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: insertLine,
                insert_text: text,
            });

            expect(result).toContain(`inserted at line ${insertLine}`);
            expect(mockBackend.update).toHaveBeenCalledWith('/test/file.md', {
                content: expectedContent,
            });
        });

        it.each([
            [10, 'Line 1\nLine 2', 'line number beyond content'],
            [-1, 'Line 1', 'negative line number'],
            [1.5, 'Line 1\nLine 2', 'decimal line number'],
            [2.999, 'Line 1\nLine 2', 'decimal line number at boundary'],
        ])('should throw InvalidLineNumberError for invalid line %i (%s)', async (lineNum, content) => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     content,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            expect(insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: lineNum,
                insert_text: 'Text',
            })).rejects.toThrow(InvalidLineNumberError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            expect(insert(mockBackend, {
                path:        '/nonexistent',
                insert_line: 1,
                insert_text: 'Text',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            expect(insert(mockBackend, {
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

            expect(strReplace(mockBackend, {
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

            expect(strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: 'Hello World',
                new_str: 'Replacement',
            })).rejects.toThrow(TextNotUniqueError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            expect(strReplace(mockBackend, {
                path:    '/nonexistent',
                old_str: 'text',
                new_str: 'replacement',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            expect(strReplace(mockBackend, {
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
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    path:  '/test/old.md',
                    error: 'Cleanup failed',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:   expect.stringContaining('Failed to delete original'),
                })
            );
        });

        it('should include warning in return message when original file deletion fails after copy', async () => {
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
                throw new Error('Delete failed');
            });

            const result = await rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/new.md',
            });

            // Should include warning in return message about incomplete deletion
            expect(result).toContain('renamed');
            expect(result).toContain('warning');
            expect(result).toContain('/test/old.md');
            expect(result).toContain('could not be deleted');
        });

        it('should throw PathNotFoundError when source path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            expect(rename(mockBackend, {
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

            expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/existing.md',
            })).rejects.toThrow(PathAlreadyExistsError);
        });

        it('should throw InvalidPathError for invalid source path', async () => {
            expect(rename(mockBackend, {
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

            expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: 'bad-path',
            })).rejects.toThrow(InvalidPathError);
        });
    });

    describe('search', () => {
        describe('contentPreview formatting', () => {
            it('should append ... when contentPreview exists AND is exactly 100 chars', async () => {
                const preview100chars = _repeat('a', 100);
                mockBackend.searchByTag = mock(async () => ({
                    items: [{
                        path:           '/test/file.md' as MemoryPath,
                        content:        'full content here',
                        contentPreview: preview100chars,
                        contentType:    'text/markdown' as ContentType,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-01T00:00:00.000Z',
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['test-tag'],
                    }],
                    nextCursor: undefined,
                }));

                const result = await search(mockBackend, { tags: ['test-tag'] });

                // Verify contentPreview content appears in output (kills template literal → empty string mutant)
                expect(result).toContain(preview100chars);
                // Verify ... is appended (kills && → || mutant for length check)
                expect(result).toContain(`${preview100chars}...`);
            });

            it('should NOT append ... when contentPreview exists but is less than 100 chars', async () => {
                const preview99chars = _repeat('b', 99);
                mockBackend.searchByTag = mock(async () => ({
                    items: [{
                        path:           '/test/file.md' as MemoryPath,
                        content:        'full content here',
                        contentPreview: preview99chars,
                        contentType:    'text/markdown' as ContentType,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-01T00:00:00.000Z',
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['test-tag'],
                    }],
                    nextCursor: undefined,
                }));

                const result = await search(mockBackend, { tags: ['test-tag'] });

                // Verify contentPreview content appears in output
                expect(result).toContain(preview99chars);
                // Verify ... is NOT appended (< 100 chars)
                expect(result).not.toContain(`${preview99chars}...`);
            });

            it('should NOT append ... when contentPreview is undefined (falls back to content)', async () => {
                mockBackend.searchByTag = mock(async () => ({
                    items: [{
                        path:           '/test/file.md' as MemoryPath,
                        content:        'short content',
                        contentPreview: undefined,
                        contentType:    'text/markdown' as ContentType,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-01T00:00:00.000Z',
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['test-tag'],
                    }],
                    nextCursor: undefined,
                }));

                const result = await search(mockBackend, { tags: ['test-tag'] });

                // Verify falls back to content (kills && → || mutant when contentPreview is undefined)
                expect(result).toContain('short content');
                // Verify no ... since content is < 100 chars
                expect(result).not.toContain('...');
            });

            it('should fallback to content and append ... when content is > 100 chars and contentPreview is undefined', async () => {
                const longContent = _repeat('c', 150);
                mockBackend.searchByTag = mock(async () => ({
                    items: [{
                        path:           '/test/file.md' as MemoryPath,
                        content:        longContent,
                        contentPreview: undefined,
                        contentType:    'text/markdown' as ContentType,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-01T00:00:00.000Z',
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['test-tag'],
                    }],
                    nextCursor: undefined,
                }));

                const result = await search(mockBackend, { tags: ['test-tag'] });

                // Verify truncated content appears with ...
                expect(result).toContain(_repeat('c', 100));
                expect(result).toContain('...');
                // Verify full content does NOT appear
                expect(result).not.toContain(longContent);
            });

            it('should NOT append ... when contentPreview is empty string', async () => {
                mockBackend.searchByTag = mock(async () => ({
                    items: [{
                        path:           '/test/file.md' as MemoryPath,
                        content:        'actual content',
                        contentPreview: '',
                        contentType:    'text/markdown' as ContentType,
                        metadata:       {},
                        version:        1,
                        createdAt:      '2025-01-01T00:00:00.000Z',
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['test-tag'],
                    }],
                    nextCursor: undefined,
                }));

                const result = await search(mockBackend, { tags: ['test-tag'] });

                // Empty contentPreview is falsy, so should fallback to content
                expect(result).toContain('actual content');
                // No ... because content is < 100 chars
                expect(result).not.toContain('...');
            });
        });
    });
});
