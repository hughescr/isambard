import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    memoryToolItemSchema,
    createMemoryPath,
    createMemoryToolKeys,
    extractLayerFromPath,
    layeredMemoryMetadataSchema,
    type MemoryPath,
    type LayerName
} from '@/storage/memory-tool/types';

describe.concurrent('memoryToolItemSchema', () => {
    const validItem = {
        path:        '/test' as MemoryPath,
        content:     'Test content',
        contentType: 'text/plain',
        version:     1,
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    test('should validate complete memory tool item', () => {
        const result = memoryToolItemSchema.safeParse(validItem);
        expect(result.success).toBe(true);
    });

    test('should apply default empty object for metadata', () => {
        const result = memoryToolItemSchema.safeParse(validItem);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({});
        }
    });

    test('should accept custom metadata and tags', () => {
        const result = memoryToolItemSchema.safeParse({
            ...validItem,
            metadata: { author: 'claude', priority: 5 },
            tags:     ['important', 'work'],
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({ author: 'claude', priority: 5 });
            expect(result.data.tags).toEqual(['important', 'work']);
        }
    });

    test('should reject content over 300KB', () => {
        const largeContent = _.repeat('x', 300001);
        const result = memoryToolItemSchema.safeParse({ ...validItem, content: largeContent });
        expect(result.success).toBe(false);
    });

    test('should accept content at 300KB limit', () => {
        const maxContent = _.repeat('x', 300000);
        const result = memoryToolItemSchema.safeParse({ ...validItem, content: maxContent });
        expect(result.success).toBe(true);
    });
});

describe.concurrent('createMemoryToolKeys', () => {
    test.each([
        {
            name:       'should create correct PK and SK',
            path:       '/projects/isambard' as MemoryPath,
            tags:       undefined,
            updatedAt:  undefined,
            expectedPK: 'TOOL_MEMORY#/projects/isambard',
            expectedSK: 'TOOL_MEMORY#/projects/isambard',
        },
        {
            name:           'should create GSI1PK with first tag when tags provided',
            path:           '/projects/isambard' as MemoryPath,
            tags:           ['work', 'important'] as string[],
            updatedAt:      '2024-01-01T00:00:00.000Z',
            expectedGSI1PK: 'TOOL_MEMORY#TAG#work',
            expectedGSI1SK: '2024-01-01T00:00:00.000Z',
        },
        {
            name:           'should create GSI1PK from path when no tags',
            path:           '/projects/isambard' as MemoryPath,
            tags:           undefined,
            updatedAt:      '2024-01-01T00:00:00.000Z',
            expectedGSI1PK: 'TOOL_MEMORY#/projects/isambard',
            expectedGSI1SK: '2024-01-01T00:00:00.000Z',
        },
        {
            name:           'should create GSI1SK as empty string when updatedAt not provided',
            path:           '/projects/isambard' as MemoryPath,
            tags:           undefined,
            updatedAt:      undefined,
            expectedGSI1SK: '',
        },
    ])('$name', ({ path, tags, updatedAt, expectedPK, expectedSK, expectedGSI1PK, expectedGSI1SK }) => {
        const keys = createMemoryToolKeys(path, tags, updatedAt);
        if(expectedPK) { expect(keys.PK).toBe(expectedPK); }
        if(expectedSK) { expect(keys.SK).toBe(expectedSK); }
        if(expectedGSI1PK !== undefined) { expect(keys.GSI1PK).toBe(expectedGSI1PK); }
        if(expectedGSI1SK !== undefined) { expect(keys.GSI1SK).toBe(expectedGSI1SK); }
    });
});

describe.concurrent('extractLayerFromPath', () => {
    test.each([
        { path: '/identity/core.md', expected: 'identity' as LayerName, desc: 'identity with file' },
        { path: '/identity', expected: 'identity' as LayerName, desc: 'identity alone' },
        { path: '/state/project.json', expected: 'state' as LayerName, desc: 'state with file' },
        { path: '/state', expected: 'state' as LayerName, desc: 'state alone' },
        { path: '/events/timeline.md', expected: 'events' as LayerName, desc: 'events with file' },
        { path: '/events', expected: 'events' as LayerName, desc: 'events alone' },
        { path: '/stateoftheart.md', expected: null, desc: 'no false positive for state prefix' },
        { path: '/identitytheft.md', expected: null, desc: 'no false positive for identity prefix' },
        { path: '/eventstoday.md', expected: null, desc: 'no false positive for events prefix' },
        { path: '/other/file.md', expected: null, desc: 'non-layer path' },
        { path: '/', expected: null, desc: 'root path' },
        { path: '/documents/state/notes.md', expected: null, desc: 'state not at root' },
    ])('should handle $desc', ({ path, expected }) => {
        const layer = extractLayerFromPath(createMemoryPath(path));
        expect(layer).toBe(expected);
    });
});

describe.concurrent('layeredMemoryMetadataSchema', () => {
    test('should validate complete metadata with all fields', () => {
        const metadata = {
            layer:        'identity' as LayerName,
            importance:   8,
            lastAccessed: '2024-01-01T00:00:00.000Z',
            accessCount:  5,
            relatedPaths: ['/state/project.json', '/events/timeline.md'],
        };
        const result = layeredMemoryMetadataSchema.safeParse(metadata);
        expect(result.success).toBe(true);
    });

    test('should apply defaults for optional fields', () => {
        const metadata = {
            layer: 'state' as LayerName,
        };
        const result = layeredMemoryMetadataSchema.safeParse(metadata);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.importance).toBe(5);
            expect(result.data.lastAccessed).toBeUndefined();
            expect(result.data.accessCount).toBe(0);
            expect(result.data.relatedPaths).toEqual([]);
        }
    });

    test.each([
        { importance: 1, valid: true, desc: 'minimum importance (1)' },
        { importance: 10, valid: true, desc: 'maximum importance (10)' },
        { importance: 0, valid: false, desc: 'importance less than 1' },
        { importance: 11, valid: false, desc: 'importance greater than 10' },
        { importance: 5.5, valid: false, desc: 'non-integer importance' },
    ])('should validate $desc', ({ importance, valid }) => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer: 'identity' as LayerName,
            importance,
        });
        expect(result.success).toBe(valid);
    });

    test.each([
        { accessCount: 0, valid: true, desc: 'accessCount of 0' },
        { accessCount: 100, valid: true, desc: 'positive accessCount' },
        { accessCount: -1, valid: false, desc: 'negative accessCount' },
        { accessCount: 5.5, valid: false, desc: 'non-integer accessCount' },
    ])('should validate $desc', ({ accessCount, valid }) => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer: 'state' as LayerName,
            accessCount,
        });
        expect(result.success).toBe(valid);
    });
});
