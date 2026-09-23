# Refactor Repository from Inheritance to Composition

## Problem Statement

`DynamoTableAccess` (this document's proposed Phase 1 rename has already landed, in #88) uses classical inheritance, but this pattern creates awkward coupling when used with helper classes. `MemoryToolBackend` extends `DynamoTableAccess` and passes inherited methods as callbacks via `.bind(this)` to specialized helper classes (`MemoryToolBackendCore`, `MemoryToolBackendQuery`, `MemoryToolBackendTagIndex`). This is a leaky abstraction that exposes internal implementation details.

**Key issues:**
- `.bind(this)` callbacks are verbose and error-prone
- Helper classes receive method references instead of clear interfaces
- Testing requires mocking the parent class or DynamoDB client
- Inheritance couples storage implementation to DynamoDB client lifecycle
- Helper classes like `MemoryToolBackendTagIndex` receive indirect callbacks instead of clear interfaces

## Current Pattern

**DynamoTableAccess (src/storage/repositories/base.ts):**
```typescript
export abstract class DynamoTableAccess {
    protected readonly docClient: DynamoDBDocumentClient;
    protected readonly tableName: string;

    protected async putItem(item: Record<string, unknown>): Promise<void> { ... }
    protected async getItem(key: DynamoDBKey): Promise<Record<string, unknown> | undefined> { ... }
    protected async deleteItem(key: DynamoDBKey): Promise<void> { ... }
    protected async query(params: Omit<QueryCommandInput, 'TableName'>): Promise<Record<string, unknown>[]> { ... }
}
```

**MemoryToolBackend extends DynamoTableAccess:**
```typescript
export class MemoryToolBackend extends DynamoTableAccess {
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
        private readonly getItem: (key: DynamoDBKey) => Promise<Record<string, unknown> | undefined>,  // Callback
        private readonly deleteItem: (key: DynamoDBKey) => Promise<void>          // Callback
    ) {}
}
```

## Proposed Pattern

Use composition instead of inheritance, keeping the `DynamoTableAccess` name #88 already established.

**DynamoTableAccess as a composed collaborator (src/storage/repositories/base.ts):**
```typescript
/**
 * Low-level DynamoDB operations wrapper.
 * Provides common CRUD operations for DynamoDB tables.
 * Intended for composition, not inheritance.
 */
export class DynamoTableAccess {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string
    ) {}

    async putItem(item: Record<string, unknown>): Promise<void> { ... }
    async getItem(key: DynamoDBKey): Promise<Record<string, unknown> | undefined> { ... }
    async deleteItem(key: DynamoDBKey): Promise<void> { ... }
    async query(params: Omit<QueryCommandInput, 'TableName'>): Promise<Record<string, unknown>[]> { ... }
}
```

**MemoryToolBackend composes DynamoTableAccess:**
```typescript
export class MemoryToolBackend {
    private readonly dynamo: DynamoTableAccess;
    private readonly coreOps: MemoryToolBackendCore;
    private readonly queryOps: MemoryToolBackendQuery;
    private readonly tagIndexOps: MemoryToolBackendTagIndex;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.dynamo = new DynamoTableAccess(docClient, tableName);

        // Clean: passing the dynamo instance directly
        this.coreOps = new MemoryToolBackendCore(
            this.dynamo        // ✅ Clear interface
        );

        this.queryOps = new MemoryToolBackendQuery(
            this.dynamo        // ✅ Clear interface
        );

        this.tagIndexOps = new MemoryToolBackendTagIndex(
            this.dynamo,        // ✅ Clear interface
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
        private readonly dynamo: DynamoTableAccess  // Clear dependency
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

### 1. Rename to DynamoTableAccess (done — #88)
- **File:** `src/storage/repositories/base.ts`
- The class has no type parameter (#88); `getItem`/`query`/`scan` return raw `Record<string, unknown>` and every subclass validates what it reads. It is still `abstract` and still extended by all ten backends — inheritance itself is unchanged, only the name and the type-safety of the raw operations. The composition switch below (concrete class, `protected` → `public`, extended by no one) is still future work.

### 2. Update MemoryToolBackend
- **File:** `src/storage/memory-tool/backend.ts`
- **Action:** Remove `extends DynamoTableAccess`
- **Action:** Add `private readonly dynamo: DynamoTableAccess`
- **Action:** Initialize `this.dynamo = new DynamoTableAccess(docClient, tableName)`
- **Action:** Pass `this.dynamo` to helper constructors instead of individual callbacks

### 3. Update MemoryToolBackendCore
- **File:** `src/storage/memory-tool/backend-core.ts`
- **Action:** Change constructor signature to accept `dynamo: DynamoTableAccess`
- **Action:** Replace callback parameters (`putItem`, `getItem`, `deleteItem`) with `this.dynamo` calls
- **Action:** No `stripKeys` callback to carry over — #88 already moved row decoding into `decodeStoredMemoryToolItem` (`./decode-stored-item.ts`), called directly rather than injected

### 4. Update MemoryToolBackendQuery
- **File:** `src/storage/memory-tool/backend-query.ts`
- **Action:** Change constructor to accept `dynamo: DynamoTableAccess`
- **Action:** Replace direct `docClient` and `tableName` usage with `this.dynamo` where applicable
- **Action:** Some methods use `QueryCommand` directly - these can stay as-is or use dynamo.query()

### 5. Update MemoryToolBackendTagIndex
- **File:** `src/storage/memory-tool/backend-tag-index.ts`
- **Action:** Change constructor to accept `dynamo: DynamoTableAccess`
- **Action:** Replace direct `docClient` and `tableName` usage with `this.dynamo`
- **Action:** Keep `listByLayer` callback (cross-module dependency to queryOps)

### 6. Check for Other Usages
- **Action:** Search for `extends DynamoTableAccess` across the codebase
- **Action:** Update any other repositories to use composition pattern
- **Action:** Note: `MemoryRepository` does not currently exist in `src/storage/repositories/` (only `base.ts`, `types.ts`, and `.gitkeep`)

## Testing Strategy

### Unit Test Updates
- Mock `DynamoTableAccess` instead of mocking DynamoDB client
- Easier to verify method calls without dealing with SDK types
- Example:
```typescript
const mockDynamo: DynamoTableAccess = {
    putItem: vi.fn(),
    getItem: vi.fn().mockResolvedValue(mockItem),
    deleteItem: vi.fn(),
    query: vi.fn(),
};

const backend = new MemoryToolBackendCore(mockDynamo);
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
- Clear interface: helpers receive `DynamoTableAccess` instead of callbacks
- Easier to understand dependencies

### Better Testability
- Mock `DynamoTableAccess` interface instead of DynamoDB client
- Simpler test setup
- More focused unit tests

### Improved Maintainability
- Composition is more flexible than inheritance
- Easier to add new operations to `DynamoTableAccess`
- No coupling between backend lifecycle and DynamoDB client

### Type Safety
- TypeScript enforces `DynamoTableAccess` interface
- No risk of forgetting `.bind(this)` or passing wrong context

## Migration Path

1. **Phase 1:** Rename to `DynamoTableAccess` (done — #88; no behavior change)
2. **Phase 2:** Update tests to use mocked `DynamoTableAccess`
3. **Phase 3:** Refactor `MemoryToolBackend` to use composition
4. **Phase 4:** Update helper classes to accept `DynamoTableAccess`
5. **Phase 5:** Run full test suite, verify mutation score
6. **Phase 6:** Remove any remaining inheritance patterns

## Priority

**Medium.** Current code works, but the pattern is awkward and makes testing harder. This refactor will improve maintainability and set a better pattern for future repositories.
