import { describe, test, expect } from 'bun:test';
import {
    memoryPathSchema,
    contentTypeSchema,
    createMemoryPath,
    isMemoryPath,
    createLayerName,
    isLayerName,
    createContentType,
    isContentType,
    layerNameSchema,
    type MemoryPath,
    type LayerName,
    type ContentType
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

describe.concurrent('createLayerName', () => {
    test('should create LayerName from "identity"', () => {
        const layer = createLayerName('identity');
        expect(layer).toBe('identity' as LayerName);
    });

    test('should create LayerName from "state"', () => {
        const layer = createLayerName('state');
        expect(layer).toBe('state' as LayerName);
    });

    test('should create LayerName from "events"', () => {
        const layer = createLayerName('events');
        expect(layer).toBe('events' as LayerName);
    });

    test('should throw error for invalid layer name', () => {
        expect(() => createLayerName('invalid')).toThrow();
    });

    test('should throw error for empty string', () => {
        expect(() => createLayerName('')).toThrow();
    });

    test('should throw error for non-string values', () => {
        expect(() => createLayerName(123 as unknown as string)).toThrow();
    });
});

describe.concurrent('isLayerName', () => {
    test('should return true for valid layer names', () => {
        expect(isLayerName('identity')).toBe(true);
        expect(isLayerName('state')).toBe(true);
        expect(isLayerName('events')).toBe(true);
    });

    test('should return false for invalid string', () => {
        expect(isLayerName('invalid')).toBe(false);
    });

    test('should return false for empty string', () => {
        expect(isLayerName('')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isLayerName(123)).toBe(false);
        expect(isLayerName(null)).toBe(false);
        expect(isLayerName(undefined)).toBe(false);
        expect(isLayerName({})).toBe(false);
    });
});

describe.concurrent('createContentType', () => {
    test('should create ContentType from "text/plain"', () => {
        const type = createContentType('text/plain');
        expect(type).toBe('text/plain' as ContentType);
    });

    test('should create ContentType from "text/markdown"', () => {
        const type = createContentType('text/markdown');
        expect(type).toBe('text/markdown' as ContentType);
    });

    test('should create ContentType from "application/json"', () => {
        const type = createContentType('application/json');
        expect(type).toBe('application/json' as ContentType);
    });

    test('should throw error for invalid content type', () => {
        expect(() => createContentType('text/html')).toThrow();
    });

    test('should throw error for empty string', () => {
        expect(() => createContentType('')).toThrow();
    });

    test('should throw error for non-string values', () => {
        expect(() => createContentType(123 as unknown as string)).toThrow();
    });
});

describe.concurrent('isContentType', () => {
    test('should return true for valid content types', () => {
        expect(isContentType('text/plain')).toBe(true);
        expect(isContentType('text/markdown')).toBe(true);
        expect(isContentType('application/json')).toBe(true);
    });

    test('should return false for invalid string', () => {
        expect(isContentType('text/html')).toBe(false);
    });

    test('should return false for empty string', () => {
        expect(isContentType('')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isContentType(123)).toBe(false);
        expect(isContentType(null)).toBe(false);
        expect(isContentType(undefined)).toBe(false);
        expect(isContentType({})).toBe(false);
    });
});
