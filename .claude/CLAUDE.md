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

**Sandbox Note**: `reports/stryker-incremental.json` is protected by `denyWrite` in project sandbox settings. Run mutation testing with `dangerouslyDisableSandbox: true` so Stryker can update its incremental cache.

### Test Performance Anti-Patterns
Since Stryker runs each test potentially hundreds of times, even small per-test overhead compounds dramatically. Every test should target <1ms execution. Avoid these patterns:

1. **Real wall-clock delays** — Never use `Date.now()` elapsed time assertions or `setTimeout` with real timers in tests. Always use `jest.useFakeTimers()` + `jest.advanceTimersByTime()`. *(enforced by ESLint: `no-restricted-syntax` bans `setTimeout`/`setInterval` in test files)*
2. **`setTimeout(resolve, 0)` for microtask flushing** — Use `await Promise.resolve()` instead (nanoseconds vs 1-4ms macrotask minimum). *(enforced indirectly: `setTimeout` and `new Promise(r => setTimeout(r, N))` are both banned by `no-restricted-syntax`)*
3. **Dynamic `await import()` per test** — Import modules once at file scope with `import * as mod from '...'`, then `spyOn(mod, 'fn')` in each test. Dynamic imports trigger ESM re-evaluation (~50ms each). *(enforced by ESLint: `no-restricted-syntax` bans `AwaitExpression > ImportExpression` in test files)*
4. **`done` callback + real `setTimeout`** — Use fake timers: `jest.advanceTimersByTime(N)` instead of waiting real milliseconds. *(enforced by ESLint: `jest/no-done-callback` plus the `setTimeout` ban)*
5. **Real delays in mock implementations** — Mock implementations should resolve immediately (`async () => 'result'`), not `await new Promise(r => setTimeout(r, 10))`. *(not statically lint-enforced; rely on code review)*
6. **Unawaited `.rejects` assertions** — Bun correctly handles these (unlike Jest), but `await` triggers the `no-confusing-void-expression` lint rule, so leave them unawaited.

### Test Hygiene Enforcement

Several hygiene rules are mechanized via ESLint so violations are caught at lint time:

**Custom rules** in `tools/eslint-rules/` (all with RuleTester-based tests):
- `require-fake-timers-cleanup` — every `jest.useFakeTimers()` in a hook or test body must pair with `jest.useRealTimers()` in the matching cleanup hook
- `require-mock-cleanup` — every `jest.spyOn()` must pair with `jest.restoreAllMocks()` or `mockRestore()` in `afterEach`
- `require-mock-reset` — mocks imported from a configured setup module must have their reset helper called in `afterEach`; configured via `mocks` option mapping identifier → reset function names, and `setupModules` option for import-path suffixes
- `no-mock-module-in-test-body` — `mock.module()` calls must live only in `tests/setup.ts` (the module is global and order-dependent); tests must not call it inside describe/it blocks
- `no-internal-in-barrel` — barrel `index.ts` files must not re-export `@internal`-tagged symbols via `export { Name } from './x'`; prevents leaking implementation details through the module's public API surface
- `no-cross-module-internal` — production code must not import `@internal` symbols from a different architectural module (e.g., `agent` importing from `storage @internal`); enforces module boundary integrity
- `no-star-export-from-non-barrel` — barrel `index.ts` files must not use `export * from './x'` when `./x` is a non-barrel file (i.e., not an `index.ts`); star re-exports leak all names silently including future `@internal` additions. `export *` from another barrel (`index.ts`) is allowed by default (`allowBarrelOfBarrels: true`)

**`eslint-plugin-jest`** enforces hook ordering, no-done-callback, no-focused-tests, and expect correctness.

**Bypass**: `// eslint-disable-next-line <rule-name> -- <specific reason>`. A description after `--` is required by `eslint-comments/require-description`.

**Intentionally disabled**: `jest/require-hook` is off. The project's module-level `mock.module()` setup pattern (which `no-mock-module-in-test-body` separately governs) conflicts with requiring all setup code to live in hooks. See `eslint.config.mjs` for the inline rationale.

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
- `src/integrations/` - External services (Discord, Email, Bluesky, CalDAV)
- `src/services/` - Service infrastructure (health monitoring, reconnection, outbox, approval saga)
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
- `src/agent/context-builder.ts` - Memory context loading (identity, user, events), user message prefix assembly, and perch context (email inbox, Bluesky DM notifications, rejected Bluesky posts/DMs)
- `src/agent/memory-mcp-server.ts` - MCP server exposing memory tools (view, storeSelf, storeUserMemory, logEvent, search, list)
- `src/agent/discord-mcp-server.ts` - MCP server for Discord message history (searchMessages, getRecentMessages, getMessageById)
- `src/agent/text-generator.ts` - Lightweight LLM text generation via Haiku
- `src/agent/types.ts` - Agent stream event types, platform-agnostic message types (`MessageContext`, `PlatformImage`)
- `src/agent/claude-retry.ts` - Retry logic for Claude API calls
- `src/agent/plugin-loader.ts` - Plugin loading and management for Claude Agent SDK
- `src/agent/session-cleanup.ts` - Session cleanup and lifecycle management
- `src/agent/prompts/` - Agent system prompts
  - `system-prompt.ts` - Main system prompt for the agent
  - `compaction-prompt.ts` - Isambard-specific compaction summary prompt injected into context window compaction
  - `index.ts` - Public exports
- `src/agent/event-delta-tracker.ts` - `EventDeltaTracker` class for tracking new events between agent interactions
- `src/agent/stream-tracker.ts` - `StreamTracker` class for tracking Claude streaming response progress and background task collection state
- `src/agent/answer-classifier/` - Answer classification subsystem
  - `types.ts` - `ClassificationResult` Zod enum type (answer/interruption/unrelated) and `MessageToClassify` interface
  - `haiku-classifier.ts` - LLM-based message classification using Haiku with prompt building and response parsing
  - `classifier.ts` - `AnswerClassifier` class for LLM-based answer classification
  - `index.ts` - Public exports
- `src/agent/question-registry/` - Question lifecycle management
  - `registry.ts` - `QuestionRegistry` class for tracking pending questions with timeouts
  - `types.ts` - Question types (PendingQuestion, QuestionAnswer, QuestionOption, QuestionState)
  - `index.ts` - Public exports
- `src/agent/history-providers/` - Cross-platform history injection
  - `coordinator.ts` - `PersonHistoryCoordinator` aggregating history from Discord, Email, and Bluesky providers
  - `types.ts` - `HistoryProvider` interface and related types
  - `index.ts` - Public exports
- `src/agent/email-mcp-server.ts` - MCP server for email operations (checkInbox, getEmailContent, archiveEmail, searchEmail, sendEmail, replyToEmail, deleteDraft, amendAndResubmitDraft)
- `src/agent/bsky-mcp-server.ts` - MCP server for Bluesky operations (getFeed, getNotifications, searchPosts, getPost, getProfile, getAuthorFeed, likePost, follow, unfollow, sendPost, replyToPost, listConversations, getDirectMessages, sendDirectMessage, listRejectedPosts, clearRejection, clearAllRejections)
- `src/agent/inbox-mcp-server.ts` - MCP server for Discord inbox operations (getUnreadOverview, getChannelSummary, fetchMessages, markAsRead, markChannelRead)
- `src/agent/caldav-mcp-server.ts` - MCP server for CalDAV calendar operations (getCalendarEvents, getUpcomingEvents, listUserCalendars)
- `src/agent/contacts-mcp-server.ts` - MCP server for contacts/address book operations (lookupContact, searchContacts, createContact, updateContact, deleteContact)
- `src/agent/media-mcp-server.ts` - MCP server for media processing (analyzeVideoFromUrl, analyzeLocalVideo, getVideoFrames, generateSpectrogramFromAudio)
- `src/agent/user-context-mcp-server.ts` - MCP server for user context and cross-platform awareness
- `src/agent/wikipedia-mcp-server.ts` - MCP server for Wikipedia article retrieval (getArticle)
- `src/agent/activity-logger.ts` - Cross-platform activity auto-logging
- `src/agent/mcp-helpers.ts` - Shared MCP server utilities
- `src/agent/event-summarizer.ts` - LLM-based event summarization for context compression
- `src/agent/multimodal-message-builder.ts` - Builds multimodal messages with image support
- `src/agent/resume-prompt-builder.ts` - Builds resume prompts for background task auto-resume
- `src/agent/task-list-reader.ts` - `TaskListReader` for reading Claude task list state
- `src/agent/task-cleanup-processor.ts` - Cleanup processor for stale task list entries
- `src/agent/task-persistence-coordinator.ts` - Coordinator for task list persistence across sessions
- `src/agent/task-directory-copier.ts` - Utility for copying task directories
- `src/agent/index.ts` - Public exports
- `src/index.ts` - Application entry point with lifecycle management

### Agent Perch System
Time-based autonomous activity scheduling with graduated suggestion levels:
- `src/agent/perch/types.ts` - `PerchSlot`, `SuggestionLevel`, `PerchSlotConfig`, `PerchConfig`, `PerchSchedulerState` types and Zod schemas
- `src/agent/perch/schedule.ts` - `SLOT_CONFIGS` array and `getSlotForHour`/`getSlotConfig` lookup functions for time-based slot determination
- `src/agent/perch/prompts.ts` - Prompt builders for perch sessions: initial, test, resumed, and timeout wrap-up variants
- `src/agent/perch/session-runner.ts` - `createPerchSessionRunner` factory managing perch lifecycle: start/suspend/resume with timeout enforcement and wrap-up prompts
- `src/agent/perch/scheduler.ts` - `PerchScheduler` cron-based trigger scheduler using cron-parser H option for jitter, with deferred trigger support when bot is busy
- `src/agent/perch/index.ts` - Public exports
- `src/agent/perch/README.md` - Design documentation for the perch time scheduling system

### Discord Integration
The Discord integration provides bot functionality:
- `src/integrations/discord/types.ts` - Branded types (GuildId, ChannelId, UserId, MessageId)
- `src/integrations/discord/client.ts` - Discord.js client factory
- `src/integrations/discord/handlers.ts` - Event handlers (ready, error, messageCreate)
- `src/integrations/discord/bot.ts` - Thin bot orchestrator delegating to setup/ modules with start/stop lifecycle
- `src/integrations/discord/messages.ts` - Message splitting utilities (splitMessage for Discord's 2000-char limit)
- `src/integrations/discord/message-coordinator.ts` - `MessageCoordinator` class for debounced message queue processing per channel
- `src/integrations/discord/rate-limiter.ts` - `DiscordRateLimiter` class for rate-limited Discord API calls
- `src/integrations/discord/retry.ts` - Retry logic for Discord operations
- `src/integrations/discord/button-builder.ts` - Builds Discord ActionRow button components for question options
- `src/integrations/discord/content-type.ts` - Infers image content type from filename for Discord attachments lacking MIME type
- `src/integrations/discord/interactions.ts` - Discord button interaction handler for question answer routing
- `src/integrations/discord/response-sender.ts` - Shared helpers for routing and sending agent responses to Discord channels
- `src/integrations/discord/register-commands.ts` - Consolidated Discord slash command registration (single bulk PUT)
- `src/integrations/discord/capability.ts` - Discord capability definitions
- `src/integrations/discord/contact-commands.ts` - Contact management Discord slash commands (/contact add, /contact delete, /contact list)
- `src/integrations/discord/allowlist-commands.ts` - Discord slash commands for person-based allowlist management (/allowlist add, /allowlist remove, /allowlist list)
- `src/integrations/discord/allowlist-interaction-handler.ts` - Multi-step allowlist saga UI handler for add-to-allowlist Discord button/modal flow
- `src/integrations/discord/history-provider.ts` - Discord history provider for cross-platform context injection
- `src/integrations/discord/colors.ts` - Shared Discord embed color constants
- `src/integrations/discord/setup/` - Bot initialization setup modules (extracted from bot.ts)
  - `presence-stream-handler.ts` - Shared utility for creating stream event handlers for presence updates
  - `presence-setup.ts` - Presence manager creation, status generators, and BotStateManager subscriptions
  - `perch-setup.ts` - Perch session runner and scheduler configuration
  - `catchup-setup.ts` - Catch-up session runner, inbox initialization, and catch-up context building
  - `coordinator-setup.ts` - Message coordinator integration with agent, attachment processing, boundary mapping (Discord→agent types)
  - `event-handler-setup.ts` - Channel registry initialization, message processing setup, channel cleanup handlers
  - `email-setup.ts` - Email MCP server initialization and WildDuck SSE listener lifecycle
  - `bsky-setup.ts` - Bluesky integration setup: allowlist, rate limiter, reply and DM approval callbacks, outbound approval handler
- `src/integrations/discord/index.ts` - Public exports

### Discord Attachments
Image fetching, conversion, and formatting for Discord message attachments:
- `src/integrations/discord/attachments/types.ts` - Attachment types (AttachmentMetadata, FetchedImage, StoredAttachment, FailedAttachment) with HEIC/HEIF and native image type definitions
- `src/integrations/discord/attachments/converter.ts` - HEIC/HEIF to PNG conversion using heic-convert
- `src/integrations/discord/attachments/fetcher.ts` - Fetches image attachments from Discord URLs, converting formats and saving non-image files to disk
- `src/integrations/discord/attachments/formatting.ts` - Utilities for formatting bytes and appending attachment info to message contexts
- `src/integrations/discord/attachments/index.ts` - Public exports

### Discord Bot State
Bot operational state machine with mode transitions and activity phases:
- `src/integrations/discord/state/types.ts` - `OperationalMode`, `ActivityPhase`, `BotState`, `BotStateManager` interface and all mode context types (idle, catching_up, processing_message, perching)
- `src/integrations/discord/state/manager.ts` - `BotStateManagerImpl` class implementing state machine with mode transitions, activity phase tracking, presence throttling, and subscriber notifications
- `src/integrations/discord/state/transitions.ts` - Valid state transition table (idle-hub pattern), `isValidTransition`, and `getModeEmoji`
- `src/integrations/discord/state/agent-context-builder.ts` - Builds mode-dependent agent configuration (MCP servers, system prompt additions, context injection) from current bot state
- `src/integrations/discord/state/status-context-builder.ts` - Produces `StatusContext` for presence status generation, mapping bot state to LLM/static strategy
- `src/integrations/discord/state/index.ts` - Public exports

### Discord Channel Registry
DynamoDB-backed channel registry with in-memory caching and well-known channel support:
- `src/integrations/discord/channel-registry/types.ts` - `ChannelStorageRecord`, `ChannelMetadata`, `WellKnownChannel` types (`general`, `catch-up`, `perch-time`, `fallback`)
- `src/integrations/discord/channel-registry/key-generator.ts` - `ChannelRegistryKeyGenerator` for DynamoDB PK/SK/GSI1/GSI2 key construction and parsing
- `src/integrations/discord/channel-registry/backend.ts` - `ChannelRegistryBackend` DynamoDB CRUD with mute, well-known designation, and GSI2 lookup
- `src/integrations/discord/channel-registry/manager.ts` - `ChannelRegistryManager` with write-through cache, Discord API merging, and `shouldProcess` filtering logic
- `src/integrations/discord/channel-registry/discovery.ts` - Discovers all guild channels from Discord API and populates registry; sets up channelCreate/Update/Delete handlers
- `src/integrations/discord/channel-registry/dm-tracker.ts` - `DMTracker` class for on-demand DM channel creation and tracking by user ID or username
- `src/integrations/discord/channel-registry/resolve.ts` - Resolves `#channel-name` or numeric ID strings to typed `ChannelId`
- `src/integrations/discord/channel-registry/response-router.ts` - `ResponseRouter` class routing agent responses to origin channel or well-known channels based on session type
- `src/integrations/discord/channel-registry/sentinel.ts` - `@@NO_RESPONSE@@` sentinel detection and stripping for suppressing unwanted agent responses
- `src/integrations/discord/channel-registry/index.ts` - Public exports

### Discord Inbox
Unread message tracking with checkpoint persistence for catch-up on restart:
- `src/integrations/discord/inbox/types.ts` - `DiscordChannelCheckpoint`, `UnreadMessage`, `ChannelSummary`, `UnreadOverview` Zod schemas
- `src/integrations/discord/inbox/config.ts` - `InboxConfig` schema with defaults (minGapDurationMs, maxCatchUpMessages, maxCatchUpAgeDays)
- `src/integrations/discord/inbox/checkpoint-manager.ts` - `CheckpointManager` class persisting last-seen timestamps per channel in memory tool backend
- `src/integrations/discord/inbox/inbox-manager.ts` - `InboxManager` class managing in-memory unread queue, loading messages since checkpoint on startup, marking read, and recording activity
- `src/integrations/discord/inbox/index.ts` - Public exports

### Discord Catch-Up System
Session runner and prompts for processing unread message backlogs:
- `src/integrations/discord/catchup/session-runner.ts` - `createCatchUpSessionRunner` factory managing catch-up lifecycle: startup check, session start/suspend/resume/complete, inProgress and completion signal persistence
- `src/integrations/discord/catchup/prompts.ts` - `buildCatchUpPrompt` and `buildCatchUpResumedPrompt` for initial and resumed catch-up agent prompts
- `src/integrations/discord/catchup/index.ts` - Public exports

### Discord Presence System
Dynamic status updates reflecting agent activity:
- `src/integrations/discord/presence/` - Complete presence management
  - `types.ts` - PresencePhase types (idle, thinking, responding, tool-use)
  - `manager.ts` - `PresenceManager` class with debouncing and rate limiting
  - `middleware.ts` - Middleware for presence state transitions
  - `stream-event-handler.ts` - Reusable stream event handler for presence updates with phase tracking and synopsis generation
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
WildDuck HTTP API for inbox reading with SSE push notifications, outbound sending, and admin approval workflow:
- `src/integrations/email/types.ts` - Email types (EmailFolder, WildDuckMessage, WildDuckAddress, SearchCriteria)
- `src/integrations/email/errors.ts` - Email error hierarchy
- `src/integrations/email/wildduck-client.ts` - WildDuck HTTP API client (message search, flag management, draft upload, message send, updateMessageFlags, folder creation, attachment fetch)
- `src/integrations/email/wildduck-listener.ts` - WildDuck SSE listener with poll fallback and checkPendingNotifications loop
- `src/integrations/email/email-processor.ts` - Email processing pipeline
- `src/integrations/email/outbound-approval-handler.ts` - Admin approval workflow for outbound emails via Discord
- `src/integrations/email/auth-checker.ts` - Authorization checking for outbound email
- `src/integrations/email/send-rate-limiter.ts` - Token bucket rate limiter for outbound sends (capacity=24, refill=1/hr)
- `src/integrations/email/classifier.ts` - Email classification
- `src/integrations/email/classifier-prompt.ts` - LLM prompt for email classification
- `src/integrations/email/review-embed-builder.ts` - Discord embed builder for approval review
- `src/integrations/email/review-handler.ts` - Handles admin approval/rejection responses
- `src/integrations/email/history-provider.ts` - Email history provider for cross-platform context injection
- `src/integrations/email/index.ts` - Public exports

### Bluesky Integration
AT Protocol client for feeds, posts, DMs, and social graph:
- `src/integrations/bsky/types.ts` - Domain types (BskyAuthor, BskyPost, BskyFeedItem, BskyNotification, BskyConversation, BskyDirectMessage, BskyConversationMember)
- `src/integrations/bsky/errors.ts` - Error hierarchy (BskyError, BskyAuthError, BskyRateLimitError)
- `src/integrations/bsky/client.ts` - `BlueskyClient` class wrapping `AtpAgent` from `@atproto/api` (feeds, posts, DMs, follow/unfollow, validation)
- `src/integrations/bsky/review-embed-builder.ts` - Discord embed builder for reply and DM approval requests with type discriminator
- `src/integrations/bsky/outbound-approval-handler.ts` - Discord button/modal approval workflow for outbound Bluesky replies and DMs (bsky-send-* and bsky-dm-* prefixes). Persists rejection data to `BskyRejectionBackend` for agent feedback.
- `src/integrations/bsky/rejection-backend.ts` - `BskyRejectionBackend` DynamoDB backend (PK=`BSKY#REJECTED`, SK=`REJECTION#{uuid}`) storing admin-rejected posts/DMs with all MCP tool retry parameters. 30-day TTL. Discriminated union: reply (text, targetHandle, parentUri, parentCid, rootUri, rootCid) vs DM (text, recipientHandles, convoId).
- `src/integrations/bsky/embeds.ts` - Embed types, normalization, and facet support for rich post content
- `src/integrations/bsky/history-provider.ts` - Bluesky history provider for cross-platform context injection
- `src/integrations/bsky/checkpoint/` - Feed and notification progress tracking for idempotent feed consumption
  - `types.ts` - `BskyFeedCheckpoint`, `BskyNotificationCheckpoint` Zod schemas with processed URI tracking
  - `checkpoint-manager.ts` - `BskyCheckpointManager` class persisting feed/notification checkpoints in memory tool backend
  - `uri-sanitizer.ts` - Feed name sanitization for safe checkpoint path construction
  - `index.ts` - Public exports
- `src/integrations/bsky/index.ts` - Public exports

### CalDAV Integration
CalDAV calendar access with per-user credential management:
- `src/integrations/caldav/types.ts` - Calendar domain types (CalendarEvent, CalendarInfo, CalDAVCredentials)
- `src/integrations/caldav/errors.ts` - CalDAV error hierarchy
- `src/integrations/caldav/client.ts` - CalDAV client via tsdav (event queries, calendar listing, recurring event expansion)
- `src/integrations/caldav/formatter.ts` - Calendar event formatting with multi-timezone display
- `src/integrations/caldav/calendar-commands.ts` - Discord slash commands for calendar credential management (/calendar add, /calendar list, /calendar remove, /calendar select)
- `src/integrations/caldav/calendar-registry/` - Per-user calendar DynamoDB registry
  - `types.ts` - Registry types and Zod schemas
  - `backend.ts` - DynamoDB CRUD for per-user calendar credentials
  - `key-generator.ts` - DynamoDB key construction for calendar registry
  - `resolve.ts` - Calendar registry resolution utilities
  - `index.ts` - Public exports
- `src/integrations/caldav/index.ts` - Public exports

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
  - `sigmoid.ts` - `sigmoidScore()` function combining access frequency (sigmoid activation) and recency (exponential decay) into a priority score
  - `reconciliation/` - Tag index reconciliation with three phases: completeness (A), orphan cleanup (B), count verification (C)
    - `types.ts` - Reconciliation config, state, and result types
    - `reconciler.ts` - Three-phase reconciler implementation
    - `scheduler.ts` - `createReconciliationScheduler` interval-based scheduler with abort support and test mode
    - `index.ts` - Public exports
  - `index.ts` - Public exports

### Storage Subsystem
DynamoDB integration and data access layer:
- `src/storage/client.ts` - DynamoDB client factory
- `src/storage/dynamo-retry.ts` - Retry logic for DynamoDB operations
- `src/storage/index.ts` - Public exports
- `src/storage/repositories/` - Data access repositories
  - `base.ts` - Base repository with common CRUD operations
- `src/storage/task-session/` - Claude Agent SDK session ID persistence
  - `types.ts` - `SessionId` branded type and `TaskSessionItem` DynamoDB record
  - `backend.ts` - `TaskSessionBackend` singleton pattern for storing/retrieving the current agent session ID
  - `index.ts` - Public exports
- `src/storage/utils/` - Storage utilities
  - `strip-keys.ts` - Utility to strip DynamoDB internal keys
  - `index.ts` - Public exports

### Contacts Storage
Cross-platform address book with identity resolution:
- `src/storage/contacts/types.ts` - Contact types and Zod schemas (ContactRecord, ContactIdentifier, PlatformType)
- `src/storage/contacts/key-generator.ts` - DynamoDB key construction for contacts (PK/SK, CONTACT_LOOKUP GSI)
- `src/storage/contacts/backend.ts` - DynamoDB CRUD for contacts with cross-platform identifier lookup
- `src/storage/contacts/utils.ts` - Contact utility functions
- `src/storage/contacts/find-or-create.ts` - Find-or-create contact resolution logic
- `src/storage/contacts/index.ts` - Public exports
- `src/storage/person-allowlist.ts` - Person-ID-based allowlist with DynamoDB backend, reverse-map identifier resolution, and in-memory cache

### Application Composition Root
Factory functions that wire together all subsystem components:
- `src/app/storage-layer.ts` - `createStorageLayer` factory creating DynamoDB client, memory backend, task persistence coordinator, and optional reconciliation scheduler
- `src/app/discord-infrastructure.ts` - `createDiscordInfrastructure` factory creating Discord client, channel registry, message history chain, inbox system, and bot state manager
- `src/app/context-layer.ts` - `createContextLayer` factory creating context builder and event delta tracker for memory-aware agent operation
- `src/app/mcp-servers.ts` - `createMCPServers` factory creating memory, Discord, and inbox MCP server configurations
- `src/app/catchup-signal-adapter.ts` - `createCatchUpSignalAdapter` adapter persisting catch-up completion and in-progress signals via memory tool backend
- `src/app/identity-loader.ts` - `loadIdentityContext` helper loading bot identity from memory for presence status generation
- `src/app/index.ts` - Public exports

### Services Layer
Service infrastructure for resilience and lifecycle management:
- `src/services/types.ts` - Service types and interfaces
- `src/services/health-registry.ts` - Service health monitoring with registration and status tracking
- `src/services/reconnection-loop.ts` - Reconnection handling with exponential backoff for external services
- `src/services/lifecycle-orchestrator.ts` - Application lifecycle management (startup sequencing, graceful shutdown)
- `src/services/outbox/` - Reliable message delivery (outbox pattern)
  - `types.ts` - Outbox item types and schemas
  - `backend.ts` - DynamoDB outbox storage
  - `drainer.ts` - Outbox message drainer with retry
  - `key-generator.ts` - Outbox DynamoDB key construction
  - `index.ts` - Public exports
- `src/services/approval-saga/` - Distributed approval workflow orchestration
  - `types.ts` - Saga types and state machine definitions
  - `backend.ts` - Saga persistence in DynamoDB
  - `executor.ts` - Saga executor for multi-step approval workflows
  - `index.ts` - Public exports
- `src/services/allowlist-saga/` - Multi-step allowlist addition workflow
  - `types.ts` - Allowlist saga state machine types and schemas
  - `backend.ts` - DynamoDB persistence for saga state with TTL and optimistic concurrency
  - `executor.ts` - Saga executor: start, submitName, confirmMatch, skipMatch, createNew, cancel
  - `starter.ts` - `AllowlistSagaStarter` interface for dependency inversion
  - `index.ts` - Public exports
- `src/services/index.ts` - Public exports

### Error Hierarchy
Centralized error classes for all Isambard operations:
- `src/errors/base.ts` - `IsambardError` base class with `code: ErrorCode` and typed `context` bag
- `src/errors/codes.ts` - `ErrorCode` enum with all error codes (storage, memory tool, reconciliation, Discord, channel registry, presence, state, utility, email, bsky, caldav, contacts)
- `src/errors/storage.ts` - `StorageError` subtree (ItemNotFoundError, ValidationError, DynamoTimeoutError, ContactNotFoundError, ContactLastIdentifierError, MemoryToolError and subclasses, ReconciliationError)
- `src/errors/discord.ts` - `DiscordError` subtree (InvalidTokenError, PermissionError, ChannelNotFoundByIdError, RateLimitError, MessageFetchError, InvalidSnowflakeError, ChannelRegistryError subclasses, PresenceError, TransitionError)
- `src/errors/utils.ts` - `PathSecurityError` for file path security validation failures
- `src/errors/index.ts` - Public exports
- `src/errors/README.md` - Error hierarchy diagram, naming conventions, extension guidelines, and usage patterns

### Configuration Subsystem
Zod-validated configuration loading with env-var for type-safe environment variable parsing:
- `src/config/schemas.ts` - Zod schemas for configuration validation (includes Bluesky config: `BSKY_HANDLE`, `BSKY_APP_PASSWORD`, `BSKY_SERVICE_URL`)
- `src/config/loader.ts` - Configuration loader with environment variable support
- `src/config/retry-config.ts` - Retry configuration constants
- `src/config/index.ts` - Public exports

### Utilities
- `src/utils/time.ts` - Time utilities (formatRelativeTime, getTimeOfDay, getCurrentTimeContext, formatShortRelativeTime, formatMemoryTimestamp, formatTimeHeader)
- `src/utils/filename.ts` - `sanitizeFilename` (strips unsafe chars and path traversal) and `deduplicateFilename` (adds counter suffix to avoid name collisions)
- `src/utils/path-validator.ts` - `validateFilePath`/`validateFilePaths` security checks (CWD containment, no symlinks, file-only)
- `src/utils/text.ts` - `truncateToWordBoundary` for status length limiting; `HARD_MAX_STATUS_LENGTH` constant
- `src/utils/safe-async-handler.ts` - `safeAsyncHandler` wrapper converting async event handlers to void-returning functions with error logging
- `src/utils/index.ts` - Public exports
- `src/utils/strip-dynamo-keys.ts` - Strip DynamoDB internal keys from response items
- `src/utils/retry/` - Retry utilities with exponential backoff
  - `types.ts` - Retry configuration types
  - `classifier.ts` - Error classification for retry decisions
  - `delay.ts` - Exponential backoff delay calculation
  - `retry-async.ts` - Retry wrapper for async functions
  - `retry-async-generator.ts` - Retry wrapper for async generators
  - `defaults.ts` - Default retry configuration values
  - `index.ts` - Public exports

### Media Processing
Video and audio analysis utilities:
- `src/utils/media/types.ts` - Media types and interfaces
- `src/utils/media/fetcher.ts` - Media file fetching from URLs
- `src/utils/media/converters/` - Format conversion utilities
  - `heic.ts` - HEIC/HEIF to PNG conversion using heic-convert
  - `index.ts` - Public exports
- `src/utils/media/video/` - Video processing pipeline
  - `processor.ts` - Main video processor orchestrating analysis pipeline
  - `downloader.ts` - Video downloading from URLs
  - `frame-extractor.ts` - Frame extraction at intervals or scene changes
  - `scene-detector.ts` - Scene change detection via ffmpeg
  - `metadata.ts` - Video metadata extraction (duration, resolution, codec)
  - `spectrogram.ts` - Audio spectrogram generation
  - `subtitle-extractor.ts` - Subtitle/transcript extraction
  - `spawn-runner.ts` - ffmpeg/ffprobe process runner
  - `markdown-builder.ts` - Video analysis markdown output builder
  - `types.ts` - Video processing types
  - `index.ts` - Public exports
- `src/utils/media/index.ts` - Public exports

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
- **Barrel Export Policy** — barrel `index.ts` files conservatively export only the public API that other modules need. Do not over-export; each module controls its cross-module API surface via the barrel. Run `bun dead-code` (knip) to verify no unused exports accumulate.
- **Import Conventions** — production code crosses module boundaries only via barrel imports (`@/agent`, `@/integrations/discord`). Tests may import directly from source files (`@/agent/perch/schedule`, `@/integrations/discord/state/types`) to access internal implementation details without inflating barrel exports.
- **@internal JSDoc Tags** for marking implementation-only exports
- **Per-Tag Atomic Counters** replacing centralized tag registry for race-condition-free tag counting
- **Sigmoid Memory Scoring** — `sigmoidScore()` combines access frequency with recency decay for state memory prioritization in `getAutoLoadItems`
- **Tags as StringSet** — DynamoDB StringSet (SS) type with `Set<string>` in TypeScript throughout; MCP boundary converts JSON arrays to Sets
- **Type Guards and Factory Functions** for branded types — `createLayerName()`, `createContentType()`, `isLayerName()`, `isContentType()` replace unsafe `as` casts with runtime-validated factories
- **Class-Based Components** — `EventDeltaTracker`, `AnswerClassifier`, `StreamTracker`, `QuestionRegistry`, `DiscordRateLimiter`, `PresenceManager`, `MessageCoordinator`, `BotStateManagerImpl` use proper TypeScript classes with private fields instead of closure-based factories
- **Background Task Auto-Resume** — `StreamTracker` counts background task launches vs `TaskOutput` collections; `handleInput` auto-resumes (max 1 attempt) when uncollected tasks detected, preserving initial response on failure
- **Person-Based Allowlists** — `PersonAllowlist` in `src/storage/person-allowlist.ts` provides person-ID-based allowlist with reverse-map identifier resolution, replacing per-platform raw address/handle allowlists
- **Allowlist Saga** — Multi-step Discord interaction flow in `src/services/allowlist-saga/` for adding contacts to allowlist from approval buttons
- **Per-User Calendar Registry** — CalDAV credentials stored per-user in DynamoDB via Discord `/calendar` commands, not SST secrets
- **Service Health Monitoring** — `HealthRegistry` tracks service status; `ReconnectionLoop` handles auto-reconnect with backoff
- **Outbox Pattern** — Reliable message delivery via DynamoDB outbox with background drainer for eventual consistency
- **Cross-Platform History Injection** — `PersonHistoryCoordinator` aggregates history from platform-specific providers (Discord, Email, Bluesky) keyed by contact identity
- **Activity Auto-Logging** — `ActivityLogger` records cross-platform interactions for context awareness

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
