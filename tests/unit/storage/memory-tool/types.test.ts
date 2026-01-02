import { describe, test, expect } from 'bun:test';
import {
    memoryPathSchema,
    contentTypeSchema,
    createMemoryPath,
    isMemoryPath,
    layerNameSchema,
    type MemoryPath
} from '@/storage/memory-tool/types';

describe.concurrent('memoryPathSchema', () => {
    test('should accept root path', () => {
        const result = memoryPathSchema.safeParse('/');
        expect(result.success).toBe(true);
    });

    test('should accept valid simple path', () => {
        const result = memoryPathSchema.safeParse('/notes');
        expect(result.success).toBe(true);
    });

    test('should accept valid nested path', () => {
        const result = memoryPathSchema.safeParse('/projects/isambard/todo');
        expect(result.success).toBe(true);
    });

    test('should reject path not starting with /', () => {
        const result = memoryPathSchema.safeParse('notes');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path must start with /');
        }
    });

    test('should reject path with double slashes', () => {
        const result = memoryPathSchema.safeParse('/notes//todo');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path cannot contain double slashes');
        }
    });

    test('should reject path with trailing slash (except root)', () => {
        const result = memoryPathSchema.safeParse('/notes/');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path cannot end with /');
        }
    });

    test('should reject empty string', () => {
        const result = memoryPathSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Path cannot be empty');
        }
    });

    test('should reject non-string values', () => {
        const result = memoryPathSchema.safeParse(123);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('createMemoryPath', () => {
    test('should create MemoryPath from valid string', () => {
        const path = createMemoryPath('/notes/todo');
        expect(path).toBe('/notes/todo' as MemoryPath);
    });

    test('should accept root path', () => {
        const path = createMemoryPath('/');
        expect(path).toBe('/' as MemoryPath);
    });

    test('should throw error for invalid path', () => {
        expect(() => createMemoryPath('invalid')).toThrow();
    });

    test('should throw error for path with double slashes', () => {
        expect(() => createMemoryPath('/notes//todo')).toThrow();
    });

    test('should throw error for path with trailing slash', () => {
        expect(() => createMemoryPath('/notes/')).toThrow();
    });
});

describe.concurrent('isMemoryPath', () => {
    test('should return true for valid MemoryPath', () => {
        const path = createMemoryPath('/notes');
        expect(isMemoryPath(path)).toBe(true);
    });

    test('should return false for invalid string', () => {
        expect(isMemoryPath('invalid')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isMemoryPath(123)).toBe(false);
        expect(isMemoryPath(null)).toBe(false);
        expect(isMemoryPath(undefined)).toBe(false);
        expect(isMemoryPath({})).toBe(false);
    });

    test('should return true for valid path string', () => {
        expect(isMemoryPath('/notes/todo')).toBe(true);
    });
});

describe.concurrent('contentTypeSchema', () => {
    test('should accept text/plain', () => {
        const result = contentTypeSchema.safeParse('text/plain');
        expect(result.success).toBe(true);
    });

    test('should accept text/markdown', () => {
        const result = contentTypeSchema.safeParse('text/markdown');
        expect(result.success).toBe(true);
    });

    test('should accept application/json', () => {
        const result = contentTypeSchema.safeParse('application/json');
        expect(result.success).toBe(true);
    });

    test('should reject invalid content type', () => {
        const result = contentTypeSchema.safeParse('text/html');
        expect(result.success).toBe(false);
    });
});

describe.concurrent('layerNameSchema', () => {
    test('should accept "identity"', () => {
        const result = layerNameSchema.safeParse('identity');
        expect(result.success).toBe(true);
    });

    test('should accept "state"', () => {
        const result = layerNameSchema.safeParse('state');
        expect(result.success).toBe(true);
    });

    test('should accept "events"', () => {
        const result = layerNameSchema.safeParse('events');
        expect(result.success).toBe(true);
    });

    test('should reject invalid layer name', () => {
        const result = layerNameSchema.safeParse('invalid');
        expect(result.success).toBe(false);
    });

    test('should reject non-string values', () => {
        const result = layerNameSchema.safeParse(123);
        expect(result.success).toBe(false);
    });

    test('should reject empty string', () => {
        const result = layerNameSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    test('should reject null', () => {
        const result = layerNameSchema.safeParse(null);
        expect(result.success).toBe(false);
    });

    test('should reject undefined', () => {
        const result = layerNameSchema.safeParse(undefined);
        expect(result.success).toBe(false);
    });
});
