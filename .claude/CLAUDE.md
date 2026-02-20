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
- [ ] Mutation score = 100% for changed files (`bun run mutate`)

### Stryker Mutation Testing
Run mutation testing to verify test quality:
```bash
bun run mutate
```
Target: 100% mutation score (break threshold in stryker.conf.mjs). If mutants survive, tests are incomplete.

**Claude Code Note**: When running mutation testing, use `dangerouslyDisableSandbox: true` as Stryker requires filesystem access outside the sandbox.

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
- `src/storage/` - DynamoDB models, repositories, and storage backends
- `src/integrations/` - External services (Discord, Email)
- `src/config/` - Configuration with Zod validation
- `src/app/` - Application composition root (composition layer for createApp decomposition)
- `src/errors/` - Centralized error hierarchy (IsambardError base with StorageError, DiscordError subtrees)
- `src/utils/` - Shared utilities

### Agents, Skills, and Plugins
- `agents-skills-plugins/` - Agent and skill definitions + plugin config
  - `agents/` - Agent definitions (.md files, copied to scratch/.claude/agents/ at startup)
  - `skills/` - Skill definitions (directories with SKILL.md, copied to scratch/.claude/skills/)
  - `plugins/` - Plugin configuration (plugins.json for external/marketplace plugins)
- `src/agent/skill-agent-loader.ts` - Copy utility: syncs agents/skills to scratch/.claude/ at startup

### Claude Agent Subsystem
The agent subsystem connects Discord to Claude with persistent memory:
- `src/agent/agent.ts` - Claude agent with `handleInput()` method using `@anthropic-ai/claude-agent-sdk`
- `src/agent/context-builder.ts` - Memory context loading (identity, user, events) and user message prefix assembly
- `src/agent/memory-mcp-server.ts` - MCP server exposing memory tools (view, storeSelf, storeUserMemory, logEvent, search, list)
- `src/agent/discord-mcp-server.ts` - MCP server for Discord message history (searchMessages, getRecentMessages, getMessageById)
- `src/agent/text-generator.ts` - Lightweight LLM text generation via Haiku
- `src/agent/types.ts` - Agent stream event types, platform-agnostic message types (`MessageContext`, `PlatformImage`)
- `src/agent/claude-retry.ts` - Retry logic for Claude API calls
- `src/agent/plugin-loader.ts` - Plugin loading and management for Claude Agent SDK
- `src/agent/session-cleanup.ts` - Session cleanup and lifecycle management
- `src/agent/prompts/` - Agent system prompts
  - `system-prompt.ts` - Main system prompt for the agent
  - `index.ts` - Public exports
- `src/agent/event-delta-tracker.ts` - `EventDeltaTracker` class for tracking new events between agent interactions
- `src/agent/stream-tracker.ts` - `StreamTracker` class for tracking Claude streaming response progress and background task collection state
- `src/agent/answer-classifier/` - Answer classification subsystem
  - `classifier.ts` - `AnswerClassifier` class for LLM-based answer classification
- `src/agent/question-registry/` - Question lifecycle management
  - `registry.ts` - `QuestionRegistry` class for tracking pending questions with timeouts
- `src/agent/email-mcp-server.ts` - MCP server for email operations (checkInbox, getEmailContent, archiveEmail, searchEmail, sendEmail, replyToEmail, deleteDraft, amendAndResubmitDraft)
- `src/agent/inbox-mcp-server.ts` - MCP server for Discord inbox operations (getUnreadOverview, getChannelSummary, fetchMessages, markAsRead, markChannelRead)
- `src/agent/event-summarizer.ts` - LLM-based event summarization for context compression
- `src/agent/multimodal-message-builder.ts` - Builds multimodal messages with image support
- `src/agent/resume-prompt-builder.ts` - Builds resume prompts for background task auto-resume
- `src/agent/task-list-reader.ts` - `TaskListReader` for reading Claude task list state
- `src/agent/task-cleanup-processor.ts` - Cleanup processor for stale task list entries
- `src/agent/task-persistence-coordinator.ts` - Coordinator for task list persistence across sessions
- `src/agent/task-directory-copier.ts` - Utility for copying task directories
- `src/agent/index.ts` - Public exports
- `src/index.ts` - Application entry point with lifecycle management

### Discord Integration
The Discord integration provides bot functionality:
- `src/integrations/discord/types.ts` - Branded types (GuildId, ChannelId, UserId, MessageId)
- `src/integrations/discord/errors.ts` - Error hierarchy
- `src/integrations/discord/client.ts` - Discord.js client factory
- `src/integrations/discord/handlers.ts` - Event handlers (ready, error, messageCreate)
- `src/integrations/discord/bot.ts` - Thin bot orchestrator delegating to setup/ modules with start/stop lifecycle
- `src/integrations/discord/messages.ts` - Message splitting utilities (splitMessage for Discord's 2000-char limit)
- `src/integrations/discord/message-coordinator.ts` - `MessageCoordinator` class for debounced message queue processing per channel
- `src/integrations/discord/rate-limiter.ts` - `DiscordRateLimiter` class for rate-limited Discord API calls
- `src/integrations/discord/retry.ts` - Retry logic for Discord operations
- `src/integrations/discord/setup/` - Bot initialization setup modules (extracted from bot.ts)
  - `presence-stream-handler.ts` - Shared utility for creating stream event handlers for presence updates
  - `presence-setup.ts` - Presence manager creation, status generators, and BotStateManager subscriptions
  - `perch-setup.ts` - Perch session runner and scheduler configuration
  - `catchup-setup.ts` - Catch-up session runner, inbox initialization, and catch-up context building
  - `coordinator-setup.ts` - Message coordinator integration with agent, attachment processing, boundary mapping (Discord→agent types)
  - `event-handler-setup.ts` - Channel registry initialization, message processing setup, channel cleanup handlers
  - `email-setup.ts` - Email MCP server initialization and IMAP listener lifecycle
- `src/integrations/discord/index.ts` - Public exports

### Discord Presence System
Dynamic status updates reflecting agent activity:
- `src/integrations/discord/presence/` - Complete presence management
  - `types.ts` - PresencePhase types (idle, thinking, responding, tool-use)
  - `errors.ts` - Presence-related errors
  - `manager.ts` - `PresenceManager` class with debouncing and rate limiting
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

### Email Integration
IMAP inbox reading with WildDuck HTTP API for outbound sending and admin approval workflow:
- `src/integrations/email/types.ts` - Email types (EmailFolder, WildDuckMessage, WildDuckAddress, SearchCriteria)
- `src/integrations/email/errors.ts` - Email error hierarchy
- `src/integrations/email/imap-connection.ts` - IMAP connection via imapflow (IDLE push support)
- `src/integrations/email/imap-listener.ts` - IMAP IDLE listener with checkPendingNotifications loop
- `src/integrations/email/wildduck-client.ts` - WildDuck HTTP API client (message search, flag management, draft upload, message send, updateMessageFlags)
- `src/integrations/email/email-processor.ts` - Email processing pipeline
- `src/integrations/email/email-counters.ts` - CleanInbox unread counter management
- `src/integrations/email/outbound-approval-handler.ts` - Admin approval workflow for outbound emails via Discord
- `src/integrations/email/allowlist.ts` - Recipient allowlist management
- `src/integrations/email/allowlist-commands.ts` - Discord slash commands for allowlist management
- `src/integrations/email/auth-checker.ts` - Authorization checking for outbound email
- `src/integrations/email/send-rate-limiter.ts` - Token bucket rate limiter for outbound sends (capacity=24, refill=1/hr)
- `src/integrations/email/classifier.ts` - Email classification
- `src/integrations/email/classifier-prompt.ts` - LLM prompt for email classification
- `src/integrations/email/review-embed-builder.ts` - Discord embed builder for approval review
- `src/integrations/email/review-handler.ts` - Handles admin approval/rejection responses
- `src/integrations/email/index.ts` - Public exports

### Memory Tool Subsystem
Custom memory tool implementation with DynamoDB backend and three-layer architecture:
- `src/storage/memory-tool/` - Complete memory tool implementation
  - `types.ts` - Zod schemas (MemoryPath, LayerName, MemoryToolItem), branded types, type guards and factory functions (createMemoryPath, createLayerName, createContentType)
  - `errors.ts` - MemoryToolError hierarchy
  - `key-generator.ts` - DynamoDB key structure (PK/SK/GSI1), tag index keys, content preview
  - `layer-config.ts` - Layer configuration (identity/state/events with TTL and autoLoad)
  - `backend.ts` - Main backend facade
  - `backend-core.ts` - Core CRUD operations (single update method, no versioning)
  - `backend-query.ts` - Query operations (list, searchByTags, listByLayer, searchByTimeRange, getAutoLoadItems)
  - `backend-tag-index.ts` - Tag index CRUD with BatchWriteItem, META_COUNT atomic counters, and listTagCounts
  - `handlers.ts` - All memory tool handlers (create, insert, str_replace, rename, search, recall, list_by_layer, consolidate)
  - `reconciliation/` - Tag index reconciliation with three phases: completeness (A), orphan cleanup (B), count verification (C)
  - `index.ts` - Public exports

### Storage Subsystem
DynamoDB integration and data access layer:
- `src/storage/client.ts` - DynamoDB client factory
- `src/storage/errors.ts` - Storage-related error hierarchy
- `src/storage/dynamo-retry.ts` - Retry logic for DynamoDB operations
- `src/storage/index.ts` - Public exports
- `src/storage/models/` - Entity definitions
  - `memory.ts` - Memory entity model
- `src/storage/repositories/` - Data access repositories
  - `base.ts` - Base repository with common CRUD operations
  - `memory.ts` - Memory repository
- `src/storage/utils/` - Storage utilities
  - `strip-keys.ts` - Utility to strip DynamoDB internal keys
  - `index.ts` - Public exports

### Configuration Subsystem
Zod-validated configuration loading with env-var for type-safe environment variable parsing:
- `src/config/schemas.ts` - Zod schemas for configuration validation
- `src/config/loader.ts` - Configuration loader with environment variable support
- `src/config/retry-config.ts` - Retry configuration constants
- `src/config/index.ts` - Public exports

### Utilities
- `src/utils/time.ts` - Time utilities (formatRelativeTime, getTimeOfDay, getCurrentTimeContext, formatShortRelativeTime, formatMemoryTimestamp, formatTimeHeader)
- `src/utils/retry/` - Retry utilities with exponential backoff
  - `types.ts` - Retry configuration types
  - `classifier.ts` - Error classification for retry decisions
  - `delay.ts` - Exponential backoff delay calculation
  - `retry-async.ts` - Retry wrapper for async functions
  - `retry-async-generator.ts` - Retry wrapper for async generators
  - `index.ts` - Public exports

### Key Patterns
- **Repository Pattern** for data access
- **Dependency Injection** for testability
- **Zod Schemas** for runtime validation
- **Branded Types** (MemoryPath, LayerName, ChannelId, GuildId, UserId, MessageId)
- **Platform-Agnostic Agent Types** — agent module uses `MessageContext` and `PlatformImage` instead of Discord-specific types; Discord integration maps at the boundary in `coordinator-setup.ts`
- **Structured Logging** with correlation IDs
- **Custom MCP Servers** for memory and Discord message history tools
- **Three-Layer Memory Architecture** with paths: `/identity/`, `/state/`, `/events/`, `/users/{userId}/`
- **Retry Logic with Exponential Backoff** for network resilience (Claude API, DynamoDB, Discord)
- **Error Classification** for intelligent retry decisions
- **Module Boundary Enforcement** with eslint-plugin-boundaries for architectural import rules
- **@internal JSDoc Tags** for marking implementation-only exports
- **Per-Tag Atomic Counters** replacing centralized tag registry for race-condition-free tag counting
- **Sigmoid Memory Scoring** — `sigmoidScore()` combines access frequency with recency decay for state memory prioritization in `getAutoLoadItems`
- **Tags as StringSet** — DynamoDB StringSet (SS) type with `Set<string>` in TypeScript throughout; MCP boundary converts JSON arrays to Sets
- **Type Guards and Factory Functions** for branded types — `createLayerName()`, `createContentType()`, `isLayerName()`, `isContentType()` replace unsafe `as` casts with runtime-validated factories
- **Class-Based Components** — `EventDeltaTracker`, `AnswerClassifier`, `StreamTracker`, `QuestionRegistry`, `DiscordRateLimiter`, `PresenceManager`, `MessageCoordinator`, `BotStateManagerImpl` use proper TypeScript classes with private fields instead of closure-based factories
- **Background Task Auto-Resume** — `StreamTracker` counts background task launches vs `TaskOutput` collections; `handleInput` auto-resumes (max 1 attempt) when uncollected tasks detected, preserving initial response on failure

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
