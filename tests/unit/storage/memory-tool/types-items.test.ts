import { describe, it, expect } from 'bun:test';
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

describe('extractLayerFromPath', () => {
    it('should extract "identity" from /identity/core.md', () => {
        const layer = extractLayerFromPath(createMemoryPath('/identity/core.md'));
        expect(layer).toBe('identity' as LayerName);
    });

    it('should extract "identity" from /identity', () => {
        const layer = extractLayerFromPath(createMemoryPath('/identity'));
        expect(layer).toBe('identity' as LayerName);
    });

    it('should extract "state" from /state/project.json', () => {
        const layer = extractLayerFromPath(createMemoryPath('/state/project.json'));
        expect(layer).toBe('state' as LayerName);
    });

    it('should extract "state" from /state', () => {
        const layer = extractLayerFromPath(createMemoryPath('/state'));
        expect(layer).toBe('state' as LayerName);
    });

    it('should extract "events" from /events/timeline.md', () => {
        const layer = extractLayerFromPath(createMemoryPath('/events/timeline.md'));
        expect(layer).toBe('events' as LayerName);
    });

    it('should extract "events" from /events', () => {
        const layer = extractLayerFromPath(createMemoryPath('/events'));
        expect(layer).toBe('events' as LayerName);
    });

    it('should return null for /stateoftheart.md (no false positive)', () => {
        const layer = extractLayerFromPath(createMemoryPath('/stateoftheart.md'));
        expect(layer).toBeNull();
    });

    it('should return null for /identitytheft.md (no false positive)', () => {
        const layer = extractLayerFromPath(createMemoryPath('/identitytheft.md'));
        expect(layer).toBeNull();
    });

    it('should return null for /eventstoday.md (no false positive)', () => {
        const layer = extractLayerFromPath(createMemoryPath('/eventstoday.md'));
        expect(layer).toBeNull();
    });

    it('should return null for /other/file.md', () => {
        const layer = extractLayerFromPath(createMemoryPath('/other/file.md'));
        expect(layer).toBeNull();
    });

    it('should return null for root path /', () => {
        const layer = extractLayerFromPath(createMemoryPath('/'));
        expect(layer).toBeNull();
    });

    it('should return null for /documents/state/notes.md (state not at root)', () => {
        const layer = extractLayerFromPath(createMemoryPath('/documents/state/notes.md'));
        expect(layer).toBeNull();
    });

    it('should return null for /projects/identity/core.md (identity not at root)', () => {
        const layer = extractLayerFromPath(createMemoryPath('/projects/identity/core.md'));
        expect(layer).toBeNull();
    });
});

describe('layeredMemoryMetadataSchema', () => {
    it('should validate complete metadata with all fields', () => {
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

    it('should apply defaults for optional fields', () => {
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

    it('should require layer field', () => {
        const metadata = {
            importance: 5,
        };
        const result = layeredMemoryMetadataSchema.safeParse(metadata);
        expect(result.success).toBe(false);
    });

    it('should require valid LayerName for layer', () => {
        const metadata = {
            layer: 'invalid',
        };
        const result = layeredMemoryMetadataSchema.safeParse(metadata);
        expect(result.success).toBe(false);
    });

    it('should accept importance from 1 to 10', () => {
        for(let importance = 1; importance <= 10; importance++) {
            const result = layeredMemoryMetadataSchema.safeParse({
                layer: 'identity' as LayerName,
                importance,
            });
            expect(result.success).toBe(true);
        }
    });

    it('should reject importance less than 1', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:      'identity' as LayerName,
            importance: 0,
        });
        expect(result.success).toBe(false);
    });

    it('should reject importance greater than 10', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:      'identity' as LayerName,
            importance: 11,
        });
        expect(result.success).toBe(false);
    });

    it('should reject non-integer importance', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:      'identity' as LayerName,
            importance: 5.5,
        });
        expect(result.success).toBe(false);
    });

    it('should validate lastAccessed as ISO datetime', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:        'events' as LayerName,
            lastAccessed: 'not-a-date',
        });
        expect(result.success).toBe(false);
    });

    it('should accept valid ISO datetime for lastAccessed', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:        'events' as LayerName,
            lastAccessed: '2024-01-15T12:30:45.123Z',
        });
        expect(result.success).toBe(true);
    });

    it('should require accessCount to be non-negative', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:       'state' as LayerName,
            accessCount: -1,
        });
        expect(result.success).toBe(false);
    });

    it('should accept accessCount of 0', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:       'state' as LayerName,
            accessCount: 0,
        });
        expect(result.success).toBe(true);
    });

    it('should accept positive accessCount', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:       'state' as LayerName,
            accessCount: 100,
        });
        expect(result.success).toBe(true);
    });

    it('should reject non-integer accessCount', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:       'state' as LayerName,
            accessCount: 5.5,
        });
        expect(result.success).toBe(false);
    });

    it('should accept array of valid MemoryPaths for relatedPaths', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:        'identity' as LayerName,
            relatedPaths: ['/state/project.json', '/events/timeline.md'],
        });
        expect(result.success).toBe(true);
    });

    it('should accept empty array for relatedPaths', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:        'identity' as LayerName,
            relatedPaths: [],
        });
        expect(result.success).toBe(true);
    });

    it('should reject invalid MemoryPaths in relatedPaths', () => {
        const result = layeredMemoryMetadataSchema.safeParse({
            layer:        'identity' as LayerName,
            relatedPaths: ['invalid-path', '/valid/path'],
        });
        expect(result.success).toBe(false);
    });
});
