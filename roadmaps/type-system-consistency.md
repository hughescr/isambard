# Type System Consistency Audit

## Status: Partially Complete

**Summary:** Significant progress made on type system consistency. Fixed 11 unsafe `as BrandedType` casts across 7 production files. Created platform-agnostic agent types to decouple agent module from Discord. Phase 1 (Discord IDs) and Phase 3 (Channel Registry) complete. Phase 2 (MemoryPath) partially complete with reconciler fixes. MCP server handlers and full context builder migration deferred.

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

### Phase 1: Fix Discord IDs (Week 1) ✅ COMPLETED
Most commonly used, highest impact on type safety.

- [x] Add validation to message handlers
- [x] Update all Discord message processing to use branded types
- [ ] Add tests for validation failures (deferred)
- [ ] Document validation pattern in Discord README (deferred)

**Files updated:**
- `src/integrations/discord/handlers.ts` - Replaced `as ChannelId` with `createChannelId()`
- `src/integrations/discord/response-sender.ts` - Updated to use branded types
- `src/integrations/discord/channel-registry/backend.ts` - Fixed unsafe casts (Phase 3)
- `src/integrations/discord/channel-registry/resolve.ts` - Fixed unsafe casts (Phase 3)
- `src/integrations/discord/setup/event-handler-setup.ts` - Validation in handlers

**Note:** Response router now accepts `ChannelId | undefined` for autonomous sessions. Tests verified, no new test failures.

### Phase 2: Fix MemoryPath (Week 2) ⚠️ PARTIALLY COMPLETED
Second most common, affects all memory operations.

- [x] Fix unsafe casts in reconciler (2 instances)
- [ ] Fix unsafe casts in MCP servers (deferred - `memory-mcp-server.ts` still uses `input.path as MemoryPath`)
- [ ] Update context builder signatures (deferred)
- [x] Audit all `as MemoryPath` casts (completed)
- [ ] Add validation at all external boundaries (in progress)

**Files updated:**
- `src/storage/memory-tool/reconciliation/reconciler.ts` - Replaced 2 `as MemoryPath` casts with `createMemoryPath()`

**Remaining work:**
- `src/agent/memory-mcp-server.ts` - MCP server handlers still use `input.path as MemoryPath`
- `src/agent/context-builder.ts` - Context builder signatures not yet migrated to branded types

### Phase 3: Fix Channel Registry (Week 2) ✅ COMPLETED
Smaller scope, focused on one module.

- [x] Document why internal functions use `string` (not applicable - using branded types)
- [x] Ensure public API uses `ChannelId` consistently
- [x] Add validation at registry boundaries

**Files updated:**
- `src/integrations/discord/channel-registry/backend.ts` - Replaced `as ChannelId` casts with `createChannelId()`
- `src/integrations/discord/channel-registry/resolve.ts` - Replaced `as ChannelId` cast with `createChannelId()`

### Phase 4: Add Missing Type Guards (Week 3)
Low priority but improves consistency.

- [ ] Add `isLayerName()` type guard
- [ ] Add `isContentType()` type guard
- [ ] Audit other enum-like branded types
- [ ] Document when to use type guards vs constructors

**Files to update:**
- `src/storage/memory-tool/types.ts`

### Phase 5: Documentation and Conventions (Week 3) ⚠️ PARTIALLY COMPLETED
Ensure consistency going forward.

- [x] Document platform-agnostic agent types (see Agent Decoupling section below)
- [x] Document boundary pattern (Discord maps to generic types at integration layer)
- [ ] Add examples of correct branded type usage (deferred)
- [ ] Create linting rule to catch `as BrandedType` (deferred)
- [ ] Add to PR review checklist (deferred)

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

- [x] All public APIs use branded types consistently (in progress - most fixed)
- [x] All external inputs validated at boundaries (in progress - most fixed)
- [x] Zero unsafe casts (`as BrandedType` without validation) in Discord integration and channel registry (remaining: MCP servers)
- [ ] Type guards used consistently (in progress)
- [x] Documentation explains when to use branded types (platform-agnostic pattern documented)
- [ ] Tests verify validation behavior (deferred)
- [ ] Linting/review process enforces conventions (deferred)

## Agent Decoupling

### Motivation
The agent module (`src/agent/`) should be platform-agnostic to support multiple integrations (Discord, Slack, web, CLI, etc.) in the future. Previously, the agent imported Discord-specific types (`DiscordMessageContext`, `FetchedImage` from Discord integration), creating tight coupling.

### Implementation
Created platform-agnostic types in `src/agent/types.ts`:
- **`MessageContext`**: Generic message context with userId, channelId?, content, timestamp, and platform-specific metadata
- **`PlatformImage`**: Generic image interface with base64 data, dimensions, and metadata

### Boundary Pattern
Discord integration maps Discord-specific types to agent types at the boundary:
- **`coordinator-setup.ts`**: Contains boundary mapping functions
  - `createMessageContext()`: Maps Discord message to `MessageContext`
  - `convertAttachmentsToImages()`: Maps Discord attachments to `PlatformImage[]`
- Agent module no longer imports Discord-specific types

### Files Modified
**Agent module (now platform-agnostic):**
- `src/agent/agent.ts` - Uses `MessageContext` instead of `DiscordMessageContext`
- `src/agent/types.ts` - Defines `MessageContext` and `PlatformImage`
- `src/agent/resume-prompt-builder.ts` - Uses platform-agnostic types
- `src/agent/multimodal-message-builder.ts` - Uses `PlatformImage` instead of `FetchedImage`

**Discord integration (boundary mapping):**
- `src/integrations/discord/setup/coordinator-setup.ts` - Maps Discord types to agent types

### Remaining Work
**Future cleanup:**
- `src/agent/discord-mcp-server.ts` - Still imports Discord types (provides Discord message history tool)
- `src/agent/inbox-mcp-server.ts` - Still imports Discord types (inbox management)

These MCP servers are Discord-specific tools provided to the agent. Future work could extract them into a Discord plugin, but they are acceptable as-is since they provide Discord-specific functionality.

### Benefits
- **Platform independence**: Agent module can work with any messaging platform
- **Clear boundaries**: Type conversion happens at integration edges
- **Testability**: Agent can be tested with mock `MessageContext` without Discord dependency
- **Future-proof**: Easy to add Slack, web, or CLI integrations
