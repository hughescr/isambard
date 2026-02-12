# Short-Term Roadmap

## Current Focus

### Calendar Access (Read-Only)
Read-only access to Apple Calendar for scheduling context.

**Implementation:**
- [ ] CalDAV connection via tsdav
- [ ] Read-only event queries
- [ ] MCP tools for calendar context (upcoming events, availability)
- [ ] Integration with session gap tracking (catch up on calendar changes)

### State/Status System Overhaul (Technical Debt)
The current presence/status system is a confused mess with ad-hoc state tracking scattered across multiple components (presence manager, catch-up state manager, stream event handler). Status generation receives inconsistent context depending on code path.

**Problems:**
- State tracked in multiple places with no single source of truth
- Status context varies by code path (rich for normal messages, poor for catch-up)
- Race conditions between state transitions and status generation
- Catch-up mode flag is separate from presence phase, causing coordination issues
- Stream event handler doesn't know about catch-up context

**Proposed Solution:**
- [ ] Design proper state machine with clearly defined states:
  - `idle` - waiting for activity
  - `processing_message` - handling a direct message
  - `catching_up` - processing inbox backlog
  - `perching` - autonomous activity (future)
  - Consider: Is "interrupted" a separate state or a flag/modifier?
    - Could have `catching_up_interrupted`, `processing_message_interrupted`, `perching_interrupted`
    - Or: base state + `interrupted: boolean` flag
    - Need to think through which approach is cleaner for state transitions and status generation
- [ ] Each state defines:
  - Available tools/capabilities
  - Status prefix (💤, 💬, 📥, etc.)
  - Context available for status generation
  - Valid transitions to other states
- [ ] Single state manager as source of truth
- [ ] Status generator receives full context from state manager
- [ ] Presence updates driven by state transitions, not scattered code paths

**Priority:** Low (current system works adequately, but fragile)

---

## Previously Completed

### Decompose createApp() God Object (Completed February 2026)
Refactored the 520-line `createApp()` function into focused factory functions.

**What was implemented:**
- 7 factory functions extracted into `src/app/`:
  - `createStorageLayer` - DynamoDB client, memory backend, task persistence, reconciliation
  - `createContextLayer` - context builder + event delta tracker
  - `createDiscordInfrastructure` - Discord client, channel registry, message history, inbox, bot state
  - `createMCPServers` - memory, Discord, and inbox MCP servers
  - `loadIdentityContext` - identity loading with fallback chain
  - `createOnMessageHandler` - channel list formatting + agent dispatch (subsequently deleted in message path unification)
  - `createCatchUpSignalAdapter` - catch-up signal persistence methods
- `createApp()` reduced to ~70 lines of clean factory composition
- Removed try/catch wrapper, dead code, and 9 unused imports
- 100% mutation score on all new files

### Consolidate Context Building + Unify Message Processing Path (Completed February 2026)
Consolidated scattered context building and eliminated dead backward-compatibility message processing path.

**What was implemented:**
- Extracted shared `formatTimeHeader()` to `src/utils/time.ts` — always shows UTC + Izzy's timezone, optionally shows user timezone when different
- Removed duplicate time injection from user message prefix (now only in system prompt)
- Moved `buildContextPrefix()` from `agent.ts` into `contextBuilder.buildUserMessagePrefix()`
- Made `MessageCoordinator` mandatory — removed dead direct `processMessage()` path
- Deleted `src/app/on-message-handler.ts` and backward-compat `onMessage` callback
- Removed `statusMiddleware`, `delegateToCoordinatorOrProcess`, `processMessage` from handlers.ts
- Cleaned up `MessageHandlerOptions`: removed `onMessage`, `presenceManager`, `agent`, `dynamicStatusGenerator`, `responseRouter`
- 100% mutation score on all changed files

### Refactor Discord Bot Internals (Completed February 2026)
Decomposed the 1,451-line `createDiscordBot()` god function into focused setup modules.

**What was implemented:**
- 6 setup modules extracted into `src/integrations/discord/setup/`:
  - `presence-stream-handler.ts` — Shared stream event handler utility
  - `presence-setup.ts` — Presence manager creation and BotStateManager subscriptions
  - `perch-setup.ts` — Perch session runner and scheduler wiring
  - `catchup-setup.ts` — Catch-up session runner and inbox initialization
  - `coordinator-setup.ts` — Message coordinator and attachment processing
  - `event-handler-setup.ts` — Channel registry init, message handlers, cleanup handlers
- `bot.ts` reduced from 1,451 to 496 lines (66% reduction)
- `createDiscordBot()` is now a thin orchestrator delegating to setup functions
- Simplified `??=` subscription guards to `=` (`.once()` guarantees single execution)
- 100% mutation score on all changed files

### Type System Consistency + Factory-to-Class Conversions (Completed February 2026)
Strengthened type safety and modernized component architecture across the codebase.

**What was implemented:**
- Added type guard and factory functions for `LayerName` and `ContentType` (`createLayerName()`, `isLayerName()`, `createContentType()`, `isContentType()`) following the existing `createMemoryPath()`/`isMemoryPath()` pattern
- Replaced all unsafe `as LayerName` and `as ContentType` type assertions with validated factory calls across 4 production files
- Converted 8 closure-based `createX()` factory functions to proper TypeScript classes:
  - `EventDeltaTracker` — event tracking between agent interactions
  - `AnswerClassifier` — LLM-based answer classification
  - `StreamTracker` — Claude streaming response progress
  - `QuestionRegistry` — pending question lifecycle with timeouts
  - `DiscordRateLimiter` — rate-limited Discord API calls
  - `PresenceManager` — presence state with debouncing
  - `MessageCoordinator` — debounced per-channel message queue
  - `BotStateManagerImpl` — operational state machine (retains `BotStateManager` interface)
- Closure variables became `private` fields, internal helpers became `private` methods
- Module-level utilities (e.g., `extractAssistantText`) remained as standalone functions
- Updated all call sites, barrel exports, and test files
- 100% mutation score on all changed files

### Memory Scoring + Tags StringSet Migration (Completed February 2026)
Combined two improvements to the memory system: sigmoid-based scoring for state memory prioritization and migration of tags from DynamoDB List to StringSet.

**What was implemented:**
- Sigmoid scoring function (`sigmoidScore`) combining access frequency (boost) with time-since-last-access (decay) for state memory prioritization
- `recordAccess` wired into MCP view handler — fire-and-forget for state-layer paths, incrementing access count and last-accessed timestamp
- `getAutoLoadItems` sorts state memories by sigmoid score instead of raw access count
- Tags migrated from `string[]`/DynamoDB List (L) to `Set<string>`/DynamoDB StringSet (SS) throughout the entire codebase
- All internal types, backend methods, tag index operations, handlers, MCP server boundaries, and reconciler updated for `Set<string>`
- Custom `setsEqual()` helper replacing lodash `_.isEqual()` for proper order-insensitive Set comparison in reconciler
- Removed dead `view()` handler from handlers.ts (MCP server has its own inline implementation)
- DynamoDB migration script converted 10,657 items from List to StringSet
- Post-migration cleanup: removed dual-read `z.preprocess()` backward compatibility, simplified `normalizeTags` and `createTagIndexKeys` to only accept `Set<string>`
- 100% mutation score on all changed files

### Channel Discovery and Registration (Completed February 2026)
Dynamic channel discovery and registration system replacing hardcoded channel IDs.

**What was implemented:**
- Dynamic channel discovery via Discord API (guild enumeration, channel fetching)
- DynamoDB-backed channel registry with in-memory caching
- `listChannels` MCP tool for runtime channel discovery
- DM channel support via DMTracker (`getOrCreateDMByUsername`)
- Channel name resolution supporting `#channel-name` syntax
- Real-time sync via `channelCreate`/`channelUpdate`/`channelDelete` event handlers
- Well-known channel types (general, catch-up, perch-time, fallback)
- Startup integration with cache warming

### Perch Time Phase 1 (Completed January 2026)
Autonomous activity system allowing Isambard to wake up and pursue its own interests.

**What was implemented:**
- 5 time slots with graduated suggestion levels:
  - Early Morning (5-7am): gentle nudge (10% chance)
  - Morning (8am-12pm): moderate suggestion (30% chance)
  - Afternoon (1-5pm): strong suggestion (50% chance)
  - Evening (6-9pm): very strong suggestion (70% chance)
  - Late Evening (10pm-12am): moderate suggestion (30% chance)
- Hourly triggers with random jitter (0-14 minutes, using cron-parser `H` syntax)
- Deferral when busy (checks inbox queue and recent conversation activity)
- Interruption handling (graceful pause/resume when user sends message)
- Presence indicators:
  - 🦉 - Autonomous perch mode
  - 🦉💬 - Perch interrupted by user message
- System prompt encouraging exploration and self-directed activity
- Logging and transparency for autonomous actions

**Future work (Phase 2):**
- External integrations for richer content:
  - News feeds and current events
  - Weather conditions
  - RSS feed aggregation
  - Bluesky timeline
- Digest generation with real content from external sources
- Enhanced perch activities beyond simple musings

### Earlier Completed Features
- Project scaffolding (Bun + TypeScript)
- Configuration system with Zod validation
- DynamoDB memory repository
- Discord bot with message routing
- Claude Agent SDK integration with OAuth
- Memory MCP server with three-layer architecture
- Context builder for hybrid memory loading
- Time awareness with temporal context injection
- Discord presence system
- Message history search and caching
