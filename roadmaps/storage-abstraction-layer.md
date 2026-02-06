# Storage Abstraction Layer

## Problem Statement

All storage operations are tightly coupled to DynamoDB. This creates several problems:

- **Testing complexity:** Unit tests require DynamoDB mocks or test containers
- **Inflexibility:** Cannot swap storage backends (e.g., for local development, different environments)
- **Vendor lock-in:** DynamoDB-specific concepts (GSI1, key structures, tag index items) leak into business logic
- **Testability:** Integration tests are slow and require infrastructure

A proper storage abstraction would decouple the memory tool from its persistence layer, allowing different implementations while preserving the same interface.

## Proposed Interface Design

Create a clean, storage-agnostic interface for memory operations:

```typescript
/**
 * Storage interface for memory tool items.
 * Implementations can use any persistence backend (DynamoDB, in-memory, SQL, etc.)
 */
export interface MemoryStorage {
    // ============ CRUD Operations ============

    /**
     * Create a new memory item.
     * Throws PathAlreadyExistsError if path exists.
     */
    create(input: CreateInput): Promise<MemoryToolItemData>

    /**
     * Get a memory item by path.
     * Returns undefined if not found.
     */
    get(path: MemoryPath): Promise<MemoryToolItemData | undefined>

    /**
     * Update an existing memory item.
     * Throws ItemNotFoundError if path doesn't exist.
     * Throws ConflictError if version mismatch (optimistic locking).
     */
    update(path: MemoryPath, input: UpdateInput): Promise<MemoryToolItemData>

    /**
     * Delete a memory item.
     * No error if item doesn't exist (idempotent).
     */
    delete(path: MemoryPath): Promise<void>

    // ============ Query Operations ============

    /**
     * List all items in a directory.
     * Returns items sorted by createdAt (oldest first).
     */
    list(directory: string, options?: ListOptions): Promise<ListResult>

    /**
     * Search for items by tags.
     * Optionally filter by layer and date range.
     */
    searchByTags(tags: string[], layer?: LayerName, options?: ListOptions): Promise<ListResult>

    /**
     * List all items in a layer.
     * Returns items sorted by updatedAt (newest first).
     */
    listByLayer(layer: LayerName, options?: ListOptions): Promise<ListResult>

    /**
     * Search for items within a time range.
     * Optionally filter by layer.
     * Returns items sorted by updatedAt (oldest first).
     */
    searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]>

    // ============ Version Operations ============

    /**
     * Get a specific version of a memory item.
     * Returns undefined if version doesn't exist.
     */
    getVersion(path: MemoryPath, version: number): Promise<MemoryToolItemData | undefined>

    /**
     * List all versions of a memory item.
     * Returns versions sorted by version number (newest first).
     */
    listVersions(path: MemoryPath, limit?: number): Promise<VersionInfo[]>

    /**
     * Prune old versions, keeping only the most recent N.
     * Returns the number of versions deleted.
     */
    pruneVersions(path: MemoryPath, keepCount: number): Promise<number>

    /**
     * Get items that should be auto-loaded into agent context.
     * Returns identity and state layer items with autoLoad=true.
     */
    getAutoLoadItems(options?: {
        maxIdentityItems?: number
        maxStateItems?: number
    }): Promise<MemoryToolItemData[]>
}

/**
 * Input types for storage operations
 */
export interface CreateInput {
    path:        MemoryPath
    content:     string
    contentType: ContentType
    metadata?:   Record<string, unknown>
    tags?:       string[]
}

export interface UpdateInput {
    content?:  string
    metadata?: Record<string, unknown>
    tags?:     string[]
}

export interface ListOptions {
    limit?:     number
    cursor?:    string
    startDate?: string  // ISO8601 datetime, inclusive
    endDate?:   string  // ISO8601 datetime, inclusive
}

export interface ListResult {
    items:       MemoryToolItemData[]
    nextCursor?: string
}

export interface VersionInfo {
    version:   number
    updatedAt: string
    size:      number
}
```

## Adapter Implementations

### 1. DynamoDBMemoryStorage

Wraps the current `MemoryToolBackend` to implement the `MemoryStorage` interface.

**File:** `src/storage/memory-tool/adapters/dynamodb-storage.ts`

```typescript
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MemoryStorage } from '../storage-interface';
import { MemoryToolBackend } from '../backend';

/**
 * DynamoDB adapter for MemoryStorage interface.
 * Wraps MemoryToolBackend to provide storage abstraction.
 */
export class DynamoDBMemoryStorage implements MemoryStorage {
    private readonly backend: MemoryToolBackend;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.backend = new MemoryToolBackend(docClient, tableName);
    }

    // Delegate all methods to backend
    async create(input: CreateInput): Promise<MemoryToolItemData> {
        return this.backend.create(input);
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        return this.backend.get(path);
    }

    async update(path: MemoryPath, input: UpdateInput): Promise<MemoryToolItemData> {
        return this.backend.update(path, input);
    }

    async delete(path: MemoryPath): Promise<void> {
        return this.backend.delete(path);
    }

    async list(directory: string, options?: ListOptions): Promise<ListResult> {
        return this.backend.list(directory, options);
    }

    async searchByTags(tags: string[], layer?: LayerName, options?: ListOptions): Promise<ListResult> {
        return this.backend.searchByTags(tags, layer, options);
    }

    async listByLayer(layer: LayerName, options?: ListOptions): Promise<ListResult> {
        return this.backend.listByLayer(layer, options);
    }

    async searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        return this.backend.searchByTimeRange(startTime, endTime, layer, options);
    }

    async getVersion(path: MemoryPath, version: number): Promise<MemoryToolItemData | undefined> {
        return this.backend.getVersion(path, version);
    }

    async listVersions(path: MemoryPath, limit?: number): Promise<VersionInfo[]> {
        return this.backend.listVersions(path, limit);
    }

    async pruneVersions(path: MemoryPath, keepCount: number): Promise<number> {
        return this.backend.pruneVersions(path, keepCount);
    }

    async getAutoLoadItems(options?: {
        maxIdentityItems?: number
        maxStateItems?: number
    }): Promise<MemoryToolItemData[]> {
        return this.backend.getAutoLoadItems(options);
    }
}
```

### 2. InMemoryStorage

Simple in-memory implementation for unit tests.

**File:** `src/storage/memory-tool/adapters/in-memory-storage.ts`

```typescript
import type { MemoryStorage, CreateInput, UpdateInput, ListOptions, ListResult } from '../storage-interface';
import type { MemoryPath, MemoryToolItemData, LayerName } from '../types';
import { ItemNotFoundError, ConflictError, PathAlreadyExistsError } from '../errors';
import { extractLayerFromPath } from '../types';

/**
 * In-memory implementation of MemoryStorage for testing.
 * All data is stored in a Map and lost when the process exits.
 */
export class InMemoryStorage implements MemoryStorage {
    private readonly items = new Map<MemoryPath, MemoryToolItemData>();
    private readonly versions = new Map<string, MemoryToolItemData[]>();

    async create(input: CreateInput): Promise<MemoryToolItemData> {
        if (this.items.has(input.path)) {
            throw new PathAlreadyExistsError(input.path);
        }

        const now = new Date().toISOString();
        const item: MemoryToolItemData = {
            path: input.path,
            content: input.content,
            contentType: input.contentType,
            metadata: input.metadata ?? {},
            tags: input.tags,
            version: 1,
            createdAt: now,
            updatedAt: now,
            contentPreview: generateContentPreview(input.content),
        };

        this.items.set(input.path, item);
        return item;
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        return this.items.get(path);
    }

    async update(path: MemoryPath, input: UpdateInput): Promise<MemoryToolItemData> {
        const existing = this.items.get(path);
        if (!existing) {
            throw new ItemNotFoundError(path);
        }

        // Save version snapshot
        const versionKey = path;
        const versionHistory = this.versions.get(versionKey) ?? [];
        versionHistory.push({ ...existing });
        this.versions.set(versionKey, versionHistory);

        // Update item
        const updated: MemoryToolItemData = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.metadata !== undefined && { metadata: input.metadata }),
            ...(input.tags !== undefined && { tags: input.tags }),
            version: existing.version + 1,
            updatedAt: new Date().toISOString(),
            contentPreview: input.content !== undefined
                ? generateContentPreview(input.content)
                : existing.contentPreview,
        };

        this.items.set(path, updated);
        return updated;
    }

    async delete(path: MemoryPath): Promise<void> {
        this.items.delete(path);
        this.versions.delete(path);
    }

    async list(directory: string, options?: ListOptions): Promise<ListResult> {
        const allItems = Array.from(this.items.values())
            .filter(item => item.path.startsWith(directory))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        // Simple pagination (no cursor support)
        const limit = options?.limit ?? allItems.length;
        const items = allItems.slice(0, limit);

        return { items, nextCursor: undefined };
    }

    async searchByTags(tags: string[], layer?: LayerName, options?: ListOptions): Promise<ListResult> {
        let allItems = Array.from(this.items.values())
            .filter(item => tags.some(tag => item.tags?.includes(tag)));

        if (layer) {
            allItems = allItems.filter(item => extractLayerFromPath(item.path) === layer);
        }

        if (options?.startDate || options?.endDate) {
            const start = options.startDate ?? '1970-01-01T00:00:00.000Z';
            const end = options.endDate ?? '9999-12-31T23:59:59.999Z';
            allItems = allItems.filter(item =>
                item.updatedAt >= start && item.updatedAt <= end
            );
        }

        const limit = options?.limit ?? allItems.length;
        const items = allItems.slice(0, limit);

        return { items, nextCursor: undefined };
    }

    async listByLayer(layer: LayerName, options?: ListOptions): Promise<ListResult> {
        let allItems = Array.from(this.items.values())
            .filter(item => extractLayerFromPath(item.path) === layer)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); // Newest first

        if (options?.startDate || options?.endDate) {
            const start = options.startDate ?? '1970-01-01T00:00:00.000Z';
            const end = options.endDate ?? '9999-12-31T23:59:59.999Z';
            allItems = allItems.filter(item =>
                item.updatedAt >= start && item.updatedAt <= end
            );
        }

        const limit = options?.limit ?? allItems.length;
        const items = allItems.slice(0, limit);

        return { items, nextCursor: undefined };
    }

    async searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        let allItems = Array.from(this.items.values())
            .filter(item => item.updatedAt >= startTime && item.updatedAt <= endTime);

        if (layer) {
            allItems = allItems.filter(item => extractLayerFromPath(item.path) === layer);
        }

        allItems.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

        const limit = options?.limit ?? allItems.length;
        return allItems.slice(-limit); // Keep newest N items
    }

    async getVersion(path: MemoryPath, version: number): Promise<MemoryToolItemData | undefined> {
        const versionHistory = this.versions.get(path) ?? [];
        return versionHistory.find(item => item.version === version);
    }

    async listVersions(path: MemoryPath, limit?: number): Promise<VersionInfo[]> {
        const versionHistory = this.versions.get(path) ?? [];
        const versions = versionHistory
            .map(item => ({
                version: item.version,
                updatedAt: item.updatedAt,
                size: item.content.length,
            }))
            .sort((a, b) => b.version - a.version); // Newest first

        return limit ? versions.slice(0, limit) : versions;
    }

    async pruneVersions(path: MemoryPath, keepCount: number): Promise<number> {
        const versionHistory = this.versions.get(path) ?? [];
        if (versionHistory.length <= keepCount) {
            return 0;
        }

        const sorted = [...versionHistory].sort((a, b) => b.version - a.version);
        const toKeep = sorted.slice(0, keepCount);
        this.versions.set(path, toKeep);

        return versionHistory.length - keepCount;
    }

    async getAutoLoadItems(options?: {
        maxIdentityItems?: number
        maxStateItems?: number
    }): Promise<MemoryToolItemData[]> {
        const identityItems = Array.from(this.items.values())
            .filter(item => extractLayerFromPath(item.path) === 'identity')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(0, options?.maxIdentityItems ?? 10);

        const stateItems = Array.from(this.items.values())
            .filter(item => extractLayerFromPath(item.path) === 'state')
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, options?.maxStateItems ?? 20);

        return [...identityItems, ...stateItems];
    }
}

function generateContentPreview(content: string): string {
    const maxLength = 100;
    return content.length > maxLength
        ? content.slice(0, maxLength) + '...'
        : content;
}
```

## Migration Strategy

### Phase 1: Define Interface
1. Create `src/storage/memory-tool/storage-interface.ts`
2. Define `MemoryStorage` interface with all methods
3. Define supporting types (`CreateInput`, `UpdateInput`, `ListOptions`, etc.)
4. No implementation changes yet

### Phase 2: Create DynamoDB Adapter
1. Create `src/storage/memory-tool/adapters/dynamodb-storage.ts`
2. Implement `DynamoDBMemoryStorage` adapter wrapping `MemoryToolBackend`
3. All methods delegate to existing backend
4. No behavior changes - pure wrapper

### Phase 3: Create InMemory Adapter
1. Create `src/storage/memory-tool/adapters/in-memory-storage.ts`
2. Implement `InMemoryStorage` using Map-based storage
3. Write unit tests to verify behavior matches DynamoDB adapter
4. Use for fast unit tests

### Phase 4: Update Consumers
1. Update memory tool handlers to accept `MemoryStorage` interface
2. Update agent initialization to create appropriate storage adapter
3. Update tests to use `InMemoryStorage` instead of DynamoDB mocks

### Phase 5: Refactor Backend (Optional)
1. Once adapters are stable, consider making `MemoryToolBackend` implement `MemoryStorage` directly
2. Remove adapter wrapper if no longer needed
3. This is optional - wrapper pattern is fine

## Testing Strategy

### Unit Tests
```typescript
describe('InMemoryStorage', () => {
    let storage: MemoryStorage;

    beforeEach(() => {
        storage = new InMemoryStorage();
    });

    it('should create and retrieve an item', async () => {
        const item = await storage.create({
            path: '/identity/name' as MemoryPath,
            content: 'Isambard',
            contentType: 'text/plain',
        });

        const retrieved = await storage.get('/identity/name' as MemoryPath);
        expect(retrieved).toEqual(item);
    });

    it('should throw PathAlreadyExistsError on duplicate create', async () => {
        await storage.create({
            path: '/identity/name' as MemoryPath,
            content: 'Isambard',
            contentType: 'text/plain',
        });

        await expect(storage.create({
            path: '/identity/name' as MemoryPath,
            content: 'Duplicate',
            contentType: 'text/plain',
        })).rejects.toThrow(PathAlreadyExistsError);
    });

    // ... more tests
});
```

### Integration Tests
```typescript
describe('DynamoDBMemoryStorage', () => {
    let storage: MemoryStorage;
    let docClient: DynamoDBDocumentClient;

    beforeEach(async () => {
        docClient = createTestDynamoClient();
        storage = new DynamoDBMemoryStorage(docClient, 'test-table');
    });

    it('should persist items to DynamoDB', async () => {
        const item = await storage.create({
            path: '/identity/name' as MemoryPath,
            content: 'Isambard',
            contentType: 'text/plain',
        });

        // Verify via direct DynamoDB query
        const result = await docClient.send(new GetCommand({
            TableName: 'test-table',
            Key: { PK: 'DIR#/identity', SK: 'FILE#name' },
        }));

        expect(result.Item).toBeDefined();
    });
});
```

### Contract Tests
```typescript
/**
 * Shared contract tests for all MemoryStorage implementations.
 * Ensures all adapters behave identically.
 */
export function runMemoryStorageContractTests(
    createStorage: () => Promise<MemoryStorage>
) {
    describe('MemoryStorage contract', () => {
        let storage: MemoryStorage;

        beforeEach(async () => {
            storage = await createStorage();
        });

        it('should support CRUD operations', async () => {
            // ... test CRUD
        });

        it('should support version history', async () => {
            // ... test versions
        });

        it('should support queries', async () => {
            // ... test queries
        });
    });
}

// Use with both implementations
runMemoryStorageContractTests(() => Promise.resolve(new InMemoryStorage()));
runMemoryStorageContractTests(() => createDynamoDBStorage());
```

## Benefits

### Testability
- Unit tests run in-memory without DynamoDB
- Faster test execution
- No infrastructure dependencies for unit tests
- Mock storage for isolated testing

### Flexibility
- Swap storage backends (DynamoDB, PostgreSQL, Redis, etc.)
- Different backends for dev/test/prod environments
- Experiment with new storage technologies without refactoring

### Separation of Concerns
- Business logic decoupled from storage implementation
- DynamoDB-specific concepts (GSI1, tag index) hidden behind interface
- Easier to understand memory tool handlers

### Future Extensibility
- Easy to add caching layer (decorator pattern)
- Easy to add metrics/observability (decorator pattern)
- Easy to add multi-region replication (adapter pattern)

## Priority

**Medium.** Current code is tightly coupled to DynamoDB, which makes testing harder and limits flexibility. This abstraction would improve testability significantly, but the current architecture is functional. Consider this refactor after completing more urgent features.
