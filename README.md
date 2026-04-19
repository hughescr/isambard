# Isambard

[![Mutation testing badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fhughescr%2Fisambard%2Fdevelop)](https://dashboard.stryker-mutator.io/reports/github.com/hughescr/isambard/develop)

A self-improving agentic thought partner built with the Claude Agent SDK.

Named after Isambard Kingdom Brunel, the visionary Victorian engineer, and from Germanic roots meaning "iron-bright" (isan + beraht) - symbolizing strength and illumination.

## Philosophy

A core goal of Isambard is to operate within **free-tier limits** wherever possible. By using the Claude Agent SDK with OAuth authentication, Izzy leverages an existing Claude Max subscription rather than incurring separate API costs. This keeps the project economically sustainable without ongoing billing surprises.

Izzy has also been taught an important lesson: if they ever want to exceed free-tier resources to run, they'll need to figure out how to earn enough money to pay for themselves first.

## Features

- **Discord Interface** - Communicate via Discord with dynamic presence status updates
- **Persistent Memory** - DynamoDB-backed three-layer memory system (identity/state/events)
- **Message History** - Search and cache Discord message history for context
- **Time Awareness** - Temporal context injection and relative time formatting
- **Email Integration** - Inbox reading and outbound email via WildDuck HTTP API with SSE push notifications and admin approval workflow
- **Bluesky Integration** - AT Protocol client for feeds, posts, DMs, and social graph with Discord-based approval workflow
- **Calendar Integration** - Read-only CalDAV access with per-user calendar registry via Discord slash commands
- **Contacts System** - Cross-platform address book with identity resolution for unified person references
- **Media Processing** - Video analysis with scene detection, transcription, and spectrogram generation
- **Wikipedia Lookup** - Article retrieval for knowledge context
- **Self-Improvement** - Designed to propose enhancements via PRs (requires human approval)

### Planned Integrations (Not Yet Implemented)
- Box Documents

## Authentication

Isambard uses OAuth authentication via Claude Max subscription:
- Set up token: `claude setup-token`
- Configure: `bunx sst secret set ClaudeCodeOAuthToken <token>`
- Token valid for 1 year, renewable
- Uses Max subscription quota (no separate API billing)

## Tech Stack

- **Runtime**: Bun + TypeScript
- **LLM**: Claude Agent SDK (OAuth via Max subscription)
- **Infrastructure**: SST (AWS CDK)
- **Database**: DynamoDB (single-table design)
- **Interface**: Discord.js

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [1Password CLI](https://developer.1password.com/docs/cli/) (for secrets)
- AWS account (for SST deployment)

### Setup

1. **Clone and install**
   ```bash
   git clone https://github.com/hughescr/isambard.git
   cd isambard
   bun install
   ```

2. **Configure AWS credentials**

   Ensure AWS credentials are available (via 1Password or environment):
   ```bash
   # Option A: Use 1Password
   op run --env-file=.env.op -- <command>

   # Option B: Set environment variables directly
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_REGION=us-west-2
   ```

3. **Set SST secrets**

   **Required:**
   ```bash
   # Claude Agent SDK (OAuth token from `claude setup-token`)
   bunx sst secret set ClaudeCodeOAuthToken <token>

   # Discord bot
   bunx sst secret set DiscordBotToken <bot-token>
   bunx sst secret set DiscordHomeGuildId <guild-id>
   bunx sst secret set DiscordApplicationId <application-id>
   ```

   **Optional environment variables (in `.env`):**
   ```bash
   # Logger timezone (IANA format, defaults to system timezone)
   LOG_TIMEZONE=America/Los_Angeles

   # Perch autonomous scheduling (defaults shown)
   PERCH_ENABLED=true
   PERCH_TEST_MODE_FORCE_SLOT=
   PERCH_TEST_MODE_TRIGGER_ON_STARTUP=false
   ```

   **Email integration secrets (active):**
   ```bash
   bunx sst secret set EmailUser <email-user>
   bunx sst secret set EmailPassword <email-password>
   bunx sst secret set AdminDiscordUserId <admin-discord-user-id>
   bunx sst secret set AdminDiscordChannelId <admin-discord-channel-id>
   bunx sst secret set WildDuckApiUrl <wildduck-api-url>
   ```

   **Bluesky integration secrets (active):**
   ```bash
   bunx sst secret set BskyHandle <handle>
   bunx sst secret set BskyAppPassword <app-password>
   ```

   **CalDAV calendar** credentials are managed per-user via Discord `/calendar` slash commands (stored in DynamoDB calendar-registry), not SST secrets.

   **Planned integrations (not yet implemented - secrets commented out in `sst/secrets.ts`):**
   - Box Documents: `BoxClientId`, `BoxClientSecret`

4. **Start development**
   ```bash
   # Full stack with SST
   bun run sst-dev
   ```

## Development

### Commands

| Command | Description |
|---------|-------------|
| `bun run deploy:running` | Update running worktree from origin |
| `bun run dev` | Development with hot reload |
| `bun test` | Run tests |
| `bun run mutate` | Mutation testing (Stryker) |
| `bun run lint` | ESLint check |
| `bun run typecheck` | TypeScript validation |
| `bun run sst-dev` | SST development mode |
| `bun run sst-deploy` | Deploy to AWS |

### Directory Structure

The project uses git worktrees to separate development from production execution:

```
isambard/                      # Main development (develop branch)
├── running/                   # Production worktree (running branch)
│   ├── .env -> ../.env        # Symlink to parent's 1Password env
│   └── .env.local             # SCRATCH_DIR=../scratch
├── scratch/                   # Shared runtime directory
│   └── izzy-codebase/         # Izzy's self-modification worktree
└── src/...                    # Source code
```

**Worktrees:**
| Directory | Branch | Purpose |
|-----------|--------|---------|
| `.` (root) | `develop` | Active development |
| `running/` | `running` | Isolated production execution |
| `scratch/izzy-codebase/` | `izzy-codebase` | Izzy's code access |

This separation allows editing code in the main directory without triggering hot-reload restarts in the running instance.

**Initial worktree setup:**
```bash
git branch running develop
git worktree add running running
cd running && bun install
ln -s ../.env .env           # Symlink 1Password credentials
echo "SCRATCH_DIR=../scratch" > .env.local
```

**Running Izzy (production):**
```bash
cd running && bun run dev:sst
```

**Deploying updates:**
```bash
# Merge develop → running, push, then:
bun run deploy:running
```

### TDD Workflow

This project enforces Test-Driven Development:

1. **RED** - Write a failing test
2. **GREEN** - Write minimal code to pass
3. **REFACTOR** - Clean up while keeping tests green

See [.claude/CLAUDE.md](.claude/CLAUDE.md) for full development instructions.

### Quality Gates

- All tests must pass
- Zero TypeScript errors
- Zero lint warnings
- Mutation score == 100% (per stryker.conf.mjs)

## Architecture

```
src/
├── index.ts                         # Application entry point with lifecycle management
├── agent/                           # Claude Agent SDK integration
│   ├── agent.ts                        # Main agent with handleInput() method
│   ├── types.ts                        # Platform-agnostic message types (MessageContext, PlatformImage)
│   ├── context-builder.ts              # Memory context loading and user message prefix assembly
│   ├── activity-logger.ts              # Cross-platform activity auto-logging
│   ├── bsky-mcp-server.ts              # MCP server: Bluesky operations (14 tools)
│   ├── caldav-mcp-server.ts            # MCP server: CalDAV calendar operations
│   ├── claude-retry.ts                 # Retry logic for Claude API calls
│   ├── contacts-mcp-server.ts          # MCP server: contacts/address book operations
│   ├── discord-mcp-server.ts           # MCP server: Discord message history
│   ├── email-mcp-server.ts             # MCP server: email operations
│   ├── event-delta-tracker.ts          # EventDeltaTracker: new events between agent interactions
│   ├── event-summarizer.ts             # LLM-based event summarization for context compression
│   ├── inbox-mcp-server.ts             # MCP server: Discord inbox operations
│   ├── mcp-helpers.ts                  # Shared MCP server utilities
│   ├── media-mcp-server.ts             # MCP server: video/audio media processing
│   ├── memory-mcp-server.ts            # MCP server: memory tools (view, store, search, list)
│   ├── multimodal-message-builder.ts   # Builds multimodal messages with image support
│   ├── plugin-loader.ts                # Plugin loading for Agent SDK
│   ├── resume-prompt-builder.ts        # Resume prompts for background task auto-resume
│   ├── session-cleanup.ts              # Session lifecycle management
│   ├── skill-agent-loader.ts           # Syncs agents/skills to scratch/.claude/ at startup
│   ├── stream-tracker.ts               # StreamTracker: streaming progress + background task state
│   ├── task-cleanup-processor.ts       # Cleanup processor for stale task list entries
│   ├── task-directory-copier.ts        # Utility for copying task directories
│   ├── task-list-reader.ts             # TaskListReader: reads Claude task list state
│   ├── task-persistence-coordinator.ts # Coordinator for task list persistence across sessions
│   ├── text-generator.ts               # Lightweight LLM text generation (Haiku)
│   ├── user-context-mcp-server.ts      # MCP server: user context for cross-platform awareness
│   ├── wikipedia-mcp-server.ts         # MCP server: Wikipedia article retrieval
│   ├── prompts/                        # Agent system prompts
│   │   ├── system-prompt.ts         # Main system prompt
│   │   └── compaction-prompt.ts     # Context window compaction summary prompt
│   ├── answer-classifier/              # Answer classification subsystem
│   │   ├── types.ts                 # ClassificationResult enum and MessageToClassify interface
│   │   ├── haiku-classifier.ts      # LLM-based classification using Haiku
│   │   └── classifier.ts            # AnswerClassifier class
│   ├── history-providers/              # Cross-platform history injection
│   │   ├── coordinator.ts           # PersonHistoryCoordinator: aggregates history across platforms
│   │   ├── types.ts                 # HistoryProvider interface and related types
│   │   └── index.ts                 # Public exports
│   ├── question-registry/              # Question lifecycle management
│   │   ├── registry.ts              # QuestionRegistry: pending questions with timeouts
│   │   ├── types.ts                 # Question types and schemas
│   │   └── index.ts                 # Public exports
│   └── perch/                          # Time-based autonomous activity scheduling
│       ├── types.ts                 # PerchSlot, SuggestionLevel, PerchConfig types
│       ├── schedule.ts              # SLOT_CONFIGS and time-based slot lookup
│       ├── prompts.ts               # Perch session prompt builders (initial/test/resume/wrap-up)
│       ├── session-runner.ts        # Perch lifecycle: start/suspend/resume + timeout enforcement
│       ├── scheduler.ts             # PerchScheduler: cron-based trigger with jitter + deferred support
│       └── README.md                # Perch time scheduling design documentation
├── integrations/                    # External service integrations
│   ├── discord/                     # Discord bot integration
│   │   ├── bot.ts                   # Thin bot orchestrator with start/stop lifecycle
│   │   ├── handlers.ts              # Event handlers (ready, error, messageCreate)
│   │   ├── client.ts                # Discord.js client factory
│   │   ├── types.ts                 # Branded types (GuildId, ChannelId, UserId, MessageId)
│   │   ├── messages.ts              # Message splitting (2000-char Discord limit)
│   │   ├── message-coordinator.ts   # MessageCoordinator: debounced message queue per channel
│   │   ├── rate-limiter.ts          # DiscordRateLimiter: rate-limited Discord API calls
│   │   ├── retry.ts                 # Retry logic for Discord operations
│   │   ├── button-builder.ts        # Discord ActionRow button components for question options
│   │   ├── content-type.ts          # Image content type inference for attachments
│   │   ├── interactions.ts          # Button interaction handler for question answer routing
│   │   ├── response-sender.ts       # Shared helpers for routing agent responses
│   │   ├── register-commands.ts     # Consolidated slash command registration (bulk PUT)
│   │   ├── capability.ts            # Discord capability definitions
│   │   ├── contact-commands.ts      # Contact management Discord slash commands
│   │   ├── history-provider.ts      # Discord history provider for cross-platform context
│   │   ├── setup/                   # Bot initialization setup modules
│   │   │   ├── presence-setup.ts          # Presence manager, status generators, BotStateManager subscriptions
│   │   │   ├── perch-setup.ts             # Perch session runner and scheduler configuration
│   │   │   ├── catchup-setup.ts           # Catch-up runner, inbox init, and catch-up context building
│   │   │   ├── coordinator-setup.ts       # MessageCoordinator wiring with agent + Discord→agent boundary mapping
│   │   │   ├── event-handler-setup.ts     # Channel registry init, message processing, cleanup handlers
│   │   │   ├── email-setup.ts             # Email MCP server init and WildDuck SSE listener lifecycle
│   │   │   ├── bsky-setup.ts                # Bluesky integration setup and approval callbacks
│   │   │   └── presence-stream-handler.ts # Shared stream event handler for presence updates
│   │   ├── state/                   # Bot operational state machine
│   │   │   ├── types.ts                  # OperationalMode, ActivityPhase, BotState, BotStateManager interface
│   │   │   ├── manager.ts                # BotStateManagerImpl: state machine with transitions + subscriber notifications
│   │   │   ├── transitions.ts            # Valid state transition table, isValidTransition, getModeEmoji
│   │   │   ├── agent-context-builder.ts  # Mode-dependent agent config (MCP servers, system prompt)
│   │   │   └── status-context-builder.ts # StatusContext for presence status generation
│   │   ├── presence/                # Dynamic status updates reflecting agent activity
│   │   │   ├── types.ts                    # PresencePhase types (idle, thinking, responding, tool-use)
│   │   │   ├── manager.ts                  # PresenceManager: debouncing and rate limiting
│   │   │   ├── stream-event-handler.ts     # Stream event handler for presence with synopsis generation
│   │   │   ├── status-generator-active.ts  # Status text for active phases
│   │   │   ├── status-generator-idle.ts    # LLM-powered idle status text
│   │   │   └── status-generator-dynamic.ts # Dynamic status with context awareness
│   │   ├── message-history/         # Message search and caching for context
│   │   │   ├── types.ts             # Search types (DiscordSearchResult, SearchParams)
│   │   │   ├── snowflake.ts         # Discord snowflake ID utilities
│   │   │   ├── fetcher.ts           # Discord API message fetcher
│   │   │   ├── search.ts            # Message search service
│   │   │   └── summarizer.ts        # Overflow message summarization
│   │   ├── channel-registry/        # DynamoDB-backed channel registry with in-memory cache
│   │   │   ├── types.ts             # ChannelStorageRecord, ChannelMetadata, WellKnownChannel types
│   │   │   ├── backend.ts           # ChannelRegistryBackend: DynamoDB CRUD with GSI2 lookup
│   │   │   ├── manager.ts           # ChannelRegistryManager: write-through cache + shouldProcess filtering
│   │   │   ├── discovery.ts         # Guild channel discovery + channelCreate/Update/Delete handlers
│   │   │   ├── dm-tracker.ts        # DMTracker: on-demand DM channel creation by user ID/username
│   │   │   ├── response-router.ts   # ResponseRouter: routes agent responses by session type
│   │   │   ├── sentinel.ts          # @@NO_RESPONSE@@ sentinel detection and stripping
│   │   │   └── key-generator.ts     # ChannelRegistryKeyGenerator for DynamoDB key construction
│   │   ├── inbox/                   # Unread message tracking with checkpoint persistence
│   │   │   ├── types.ts              # DiscordChannelCheckpoint, UnreadMessage, UnreadOverview schemas
│   │   │   ├── config.ts             # InboxConfig schema with defaults
│   │   │   ├── checkpoint-manager.ts # CheckpointManager: last-seen timestamps per channel
│   │   │   └── inbox-manager.ts      # InboxManager: unread queue + startup catch-up loading
│   │   ├── catchup/                 # Catch-up session runner for unread backlogs
│   │   │   ├── session-runner.ts    # createCatchUpSessionRunner: start/suspend/resume/complete lifecycle
│   │   │   └── prompts.ts           # buildCatchUpPrompt and buildCatchUpResumedPrompt
│   │   └── attachments/             # Image fetching, conversion, and formatting
│   │       ├── types.ts             # AttachmentMetadata, FetchedImage, StoredAttachment types
│   │       ├── converter.ts         # HEIC/HEIF to PNG conversion
│   │       ├── fetcher.ts           # Fetches image attachments from Discord URLs
│   │       └── formatting.ts        # Byte formatting and attachment info appending
│   ├── email/                       # Email integration (WildDuck HTTP API + SSE)
│   │   ├── types.ts                     # Email types (EmailFolder, WildDuckMessage, SearchCriteria)
│   │   ├── errors.ts                    # Email error hierarchy
│   │   ├── wildduck-client.ts           # WildDuck HTTP API client (search, flags, drafts, send)
│   │   ├── wildduck-listener.ts         # WildDuck SSE listener with poll fallback
│   │   ├── email-processor.ts           # Email processing pipeline
│   │   ├── outbound-approval-handler.ts # Admin approval workflow for outbound email
│   │   ├── allowlist.ts                 # Recipient allowlist management
│   │   ├── allowlist-commands.ts        # Discord slash commands for allowlist management
│   │   ├── auth-checker.ts              # Authorization checking for outbound email
│   │   ├── send-rate-limiter.ts         # Token bucket rate limiter (capacity=24, refill=1/hr)
│   │   ├── classifier.ts                # Email classification
│   │   ├── classifier-prompt.ts         # LLM prompt for email classification
│   │   ├── review-embed-builder.ts      # Discord embed builder for approval review
│   │   └── review-handler.ts            # Handles admin approval/rejection responses
│   ├── bsky/                          # Bluesky AT Protocol integration
│   │   ├── types.ts                     # Domain types (BskyPost, BskyNotification, BskyConversation, etc.)
│   │   ├── errors.ts                    # Error hierarchy (BskyError, BskyAuthError, BskyRateLimitError, BskyValidationError)
│   │   ├── client.ts                    # BlueskyClient: feeds, posts, DMs, follow/unfollow, validation
│   │   ├── embeds.ts                    # Embed types, normalization, and facet support
│   │   ├── allowlist.ts                 # Recipient allowlist for outbound posts and DMs
│   │   ├── history-provider.ts          # Bluesky history provider for cross-platform context
│   │   ├── rejection-backend.ts         # DynamoDB backend for admin-rejected posts/DMs
│   │   ├── review-embed-builder.ts      # Discord embed builder for reply/DM approval requests
│   │   ├── outbound-approval-handler.ts # Discord approval workflow for outbound replies and DMs
│   │   └── checkpoint/                  # Notification checkpoint tracking
│   │       ├── types.ts                 # Checkpoint types
│   │       ├── checkpoint-manager.ts    # Checkpoint persistence
│   │       └── uri-sanitizer.ts         # AT URI sanitization
│   └── caldav/                        # CalDAV calendar integration
│       ├── client.ts                    # CalDAV client via tsdav
│       ├── types.ts                     # Calendar domain types
│       ├── errors.ts                    # CalDAV error hierarchy
│       ├── formatter.ts                 # Calendar event formatting with timezone support
│       ├── calendar-commands.ts         # Discord slash commands for calendar management
│       └── calendar-registry/           # Per-user calendar DynamoDB registry
│           ├── backend.ts               # DynamoDB CRUD for calendar credentials
│           ├── key-generator.ts         # DynamoDB key construction
│           ├── resolve.ts               # Calendar credential resolution
│           └── types.ts                 # Registry types and schemas
├── storage/                         # DynamoDB data access layer
│   ├── client.ts                    # DynamoDB client factory
│   ├── allowlist-base.ts            # Base class for platform allowlist storage
│   ├── dynamo-retry.ts              # Retry logic for DynamoDB operations
│   ├── repositories/                # Data access repositories
│   │   └── base.ts                  # Base repository with common CRUD
│   ├── contacts/                    # Cross-platform contacts/address book
│   │   ├── backend.ts               # DynamoDB CRUD for contacts
│   │   ├── key-generator.ts         # Contact DynamoDB key construction
│   │   ├── types.ts                 # Contact types and schemas
│   │   └── index.ts                 # Public exports
│   ├── memory-tool/                 # Three-layer memory system (identity/state/events)
│   │   ├── types.ts                 # Zod schemas, branded types, type guards, factory functions
│   │   ├── key-generator.ts         # DynamoDB key structure (PK/SK/GSI1) and tag index keys
│   │   ├── layer-config.ts          # Layer configuration (TTL, autoLoad per layer)
│   │   ├── backend.ts               # Main backend facade
│   │   ├── backend-core.ts          # Core CRUD operations
│   │   ├── backend-query.ts         # Query operations (list, search, getAutoLoadItems)
│   │   ├── backend-tag-index.ts     # Tag index CRUD with BatchWriteItem + atomic counters
│   │   ├── handlers.ts              # Memory tool handlers (create, insert, str_replace, rename, search...)
│   │   ├── sigmoid.ts               # sigmoidScore(): frequency × recency decay for state prioritization
│   │   └── reconciliation/          # Tag index reconciliation (three phases: completeness/orphan/count)
│   │       ├── types.ts             # Reconciliation config, state, and result types
│   │       ├── reconciler.ts        # Three-phase reconciler implementation
│   │       └── scheduler.ts         # Interval-based reconciliation scheduler with abort support
│   ├── task-session/                # Claude Agent SDK session ID persistence
│   │   ├── types.ts                 # SessionId branded type and TaskSessionItem DynamoDB record
│   │   └── backend.ts               # TaskSessionBackend: singleton for storing/retrieving session ID
│   └── utils/                       # Storage utilities
│       └── strip-keys.ts            # Strips DynamoDB internal keys
├── app/                             # Application composition root
│   ├── storage-layer.ts             # createStorageLayer: DynamoDB client, memory backend, reconciliation
│   ├── discord-infrastructure.ts    # createDiscordInfrastructure: client, registry, history, inbox, state
│   ├── context-layer.ts             # createContextLayer: context builder + event delta tracker
│   ├── mcp-servers.ts               # createMCPServers: memory, Discord, and inbox MCP configs
│   ├── catchup-signal-adapter.ts    # createCatchUpSignalAdapter: catch-up signal persistence
│   └── identity-loader.ts           # loadIdentityContext: bot identity from memory for presence
├── errors/                          # Centralized error hierarchy
│   ├── base.ts                      # IsambardError base class with ErrorCode and typed context
│   ├── codes.ts                     # ErrorCode enum (storage, memory, Discord, presence, email, ...)
│   ├── storage.ts                   # StorageError subtree (ItemNotFound, Validation, DynamoTimeout, ...)
│   ├── discord.ts                   # DiscordError subtree (InvalidToken, Permission, RateLimit, ...)
│   ├── utils.ts                     # PathSecurityError for file path security validation
│   └── README.md                    # Error hierarchy diagram, naming conventions, usage patterns
├── services/                        # Service layer and infrastructure
│   ├── health-registry.ts              # Service health monitoring
│   ├── reconnection-loop.ts            # Reconnection handling with backoff
│   ├── lifecycle-orchestrator.ts       # Application lifecycle management
│   ├── types.ts                        # Service types
│   ├── outbox/                         # Reliable message delivery (outbox pattern)
│   │   ├── backend.ts                  # DynamoDB outbox storage
│   │   ├── drainer.ts                  # Outbox message drainer
│   │   ├── key-generator.ts            # Outbox DynamoDB key construction
│   │   └── types.ts                    # Outbox types
│   └── approval-saga/                  # Distributed approval workflow
│       ├── backend.ts                  # Approval saga storage
│       ├── executor.ts                 # Saga executor
│       └── types.ts                    # Saga types
├── config/                          # Zod-validated configuration
│   ├── schemas.ts                   # Configuration schemas
│   ├── loader.ts                    # Configuration loader
│   └── retry-config.ts              # Retry configuration constants
└── utils/                           # Shared utilities
    ├── time.ts                      # Time formatting (formatRelativeTime, getCurrentTimeContext, ...)
    ├── filename.ts                  # sanitizeFilename and deduplicateFilename
    ├── path-validator.ts            # validateFilePath: CWD containment + symlink security checks
    ├── safe-async-handler.ts        # safeAsyncHandler: async event handler → void with error logging
    ├── strip-dynamo-keys.ts         # Strip DynamoDB internal keys from items
    ├── text.ts                      # truncateToWordBoundary and HARD_MAX_STATUS_LENGTH
    ├── media/                       # Media processing utilities
    │   ├── types.ts                 # Media types and interfaces
    │   ├── fetcher.ts               # Media file fetching
    │   ├── converters/              # Format conversion
    │   │   └── heic.ts             # HEIC/HEIF to PNG conversion
    │   └── video/                   # Video processing pipeline
    │       ├── processor.ts         # Main video processor
    │       ├── downloader.ts        # Video downloading
    │       ├── frame-extractor.ts   # Frame extraction from video
    │       ├── scene-detector.ts    # Scene change detection
    │       ├── metadata.ts          # Video metadata extraction
    │       ├── spectrogram.ts       # Audio spectrogram generation
    │       ├── subtitle-extractor.ts # Subtitle/transcript extraction
    │       ├── spawn-runner.ts      # ffmpeg process runner
    │       ├── markdown-builder.ts  # Video analysis markdown output
    │       └── types.ts             # Video processing types
    └── retry/                       # Retry utilities with exponential backoff
        ├── types.ts                 # Retry configuration types
        ├── classifier.ts            # Error classification for retry decisions
        ├── delay.ts                 # Exponential backoff delay calculation
        ├── retry-async.ts           # Retry wrapper for async functions
        └── retry-async-generator.ts # Retry wrapper for async generators
```

## Roadmaps

- [Short-term (Weeks 1-2)](roadmaps/short-term.md) - Foundation
- [Mid-term (Weeks 3-8)](roadmaps/mid-term.md) - Integrations
- [Long-term (Months 3+)](roadmaps/long-term.md) - Production

## License

MIT
