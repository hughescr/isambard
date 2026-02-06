# Consolidate Context Building

## Problem Statement

Context building for the agent is scattered across 5+ different files, each assembling different pieces of what the agent receives. There is no single source of truth for "what context does the agent see?" This fragmentation makes it difficult to:
- Understand what information the agent actually receives
- Debug context-related issues
- Add new context sources consistently
- Maintain proper ordering and formatting

**Current state:** Context is assembled in multiple places with overlapping responsibilities and unclear boundaries.

## Current State

| File | What It Builds | Who Calls It | When |
|------|---------------|--------------|------|
| `src/agent/context-builder.ts` | Identity layer (auto-loaded memories), user memories, recent events | `buildSystemPrompt()`, `buildContextPrefix()` | System prompt construction + user message prefix |
| `src/agent/agent.ts` (`buildContextPrefix()`) | Time context, user memories, bot memories, recent events | `handleInput()` | User message construction |
| `src/agent/prompts/system-prompt.ts` | Base system prompt, time context, core identity, Discord channel list | `handleInput()` | System prompt construction |
| `src/integrations/discord/state/agent-context-builder.ts` | MCP server config, tools list, system prompt additions, context injection flags | Discord bot handlers | Agent configuration based on bot state |
| `src/integrations/discord/state/status-context-builder.ts` | Status emoji, generation strategy, activity phase context | Presence manager | Status generation |

**Overlap Examples:**
- Time context appears in both `buildContextPrefix()` and `buildSystemPrompt()`
- User memories loaded in both `context-builder.ts` and `buildContextPrefix()`
- Identity loading split between `context-builder.ts` and `system-prompt.ts`
- Channel list added separately in `buildSystemPrompt()`

## Proposed Design

Create a unified `AgentContextBuilder` with clear, composable layers. Each layer is optional and can be toggled based on agent mode (idle, processing, catching up, perching).

### Layers

```typescript
interface AgentContext {
    // System-level context (always present)
    systemPrompt: string

    // User message context (optional based on mode)
    userMessagePrefix?: string

    // Configuration context (mode-dependent)
    mcpServers: McpServerConfig[]
    allowedTools: string[]

    // Metadata
    contextMetadata: {
        layers: string[]           // Which layers were included
        truncated: boolean         // Whether any content was truncated
        totalCharacters: number    // Total context size
    }
}

interface ContextLayer {
    name: string
    enabled: boolean
    content: string
    priority: number  // Lower = higher priority (for truncation)
}
```

### Layer Definitions

**Time Layer** (priority: 1)
- Current UTC time
- Day of week
- Time of day
- Optional: User timezone preference

**Identity Layer** (priority: 2)
- Core identity from `/identity/` memories
- Auto-loaded, permanently present
- Max tokens: 500 (configurable)

**User Memory Layer** (priority: 3)
- Recent memories about the current user (`/users/{userId}/`)
- Configurable limit (default: 3 most recent)
- Age-aware formatting

**Event Layer** (priority: 4)
- Recent events from `/events/`
- Time-range filtered (default: last 14 days)
- Sorted chronologically
- Max items: 50 (configurable)

**State Layer** (priority: 5)
- Bot's own recent activities (`/users/{botUserId}/`)
- Configurable limit (default: 2 most recent)

**Channel Layer** (priority: 6)
- Available Discord channels (unmuted only by default)
- Well-known channels documentation
- Channel management tools documentation

**Mode Layer** (priority: 7)
- Catch-up context (inbox summary, workflow guidance)
- Perch context (autonomous exploration guidance)
- Special mode system prompt additions

### Unified Interface

```typescript
interface AgentContextBuilder {
    /**
     * Build complete context for agent.
     * Returns system prompt, user message prefix, and configuration.
     */
    buildContext(options: ContextOptions): Promise<AgentContext>

    /**
     * Build only system prompt (for lightweight queries).
     */
    buildSystemPrompt(options: SystemPromptOptions): Promise<string>

    /**
     * Build only user message prefix.
     */
    buildUserMessagePrefix(options: UserMessageOptions): Promise<string>
}

interface ContextOptions {
    // What to include
    mode: 'idle' | 'processing_message' | 'catching_up' | 'perching'
    includeIdentity: boolean
    includeUserMemories: boolean
    includeEvents: boolean
    includeChannels: boolean

    // User/context specific
    userId?: string
    botUserId?: string
    channelList?: string[]

    // Mode-specific
    catchUpContext?: CatchUpContextInjection
    perchContext?: PerchContextInjection

    // Limits
    maxIdentityTokens?: number
    maxStateTokens?: number
    maxEventCount?: number
}
```

## Migration Strategy

Consolidate one layer at a time, verifying equivalence at each step:

### Phase 1: Create Unified Builder Interface (Week 1)
- [ ] Create `src/agent/unified-context-builder.ts`
- [ ] Define `AgentContextBuilder` interface
- [ ] Define layer types and priorities
- [ ] Add unit tests for layer composition logic

### Phase 2: Migrate Time Layer (Week 1)
- [ ] Extract time context logic from `buildContextPrefix()` and `buildSystemPrompt()`
- [ ] Create `TimeLayer` with timezone support
- [ ] Test equivalence with existing time context
- [ ] Update callers to use unified builder

### Phase 3: Migrate Identity + User Memory Layers (Week 2)
- [ ] Extract identity loading from `context-builder.ts` and `system-prompt.ts`
- [ ] Unify user memory loading (currently duplicated)
- [ ] Add age-aware formatting
- [ ] Test equivalence

### Phase 4: Migrate Event + State Layers (Week 2)
- [ ] Extract event loading from `context-builder.ts`
- [ ] Extract bot state loading from `buildContextPrefix()`
- [ ] Add configurable limits and time ranges
- [ ] Test equivalence

### Phase 5: Migrate Channel Layer (Week 3)
- [ ] Extract channel list logic from `system-prompt.ts`
- [ ] Add channel registry integration
- [ ] Test equivalence

### Phase 6: Migrate Mode Layer (Week 3)
- [ ] Extract mode-specific context from `agent-context-builder.ts`
- [ ] Integrate catch-up and perch contexts
- [ ] Test equivalence

### Phase 7: Replace Old Builders (Week 4)
- [ ] Update `handleInput()` to use unified builder
- [ ] Update Discord handlers to use unified builder
- [ ] Remove deprecated builders:
  - `buildContextPrefix()` in `agent.ts`
  - `buildSystemPrompt()` in `system-prompt.ts`
  - `createAgentContextBuilder()` in `agent-context-builder.ts`
- [ ] Delete obsolete files after full migration

### Phase 8: Add Observability (Week 4)
- [ ] Log which layers were included in each request
- [ ] Track context size metrics
- [ ] Add truncation warnings
- [ ] Create debug tool to inspect full context

## Benefits

**Single Source of Truth**
- One place to understand what context the agent receives
- Clear ordering and composition rules
- Consistent formatting across all modes

**Easier Debugging**
- See exactly which layers were included in a request
- Track context size and truncation
- Inspect full context via debug tool

**Clear Modification Points**
- Adding a new context source: Create a new layer
- Changing context for a mode: Adjust layer flags in ContextOptions
- Tuning context size: Adjust layer priorities and limits

**Better Testing**
- Mock individual layers in isolation
- Test layer composition logic
- Verify context size limits
- Test mode-specific context variations

**Performance**
- Lazy loading: Only build enabled layers
- Caching: Cache expensive layers (identity, channel list)
- Truncation: Clear priority-based truncation rules

## Implementation Notes

**Backward Compatibility:**
- Keep old builders during migration
- Add deprecation warnings
- Maintain existing API surface until Phase 7

**Testing Strategy:**
- Golden master tests: Capture existing context output
- Compare unified builder output with existing builders
- Verify equivalence before removing old code

**Code Organization:**
```
src/agent/context/
├── builder.ts              # Main AgentContextBuilder
├── layers/
│   ├── time-layer.ts
│   ├── identity-layer.ts
│   ├── user-memory-layer.ts
│   ├── event-layer.ts
│   ├── state-layer.ts
│   ├── channel-layer.ts
│   └── mode-layer.ts
├── types.ts                # Shared types
└── index.ts                # Public exports
```

**Performance Considerations:**
- Cache identity layer (rarely changes)
- Cache channel list (updates on registry change)
- Lazy-load user memories (only when needed)
- Parallelize independent layer loading

## Success Criteria

- [ ] All context building goes through unified builder
- [ ] Zero regressions in agent responses
- [ ] Context size reduced by 10-20% (via better truncation)
- [ ] Debug logs show clear layer composition
- [ ] Tests verify context equivalence
- [ ] Documentation updated with new architecture
