# Tags StringSet Migration: L (List) to SS (StringSet) in DynamoDB

## Status: Planned

**Summary:** Migrate the tag storage system from DynamoDB List (L) type to StringSet (SS) type, and update the TypeScript representation from `string[]` to `Set<string>` throughout the codebase. This eliminates duplicate tag storage at the persistence layer, aligns the data model with DynamoDB's native set semantics, and makes the TypeScript types more accurately represent the unordered, unique nature of tags.

## Problem Statement

Tags in the memory tool are semantically a **set** — unordered, unique strings used for categorization and search. However, the current implementation stores them as:

- **DynamoDB:** List (L) type — allows duplicates, preserves order
- **TypeScript:** `string[]` — allows duplicates, preserves order

This mismatch creates several issues:

**Semantic Mismatch:**
- `normalizeTags()` manually deduplicates via `[...new Set(...)]` on every write path
- Array equality checks in the reconciler use `_.isEqual()`, which is order-sensitive — identical tag sets in different orders would be treated as "stale"
- Consumers must remember to normalize before comparison or storage

**Wasted Computation:**
- Deduplication logic runs on every create, update, and reconciliation operation
- Could be eliminated by using DynamoDB's native SS deduplication

**Type System Imprecision:**
- `string[]` communicates "ordered list of potentially duplicate strings"
- `Set<string>` communicates "unordered collection of unique strings" — which is what tags actually are
- Functions like `normalizeTags()` exist solely to bridge this gap

## Current Architecture

### Types (`src/storage/memory-tool/types.ts`)

```typescript
// Memory item schema — tags stored as optional string array
export const memoryToolItemSchema = z.object({
    // ...
    tags: z.array(z.string()).optional(),
});

// Tag index fat pointer — tags stored as string array
export interface TagIndexItem {
    PK:             string
    SK:             string
    memoryPath:     string
    layer:          string
    updatedAt:      string
    tags:           string[]    // <-- Currently string[]
    contentPreview: string
}
```

### Key Generator (`src/storage/memory-tool/key-generator.ts`)

```typescript
// Normalizes tags by lowercasing and deduplicating
export function normalizeTags(tags: string[] | undefined): string[] {
    if(!tags || tags.length === 0) {
        return [];
    }
    return [...new Set(_map(tags, tag => _toLower(tag)))];
}
```

### Backend Core (`src/storage/memory-tool/backend-core.ts`)

```typescript
export interface CreateMemoryToolItemInput {
    path:        MemoryPath
    content:     string
    contentType: ContentType
    metadata?:   Record<string, unknown>
    tags?:       string[]    // <-- Currently string[]
}

export interface UpdateMemoryToolItemInput {
    content?:  string
    metadata?: Record<string, unknown>
    tags?:     string[]    // <-- Currently string[]
}
```

### Backend Tag Index (`src/storage/memory-tool/backend-tag-index.ts`)

All tag index methods accept `tags: string[]`:
- `createTagIndexItems(path, tags: string[], ...)`
- `deleteTagIndexItems(path, tags: string[])`
- `refreshTagIndexItems(path, tags: string[], ...)`
- `updateTagIndexItems(path, oldTags: string[], newTags: string[], ...)`
- `incrementTagCounts(tags: string[])`
- `decrementTagCounts(tags: string[])`

Tag index items written to DynamoDB with `tags: normalizedTags` (currently an array).

### Backend Facade (`src/storage/memory-tool/backend.ts`)

Orchestrates core + query + tag index operations. Uses `normalizeTags()` throughout `create()`, `update()`, and `delete()` methods.

### MCP Server (`src/agent/memory-mcp-server.ts`)

- `storeSelf`, `storeUserMemory`, `logEvent`: Accept `tags: z.array(z.string()).optional()`
- `search`: Uses `z.array(z.string()).min(1)` for tag input
- `deleteMemory`: Displays tags with `result.tags.join(', ')`

### Handlers (`src/storage/memory-tool/handlers.ts`)

- `search()`: Passes `params.tags` (string array) to `backend.searchByTags()`
- `rename()`: Passes `sourceItem.tags` to `backend.create()`
- Other handlers don't directly manipulate tags

### Reconciler (`src/storage/memory-tool/reconciliation/reconciler.ts`)

- Phase A `processMemoryItemTags()`: Reads `memoryItem.tags`, calls `normalizeTags(memoryItem.tags ?? [])`
- Phase A `isTagIndexStale()`: Compares `indexItem.tags` with `normalizeTags(memoryItem.tags ?? [])` via `_.isEqual()`
- Phase B `processTagIndexItem()`: Reads `memory.tags`, calls `normalizeTags(memory.tags ?? [])`

## Proposed Changes

### Design Decisions

1. **DynamoDB storage type:** Tags on memory items change from List (L) to StringSet (SS)
2. **TypeScript type:** Change from `string[]` to `Set<string>` in internal code
3. **Tag index items stay as fat pointers:** Tag index items (`PK=TAG#tagname`, `SK=PATH#memoryPath`) remain as individual DynamoDB items — they are NOT candidates for SS because each is a separate item. However, the `tags` field within these fat pointer items also changes from L to SS.
4. **MCP boundary:** Tool inputs from the agent remain JSON arrays (MCP protocol limitation). Conversion to `Set<string>` happens at the MCP server boundary.
5. **Empty set handling:** DynamoDB does not allow empty StringSets. When tags are empty/undefined, omit the `tags` attribute entirely rather than writing an empty set.

### Technical Notes

- **DynamoDB Document Client** automatically marshalls JavaScript `Set<string>` to DynamoDB SS type and unmarshalls SS back to `Set<string>`. No manual marshalling needed.
- **SS type** provides native deduplication — duplicate values in a Set are silently ignored on write.
- **SS type** has no ordering guarantee, which is correct for tags (unordered).
- **Zod** does not have native `Set` support. Use `z.array(z.string()).transform(arr => new Set(arr))` for parsing, and a custom schema for output validation.
- **`normalizeTags()`** currently returns `string[]`; will return `Set<string>`. The function still lowercases all tags. Deduplication is now handled natively by `Set` rather than the `[...new Set()]` trick.

---

## Part 1: Migration Script

### Purpose

A standalone script to scan all existing DynamoDB items and convert their `tags` field from List (L) type to StringSet (SS) type.

### Location

`scripts/migrate-tags-to-stringset.ts`

### Scope

The script must handle two classes of items:

1. **Memory items** (`PK=DIR#...`, `SK=FILE#...`) — the main memory content items
2. **Tag index items** (`PK=TAG#...`, `SK=PATH#...`) — the fat pointer items in the tag index

Both item types have a `tags` field that is currently List (L) and must become StringSet (SS).

### Behavior

```
Usage: bun run scripts/migrate-tags-to-stringset.ts [--dry-run] [--table TABLE_NAME]

Options:
  --dry-run     Scan and report without making changes (default: true)
  --execute     Actually perform the migration
  --table       DynamoDB table name (default: from environment)
```

### Algorithm

1. **Full table scan** with pagination (handle `LastEvaluatedKey`)
2. For each item:
   a. Check if item has a `tags` field
   b. If `tags` is absent or already SS type, skip
   c. If `tags` is an empty List, **remove** the `tags` attribute (SS cannot be empty)
   d. If `tags` is a non-empty List, convert to `Set<string>` and write back via `UpdateCommand`
3. Track and log progress: items scanned, items migrated, items skipped, errors
4. Dry-run mode reports what would change without writing

### Error Handling

- Retry individual item updates with exponential backoff (3 attempts)
- Log failures but continue scanning (don't abort on single item errors)
- Report summary at end: total scanned, migrated, skipped, failed

### Rate Limiting

- Use configurable delay between write operations (default 50ms)
- Batch reads via Scan with reasonable page size (25 items)
- Respect DynamoDB provisioned throughput

### Rollback

The migration is backward-compatible in the sense that DynamoDB Document Client will read both L and SS types transparently during the transition period (code changes in Part 2 handle both). However, once the code is deployed expecting SS, rolling back the code without rolling back the data would cause issues. Therefore:

- Run migration script **after** deploying the updated code (which handles both L and SS)
- Or run migration script first in dry-run mode to verify scope

---

## Part 2: Code Changes

### Dependency Order

Changes must be implemented in this order to maintain compilability at each step:

```
1. types.ts (schemas + interfaces)
     |
2. key-generator.ts (normalizeTags signature)
     |
3. backend-core.ts (input types)
     |
4. backend-tag-index.ts (all tag methods)
     |
5. backend.ts (facade)
     |
6. backend-query.ts (searchByTags return type)
     |
7. handlers.ts (search, rename)
     |
8. memory-mcp-server.ts (boundary conversion)
     |
9. reconciler.ts (comparison logic)
     |
10. index.ts (re-exports — verify public API)
```

### File-by-File Changes

#### 1. `src/storage/memory-tool/types.ts`

**Zod schema change:**

```typescript
// Before
tags: z.array(z.string()).optional(),

// After
tags: z.array(z.string()).transform(arr => new Set(arr)).optional(),
```

However, this creates a type mismatch: Zod's `input` type would be `string[]` but `output` type would be `Set<string>`. For DynamoDB reads where Document Client already returns `Set<string>`, we need a schema that accepts both:

```typescript
// Schema that accepts both string[] (from JSON/MCP input) and Set<string> (from DynamoDB)
const tagsSchema = z.union([
    z.array(z.string()).transform(arr => new Set(arr)),
    z.instanceof(Set) as z.ZodType<Set<string>>,
]).optional();
```

**Alternatively**, use a simpler custom schema:

```typescript
// Custom Zod schema for Set<string>
const stringSetSchema = z.preprocess(
    (val) => (Array.isArray(val) ? new Set(val as string[]) : val),
    z.instanceof(Set) as z.ZodType<Set<string>>
);

export const memoryToolItemSchema = z.object({
    // ...
    tags: stringSetSchema.optional(),
});
```

**`MemoryToolItemData` type** will automatically become `{ tags?: Set<string> }` via Zod inference.

**`TagIndexItem` interface change:**

```typescript
// Before
export interface TagIndexItem {
    // ...
    tags: string[]
}

// After
export interface TagIndexItem {
    // ...
    tags: Set<string>
}
```

#### 2. `src/storage/memory-tool/key-generator.ts`

**`normalizeTags` signature change:**

```typescript
// Before
export function normalizeTags(tags: string[] | undefined): string[]

// After
export function normalizeTags(tags: Set<string> | string[] | undefined): Set<string>
```

**Implementation change:**

```typescript
// Before
export function normalizeTags(tags: string[] | undefined): string[] {
    if(!tags || tags.length === 0) {
        return [];
    }
    return [...new Set(_map(tags, tag => _toLower(tag)))];
}

// After
export function normalizeTags(tags: Set<string> | string[] | undefined): Set<string> {
    if(!tags || (tags instanceof Set ? tags.size === 0 : tags.length === 0)) {
        return new Set();
    }
    const iterable = tags instanceof Set ? tags : tags;
    return new Set([...iterable].map(tag => _toLower(tag)));
}
```

The function now accepts both `Set<string>` and `string[]` for backward compatibility during migration, but always returns `Set<string>`.

**`createTagIndexKeys` change:**

```typescript
// Before
static createTagIndexKeys(path: MemoryPath, tags: string[]): { PK: string, SK: string }[]

// After
static createTagIndexKeys(path: MemoryPath, tags: Set<string> | string[]): { PK: string, SK: string }[]
```

Internal implementation changes from `_map(tags, ...)` to `[...tags].map(...)`.

#### 3. `src/storage/memory-tool/backend-core.ts`

**Input type changes:**

```typescript
// Before
export interface CreateMemoryToolItemInput {
    // ...
    tags?: string[]
}

export interface UpdateMemoryToolItemInput {
    // ...
    tags?: string[]
}

// After
export interface CreateMemoryToolItemInput {
    // ...
    tags?: Set<string>
}

export interface UpdateMemoryToolItemInput {
    // ...
    tags?: Set<string>
}
```

**Empty set handling in `create()` and `update()`:**

When writing to DynamoDB, if tags is an empty Set, omit the `tags` attribute:

```typescript
// In create():
const itemData = {
    // ...
    // Only include tags if non-empty (DynamoDB SS cannot be empty)
    ...(input.tags && input.tags.size > 0 && { tags: input.tags }),
};
```

Same pattern in `update()`:

```typescript
// In update():
const updatedData = {
    ...existing,
    ...(input.tags !== undefined && {
        // Omit tags entirely if empty set (SS cannot be empty)
        ...(input.tags.size > 0 ? { tags: input.tags } : { tags: undefined }),
    }),
};
```

Note: Setting `tags: undefined` in the spread will effectively remove the field from the Zod parse result, since the schema has `.optional()`.

#### 4. `src/storage/memory-tool/backend-tag-index.ts`

**All method signatures change from `string[]` to `Set<string>` or accept both:**

```typescript
// Before
async createTagIndexItems(path: MemoryPath, tags: string[], ...): Promise<void>
async deleteTagIndexItems(path: MemoryPath, tags: string[]): Promise<void>
async refreshTagIndexItems(path: MemoryPath, tags: string[], ...): Promise<void>
async updateTagIndexItems(path: MemoryPath, oldTags: string[], newTags: string[], ...): Promise<void>
async incrementTagCounts(tags: string[]): Promise<void>
async decrementTagCounts(tags: string[]): Promise<void>

// After
async createTagIndexItems(path: MemoryPath, tags: Set<string>, ...): Promise<void>
async deleteTagIndexItems(path: MemoryPath, tags: Set<string>): Promise<void>
async refreshTagIndexItems(path: MemoryPath, tags: Set<string>, ...): Promise<void>
async updateTagIndexItems(path: MemoryPath, oldTags: Set<string>, newTags: Set<string>, ...): Promise<void>
async incrementTagCounts(tags: Set<string>): Promise<void>
async decrementTagCounts(tags: Set<string>): Promise<void>
```

**Internal changes:**

- `tags.length === 0` becomes `tags.size === 0`
- `_map(normalizedTags, tag => ...)` becomes `[...normalizedTags].map(tag => ...)`
- `_difference()` and `_intersection()` from lodash don't work with Sets — replace with Set operations:

```typescript
// Before (lodash)
const added = _difference(normalizedNew, normalizedOld);
const removed = _difference(normalizedOld, normalizedNew);
const unchanged = _intersection(normalizedOld, normalizedNew);

// After (native Set operations)
const added = new Set([...normalizedNew].filter(t => !normalizedOld.has(t)));
const removed = new Set([...normalizedOld].filter(t => !normalizedNew.has(t)));
const unchanged = new Set([...normalizedOld].filter(t => normalizedNew.has(t)));
```

**Tag index item `tags` field in DynamoDB writes:**

When writing tag index items, the `tags` field is now a `Set<string>`:

```typescript
// Before
Item: {
    PK: `TAG#${tag}`,
    SK: `PATH#${path}`,
    tags: normalizedTags,  // string[] -> DynamoDB L type
    // ...
}

// After
Item: {
    PK: `TAG#${tag}`,
    SK: `PATH#${path}`,
    tags: normalizedTags,  // Set<string> -> DynamoDB SS type
    // ...
}
```

**queryByTag and queryByTags return type:**

Already returns `TagIndexItem` which now has `tags: Set<string>`. The DynamoDB Document Client will automatically unmarshall SS to `Set<string>`.

**Multi-tag filtering in `queryByTags()`:**

```typescript
// Before
const matching = _filter(pageResult.items, item =>
    _every(remainingTags, tag => _includes(item.tags, tag))
);

// After
const matching = pageResult.items.filter(item =>
    [...remainingTags].every(tag => item.tags.has(tag))
);
```

#### 5. `src/storage/memory-tool/backend.ts`

**Facade method changes:**

The facade passes tags through to the underlying modules. Changes are primarily type signature updates:

- `create()`: `normalizeTags(input.tags)` now returns `Set<string>` — size checks change from `.length` to `.size`
- `update()`: Same pattern
- `delete()`: `normalizeTags(existing.tags)` now returns `Set<string>`
- `searchByTags()`: Input tags parameter changes from `string[]` to `Set<string>` or stays `string[]` at the public API level (since callers like MCP server pass arrays)

**Design choice for public API:**

The facade's `searchByTags()` can accept `string[]` at the public boundary and convert internally:

```typescript
// Public API accepts string[] for backward compatibility
async searchByTags(
    tags: string[],
    layer?: LayerName,
    options?: ListOptions
): Promise<ListResult<TagIndexItem>> {
    return this.queryOps.searchByTags(tags, layer, options);
}
```

Or it can be changed to `Set<string>`. Given that the MCP server (the primary caller) receives JSON arrays, keeping `string[]` at the `searchByTags` public API and converting internally may be cleaner.

**Decision:** Accept `string[]` at the MemoryToolBackend public boundary for `searchByTags` (since it's a query input, not stored data). Internal types use `Set<string>`.

#### 6. `src/storage/memory-tool/backend-query.ts`

**`searchByTags` delegates to tag index — minimal changes:**

The input `tags: string[]` stays as `string[]` at this level (query parameter, not stored data). The return type `ListResult<TagIndexItem>` now has `tags: Set<string>` on each item via the `TagIndexItem` interface change.

#### 7. `src/storage/memory-tool/handlers.ts`

**`search()` handler:**

No direct tag manipulation — passes `params.tags` (string array from caller) to `backend.searchByTags()`. No change needed if `searchByTags` still accepts `string[]`.

**`rename()` handler:**

```typescript
// Before
await backend.create({
    // ...
    tags: sourceItem.tags,  // string[] | undefined
});

// After — sourceItem.tags is now Set<string> | undefined, which matches CreateMemoryToolItemInput
await backend.create({
    // ...
    tags: sourceItem.tags,  // Set<string> | undefined
});
```

No explicit conversion needed since both the source data and the create input are now `Set<string>`.

#### 8. `src/agent/memory-mcp-server.ts`

**MCP tool input schemas stay as arrays** (JSON has no Set type):

```typescript
// These stay the same — MCP protocol uses JSON arrays
tags: z.array(z.string()).optional()
tags: z.array(z.string()).min(1)
```

**Boundary conversion — convert array to Set before passing to backend:**

```typescript
// Before (storeSelf handler)
await backend.create({
    path,
    content: args.content,
    contentType: 'text/plain' as ContentType,
    tags: args.tags,
});

// After
await backend.create({
    path,
    content: args.content,
    contentType: 'text/plain' as ContentType,
    tags: args.tags ? new Set(args.tags) : undefined,
});
```

Same pattern for `storeUserMemory`, `logEvent`, and the `update()` calls in `storeSelf`/`storeUserMemory`.

**Display conversion — convert Set to array for output:**

```typescript
// Before (deleteMemory handler)
const tags = result.tags && result.tags.length > 0 ? result.tags.join(', ') : 'none';

// After
const tags = result.tags && result.tags.size > 0 ? [...result.tags].join(', ') : 'none';
```

#### 9. `src/storage/memory-tool/reconciliation/reconciler.ts`

**Phase A — `isTagIndexStale()`:**

```typescript
// Before
function isTagIndexStale(memoryItem: MemoryToolItem, indexItem: TagIndexItem): boolean {
    return (
        indexItem.contentPreview !== memoryItem.contentPreview
        || indexItem.updatedAt !== memoryItem.updatedAt
        || !_isEqual(indexItem.tags, normalizeTags(memoryItem.tags ?? []))
    );
}

// After — Set comparison using symmetric difference
function isTagIndexStale(memoryItem: MemoryToolItem, indexItem: TagIndexItem): boolean {
    const normalizedTags = normalizeTags(memoryItem.tags);
    const setsEqual = normalizedTags.size === indexItem.tags.size
        && [...normalizedTags].every(tag => indexItem.tags.has(tag));

    return (
        indexItem.contentPreview !== memoryItem.contentPreview
        || indexItem.updatedAt !== memoryItem.updatedAt
        || !setsEqual
    );
}
```

This eliminates the order-sensitivity bug in the current `_.isEqual()` comparison.

**Phase A — `processMemoryItemTags()`:**

```typescript
// Before
if(!memoryItem.tags || memoryItem.tags.length === 0) { return; }
const normalizedTags = normalizeTags(memoryItem.tags);
for(const tag of normalizedTags) { ... }

// After
if(!memoryItem.tags || memoryItem.tags.size === 0) { return; }
const normalizedTags = normalizeTags(memoryItem.tags);
for(const tag of normalizedTags) { ... }  // Set is directly iterable
```

**Phase B — `processTagIndexItem()`:**

```typescript
// Before
const normalizedTags = normalizeTags(memory.tags ?? []);
if(!_includes(normalizedTags, tag)) { ... }

// After
const normalizedTags = normalizeTags(memory.tags);
if(!normalizedTags.has(tag)) { ... }
```

The `Set.has()` method replaces lodash `_includes()`, which is both cleaner and O(1) vs O(n).

#### 10. `src/storage/memory-tool/index.ts`

**Verify re-exports:**

The public API surface includes `normalizeTags`, `TagIndexItem`, `MemoryToolItemData`, `CreateMemoryToolItemInput`, `UpdateMemoryToolItemInput`. All of these have type changes that propagate automatically. No explicit changes to the barrel file needed, but verify that downstream consumers in `src/agent/` compile correctly.

---

## Part 3: Tag Index Updates

### Tag Index Fat Pointer Items

Tag index items (`PK=TAG#tagname`, `SK=PATH#memoryPath`) are individual DynamoDB items — each one is a "fat pointer" carrying preview data. They cannot be consolidated into a single SS attribute. However, each fat pointer item contains a `tags` field that lists all tags for the referenced memory item.

**Current state:** The `tags` field on each tag index item is stored as DynamoDB List (L) type.

**Target state:** The `tags` field changes to StringSet (SS) type, matching the memory items.

### Migration Coverage

The migration script (Part 1) handles both:
1. Memory items: `PK=DIR#...`, `SK=FILE#...` with `tags` field
2. Tag index items: `PK=TAG#...`, `SK=PATH#...` with `tags` field

Both are converted from L to SS in the same scan pass.

### Reconciler Updates

After migration, the reconciler (Part 2, step 9) works with `Set<string>` throughout:

- Phase A creates/refreshes tag index items with `tags: Set<string>` (written as SS)
- Phase B reads tag index items with `tags: Set<string>` (read from SS)
- Phase C verifies META_COUNT items (no tags field involved)

The `isTagIndexStale()` comparison now uses Set equality instead of `_.isEqual()` on arrays, which is both correct (order-insensitive) and efficient.

---

## Migration Strategy

### Phase 1: Dual-Read Code (Backward Compatible)

Deploy code that **reads** both List and StringSet, but **writes** StringSet only.

1. Update `normalizeTags()` to accept both `string[]` and `Set<string>`
2. Update Zod schema to accept both array and Set inputs via `z.preprocess()`
3. Update all internal code to use `Set<string>`
4. Deploy to production

**At this point:** Existing data in DynamoDB is still List (L) type. The Document Client reads L as `string[]`, which the Zod preprocess/normalizeTags handles by converting to Set. New writes go out as SS.

### Phase 2: Run Migration Script

1. Run migration script in **dry-run** mode to verify scope and identify edge cases
2. Review dry-run output
3. Run migration script in **execute** mode
4. Verify migration results (all items converted)

**At this point:** All DynamoDB items have SS type for tags. New code writes SS. Everything is consistent.

### Phase 3: Remove Dual-Read Support (Optional Cleanup)

Once all data is confirmed migrated:

1. Simplify Zod schema to only accept `Set<string>` (remove array preprocess)
2. Simplify `normalizeTags()` to only accept `Set<string>` (remove `string[]` overload)
3. This is optional — dual-read support has minimal overhead

### Rollback Plan

- **Before Phase 2:** Roll back code to previous version (reads arrays, writes arrays). No data change.
- **During Phase 2:** Abort migration script. Partially migrated data is fine — the dual-read code handles both types.
- **After Phase 2:** To fully roll back, write a reverse migration script (SS back to L) and deploy the old code. However, this should rarely be needed since the dual-read code handles both types.

---

## Testing Strategy

### TDD Mandate

All changes follow the RED-GREEN-REFACTOR cycle. Target: 100% mutation score via Stryker for all changed files.

### Unit Tests

#### `types.test.ts`
- Test Zod schema parsing with `Set<string>` input
- Test Zod schema parsing with `string[]` input (preprocess)
- Test that empty arrays/sets result in `undefined` tags (not empty set)
- Test `TagIndexItem` interface with `Set<string>` tags
- Test round-trip: array input -> Set -> serialization -> deserialization -> Set

#### `key-generator.test.ts`
- Test `normalizeTags()` with `Set<string>` input
- Test `normalizeTags()` with `string[]` input (backward compat)
- Test `normalizeTags()` with `undefined` input
- Test `normalizeTags()` with empty Set
- Test `normalizeTags()` with mixed-case Set (lowercasing)
- Test `normalizeTags()` deduplication (Set input with duplicates after lowercasing)
- Test `createTagIndexKeys()` with Set input

#### `backend-core.test.ts`
- Test `create()` with `Set<string>` tags
- Test `create()` with empty `Set<string>` tags (should omit attribute)
- Test `update()` with `Set<string>` tags
- Test `update()` removing tags (empty Set)

#### `backend-tag-index.test.ts`
- Test all methods with `Set<string>` parameters
- Test `updateTagIndexItems()` diff calculation with Sets
- Test `queryByTags()` multi-tag filtering with `Set.has()`
- Test that tag index items written to DynamoDB have SS type tags

#### `backend.test.ts`
- Test facade methods pass `Set<string>` through correctly
- Test `searchByTags()` accepts `string[]` at public API

#### `memory-mcp-server.test.ts`
- Test array-to-Set conversion at MCP boundary
- Test Set-to-array conversion for display output
- Test `deleteMemory` displays tags correctly from Set

#### `reconciler.test.ts`
- Test `isTagIndexStale()` with Set comparison (order-insensitive)
- Test Phase A with `Set<string>` tags on memory items
- Test Phase B with `Set<string>` tags on tag index items
- Test that identical tag sets in different orders are NOT treated as stale

### Integration Tests

- Test full create-search-delete cycle with Set tags
- Test migration script against local DynamoDB (dry-run and execute modes)
- Test dual-read: write with old code (array), read with new code (Set)

### Migration Script Tests

- Test scanning and converting a mock DynamoDB table
- Test skipping items with no tags
- Test skipping items already using SS type
- Test handling empty arrays (remove attribute)
- Test dry-run mode (no writes)
- Test error handling (continue on individual item failure)
- Test progress reporting

---

## Benefits

### Semantic Correctness
- TypeScript types accurately represent that tags are unordered and unique
- Set operations (`has`, `size`, iteration) are more natural than array operations for tags
- Eliminates the order-sensitivity bug in `_.isEqual()` comparison

### Performance
- DynamoDB SS type provides native deduplication — no need for `[...new Set()]` trick
- `Set.has()` is O(1) vs `Array.includes()` at O(n) — matters for multi-tag queries in reconciler
- Simpler `normalizeTags()` — just lowercase and construct Set

### Code Clarity
- `normalizeTags()` becomes a straightforward lowercasing function
- Set operations in `updateTagIndexItems()` replace lodash `_difference()` and `_intersection()`
- Reconciler comparison logic is cleaner and obviously correct

### DynamoDB Alignment
- Using SS type communicates intent to anyone reading the DynamoDB table directly
- SS type is the idiomatic DynamoDB way to store sets of strings
- Smaller storage footprint (SS is slightly more compact than L for string sets)

---

## Success Criteria

- [ ] All memory items in DynamoDB use SS type for tags
- [ ] All tag index items in DynamoDB use SS type for tags
- [ ] TypeScript codebase uses `Set<string>` for tags throughout internal code
- [ ] MCP server boundary correctly converts between JSON arrays and Sets
- [ ] `normalizeTags()` accepts both `Set<string>` and `string[]`, returns `Set<string>`
- [ ] Reconciler uses Set comparison (order-insensitive) for tag staleness checks
- [ ] All tests pass with 100% Stryker mutation score for changed files
- [ ] Migration script handles all edge cases (no tags, empty tags, already-SS tags)
- [ ] No behavioral regression in search, create, update, delete, rename, consolidate operations

## Priority

**Medium-High.** This is a foundational data model improvement that affects the entire memory tool subsystem. The semantic mismatch between arrays and sets is a latent source of bugs (the `_.isEqual()` order-sensitivity issue in the reconciler is one example). Best done before adding more tag-dependent features (like the planned `updateTags` MCP tool).

## Estimated Effort

- **Part 1 (Migration script):** 1-2 days
- **Part 2 (Code changes):** 2-3 days (mostly mechanical, but thorough testing needed)
- **Part 3 (Tag index updates):** Included in Parts 1 and 2 (no separate work)
- **Total:** 3-5 days including comprehensive test coverage
