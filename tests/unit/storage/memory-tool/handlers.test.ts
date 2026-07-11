import { describe, it, expect, beforeEach, spyOn, mock  } from 'bun:test';
import { mockLogger } from '../../../setup';
import {
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError,
    TextNotUniqueError,
    InvalidLineNumberError,
    ContentTooLargeError
} from '@/errors/storage';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import {
    create,
    insert,
    str_replace as strReplace,
    rename
} from '@/storage/memory-tool/handlers';
import { type MemoryPath, type ContentType, memoryPathSchema  } from '@/storage/memory-tool/types';

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
            'delete':          mock(async () => undefined),
            list:              mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags:      mock(async () => ({ items: [], nextCursor: undefined })),
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

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
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
                content,
                contentType: expectedType as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            await create(mockBackend, {
                path,
                file_text: content,
            });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path,
                content,
                contentType: expectedType,
            });
        });

        it('should throw InvalidPathError for invalid paths', async () => {
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

            await expect(promise).rejects.toThrow(InvalidPathError);
            await expect(promise).rejects.toThrow('invalid//path');
            await expect(promise).rejects.toThrow('must start with /');
        });

        it('should extract and join multiple ZodError messages with comma separator', async () => {
            // Path that violates multiple rules: no leading slash AND double slashes
            const promise = create(mockBackend, {
                path:      'no-slash//double',
                file_text: 'content',
            });

            await expect(promise).rejects.toThrow(InvalidPathError);
            // Should contain both error messages joined with ', '
            await expect(promise).rejects.toThrow('must start with /');
            await expect(promise).rejects.toThrow('cannot contain double slashes');
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
                await expect(promise).rejects.toThrow(customError);
                await expect(promise).rejects.not.toThrow(InvalidPathError);
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

        it('should not throw ContentTooLargeError for content at exactly 350,000 bytes', async () => {
            const content = 'a'.repeat(350_000);
            const result = await create(mockBackend, {
                path:      '/test/file.md',
                file_text: content,
            });
            expect(result).toContain('successfully created');
        });

        it('should throw ContentTooLargeError for content at 350,001 bytes', async () => {
            const content = 'a'.repeat(350_001);
            await expect(create(mockBackend, {
                path:      '/test/file.md',
                file_text: content,
            })).rejects.toThrow(ContentTooLargeError);
        });
    });

    describe('insert', () => {
        it('should insert text at the specified line', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nLine 3',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Line 1\nLine 2\nInserted\nLine 3',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
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

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     expectedContent,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
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
            { lineNum: 10,    content: 'Line 1\nLine 2', desc: 'line number beyond content' },
            { lineNum: -1,    content: 'Line 1',         desc: 'negative line number' },
            { lineNum: 1.5,   content: 'Line 1\nLine 2', desc: 'decimal line number' },
            { lineNum: 2.999, content: 'Line 1\nLine 2', desc: 'decimal line number at boundary' },
        ])('should throw InvalidLineNumberError for invalid line $lineNum ($desc)', async ({ lineNum, content }) => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            await expect(insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: lineNum,
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

        it('should not throw ContentTooLargeError when inserted content is at exactly 350,000 bytes', async () => {
            // existing content: 1 byte, insert_text: 349,998 bytes → joined with \n: 349,998 + 1 + 1 = 350,000
            const existingContent = 'a';
            const insertText = 'a'.repeat(349_998);
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     existingContent,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            const result = await insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: 0,
                insert_text: insertText,
            });
            expect(result).toContain('inserted');
        });

        it('should throw ContentTooLargeError when inserted content exceeds 350,000 bytes', async () => {
            // existing content: 1 byte, insert_text: 349,999 bytes → joined with \n: 349,999 + 1 + 1 = 350,001
            const existingContent = 'a';
            const insertText = 'a'.repeat(349_999);
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     existingContent,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            await expect(insert(mockBackend, {
                path:        '/test/file.md',
                insert_line: 0,
                insert_text: insertText,
            })).rejects.toThrow(ContentTooLargeError);
        });
    });

    describe('strReplace', () => {
        it('should replace unique text occurrence', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello World\nGoodbye World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));
            mockBackend.update = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     'Hello Universe\nGoodbye World',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
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

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

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

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            await expect(strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: 'Hello World',
                new_str: 'Replacement',
            })).rejects.toThrow(TextNotUniqueError);
        });

        it('should throw PathNotFoundError when path does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            await expect(strReplace(mockBackend, {
                path:    '/nonexistent',
                old_str: 'text',
                new_str: 'replacement',
            })).rejects.toThrow(PathNotFoundError);
        });

        it('should throw InvalidPathError for invalid paths', async () => {
            await expect(strReplace(mockBackend, {
                path:    'invalid',
                old_str: 'text',
                new_str: 'replacement',
            })).rejects.toThrow(InvalidPathError);
        });

        it('should not throw ContentTooLargeError when replacement produces content at exactly 350,000 bytes', async () => {
            // old content: 'REPLACE', new content after replacement: 350,000 'a' chars
            const placeholder = 'REPLACE';
            const newStr = 'a'.repeat(350_000);
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     placeholder,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            const result = await strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: placeholder,
                new_str: newStr,
            });
            expect(result).toContain('replaced');
        });

        it('should throw ContentTooLargeError when replacement produces content exceeding 350,000 bytes', async () => {
            const placeholder = 'REPLACE';
            const newStr = 'a'.repeat(350_001);
            mockBackend.get = mock(async () => ({
                path:        '/test/file.md' as MemoryPath,
                content:     placeholder,
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));
            await expect(strReplace(mockBackend, {
                path:    '/test/file.md',
                old_str: placeholder,
                new_str: newStr,
            })).rejects.toThrow(ContentTooLargeError);
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

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                        tags:      new Set(['tag1']),
                    };
                }
                return undefined;
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/new.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    { key: 'value', previouslyKnownAs: '/test/old.md', previouslyKnownAsTags: ['tag1'] },

                createdAt: '2025-01-01T00:00:01.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
                tags:      new Set(['tag1']),
            }));
            mockBackend.delete = mock(async () => undefined);

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
                metadata:    { key: 'value', previouslyKnownAs: '/test/old.md', previouslyKnownAsTags: ['tag1'] },
                tags:        new Set(['tag1']),
            });
            expect(mockBackend.delete).toHaveBeenCalledWith('/test/old.md');
        });

        it('should store previouslyKnownAsTags as empty array when source has no tags', async () => {
            mockBackend.get = mock(async (path: MemoryPath) => {
                if(path === '/test/old.md') {
                    return {
                        path:        '/test/old.md' as MemoryPath,
                        content:     'Content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    { key: 'value' },

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                        // No tags field
                    };
                }
                return undefined;
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/new.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    { key: 'value', previouslyKnownAs: '/test/old.md', previouslyKnownAsTags: [] },

                createdAt: '2025-01-01T00:00:01.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
            }));
            mockBackend.delete = mock(async () => undefined);

            await rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/new.md',
            });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/new.md',
                content:     'Content',
                contentType: 'text/markdown',
                metadata:    { key: 'value', previouslyKnownAs: '/test/old.md', previouslyKnownAsTags: [] },
                tags:        undefined,
            });
        });

        it('should add previouslyKnownAs metadata to renamed memory', async () => {
            mockBackend.get = mock(async (path: MemoryPath) => {
                if(path === '/test/old.md') {
                    return {
                        path:        '/test/old.md' as MemoryPath,
                        content:     'Content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    { existingKey: 'existingValue' },

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    };
                }
                return undefined;
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/new.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    { existingKey: 'existingValue', previouslyKnownAs: '/test/old.md', previouslyKnownAsTags: [] },

                createdAt: '2025-01-01T00:00:01.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
            }));
            mockBackend.delete = mock(async () => undefined);

            await rename(mockBackend, {
                path:     '/test/old.md',
                new_path: '/test/new.md',
            });

            // Verify the created memory includes previouslyKnownAs and previouslyKnownAsTags metadata
            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/test/new.md',
                content:     'Content',
                contentType: 'text/markdown',
                metadata:    { existingKey: 'existingValue', previouslyKnownAs: '/test/old.md', previouslyKnownAsTags: [] },
                tags:        undefined,
            });
        });

        it('should log warning when cleanup delete fails after rename', async () => {
            mockBackend.get = mock(async (path: MemoryPath) => {
                if(path === '/test/old.md') {
                    return {
                        path:        '/test/old.md' as MemoryPath,
                        content:     'Content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    };
                }
                return undefined;
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/new.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:01.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
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

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    };
                }
                return undefined;
            });
            mockBackend.create = mock(async () => ({
                path:        '/test/new.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:01.000Z',
                updatedAt: '2025-01-01T00:00:01.000Z',
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

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
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

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            await expect(rename(mockBackend, {
                path:     '/test/old.md',
                new_path: 'bad-path',
            })).rejects.toThrow(InvalidPathError);
        });
    });
});
