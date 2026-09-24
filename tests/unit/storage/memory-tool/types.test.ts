import { describe, test, expect, expectTypeOf } from 'bun:test';
import {
    memoryPathSchema,
    contentTypeSchema,
    memoryToolItemSchema,
    createMemoryPath,
    isMemoryPath,
    createLayerName,
    isLayerName,
    createContentType,
    isContentType,
    layerNameSchema,
    decodeMemoryAccessStats,
    decodePendingRenameIndexCleanup,
    memoryAccessStatsSchema,
    pendingRenameIndexCleanupSchema,
    pathNamespaceSchema,
    type MemoryPath,
    type LayerName,
    type IndexLayer,
    type ContentType,
    type MemoryPathClass,
    type SearchableNamespace,
    type TagIndexItem,
    type TagIndexReadItem,
    classifyMemoryPath,
    createIndexLayer,
    createSearchableNamespace,
    LAYER_NAME_VALUES,
    LAYER_NAMES,
    SELF_LAYER_NAME_VALUES,
    SEARCHABLE_NAMESPACE_VALUES,
    SEARCHABLE_NAMESPACES
} from '@/storage/memory-tool/types';

describe.concurrent('host-owned memory metadata', () => {
    const fallback = '2025-01-01T00:00:00.000Z';
    const accessed = '2025-02-01T00:00:00.000Z';

    test.each([
        ['absent', undefined, 0, fallback],
        ['null', null, 0, fallback],
        ['array', Object.assign([], { accessCount: 3, lastAccessed: accessed }), 0, fallback],
        ['string count', { accessCount: '3', lastAccessed: accessed }, 0, accessed],
        ['negative count', { accessCount: -1 }, 0, fallback],
        ['fractional count', { accessCount: 1.5 }, 0, fallback],
        ['invalid timestamp', { accessCount: 3, lastAccessed: 'yesterday' }, 3, fallback],
        ['valid legacy row', { accessCount: 3, lastAccessed: accessed, annotation: 'retained' }, 3, accessed],
    ] as const)('decodes access stats: %s', (_name, metadata, accessCount, lastAccessedAt) => {
        expect(decodeMemoryAccessStats(metadata, fallback)).toEqual({ accessCount, lastAccessedAt });
    });

    test('access stats schema rejects malformed shape', () => {
        expect(memoryAccessStatsSchema.safeParse({ accessCount: -1, lastAccessedAt: accessed }).success).toBe(false);
        expect(memoryAccessStatsSchema.safeParse({ accessCount: 1, lastAccessedAt: accessed }).success).toBe(true);
    });

    test.each([
        ['missing', undefined, undefined],
        ['null', null, undefined],
        ['array', Object.assign([], { previouslyKnownAs: '/state/old' }), undefined],
        ['non-string path', { previouslyKnownAs: 4 }, undefined],
        ['malformed path', { previouslyKnownAs: 'state/old' }, undefined],
        ['known tags', { previouslyKnownAs: '/state/old', previouslyKnownAsTags: ['a'] }, { oldPath: '/state/old', tags: { kind: 'known', tags: ['a'] } }],
        ['empty known tags', { previouslyKnownAs: '/state/old', previouslyKnownAsTags: [] }, { oldPath: '/state/old', tags: { kind: 'known', tags: [] } }],
        ['legacy absent tags', { previouslyKnownAs: '/state/old' }, { oldPath: '/state/old', tags: { kind: 'legacy-unknown' } }],
        ['legacy malformed tags', { previouslyKnownAs: '/state/old', previouslyKnownAsTags: ['a', 7] }, { oldPath: '/state/old', tags: { kind: 'legacy-unknown' } }],
    ] as const)('decodes pending rename cleanup: %s', (_name, metadata, expected) => {
        expect(decodePendingRenameIndexCleanup(metadata) as unknown).toEqual(expected);
    });

    test('pending cleanup schema validates known and legacy variants', () => {
        expect(pendingRenameIndexCleanupSchema.safeParse({ oldPath: '/state/old', tags: { kind: 'legacy-unknown' } }).success).toBe(true);
        expect(pendingRenameIndexCleanupSchema.safeParse({ oldPath: '/state/old', tags: { kind: 'known', tags: ['a'] } }).success).toBe(true);
        expect(pendingRenameIndexCleanupSchema.safeParse({ oldPath: 'bad', tags: { kind: 'known', tags: [] } }).success).toBe(false);
    });
});

describe.concurrent('memoryPathSchema', () => {
    test.each([
        { name: 'valid simple path', path: '/notes' },
        { name: 'valid nested path', path: '/projects/isambard/todo' },
    ])('should accept $name', ({ path }) => {
        const result = memoryPathSchema.safeParse(path);
        expect(result.success).toBe(true);
    });

    test('rejects root as a memory item, not only as a trailing slash', () => {
        const result = memoryPathSchema.safeParse('/');
        expect(result.error?.issues.map(issue => issue.message)).toEqual([
            'Root path / is not a memory item',
            'Path cannot end with /',
        ]);
    });

    test.each([
        { name: 'path not starting with /', input: 'notes', message: 'Path must start with /' },
        { name: 'path containing a slash but not starting with one', input: 'memories/notes.md', message: 'Path must start with /' },
        { name: 'path with double slashes', input: '/notes//todo', message: 'Path cannot contain double slashes' },
        { name: 'path with trailing slash (except root)', input: '/notes/', message: 'Path cannot end with /' },
        { name: 'empty string', input: '', message: 'Path cannot be empty' },
    ])('should reject $name', ({ input, message }) => {
        const result = memoryPathSchema.safeParse(input);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain(message);
        }
    });

    test('should reject non-string values', () => {
        const result = memoryPathSchema.safeParse(123);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('memory path namespaces', () => {
    test('a path namespace is one non-empty path segment', () => {
        expect(pathNamespaceSchema.safeParse('').error?.issues.map(issue => issue.message)).toEqual(['Namespace cannot be empty']);
        expect(pathNamespaceSchema.safeParse('users/other').error?.issues.map(issue => issue.message)).toEqual(['Namespace cannot contain /']);
        expect(pathNamespaceSchema.parse('users') as string).toBe('users');
        expect(createIndexLayer('legacy') as string).toBe('legacy');
        expect(() => createIndexLayer('a/b')).toThrow('Namespace cannot contain /');
    });

    test('derives cognitive layers and searchable namespaces from one tuple', () => {
        const cognitiveAsIndex: IndexLayer = createLayerName('state');
        expect(cognitiveAsIndex as string).toBe('state');
        expect(LAYER_NAME_VALUES).toEqual(['identity', 'state', 'events']);
        expect(SELF_LAYER_NAME_VALUES).toEqual(['identity', 'state']);
        expect(LAYER_NAMES).toEqual(LAYER_NAME_VALUES.map(name => createLayerName(name)));
        expect(SEARCHABLE_NAMESPACE_VALUES).toEqual(['identity', 'state', 'events', 'users']);
        expect(SEARCHABLE_NAMESPACES).toEqual(SEARCHABLE_NAMESPACE_VALUES.map(name => createSearchableNamespace(name)));
    });

    test('searchable namespaces accept users but reject typos and other roots', () => {
        expect(createSearchableNamespace('users') as string).toBe('users');
        expect(createSearchableNamespace('identity') as string).toBe('identity');
        expect(() => createSearchableNamespace('identiy')).toThrow();
        expect(() => createSearchableNamespace('foo')).toThrow();
        expect(() => createLayerName('users')).toThrow();
    });

    test.each([
        ['/identity', { namespace: 'identity', cognitiveLayer: 'identity' }],
        ['/identity/x', { namespace: 'identity', cognitiveLayer: 'identity' }],
        ['/state/file.md', { namespace: 'state', cognitiveLayer: 'state' }],
        ['/events/x', { namespace: 'events', cognitiveLayer: 'events' }],
        ['/users', { namespace: 'users' }],
        ['/users/person', { namespace: 'users', userId: 'person' }],
        ['/users/person/name', { namespace: 'users', userId: 'person' }],
        ['/foo/bar', { namespace: 'foo' }],
        ['/foo/state', { namespace: 'foo' }],
        ['/prefix/users/person', { namespace: 'prefix' }],
        ['/stateful', { namespace: 'stateful' }],
        ['/stateoftheart.md', { namespace: 'stateoftheart.md' }],
    ] as const)('classifies %s by its first path segment', (path, expected) => {
        expect(classifyMemoryPath(createMemoryPath(path)) as unknown).toStrictEqual(expected);
    });

    test('index layer fields carry a classified namespace; persisted tag reads stay untrusted strings', () => {
        expectTypeOf<TagIndexItem['layer']>().toEqualTypeOf<IndexLayer>();
        expectTypeOf<TagIndexReadItem['layer']>().toEqualTypeOf<string>();
        expectTypeOf<MemoryPathClass['cognitiveLayer']>().toEqualTypeOf<LayerName | undefined>();
        expectTypeOf<LayerName>().toExtend<IndexLayer>();
        expectTypeOf<SearchableNamespace>().toExtend<IndexLayer>();
        const legacyRead: TagIndexReadItem = { PK: 'TAG#person', SK: 'PATH#/users/a/n', memoryPath: '/users/a/n', layer: 'unknown', updatedAt: '2024-01-01T00:00:00.000Z', tags: new Set() };
        expect(legacyRead.layer).not.toBe(classifyMemoryPath(createMemoryPath(legacyRead.memoryPath)).namespace);
    });
});

describe.concurrent('createMemoryPath', () => {
    test('should create MemoryPath from valid string', () => {
        const path = createMemoryPath('/notes/todo');
        expect(path).toBe('/notes/todo' as MemoryPath);
    });

    test('rejects root with a clear error', () => {
        expect(() => createMemoryPath('/')).toThrow('Root path / is not a memory item');
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
    test.each([
        'text/plain',
        'text/markdown',
        'application/json',
    ])('should accept %s', (value) => {
        const result = contentTypeSchema.safeParse(value);
        expect(result.success).toBe(true);
    });

    test('should reject invalid content type', () => {
        const result = contentTypeSchema.safeParse('text/html');
        expect(result.success).toBe(false);
    });
});

describe.concurrent('layerNameSchema', () => {
    test.each([
        'identity',
        'state',
        'events',
    ])('should accept "%s"', (value) => {
        const result = layerNameSchema.safeParse(value);
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

describe.concurrent('memoryToolItemSchema - content field bounds', () => {
    const baseItem = {
        path:        '/test/file.md',
        contentType: 'text/plain',
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    test('defaults absent metadata to an empty object', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, content: 'a' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({});
        }
    });

    test('accepts content at the 1-char minimum', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, content: 'a' });
        expect(result.success).toBe(true);
    });

    test('rejects empty content', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, content: '' });
        expect(result.success).toBe(false);
    });

    test('accepts content at the 300,000-char maximum', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, content: 'a'.repeat(300_000) });
        expect(result.success).toBe(true);
    });

    test('rejects content one char over the 300,000-char maximum', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, content: 'a'.repeat(300_001) });
        expect(result.success).toBe(false);
    });
});

describe.concurrent('memoryToolItemSchema - contentPreview field bounds', () => {
    const baseItem = {
        path:        '/test/file.md',
        content:     'Test content',
        contentType: 'text/plain',
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    test('accepts contentPreview at the 100-char maximum', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, contentPreview: 'a'.repeat(100) });
        expect(result.success).toBe(true);
    });

    test('rejects contentPreview one char over the 100-char maximum', () => {
        const result = memoryToolItemSchema.safeParse({ ...baseItem, contentPreview: 'a'.repeat(101) });
        expect(result.success).toBe(false);
    });
});

describe.concurrent('memoryToolItemSchema - tags field', () => {
    const baseItem = {
        path:        '/test/file.md',
        content:     'Test content',
        contentType: 'text/plain',
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    test('should parse Set<string> input and output Set<string>', () => {
        const input = { ...baseItem, tags: new Set(['tag1', 'tag2']) };
        const result = memoryToolItemSchema.safeParse(input);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tags).toBeInstanceOf(Set);
            expect(result.data.tags).toEqual(new Set(['tag1', 'tag2']));
        }
    });

    test('should handle undefined tags', () => {
        const result = memoryToolItemSchema.safeParse(baseItem);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tags).toBeUndefined();
        }
    });

    test('should handle empty Set', () => {
        const input = { ...baseItem, tags: new Set<string>() };
        const result = memoryToolItemSchema.safeParse(input);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tags).toBeInstanceOf(Set);
            expect(result.data.tags!.size).toBe(0);
        }
    });

    test('should reject null tags', () => {
        const input = { ...baseItem, tags: null };
        const result = memoryToolItemSchema.safeParse(input);
        expect(result.success).toBe(false);
    });

    test('should reject array tags', () => {
        const input = { ...baseItem, tags: ['tag1', 'tag2'] };
        const result = memoryToolItemSchema.safeParse(input);
        expect(result.success).toBe(false);
    });
});
