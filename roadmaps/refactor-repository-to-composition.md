# Refactor Repository from Inheritance to Composition

## Problem Statement

`BaseRepository` uses classical inheritance, but this pattern creates awkward coupling when used with helper classes. `MemoryToolBackend` extends `BaseRepository` and passes inherited methods as callbacks via `.bind(this)` to specialized helper classes (`MemoryToolBackendCore`, `MemoryToolBackendQuery`, `MemoryToolBackendTagIndex`). This is a leaky abstraction that exposes internal implementation details.

**Key issues:**
- `.bind(this)` callbacks are verbose and error-prone
- Helper classes receive method references instead of clear interfaces
- Testing requires mocking the parent class or DynamoDB client
- Inheritance couples storage implementation to DynamoDB client lifecycle
- Helper classes like `MemoryToolBackendTagIndex` receive indirect callbacks instead of clear interfaces

## Current Pattern

**BaseRepository (src/storage/repositories/base.ts):**
```typescript
export abstract class BaseRepository<_T> {
    protected readonly docClient: DynamoDBDocumentClient;
    protected readonly tableName: string;

    protected async putItem(item: Record<string, unknown>): Promise<void> { ... }
    protected async getItem<R>(key: DynamoDBKey): Promise<R | undefined> { ... }
    protected async deleteItem(key: DynamoDBKey): Promise<void> { ... }
    protected async query<R>(params: Omit<QueryCommandInput, 'TableName'>): Promise<R[]> { ... }
}
```

**MemoryToolBackend extends BaseRepository:**
```typescript
export class MemoryToolBackend extends BaseRepository<MemoryToolItemData> {
    private readonly coreOps: MemoryToolBackendCore;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName);

        // Awkward: passing inherited methods as callbacks
        this.coreOps = new MemoryToolBackendCore(
            docClient,
            tableName,
            this.putItem.bind(this),      // ❌ Leaky abstraction
            this.getItem.bind(this),      // ❌ Leaky abstraction
            this.deleteItem.bind(this),   // ❌ Leaky abstraction
            stripDynamoKeys
        );

        this.queryOps = new MemoryToolBackendQuery(
            docClient,
            tableName,
            stripDynamoKeys
        );

        this.tagIndexOps = new MemoryToolBackendTagIndex(
            docClient,
            tableName,
            stripDynamoKeys,
            this.listByLayer.bind(this)   // ❌ Leaky abstraction
        );
    }
}
```

**Helper class signature:**
```typescript
export class MemoryToolBackendCore {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly putItem: (item: Record<string, unknown>) => Promise<void>,  // Callback
        private readonly getItem: <R>(key: DynamoDBKey) => Promise<R | undefined>,  // Callback
        private readonly deleteItem: (key: DynamoDBKey) => Promise<void>,          // Callback
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData
    ) {}
}
```

## Proposed Pattern

Rename `BaseRepository` to `DynamoDBOperations` and use composition instead of inheritance.

**DynamoDBOperations (src/storage/repositories/base.ts):**
```typescript
/**
 * Low-level DynamoDB operations wrapper.
 * Provides common CRUD operations for DynamoDB tables.
 * Intended for composition, not inheritance.
 */
export class DynamoDBOperations {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string
    ) {}

    async putItem(item: Record<string, unknown>): Promise<void> { ... }
    async getItem<R>(key: DynamoDBKey): Promise<R | undefined> { ... }
    async deleteItem(key: DynamoDBKey): Promise<void> { ... }
    async query<R>(params: Omit<QueryCommandInput, 'TableName'>): Promise<R[]> { ... }
}
```

**MemoryToolBackend composes DynamoDBOperations:**
```typescript
export class MemoryToolBackend {
    private readonly dynamo: DynamoDBOperations;
    private readonly coreOps: MemoryToolBackendCore;
    private readonly queryOps: MemoryToolBackendQuery;
    private readonly tagIndexOps: MemoryToolBackendTagIndex;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.dynamo = new DynamoDBOperations(docClient, tableName);

        // Clean: passing the dynamo instance directly
        this.coreOps = new MemoryToolBackendCore(
            this.dynamo,        // ✅ Clear interface
            stripDynamoKeys
        );

        this.queryOps = new MemoryToolBackendQuery(
            this.dynamo,        // ✅ Clear interface
            stripDynamoKeys
        );

        this.tagIndexOps = new MemoryToolBackendTagIndex(
            this.dynamo,        // ✅ Clear interface
            stripDynamoKeys,
            this.listByLayer.bind(this)  // Still needed - listByLayer delegates to queryOps
        );
    }

    // Public API delegates to helpers
    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        return this.coreOps.create(input);
    }

    async list(directoryPath: string, options?: ListOptions): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.list(directoryPath, options);
    }

    // ... other methods
}
```

**Helper class signature (simplified):**
```typescript
export class MemoryToolBackendCore {
    constructor(
        private readonly dynamo: DynamoDBOperations,  // Clear dependency
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData
    ) {}

    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        // Use dynamo directly
        const item = { ...buildItem(input) };
        await this.dynamo.putItem(item);
        return data;
    }
}
```

## Changes Required

### 1. Rename BaseRepository
- **File:** `src/storage/repositories/base.ts`
- **Action:** Rename class `BaseRepository<T>` → `DynamoDBOperations`
- **Action:** Remove abstract class pattern, make it concrete
- **Action:** Remove generic `<T>` parameter (not used)
- **Action:** Change method visibility from `protected` to `public`

### 2. Update MemoryToolBackend
- **File:** `src/storage/memory-tool/backend.ts`
- **Action:** Remove `extends BaseRepository<MemoryToolItemData>`
- **Action:** Add `private readonly dynamo: DynamoDBOperations`
- **Action:** Initialize `this.dynamo = new DynamoDBOperations(docClient, tableName)`
- **Action:** Pass `this.dynamo` to helper constructors instead of individual callbacks

### 3. Update MemoryToolBackendCore
- **File:** `src/storage/memory-tool/backend-core.ts`
- **Action:** Change constructor signature to accept `dynamo: DynamoDBOperations`
- **Action:** Replace callback parameters (`putItem`, `getItem`, `deleteItem`) with `this.dynamo` calls
- **Action:** Keep `stripKeys` callback (utility function, not DynamoDB operation)

### 4. Update MemoryToolBackendQuery
- **File:** `src/storage/memory-tool/backend-query.ts`
- **Action:** Change constructor to accept `dynamo: DynamoDBOperations`
- **Action:** Replace direct `docClient` and `tableName` usage with `this.dynamo` where applicable
- **Action:** Some methods use `QueryCommand` directly - these can stay as-is or use dynamo.query()

### 5. Update MemoryToolBackendTagIndex
- **File:** `src/storage/memory-tool/backend-tag-index.ts`
- **Action:** Change constructor to accept `dynamo: DynamoDBOperations`
- **Action:** Replace direct `docClient` and `tableName` usage with `this.dynamo`
- **Action:** Keep `listByLayer` callback (cross-module dependency to queryOps)

### 6. Check for Other Usages
- **Action:** Search for `extends BaseRepository` across the codebase
- **Action:** Update any other repositories to use composition pattern
- **Action:** Note: `MemoryRepository` does not currently exist in `src/storage/repositories/` (only `base.ts` and `.gitkeep`)

## Testing Strategy

### Unit Test Updates
- Mock `DynamoDBOperations` instead of mocking DynamoDB client
- Easier to verify method calls without dealing with SDK types
- Example:
```typescript
const mockDynamo: DynamoDBOperations = {
    putItem: vi.fn(),
    getItem: vi.fn().mockResolvedValue(mockItem),
    deleteItem: vi.fn(),
    query: vi.fn(),
};

const backend = new MemoryToolBackendCore(mockDynamo, stripDynamoKeys);
await backend.create(input);

expect(mockDynamo.putItem).toHaveBeenCalledWith(expectedItem);
```

### Integration Tests
- No changes required - DynamoDB client behavior unchanged
- Existing integration tests should pass without modification

### Mutation Testing
- Verify that removal of `.bind(this)` doesn't introduce bugs
- Ensure all method calls go through correct dynamo instance

## Benefits

### Cleaner API
- No more `.bind(this)` boilerplate
- Clear interface: helpers receive `DynamoDBOperations` instead of callbacks
- Easier to understand dependencies

### Better Testability
- Mock `DynamoDBOperations` interface instead of DynamoDB client
- Simpler test setup
- More focused unit tests

### Improved Maintainability
- Composition is more flexible than inheritance
- Easier to add new operations to `DynamoDBOperations`
- No coupling between backend lifecycle and DynamoDB client

### Type Safety
- TypeScript enforces `DynamoDBOperations` interface
- No risk of forgetting `.bind(this)` or passing wrong context

## Migration Path

1. **Phase 1:** Rename `BaseRepository` → `DynamoDBOperations` (no behavior change)
2. **Phase 2:** Update tests to use mocked `DynamoDBOperations`
3. **Phase 3:** Refactor `MemoryToolBackend` to use composition
4. **Phase 4:** Update helper classes to accept `DynamoDBOperations`
5. **Phase 5:** Run full test suite, verify mutation score
6. **Phase 6:** Remove any remaining inheritance patterns

## Priority

**Medium.** Current code works, but the pattern is awkward and makes testing harder. This refactor will improve maintainability and set a better pattern for future repositories.
