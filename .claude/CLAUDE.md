# Isambard Development Instructions

## Project Overview
Isambard is a self-improving agentic thought partner using Claude Agent SDK, TypeScript, and Bun.

## Development Workflow

### TDD Mandate (RED-GREEN-REFACTOR)
1. **RED**: Write a failing test first
2. **GREEN**: Write minimal code to pass the test
3. **REFACTOR**: Clean up while keeping tests green

Never write production code without a failing test. Tests are not optional.

### Quality Gates
Before any PR or commit:
- [ ] All tests pass (`bun test`)
- [ ] Zero TypeScript errors (`bun run typecheck`)
- [ ] Zero lint warnings (`bun run lint`)
- [ ] Mutation score >= 90% for changed files (`bun run mutate`)

### Stryker Mutation Testing
Run mutation testing to verify test quality:
```bash
bun run mutate
```
Target: >= 90% mutation score (break threshold in stryker.conf.mjs). If mutants survive, tests are incomplete.

**Claude Code Note**: When running mutation testing in Claude Code, use a clean PATH to avoid module resolution conflicts:
```bash
PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin bun run mutate
```
This prevents Claude Code's bundled paths from interfering with Stryker's `@babel/generator` module resolution.

### Codex Consultation
Consult Codex for:
- Architectural decisions
- Design pattern choices
- API design reviews
- Performance considerations

### Self-Modification Protocol
Isambard can propose improvements to its own code:
1. Changes are submitted as PRs
2. All PRs require human approval
3. CI must pass before merge
4. No direct commits to main

## Architecture

### Directory Structure
- `src/agent/` - Claude Agent SDK integration
- `src/storage/` - DynamoDB models and repositories
- `src/integrations/` - External services (Discord, etc.)
- `src/config/` - Configuration with Zod validation
- `src/utils/` - Shared utilities

### Claude Agent Subsystem
The agent subsystem connects Discord to Claude with persistent memory:
- `src/agent/agent.ts` - Claude agent with `chat()` method using `@anthropic-ai/claude-agent-sdk`
- `src/agent/context-builder.ts` - Memory context loading (identity, user, events)
- `src/agent/memory-mcp-server.ts` - MCP server exposing memory tools (view, storeSelf, storeUserMemory, logEvent, search, list)
- `src/agent/discord-mcp-server.ts` - MCP server for Discord message history (searchMessages, getRecentMessages, getMessageById)
- `src/agent/text-generator.ts` - Lightweight LLM text generation via Haiku
- `src/agent/types.ts` - Agent stream event types
- `src/index.ts` - Application entry point with lifecycle management

### Discord Integration
The Discord integration provides bot functionality:
- `src/integrations/discord/types.ts` - Branded types (GuildId, ChannelId, UserId)
- `src/integrations/discord/errors.ts` - Error hierarchy
- `src/integrations/discord/client.ts` - Discord.js client factory
- `src/integrations/discord/handlers.ts` - Event handlers (ready, error, messageCreate)
- `src/integrations/discord/bot.ts` - Bot factory with start/stop lifecycle
- `src/integrations/discord/messages.ts` - Message splitting utilities (splitMessage for Discord's 2000-char limit)
- `src/integrations/discord/index.ts` - Public exports

### Discord Presence System
Dynamic status updates reflecting agent activity:
- `src/integrations/discord/presence/` - Complete presence management
  - `types.ts` - PresencePhase types (idle, thinking, responding, tool-use)
  - `errors.ts` - Presence-related errors
  - `manager.ts` - Presence manager with debouncing and rate limiting
  - `middleware.ts` - Middleware for presence state transitions
  - `status-generator-active.ts` - Generates status text for active phases
  - `status-generator-idle.ts` - Generates LLM-powered idle status text
  - `status-generator-dynamic.ts` - Dynamic status with context awareness
  - `index.ts` - Public exports

### Discord Message History
Message search and caching for historical context:
- `src/integrations/discord/message-history/` - Message history subsystem
  - `types.ts` - Search types (DiscordSearchResult, SearchParams, SearchResponse)
  - `snowflake.ts` - Discord snowflake ID utilities
  - `fetcher.ts` - Discord API message fetcher
  - `search.ts` - Message search service
  - `summarizer.ts` - Overflow message summarization
  - `index.ts` - Public exports

### Message Cache
DynamoDB-backed cache for Discord messages:
- `src/storage/message-cache/` - Message caching layer
  - `types.ts` - Cache types (CachedMessage, CachedSegment, CacheGap)
  - `key-generator.ts` - DynamoDB key generation
  - `segment-manager.ts` - Segment management for contiguous message ranges
  - `backend.ts` - DynamoDB operations
  - `cache.ts` - Cache facade
  - `index.ts` - Public exports

### Memory Tool Subsystem
Custom memory tool implementation with DynamoDB backend and three-layer architecture:
- `src/storage/memory-tool/` - Complete memory tool implementation
  - `types.ts` - Zod schemas (MemoryPath, LayerName, MemoryToolItem), branded types
  - `errors.ts` - MemoryToolError hierarchy
  - `key-generator.ts` - DynamoDB key structure (PK/SK/GSI1/GSI2)
  - `layer-config.ts` - Layer configuration (identity/state/events with TTL and versioning)
  - `backend.ts` - Main backend facade
  - `backend-core.ts` - Core CRUD operations
  - `backend-query.ts` - Query operations (list, searchByTag)
  - `backend-versions.ts` - Version history management
  - `handlers.ts` - Facade re-exporting all handlers
  - `handlers-basic.ts` - Basic handlers: view, create, delete_memory, insert
  - `handlers-advanced.ts` - Advanced handlers: str_replace, rename, search, recall, list_by_layer, consolidate
  - `index.ts` - Public exports

### Utilities
- `src/utils/time.ts` - Time utilities (formatRelativeTime, getTimeOfDay, getCurrentTimeContext, formatShortRelativeTime)

### Key Patterns
- **Repository Pattern** for data access
- **Dependency Injection** for testability
- **Zod Schemas** for runtime validation
- **Branded Types** (MemoryPath, LayerName, ChannelId, GuildId, UserId, MessageId)
- **Structured Logging** with correlation IDs
- **Custom MCP Servers** for memory and Discord message history tools
- **Three-Layer Memory Architecture** with paths: `/identity/`, `/state/`, `/events/`, `/users/{userId}/`

## Roadmaps
- [Short-term (Weeks 1-2)](../roadmaps/short-term.md)
- [Mid-term (Weeks 3-8)](../roadmaps/mid-term.md)
- [Long-term (Months 3+)](../roadmaps/long-term.md)

## Commands
```bash
bun run dev:sst      # Development with SST shell and hot reload
bun run dev:docker   # Full stack with DynamoDB containers
bun test             # Run tests
bun run mutate       # Mutation testing
bun run lint         # Check linting
bun run typecheck    # TypeScript validation
```
