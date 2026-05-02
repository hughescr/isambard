# Isambard Architecture

Isambard is a self-improving agentic thought partner built on the Claude Agent SDK, TypeScript, and Bun. It follows a layered architecture with a single composition root (`src/app/`) that wires subsystems together; all external I/O goes through platform integrations that map at the boundary into platform-agnostic agent types. The runtime working directory is `scratch/`, which is a separate live git repo — production code lives only in `src/`.

## Module Map

| Module | Responsibility | Layer |
|---|---|---|
| `src/utils/` | Pure utilities: time, text, filename, path security, retry, media processing. No domain knowledge. | Foundation |
| `src/errors/` | Centralized error hierarchy (`IsambardError` base, `StorageError` and `DiscordError` subtrees, `ErrorCode` enum). | Foundation |
| `src/config/` | Zod-validated configuration loading from environment variables. | Foundation |
| `src/storage/` | DynamoDB client, repository base, memory tool subsystem, contacts, person allowlist, task session persistence. | Data |
| `src/services/` | Resilience infrastructure: health registry, reconnection loop, lifecycle orchestrator, outbox, approval saga, allowlist saga. | Infrastructure |
| `src/agent/` | Platform-agnostic Claude agent: MCP servers, perch scheduler, answer classifier, question registry, stream tracker, context builder, history providers. | Agent |
| `src/integrations/discord/` | Discord bot: state machine, channel registry, inbox, catch-up, presence, message history, attachments, slash commands. | Integration |
| `src/integrations/email/` | WildDuck HTTP API client with SSE push, outbound approval workflow, rate limiter. | Integration |
| `src/integrations/bsky/` | AT Protocol client: feeds, posts, DMs, social graph, checkpoint tracking, rejection backend. | Integration |
| `src/integrations/caldav/` | CalDAV client (tsdav), per-user credential registry, calendar slash commands. | Integration |
| `src/app/` | Composition root: factory functions that wire all subsystems together. | Composition |

## Layering

Import direction runs strictly from higher layers toward lower ones. The enforced dependency order, from most independent to most dependent:

```
utils  →  errors  →  config  →  storage
                              →  services  →  storage
                                           →  agent  →  storage, services, email, bsky, caldav
                                                     →  discord  →  agent, email, bsky, caldav, storage, services
                                                                 →  app  (composition root, imports everything)
```

The composition root (`src/app/`) is the only module allowed to import from all layers simultaneously. It contains six factory functions: `createStorageLayer`, `createDiscordInfrastructure`, `createContextLayer`, `createMCPServers`, `createCatchUpSignalAdapter`, and `loadIdentityContext`. These construct subsystems and inject their dependencies rather than letting subsystems find each other.

Platform integrations (Discord, Email, Bluesky) each own their own setup concerns. Discord is the hub for approval UI (buttons, modals) and routes approvals back to email and Bluesky outbound handlers. CalDAV is independent of the agent module — it provides data but does not call agent APIs.

`src/agent/` does not import from `src/integrations/discord/`. The Discord integration calls into the agent, never the reverse. Boundary mapping — translating Discord-specific types to the agent's `MessageContext`/`PlatformImage` — happens in `src/integrations/discord/setup/coordinator-setup.ts`.

## Module Boundaries

Boundaries are enforced by two complementary mechanisms.

**`eslint-plugin-boundaries`** (`eslint-boundaries.config.mjs`) implements the layering table above as a lint rule with `default: 'disallow'`. Every allowed import direction is an explicit rule; anything not listed is an error. The same config also enforces entry-point discipline: production code crossing a module boundary must import from the barrel (`index.ts`), not from internal files. This is the `!index.ts` catch-all disallow rule.

**`@hughescr/eslint-plugin-module-boundaries`** adds three finer-grained rules:
- `no-internal-in-barrel` — barrel `index.ts` files must not re-export symbols tagged `@internal`.
- `no-cross-module-internal` — production code must not import an `@internal`-tagged symbol from a different architectural module.
- `no-star-export-from-non-barrel` — barrel files must not `export *` from a non-barrel source file (star-exports from another `index.ts` are allowed).

**`@internal` JSDoc tags** mark symbols that are implementation details — exported for intra-module use (e.g., sub-directory to parent directory), but not part of the public cross-module API.

**Barrel export policy**: each `index.ts` conservatively exports only what other modules actually need. Over-exporting is caught by `bun dead-code` (knip). Tests may bypass the barrel and import directly from source files to access internals without inflating the public API surface.

## Data Layer

All persistent state lives in a **single DynamoDB table** with PK/SK primary key and two GSIs:

- **GSI1** (`GSI1PK` / `GSI1SK`): layer-and-time index, used for memory layer queries and time-range scans.
- **GSI2** (shared partition space): multiple unrelated subsystems share this GSI using non-overlapping partition key prefixes. Known GSI2 partitions:
  - Channel registry items — partitioned by guild ID.
  - Tag index items — partitioned as `TAG#<tagname>`.
  - Contact lookup rows — partitioned as `CONTACT_LOOKUPS`.

**Memory tool** (`src/storage/memory-tool/`) implements a three-layer memory architecture exposed to the agent via MCP:
- `/identity/` — Long-lived self-knowledge, no TTL, auto-loaded every session.
- `/state/` — Working state, no TTL, selectively auto-loaded via sigmoid scoring.
- `/events/` — Time-stamped event log, TTL-based expiry, not auto-loaded.
- `/users/{userId}/` — Per-user memory, keyed by person ID.

Auto-loading of `/state/` items uses `sigmoidScore()`, which combines access frequency (sigmoid activation) and recency (exponential decay) to prioritize what gets injected into context. The tag index uses per-tag atomic counters (`META_COUNT`) and fat-pointer items that carry content preview data, avoiding a centralized registry and the race conditions that come with it. A three-phase background reconciler keeps the tag index consistent.

**Contacts** (`src/storage/contacts/`) provide a cross-platform address book. Each contact record holds a set of platform identifiers (Discord user ID, email address, Bluesky handle, etc.). The CONTACT_LOOKUP GSI enables identifier-to-contact resolution without a full scan. A two-phase reconciler handles orphan cleanup and missing-lookup repair.

**Person allowlist** (`src/storage/person-allowlist.ts`) gates outbound writes (email sends, Bluesky posts/DMs) by person ID rather than per-platform raw addresses. A reverse-map resolves any known identifier to its person ID for allowlist checks.

## Agent Subsystem

The agent module is **platform-agnostic**. It receives `MessageContext` objects (text, optional `PlatformImage` attachments) and emits stream events — it has no knowledge of Discord, email, or Bluesky at the type level.

The agent exposes its capabilities to Claude through a suite of **custom MCP servers**: memory (view, store, search, log), Discord message history, email (inbox, send, archive, reply, drafts), Bluesky (feeds, posts, DMs, social graph, rejection management), Discord inbox (unread overview, channel summary), CalDAV (calendar events), contacts (lookup, search, create, update, delete), media processing (video analysis, spectrograms), Wikipedia, and user context.

Supporting machinery within the agent module:
- **Context builder**: assembles the per-turn user message prefix by loading auto-load memory items, perch context (email inbox state, Bluesky DM notifications, rejected posts), and calendar events.
- **AnswerClassifier**: LLM-based (Haiku) classifier that determines whether an incoming message is an answer to a pending question, an interruption, or an unrelated message.
- **QuestionRegistry**: tracks pending questions with timeouts; routes button-interaction answers back to the waiting handler.
- **StreamTracker**: counts background task launches versus `TaskOutput` collections; triggers auto-resume (max one attempt) when uncollected background tasks are detected on the next `handleInput` call.
- **EventDeltaTracker**: surfaces only new events between interactions, avoiding re-injection of already-seen context.
- **PersonHistoryCoordinator**: aggregates cross-platform message history from Discord, Email, and Bluesky providers, keyed by contact person ID.

**Perch system** (`src/agent/perch/`) provides time-based autonomous activity scheduling. A cron-based scheduler uses jitter (cron-parser H option) to trigger perch sessions at graduated suggestion levels depending on the hour. Sessions can be suspended and resumed; a timeout wrap-up prompt is injected when the time slot ends. Perch triggers are deferred when the bot is busy processing a message.

**Agent / skill / plugin definitions** live outside `src/` in `agents-skills-plugins/` (subagent `.md` files, skill directories with `SKILL.md`, and `plugins.json` for marketplace plugins). These are content artifacts, not code. At startup, `src/agent/skill-agent-loader.ts` copies them into `scratch/.claude/agents/` and `scratch/.claude/skills/` so the Claude Agent SDK's auto-discovery picks them up from the runtime working directory.

## Platform Integrations

Each integration in `src/integrations/` owns its full vertical slice: types, errors, client, history provider, and any approval or saga machinery it needs.

**Discord** is the primary operator interface. The bot is a thin orchestrator (`bot.ts`) that delegates to setup modules in `src/integrations/discord/setup/`. The bot state machine (`state/`) tracks operational modes (idle, catching_up, processing_message, perching) with an idle-hub transition pattern, and drives presence status updates and MCP server selection from current state. The channel registry is DynamoDB-backed with write-through cache and supports well-known channels (`general`, `catch-up`, `perch-time`, `fallback`). The inbox system tracks unread messages with checkpoint persistence; the catch-up system drains the backlog on restart.

**Email** uses the WildDuck HTTP API for all operations (read, search, send, flag management, draft upload). SSE push with poll fallback drives real-time inbox notifications. Outbound sends require admin approval via Discord unless the recipient is on the person allowlist. A token-bucket rate limiter (capacity 24, refill 1/hr) prevents send storms. Custom keyword flags use no `\\` prefix — WildDuck HTTP convention, not IMAP.

**Bluesky** wraps `@atproto/api`'s `AtpAgent`. MCP tools expose handles everywhere; DIDs are internal. Outbound replies and DMs flow through an approval workflow with Discord buttons/modals. Admin rejections are persisted to a `BskyRejectionBackend` (DynamoDB, 30-day TTL) and surfaced back to the agent in perch context so it can retry or acknowledge them. Feed and notification consumption is idempotent via a checkpoint manager backed by the memory tool.

**CalDAV** stores per-user credentials in DynamoDB (no global SST secrets). Discord `/calendar` slash commands manage credentials. The agent accesses calendar data through the `caldav-mcp-server` MCP tool; CalDAV itself does not import from the agent module.

Boundary mapping between Discord-specific types and the agent's platform-agnostic types happens in `src/integrations/discord/setup/coordinator-setup.ts`. The other platform setups (`email-setup.ts`, `bsky-setup.ts`, etc.) handle their own initialization and wire approval callbacks back into the Discord approval infrastructure.

## Services Layer

`src/services/` provides resilience and workflow infrastructure:

- **HealthRegistry**: registers named services and tracks their health status for observability.
- **ReconnectionLoop**: wraps external service connections with exponential-backoff auto-reconnect.
- **LifecycleOrchestrator**: sequences startup (in dependency order) and graceful shutdown.
- **Outbox pattern** (`services/outbox/`): DynamoDB-backed reliable message delivery with a background drainer and retry, ensuring eventual delivery even across restarts.
- **ApprovalSaga** (`services/approval-saga/`): distributed approval workflow for multi-step, stateful human-in-the-loop decisions persisted in DynamoDB.
- **AllowlistSaga** (`services/allowlist-saga/`): multi-step Discord UI flow (button → modal → confirm) for adding a contact to the person allowlist, with DynamoDB state and optimistic concurrency.

## Cross-Cutting Patterns

- **Repository pattern**: all DynamoDB access goes through typed backend classes with a common base; no ad-hoc SDK calls in business logic.
- **Dependency injection**: subsystems receive their dependencies as constructor arguments or factory parameters, never via module-level singletons.
- **Zod schemas**: all external data (config, DynamoDB records, MCP tool arguments, API responses) is validated at the boundary with Zod before entering typed TypeScript.
- **Branded types**: `MemoryPath`, `LayerName`, `ChannelId`, `GuildId`, `UserId`, `MessageId` and others prevent mixing identifiers of different kinds. Factory functions (`createLayerName()`, `createContentType()`) and type guards (`isLayerName()`, `isContentType()`) replace unsafe `as` casts with runtime-validated construction.
- **Class-based components**: `EventDeltaTracker`, `AnswerClassifier`, `StreamTracker`, `QuestionRegistry`, `DiscordRateLimiter`, `PresenceManager`, `MessageCoordinator`, `BotStateManagerImpl` are proper TypeScript classes with private fields.
- **Retry with exponential backoff**: `src/utils/retry/` provides generic async and async-generator retry wrappers with error classification for intelligent retry decisions. Applied to Claude API calls, DynamoDB operations, and Discord API calls.
- **Structured logging**: log entries carry correlation IDs for tracing requests across subsystem boundaries.
- **`assertNever()`**: exhaustiveness helper for discriminated union switches that throws `InvariantViolationError` at runtime if an unhandled variant slips through.
- **Background task auto-resume**: `StreamTracker` detects uncollected background task results and auto-resumes on the next `handleInput` call (max one attempt), preserving the initial response on failure.
- **Activity auto-logging**: `ActivityLogger` records cross-platform interactions automatically for cross-platform context awareness.

## Configuration and Errors

`src/config/` loads all configuration from environment variables using the `env-var` package for type coercion, validated by Zod schemas at startup. Retry constants live in `config/retry-config.ts` and are imported by the retry utilities.

`src/errors/` defines `IsambardError` as the base class for all application errors. It carries a typed `code: ErrorCode` field and a context bag for structured diagnostics. Two main subtrees exist: `StorageError` (DynamoDB, memory tool, contacts, reconciliation errors) and `DiscordError` (channel registry, presence, state transition, permission errors). A separate `PathSecurityError` handles file path validation failures. All error codes are centralized in `ErrorCode` enum in `errors/codes.ts`.
