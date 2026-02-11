# Memory Scoring: Sigmoid-Based State Layer Prioritization

## Status: Planned

**Summary:** Add a sigmoid-based scoring function to prioritize which state-layer memories are surfaced in the agent's system context. By combining access frequency (boost) with time-since-last-access (decay), the memory system naturally promotes actively-used state memories and lets stale ones fade — without any persisted scores or scheduled decay jobs.

## Problem Statement

The agent's memory system has three layers: identity (always loaded), state (working memory), and events (timeline). State memories are the most dynamic — they represent current projects, ongoing conversations, and active context. Today, all state memories are treated equally:

**No signal differentiation:** `getAutoLoadItems` sorts state memories by `accessCount` DESC then `lastAccessed` DESC, but `recordAccess` is never called anywhere. Every state memory has `accessCount: 0`, so the sort is effectively by `updatedAt` — the last time content was *edited*, not *used*.

**No decay mechanism:** A state memory edited six months ago but never referenced since ranks the same as one edited six months ago but consulted daily. There is no way for unused memories to naturally lose priority.

**Context window waste:** The agent injects up to 50 state memories (300 tokens / 1200 chars per section) into every system prompt. Without scoring, this budget is spent on whatever was most recently *written*, not what is most *relevant*.

**The infrastructure exists but is unwired:** `recordAccess` exists in `context-builder.ts` and is fully tested. `getAutoLoadItems` already reads `accessCount` and `lastAccessed` from metadata. The gap is: (1) nothing calls `recordAccess`, (2) the sort uses raw counts instead of a score that blends frequency with recency, and (3) there is no path toward the agent *choosing* which memories to load rather than getting them all injected.

## Current Architecture

### recordAccess (context-builder.ts, lines 216-241)

The function exists, is tested, but has **no call site**:

```typescript
recordAccess: async (paths: MemoryPath[]): Promise<void> => {
    for(const path of paths) {
        const item = await backend.get(path);

        if(!item) {
            continue;
        }

        const currentAccessCount = _isNumber(item.metadata?.accessCount)
            ? item.metadata.accessCount
            : 0;

        await backend.update(path, {
            metadata: {
                ...item.metadata,
                accessCount:  currentAccessCount + 1,
                lastAccessed: new Date().toISOString(),
            },
        });
    }
},
```

### getAutoLoadItems (backend-query.ts, lines 219-255)

Already sorts by access metadata — but all counts are 0:

```typescript
async getAutoLoadItems(
    options?: { maxIdentityItems?: number, maxStateItems?: number }
): Promise<MemoryToolItemData[]> {
    const maxIdentityItems = options?.maxIdentityItems ?? 100;
    const maxStateItems = options?.maxStateItems ?? 50;

    const identityResult = await this.listByLayer('identity' as LayerName, { limit: maxIdentityItems });
    const identityItems = _take(identityResult.items, maxIdentityItems);

    const stateResult = await this.listByLayer('state' as LayerName, { limit: maxStateItems });
    let stateItems = stateResult.items;

    // Sort by accessCount (descending), then by lastAccessed (most recent first)
    const enrichedItems = _map(stateItems, item => ({
        item,
        accessCount:  (item.metadata?.accessCount as number | undefined) ?? 0,
        lastAccessed: (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt,
    }));

    stateItems = _chain(enrichedItems)
        .orderBy(['accessCount', 'lastAccessed'], ['desc', 'desc'])
        .take(maxStateItems)
        .map(({ item }) => item)
        .value();

    return [...identityItems, ...stateItems];
}
```

### view handler (handlers.ts, lines 110-144)

The view handler retrieves and displays a memory but does **not** record the access:

```typescript
export async function view(
    backend: MemoryToolBackend,
    params: { path: string, view_range?: [number, number] }
): Promise<string> {
    const memoryPath = validatePath(params.path);
    const item = await backend.get(memoryPath);

    if(item) {
        const timestamp = formatMemoryTimestamp(item.updatedAt);
        const header = `File: ${params.path} ${timestamp}`;
        const content = formatLineNumbers(item.content, params.view_range);
        return `${header}\n${content}`;
        // ^^^ No recordAccess call — this is the missing wire
    }
    // ... directory listing fallback
}
```

### buildSystemContext (context-builder.ts, lines 160-214)

Renders identity and state sections but does not call `recordAccess` for the memories it injects:

```typescript
buildSystemContext: async (): Promise<string> => {
    const items = await backend.getAutoLoadItems();

    // Group items by layer
    const grouped = _groupBy(items, (item) => {
        const layer = extractLayerFromPath(item.path);
        return layer ?? 'other';
    });

    // Renders identity section (truncated to 2000 chars)
    // Renders state section (truncated to 1200 chars)
    // Does NOT call recordAccess on any loaded items
},
```

### Metadata Structure (types.ts)

Metadata is a flexible record — no schema changes needed:

```typescript
metadata: z.record(z.string(), z.unknown()).default({})

// recordAccess stores:
// - accessCount (number): Incremented on each view
// - lastAccessed (ISO string): Set to current time on each view
```

## Design Decisions

These decisions emerged from design conversations and are intentional constraints:

1. **No persisted scores.** Compute the sigmoid on read, never store it. This avoids write amplification and keeps the scoring function tunable without data migration.

2. **No debounce.** Just increment on view. If the agent views a memory 5 times in one conversation, that is 5 genuine signals of relevance. Keep it simple.

3. **No neighborhood decay.** When one memory is accessed, do not decay its neighbors. The write amplification is not worth the marginal signal quality.

4. **State layer only.** Identity always injects everything (it is the agent's core self-model). Events use pure recency via GSI1 time-based sorting. Only state memories need frequency+recency scoring.

5. **Boost signal = direct view.** Only the `view` tool triggers a write (1 write per view). Tag search results are read-only — no boost from appearing in search results.

6. **Key insight: Tags-as-previews.** What gets injected into context is tags and paths, not full content. This forces the agent to `view` the memories it actually needs, which is the boost signal. Not viewing is the decay signal. (This is a future phase, not Phase 1.)

---

## Proposed Changes

### Phase 1: Sigmoid Function (Pure, No Dependencies)

**Goal:** Create the scoring function as an independently testable, pure module.

**New file:** `src/storage/memory-tool/sigmoid.ts`

```typescript
/**
 * Sigmoid-based memory scoring for state layer prioritization.
 *
 * Combines access frequency (boost) with time-since-last-access (decay)
 * to produce a 0-1 relevance score. Higher scores = more relevant.
 *
 * Pure function — no side effects, no dependencies.
 */

/** Tuning parameters for the sigmoid scoring function */
export interface SigmoidParams {
    /** Steepness of the frequency sigmoid curve (default: 0.5) */
    steepness: number
    /** Access count at which frequency score = 0.5 (default: 5) */
    midpoint: number
    /** Exponential decay rate for recency in ms^-1 (default: ~1 week half-life) */
    lambda: number
}

const DEFAULT_PARAMS: SigmoidParams = {
    steepness: 0.5,
    midpoint:  5,
    // ln(2) / (7 * 24 * 60 * 60 * 1000) ≈ 1.15e-9
    // This gives a half-life of ~1 week
    lambda:    Math.LN2 / (7 * 24 * 60 * 60 * 1000),
};

/**
 * Compute a relevance score for a state memory.
 *
 * @param accessCount - Number of times this memory has been viewed
 * @param timeSinceLastAccessMs - Milliseconds since last access
 * @param params - Optional tuning parameters
 * @returns Score between 0 and 1 (higher = more relevant)
 *
 * The score is the product of two components:
 * - frequencyScore: sigmoid(accessCount) — how often this memory is used
 * - recencyDecay: exp(-lambda * time) — how recently it was used
 *
 * A memory accessed 10 times but not for 3 weeks scores lower than
 * a memory accessed 3 times yesterday.
 */
export function sigmoidScore(
    accessCount: number,
    timeSinceLastAccessMs: number,
    params: SigmoidParams = DEFAULT_PARAMS
): number {
    const { steepness, midpoint, lambda } = params;

    // Frequency component: standard sigmoid centered at midpoint
    // accessCount=0 → ~0.08 (with defaults), accessCount=midpoint → 0.5, accessCount=20 → ~1.0
    const frequencyScore = 1 / (1 + Math.exp(-steepness * (accessCount - midpoint)));

    // Recency component: exponential decay
    // t=0 → 1.0, t=1 week → 0.5, t=2 weeks → 0.25
    const recencyDecay = Math.exp(-lambda * timeSinceLastAccessMs);

    return frequencyScore * recencyDecay;
}
```

**Why Phase 1 is independently deployable:** The sigmoid module has zero imports from the rest of the codebase. It can be merged, tested, and tuned in isolation. Nothing calls it yet.

---

### Phase 2: Wire recordAccess into the View Handler

**Goal:** Every time a state memory is viewed via the `view` tool, increment its access count and update its last-accessed timestamp. This is the boost signal.

**File:** `src/storage/memory-tool/handlers.ts`

```typescript
// Before (current)
export async function view(
    backend: MemoryToolBackend,
    params: { path: string, view_range?: [number, number] }
): Promise<string> {
    const memoryPath = validatePath(params.path);
    const item = await backend.get(memoryPath);

    if(item) {
        const timestamp = formatMemoryTimestamp(item.updatedAt);
        const header = `File: ${params.path} ${timestamp}`;
        const content = formatLineNumbers(item.content, params.view_range);
        return `${header}\n${content}`;
    }
    // ...
}

// After (proposed)
export async function view(
    backend: MemoryToolBackend,
    params: { path: string, view_range?: [number, number] },
    options?: { recordAccess?: (paths: MemoryPath[]) => Promise<void> }
): Promise<string> {
    const memoryPath = validatePath(params.path);
    const item = await backend.get(memoryPath);

    if(item) {
        const timestamp = formatMemoryTimestamp(item.updatedAt);
        const header = `File: ${params.path} ${timestamp}`;
        const content = formatLineNumbers(item.content, params.view_range);

        // Record access for state layer memories (fire-and-forget)
        if(options?.recordAccess && extractLayerFromPath(memoryPath) === 'state') {
            options.recordAccess([memoryPath]).catch(err =>
                logger.warn({ err, path: memoryPath }, 'Failed to record memory access')
            );
        }

        return `${header}\n${content}`;
    }
    // ...
}
```

**Design notes:**
- `recordAccess` is injected via options, preserving testability and the existing handler signature for non-state views.
- Only state-layer memories get access tracking (identity and events are excluded per design decision #4).
- Fire-and-forget: the access recording does not block the view response. A failed write is logged but does not fail the view.
- The MCP server (`memory-mcp-server.ts`) passes `recordAccess` from the ContextBuilder when wiring up the view handler.

**Why Phase 2 is independently deployable:** After this phase, state memories accumulate real access metadata. The existing `getAutoLoadItems` already sorts by `accessCount` DESC, so frequently-viewed memories naturally rise to the top — even before the sigmoid function replaces the sort. This phase provides immediate value.

---

### Phase 3: Replace Sorting with Sigmoid Scoring

**Goal:** Replace the raw `orderBy(['accessCount', 'lastAccessed'])` in `getAutoLoadItems` with sigmoid-based scoring.

**File:** `src/storage/memory-tool/backend-query.ts`

```typescript
// Before (current)
const enrichedItems = _map(stateItems, item => ({
    item,
    accessCount:  (item.metadata?.accessCount as number | undefined) ?? 0,
    lastAccessed: (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt,
}));

stateItems = _chain(enrichedItems)
    .orderBy(['accessCount', 'lastAccessed'], ['desc', 'desc'])
    .take(maxStateItems)
    .map(({ item }) => item)
    .value();

// After (proposed)
import { sigmoidScore } from './sigmoid';

const now = Date.now();
const scoredItems = _map(stateItems, item => {
    const accessCount = (item.metadata?.accessCount as number | undefined) ?? 0;
    const lastAccessed = (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt;
    const timeSinceLastAccessMs = now - new Date(lastAccessed).getTime();

    return {
        item,
        score: sigmoidScore(accessCount, timeSinceLastAccessMs),
    };
});

stateItems = _chain(scoredItems)
    .orderBy(['score'], ['desc'])
    .take(maxStateItems)
    .map(({ item }) => item)
    .value();
```

**Behavior change:** Instead of sorting by raw access count (a step function), the sort now uses a continuous 0-1 score that blends frequency and recency. A memory accessed 3 times yesterday outranks one accessed 10 times three weeks ago.

**Fallback for unaccessed items:** Items with `accessCount: 0` and `lastAccessed` falling back to `updatedAt` will get a low but non-zero frequency score (~0.08 with default params) multiplied by recency decay from their last edit. This means recently-created but never-viewed items still appear — they just rank below actively-used ones.

**Optional: `now` injection for testing:**

```typescript
async getAutoLoadItems(
    options?: { maxIdentityItems?: number, maxStateItems?: number, now?: Date }
): Promise<MemoryToolItemData[]> {
    const now = options?.now ?? new Date();
    // ...
}
```

This allows deterministic testing without mocking `Date.now()`.

**Why Phase 3 is independently deployable:** Requires Phase 1 (sigmoid function) and benefits from Phase 2 (real access data). However, it works even without Phase 2 — unaccessed items get scored by their `updatedAt` age, which is better than the current "everything is 0" behavior.

---

### Phase 4 (Future): Tags-as-Previews

**Goal:** Instead of injecting full state memory content into the system prompt, inject only paths and tags. The agent must `view` the memory to read full content, which triggers `recordAccess`. Memories that are never retrieved naturally decay.

**File:** `src/agent/context-builder.ts`

```typescript
// Before (current) — full content injection
const stateContent = _map(
    grouped.state,
    item => `${item.path}:\n${item.content}`
).join('\n\n');

// After (proposed) — tags-as-previews
const stateContent = _map(
    grouped.state,
    item => {
        const tags = item.tags && item.tags.length > 0
            ? ` [${item.tags.join(', ')}]`
            : '';
        return `${item.path}${tags}`;
    }
).join('\n');
```

**This fundamentally changes the agent's relationship with state memory:**
- Before: the agent passively receives state content. No view = no decay signal.
- After: the agent sees *what exists* (paths + tags) and actively chooses what to `view`. Viewing is the boost. Not viewing is the decay.
- The context budget drops dramatically — from 1200 chars of full content to a compact listing of paths and tags.
- The agent develops retrieval behavior: it learns which memories are useful and actively fetches them, rather than being fed everything.

**Why Phase 4 is a separate phase:** This is a behavioral change to the agent, not just a scoring change. It requires prompt engineering to teach the agent to use `view` for state memories. It should be tested carefully after Phases 1-3 establish the scoring infrastructure.

**Phase 4 is not in scope for this roadmap's initial implementation.** It is documented here because it is the design's intended end state and because Phases 1-3 are architected to support it.

---

## Testing Strategy

### TDD Mandate

All changes follow RED-GREEN-REFACTOR. Target: 100% Stryker mutation score for all changed files.

### Phase 1 Tests: sigmoid.ts

```
sigmoid.test.ts
├── sigmoidScore()
│   ├── returns 0.5 frequency component when accessCount equals midpoint
│   ├── returns near-0 frequency when accessCount is 0
│   ├── returns near-1 frequency when accessCount is very high
│   ├── returns 1.0 recency when timeSinceLastAccess is 0
│   ├── returns ~0.5 recency when timeSinceLastAccess equals one half-life
│   ├── returns near-0 recency for very old access times
│   ├── score increases monotonically with accessCount (holding time constant)
│   ├── score decreases monotonically with time (holding count constant)
│   ├── accepts custom SigmoidParams
│   ├── handles edge case: accessCount = 0, time = 0
│   └── product of frequency and recency (verify multiplicative behavior)
```

### Phase 2 Tests: handlers.ts (view wiring)

```
handlers.test.ts (additions)
├── view()
│   ├── calls recordAccess for state layer memories
│   ├── does NOT call recordAccess for identity layer memories
│   ├── does NOT call recordAccess for event layer memories
│   ├── does NOT call recordAccess when options.recordAccess is undefined
│   ├── returns content even when recordAccess fails (fire-and-forget)
│   ├── logs warning when recordAccess fails
│   └── passes correct MemoryPath to recordAccess
```

### Phase 3 Tests: backend-query.ts (sigmoid sort)

```
backend-query.test.ts (modifications)
├── getAutoLoadItems()
│   ├── returns state items sorted by sigmoid score descending
│   ├── recently-accessed low-count items outrank old high-count items
│   ├── items with no access metadata score by updatedAt age
│   ├── respects maxStateItems limit after scoring
│   ├── identity items are returned unfiltered (no scoring)
│   └── deterministic results with injected `now` parameter
```

### Integration Test

End-to-end test verifying the full cycle:
1. Create state memory
2. View it multiple times (triggers recordAccess)
3. Call getAutoLoadItems
4. Verify the viewed memory ranks higher than an unviewed one created at the same time

---

## Benefits

### Relevance over Recency
State memories are prioritized by actual usage patterns, not just when they were last edited. A memory updated once six months ago but consulted weekly ranks appropriately high.

### Natural Decay Without Write Amplification
Unused memories naturally decay via the recency component of the sigmoid. No background jobs, no scheduled writes, no neighborhood decay. A memory that stops being viewed simply drops in score over time.

### Tunable Without Migration
Since scores are computed on read (never persisted), the sigmoid parameters can be adjusted without any data migration. Changing the half-life from 1 week to 2 weeks is a code change, not a data change.

### Foundation for Active Retrieval
Phases 1-3 build the scoring infrastructure that Phase 4 (tags-as-previews) needs. Once the agent must actively `view` memories instead of having them injected, the scoring system has real signal to work with.

### Minimal Write Overhead
Only the `view` handler triggers a write (1 DynamoDB update per view). Tag searches, listing, and context building are read-only. This keeps DynamoDB costs and latency predictable.

---

## Success Criteria

- [ ] `sigmoidScore()` is a pure function with 100% Stryker mutation score
- [ ] `view` handler calls `recordAccess` for state-layer memories on every view
- [ ] `view` handler does NOT call `recordAccess` for identity or events layers
- [ ] `recordAccess` failures do not fail the view operation (fire-and-forget)
- [ ] `getAutoLoadItems` sorts state items by sigmoid score instead of raw accessCount
- [ ] Recently-accessed memories with moderate counts outrank stale memories with high counts
- [ ] Items with no prior access metadata (accessCount=0) still receive a score based on updatedAt
- [ ] No persisted scores — sigmoid is computed fresh on every `getAutoLoadItems` call
- [ ] All changed files pass Stryker mutation testing at 100%
- [ ] No behavioral regression in existing memory tool operations (create, search, rename, etc.)

## Priority

**High.** This is the next step in making the memory system intelligent about what it surfaces. The infrastructure already exists (`recordAccess`, access metadata fields, sorting in `getAutoLoadItems`). The gap is small — a pure function, one handler wire, and a sort replacement. The payoff is large: the agent's context window stops being wasted on irrelevant state memories, and the foundation is laid for the tags-as-previews architecture that Craig has identified as the long-term direction.

## Estimated Effort

- **Phase 1 (sigmoid.ts):** 0.5 days — pure function, straightforward TDD
- **Phase 2 (view handler wiring):** 1 day — handler modification, MCP server wiring, fire-and-forget error handling
- **Phase 3 (sigmoid sort in getAutoLoadItems):** 1 day — replace orderBy, inject `now` for testing, update existing tests
- **Phase 4 (tags-as-previews):** 2-3 days — context-builder changes, prompt engineering, behavioral testing (future, not in initial scope)
- **Total (Phases 1-3):** 2-3 days including comprehensive test coverage
