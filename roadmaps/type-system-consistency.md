# Type System Consistency Audit

## Problem Statement

Branded types are used inconsistently throughout the codebase. Some functions accept branded types (`UserId`, `ChannelId`, `MemoryPath`), while others accept raw strings and perform type casting internally. This creates several issues:

**Type Safety Erosion:**
- Functions that accept `string` instead of branded types lose compile-time guarantees
- Easy to accidentally pass wrong ID type (e.g., `channelId` to function expecting `userId`)
- Type guards (`isMemoryPath`, `isUserId`) not consistently used

**Validation Confusion:**
- Unclear where validation happens (at boundary vs internally)
- Some functions validate, others assume valid input
- Error messages inconsistent when validation fails

**API Clarity:**
- Function signatures don't clearly indicate whether validation is expected
- Callers uncertain whether to cast or pass raw strings
- Internal functions sometimes use raw strings for convenience, breaking type chain

## Current Branded Types

The codebase defines the following branded types:

| Branded Type | Schema | Location | Type Guard | Constructor |
|-------------|--------|----------|------------|-------------|
| `MemoryPath` | `memoryPathSchema` | `src/storage/memory-tool/types.ts` | `isMemoryPath(value)` | `createMemoryPath(path)` |
| `LayerName` | `layerNameSchema` | `src/storage/memory-tool/types.ts` | N/A | N/A |
| `ContentType` | `contentTypeSchema` | `src/storage/memory-tool/types.ts` | N/A | N/A |
| `GuildId` | `guildIdSchema` | `src/integrations/discord/types.ts` | `isGuildId(value)` | `createGuildId(id)` |
| `ChannelId` | `channelIdSchema` | `src/integrations/discord/types.ts` | `isChannelId(value)` | `createChannelId(id)` |
| `UserId` | `userIdSchema` | `src/integrations/discord/types.ts` | `isUserId(value)` | `createUserId(id)` |
| `MessageId` | `messageIdSchema` | `src/integrations/discord/types.ts` | `isMessageId(value)` | `createMessageId(id)` |

**Pattern:** All branded types use Zod schemas with `.brand<'TypeName'>()` and provide:
- Type guard (`is{Type}(value)`)
- Constructor (`create{Type}(value)`) that validates via schema

## Usage Audit

### Consistent Usage Examples

**Good: `src/agent/context-builder.ts`**
```typescript
loadUserTimezone: async (userId: string): Promise<string | undefined> => {
    const path = createMemoryPath(`/users/${userId}/timezone`);
    // Uses createMemoryPath() to validate and brand
}
```

**Good: `src/storage/memory-tool/backend.ts`**
```typescript
async get(path: MemoryPath): Promise<MemoryToolItem | null> {
    // Public API requires branded type
}
```

### Inconsistent Usage Examples

**Inconsistent: `src/integrations/discord/handlers.ts`**
```typescript
// Message handler extracts raw string IDs from Discord
const channelId = message.channel.id;  // string
const userId = message.author.id;      // string

// Passes raw strings to functions expecting branded types
await someFunction(channelId, userId);  // Should validate first
```

**Inconsistent: `src/agent/memory-mcp-server.ts`**
```typescript
// Some handlers validate input paths
if (!isMemoryPath(input.path)) {
    throw new Error('Invalid path');
}

// Others assume valid input
const item = await backend.get(input.path as MemoryPath);  // Unsafe cast
```

**Inconsistent: `src/integrations/discord/channel-registry/backend.ts`**
```typescript
async getChannel(channelId: ChannelId): Promise<...> {
    // Public API uses branded type
}

// Internal function uses raw string
private async fetchFromDiscord(channelId: string): Promise<...> {
    // Should use branded type or document why not
}
```

## Proposed Convention

### Public API Rules

**Rule 1: Public APIs use branded types**
- All exported functions accept branded types for IDs and paths
- This enforces validation at module boundaries
- Clear signal that input must be validated

```typescript
// ✅ Correct
export async function processMessage(
    userId: UserId,
    channelId: ChannelId,
    content: string
): Promise<void> { ... }

// ❌ Incorrect
export async function processMessage(
    userId: string,
    channelId: string,
    content: string
): Promise<void> { ... }
```

**Rule 2: Validate at boundaries**
- Use constructors (`createUserId()`) when receiving external input
- Use type guards (`isUserId()`) when checking validity
- Throw errors with descriptive messages on validation failure

```typescript
// ✅ Correct
const userId = createUserId(message.author.id);  // Validates

// ✅ Also correct
if (!isUserId(message.author.id)) {
    throw new Error(`Invalid user ID: ${message.author.id}`);
}
const userId = message.author.id as UserId;

// ❌ Incorrect
const userId = message.author.id as UserId;  // No validation
```

### Internal Function Rules

**Rule 3: Internal functions may use raw strings**
- Private/internal functions can use `string` for convenience
- Document why branded type is not used
- Convert to branded type before calling public APIs

```typescript
// ✅ Acceptable for internal function
private async fetchUserData(userId: string): Promise<UserData> {
    // Internal helper - assumes caller validated
    const key = `USER#${userId}`;
    return await db.get(key);
}

// Caller validates and passes raw string
const userId = createUserId(rawId);  // Validate at boundary
const data = await this.fetchUserData(userId);  // Pass validated string
```

**Rule 4: Document validation assumptions**
- If internal function assumes validated input, document it
- Add JSDoc comment stating validation expectation

```typescript
/**
 * Fetch user data from database.
 * @param userId - User ID (assumed to be validated by caller)
 * @internal
 */
private async fetchUserData(userId: string): Promise<UserData> { ... }
```

## Inconsistencies to Fix

### High Priority (Type Safety Violations)

**Issue 1: Discord message handlers skip validation**
- **Location:** `src/integrations/discord/handlers.ts`
- **Problem:** Raw Discord IDs passed directly to functions expecting branded types
- **Fix:** Add validation at handler entry point
```typescript
// Before
const context = {
    userId: message.author.id,
    channelId: message.channel.id,
};

// After
const context = {
    userId: createUserId(message.author.id),
    channelId: createChannelId(message.channel.id),
};
```

**Issue 2: MCP server handlers use unsafe casts**
- **Location:** `src/agent/memory-mcp-server.ts`, `src/agent/discord-mcp-server.ts`
- **Problem:** `input.path as MemoryPath` without validation
- **Fix:** Use `createMemoryPath()` or type guard

**Issue 3: Channel registry mixes branded and raw types**
- **Location:** `src/integrations/discord/channel-registry/backend.ts`
- **Problem:** Public API uses `ChannelId`, private methods use `string`
- **Fix:** Document why internal functions use raw strings

### Medium Priority (API Clarity)

**Issue 4: Context builder accepts raw strings**
- **Location:** `src/agent/context-builder.ts`
- **Problem:** `loadRecentContext(userId: string)` should accept `UserId`
- **Fix:** Change signature to `loadRecentContext(userId: UserId)`

**Issue 5: Memory backend key generator**
- **Location:** `src/storage/memory-tool/key-generator.ts`
- **Problem:** Functions accept `MemoryPath | string`
- **Fix:** Accept only `MemoryPath`, require callers to validate

### Low Priority (Documentation)

**Issue 6: Missing type guards for LayerName, ContentType**
- **Location:** `src/storage/memory-tool/types.ts`
- **Problem:** No `isLayerName()` or `isContentType()` type guards
- **Fix:** Add type guards for consistency (even if rarely used)

**Issue 7: Inconsistent constructor naming**
- **Location:** Various
- **Problem:** Some use `createX()`, others might use different patterns
- **Fix:** Audit and standardize on `create{Type}()` pattern

## Implementation Strategy

Fix one type at a time, starting with most-used:

### Phase 1: Fix Discord IDs (Week 1)
Most commonly used, highest impact on type safety.

- [ ] Add validation to message handlers
- [ ] Update all Discord message processing to use branded types
- [ ] Add tests for validation failures
- [ ] Document validation pattern in Discord README

**Files to update:**
- `src/integrations/discord/handlers.ts`
- `src/integrations/discord/bot.ts`
- `src/integrations/discord/response-sender.ts`

### Phase 2: Fix MemoryPath (Week 2)
Second most common, affects all memory operations.

- [ ] Fix unsafe casts in MCP servers
- [ ] Update context builder signatures
- [ ] Audit all `as MemoryPath` casts
- [ ] Add validation at all external boundaries

**Files to update:**
- `src/agent/memory-mcp-server.ts`
- `src/agent/context-builder.ts`
- `src/storage/memory-tool/handlers.ts`

### Phase 3: Fix Channel Registry (Week 2)
Smaller scope, focused on one module.

- [ ] Document why internal functions use `string`
- [ ] Ensure public API uses `ChannelId` consistently
- [ ] Add validation at registry boundaries

**Files to update:**
- `src/integrations/discord/channel-registry/backend.ts`
- `src/integrations/discord/channel-registry/resolve.ts`

### Phase 4: Add Missing Type Guards (Week 3)
Low priority but improves consistency.

- [ ] Add `isLayerName()` type guard
- [ ] Add `isContentType()` type guard
- [ ] Audit other enum-like branded types
- [ ] Document when to use type guards vs constructors

**Files to update:**
- `src/storage/memory-tool/types.ts`

### Phase 5: Documentation and Conventions (Week 3)
Ensure consistency going forward.

- [ ] Document branded type conventions in CLAUDE.md
- [ ] Add examples of correct usage
- [ ] Create linting rule to catch `as BrandedType` (if possible)
- [ ] Add to PR review checklist

## Testing Strategy

**Validation Tests:**
- Test that constructors throw on invalid input
- Test that type guards return false on invalid input
- Test boundary validation in handlers

**Regression Tests:**
- Ensure existing functionality unchanged
- Golden master tests for key flows

**Type Tests:**
- Use TypeScript's type testing tools
- Verify type inference works correctly
- Ensure no `any` types introduced

## Benefits

**Type Safety:**
- Compile-time guarantees for ID/path types
- Impossible to pass wrong ID type to function
- Type errors caught before runtime

**Clearer APIs:**
- Function signatures clearly indicate validation requirements
- Callers know when to validate vs trust input
- Self-documenting code

**Better Error Messages:**
- Validation errors at boundaries provide context
- Easier to debug ID/path issues
- Consistent error format

**Easier Refactoring:**
- Type system catches breaking changes
- Renaming ID fields caught by compiler
- Safe to change internal representations

## Success Criteria

- [ ] All public APIs use branded types consistently
- [ ] All external inputs validated at boundaries
- [ ] Zero unsafe casts (`as BrandedType` without validation)
- [ ] Type guards used consistently
- [ ] Documentation explains when to use branded types
- [ ] Tests verify validation behavior
- [ ] Linting/review process enforces conventions
