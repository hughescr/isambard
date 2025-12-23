import { describe, it, expect } from 'bun:test';
import _ from 'lodash';
import {
    memoryPathSchema,
    contentTypeSchema,
    memoryToolItemSchema,
    createMemoryPath,
    isMemoryPath,
    createMemoryToolKeys,
    type MemoryPath
} from '@/storage/memory-tool/types';

describe('memoryPathSchema', () => {
    it('should accept root path', () => {
        const result = memoryPathSchema.safeParse('/');
        expect(result.success).toBe(true);
    });

    it('should accept valid simple path', () => {
        const result = memoryPathSchema.safeParse('/notes');
        expect(result.success).toBe(true);
    });

    it('should accept valid nested path', () => {
        const result = memoryPathSchema.safeParse('/projects/isambard/todo');
        expect(result.success).toBe(true);
    });

    it('should reject path not starting with /', () => {
        const result = memoryPathSchema.safeParse('notes');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path must start with /');
        }
    });

    it('should reject path with double slashes', () => {
        const result = memoryPathSchema.safeParse('/notes//todo');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path cannot contain double slashes');
        }
    });

    it('should reject path with trailing slash (except root)', () => {
        const result = memoryPathSchema.safeParse('/notes/');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path cannot end with /');
        }
    });

    it('should reject empty string', () => {
        const result = memoryPathSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path cannot be empty');
        }
    });

    it('should reject non-string values', () => {
        const result = memoryPathSchema.safeParse(123);
        expect(result.success).toBe(false);
    });
});

describe('contentTypeSchema', () => {
    it('should accept text/plain', () => {
        const result = contentTypeSchema.safeParse('text/plain');
        expect(result.success).toBe(true);
    });

    it('should accept text/markdown', () => {
        const result = contentTypeSchema.safeParse('text/markdown');
        expect(result.success).toBe(true);
    });

    it('should accept application/json', () => {
        const result = contentTypeSchema.safeParse('application/json');
        expect(result.success).toBe(true);
    });

    it('should reject invalid content type', () => {
        const result = contentTypeSchema.safeParse('text/html');
        expect(result.success).toBe(false);
    });
});

describe('memoryToolItemSchema', () => {
    const validItem = {
        path:        '/test' as MemoryPath,
        content:     'Test content',
        contentType: 'text/plain',
        version:     1,
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    it('should validate complete memory tool item', () => {
        const result = memoryToolItemSchema.safeParse(validItem);
        expect(result.success).toBe(true);
    });

    it('should apply default empty object for metadata', () => {
        const result = memoryToolItemSchema.safeParse(validItem);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({});
        }
    });

    it('should accept custom metadata', () => {
        const result = memoryToolItemSchema.safeParse({
            ...validItem,
            metadata: { author: 'claude', priority: 5 },
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({ author: 'claude', priority: 5 });
        }
    });

    it('should accept optional tags', () => {
        const result = memoryToolItemSchema.safeParse({
            ...validItem,
            tags: ['important', 'work'],
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tags).toEqual(['important', 'work']);
        }
    });

    it('should require path', () => {
        const { path: _path, ...noPath } = validItem;
        const result = memoryToolItemSchema.safeParse(noPath);
        expect(result.success).toBe(false);
    });

    it('should require valid MemoryPath', () => {
        const result = memoryToolItemSchema.safeParse({ ...validItem, path: 'invalid-path' });
        expect(result.success).toBe(false);
    });

    it('should require content', () => {
        const { content: _content, ...noContent } = validItem;
        const result = memoryToolItemSchema.safeParse(noContent);
        expect(result.success).toBe(false);
    });

    it('should reject content over 300KB', () => {
        const largeContent = _.repeat('x', 300001);
        const result = memoryToolItemSchema.safeParse({ ...validItem, content: largeContent });
        expect(result.success).toBe(false);
    });

    it('should accept content at 300KB limit', () => {
        const maxContent = _.repeat('x', 300000);
        const result = memoryToolItemSchema.safeParse({ ...validItem, content: maxContent });
        expect(result.success).toBe(true);
    });

    it('should require contentType', () => {
        const { contentType: _contentType, ...noContentType } = validItem;
        const result = memoryToolItemSchema.safeParse(noContentType);
        expect(result.success).toBe(false);
    });

    it('should require version', () => {
        const { version: _version, ...noVersion } = validItem;
        const result = memoryToolItemSchema.safeParse(noVersion);
        expect(result.success).toBe(false);
    });

    it('should require version to be positive integer', () => {
        const result = memoryToolItemSchema.safeParse({ ...validItem, version: 0 });
        expect(result.success).toBe(false);
    });

    it('should reject negative version', () => {
        const result = memoryToolItemSchema.safeParse({ ...validItem, version: -1 });
        expect(result.success).toBe(false);
    });

    it('should reject non-integer version', () => {
        const result = memoryToolItemSchema.safeParse({ ...validItem, version: 1.5 });
        expect(result.success).toBe(false);
    });

    it('should require createdAt', () => {
        const { createdAt: _createdAt, ...noCreatedAt } = validItem;
        const result = memoryToolItemSchema.safeParse(noCreatedAt);
        expect(result.success).toBe(false);
    });

    it('should validate createdAt as ISO datetime', () => {
        const result = memoryToolItemSchema.safeParse({ ...validItem, createdAt: 'not-a-date' });
        expect(result.success).toBe(false);
    });

    it('should require updatedAt', () => {
        const { updatedAt: _updatedAt, ...noUpdatedAt } = validItem;
        const result = memoryToolItemSchema.safeParse(noUpdatedAt);
        expect(result.success).toBe(false);
    });

    it('should validate updatedAt as ISO datetime', () => {
        const result = memoryToolItemSchema.safeParse({ ...validItem, updatedAt: 'not-a-date' });
        expect(result.success).toBe(false);
    });
});

describe('createMemoryPath', () => {
    it('should create MemoryPath from valid string', () => {
        const path = createMemoryPath('/notes/todo');
        expect(path).toBe('/notes/todo' as MemoryPath);
    });

    it('should accept root path', () => {
        const path = createMemoryPath('/');
        expect(path).toBe('/' as MemoryPath);
    });

    it('should throw error for invalid path', () => {
        expect(() => createMemoryPath('invalid')).toThrow();
    });

    it('should throw error for path with double slashes', () => {
        expect(() => createMemoryPath('/notes//todo')).toThrow();
    });

    it('should throw error for path with trailing slash', () => {
        expect(() => createMemoryPath('/notes/')).toThrow();
    });
});

describe('isMemoryPath', () => {
    it('should return true for valid MemoryPath', () => {
        const path = createMemoryPath('/notes');
        expect(isMemoryPath(path)).toBe(true);
    });

    it('should return false for invalid string', () => {
        expect(isMemoryPath('invalid')).toBe(false);
    });

    it('should return false for non-string values', () => {
        expect(isMemoryPath(123)).toBe(false);
        expect(isMemoryPath(null)).toBe(false);
        expect(isMemoryPath(undefined)).toBe(false);
        expect(isMemoryPath({})).toBe(false);
    });

    it('should return true for valid path string', () => {
        expect(isMemoryPath('/notes/todo')).toBe(true);
    });
});

describe('createMemoryToolKeys', () => {
    const path = '/projects/isambard' as MemoryPath;
    const updatedAt = '2024-01-01T00:00:00.000Z';

    it('should create correct PK', () => {
        const keys = createMemoryToolKeys(path);
        expect(keys.PK).toBe('TOOL_MEMORY#/projects/isambard');
    });

    it('should create correct SK (same as PK)', () => {
        const keys = createMemoryToolKeys(path);
        expect(keys.SK).toBe('TOOL_MEMORY#/projects/isambard');
    });

    it('should create GSI1PK with first tag when tags provided', () => {
        const keys = createMemoryToolKeys(path, ['work', 'important'], updatedAt);
        expect(keys.GSI1PK).toBe('TOOL_MEMORY#TAG#work');
    });

    it('should create GSI1PK from path when no tags', () => {
        const keys = createMemoryToolKeys(path, undefined, updatedAt);
        expect(keys.GSI1PK).toBe('TOOL_MEMORY#/projects/isambard');
    });

    it('should create GSI1PK from path when empty tags array', () => {
        const keys = createMemoryToolKeys(path, [], updatedAt);
        expect(keys.GSI1PK).toBe('TOOL_MEMORY#/projects/isambard');
    });

    it('should create GSI1SK from updatedAt when provided', () => {
        const keys = createMemoryToolKeys(path, undefined, updatedAt);
        expect(keys.GSI1SK).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should create GSI1SK as empty string when updatedAt not provided', () => {
        const keys = createMemoryToolKeys(path);
        expect(keys.GSI1SK).toBe('');
    });
});
