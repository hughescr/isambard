import { describe, it, expect } from 'bun:test';
import {
    memoryPathSchema,
    contentTypeSchema,
    createMemoryPath,
    isMemoryPath,
    layerNameSchema,
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

describe('layerNameSchema', () => {
    it('should accept "identity"', () => {
        const result = layerNameSchema.safeParse('identity');
        expect(result.success).toBe(true);
    });

    it('should accept "state"', () => {
        const result = layerNameSchema.safeParse('state');
        expect(result.success).toBe(true);
    });

    it('should accept "events"', () => {
        const result = layerNameSchema.safeParse('events');
        expect(result.success).toBe(true);
    });

    it('should reject invalid layer name', () => {
        const result = layerNameSchema.safeParse('invalid');
        expect(result.success).toBe(false);
    });

    it('should reject non-string values', () => {
        const result = layerNameSchema.safeParse(123);
        expect(result.success).toBe(false);
    });

    it('should reject empty string', () => {
        const result = layerNameSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('should reject null', () => {
        const result = layerNameSchema.safeParse(null);
        expect(result.success).toBe(false);
    });

    it('should reject undefined', () => {
        const result = layerNameSchema.safeParse(undefined);
        expect(result.success).toBe(false);
    });
});
