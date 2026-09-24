# Isambard

[![Mutation testing badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fhughescr%2Fisambard%2Fdevelop)](https://dashboard.stryker-mutator.io/reports/github.com/hughescr/isambard/develop)

A self-improving agentic thought partner built with the Claude Agent SDK.

Named after Isambard Kingdom Brunel, the visionary Victorian engineer, and from Germanic roots meaning "iron-bright" (isan + beraht) - symbolizing strength and illumination.

## Philosophy

A core goal of Isambard is to use available model capacity economically. Izzy can route work across existing Claude Max and Codex subscriptions, while using a small prepaid DeepSeek API balance when that is the cheapest capable choice. Provider quota and real monetary spend remain visible so paid usage stays deliberate and bounded.

## Features

- **Discord Interface** - Communicate via Discord with dynamic presence status updates
- **Persistent Memory** - DynamoDB-backed three-layer memory system (identity/state/events)
- **Message History** - Search and cache Discord message history for context
- **Time Awareness** - Temporal context injection and relative time formatting
- **Email Integration** - Inbox reading and outbound email via WildDuck HTTP API with SSE push notifications and admin approval workflow
- **Bluesky Integration** - AT Protocol client for feeds, posts, DMs, and social graph with Discord-based approval workflow
- **Calendar Integration** - Read-only CalDAV access with personal/shared calendar registry via Discord slash commands. Calendar MCP event responses carry a discriminated `time` object: `all_day` local dates (`endExclusive`), `floating` zone-less local date-times, or `timed` ISO instants and optional source timezone; no top-level instant pair is synthesized for date-only or floating events.
- **Contacts System** - Cross-platform address book with identity resolution for unified person references
- **Media Processing** - Video analysis with scene detection, transcription, and spectrogram generation
- **Wikipedia Lookup** - Article retrieval for knowledge context
- **Self-Improvement** - Designed to propose enhancements via PRs (requires human approval)

### Planned Integrations (Not Yet Implemented)
- Box Documents

## Authentication and model routing

Isambard uses OAuth authentication via Claude Max subscription:
- Set up token: `claude setup-token`
- Configure: `bunx sst secret set ClaudeCodeOAuthToken <token>`
- Token valid for 1 year, renewable
- Claude routes use Max subscription quota; DeepSeek routes debit the configured API balance

Isambard routes the Agent SDK through the local [utraque](https://github.com/hughescr/utraque) proxy by default. This applies process-wide to the long-lived sessions and one-shot text generators. The default configuration is equivalent to:

```bash
UTRAQUE_ENABLED=true
ANTHROPIC_BASE_URL=http://127.0.0.1:8317
UTRAQUE_REPORT_TIMEOUT_MS=100000
```

Isambard sets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` itself so proxied Claude models retain first-party context-window handling. If utraque uses local authentication, provide `UTRAQUE_LOCAL_TOKEN`; Isambard sends it as `X-Utraque-Token` for inference and provider reporting without logging it. Set `UTRAQUE_ENABLED=false` for direct-Claude mode; Isambard removes the SDK proxy routing and omits cross-provider named sub-agents even if `ANTHROPIC_BASE_URL` was inherited.

The per-turn provider line combines Codex and DeepSeek data from utraque's provider report (schema 2, served at `/utraque/providers/v2`) with Anthropic windows emitted by the Claude Agent SDK. Isambard deliberately omits its Claude OAuth bearer from the provider-report request, so utraque skips the separate Anthropic usage lookup. SDK quota events arrive only while Izzy is active and cannot observe Craig's external Claude spend while Izzy is idle; the existing pause guard retains its prior peak until another SDK event arrives. Percentages are 0–100 values. When local history and models.dev reference prices are available, each five-hour or weekly bucket can include a rough `estimate_tokens_remaining` normalized to the cheapest currently routed model; its basis, sample token mix, period, and price timestamp stay beside the estimate. DeepSeek balance estimates remain per model. Quota, monetary balances, spend limits, source timestamps, scopes, cache state and failures remain distinct; local history's calculated API-reference cost is neither an invoice nor a subscription quota weight. See the provider terms for [Claude Max](https://support.claude.com/en/articles/11049741-what-is-the-max-plan), [Codex](https://learn.chatgpt.com/docs/pricing), and [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/).

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

   **Discord admin secrets (required):** the admin review channel receives every outbound
   approval (email sends, Bluesky replies/DMs, contact changes), whichever integrations are enabled.
   ```bash
   bunx sst secret set AdminDiscordUserId <admin-discord-user-id>
   bunx sst secret set AdminDiscordChannelId <admin-review-channel-id>
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

   **Email integration secrets (active):** approvals post to the Discord admin review channel (see Discord admin secrets).
   ```bash
   bunx sst secret set EmailUser <email-user>
   bunx sst secret set EmailPassword <email-password>
   bunx sst secret set WildDuckApiUrl <wildduck-api-url>
   ```

   **Bluesky integration secrets (active):** approvals post to the Discord admin review channel (see Discord admin secrets).
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
| `bun run mutate` | Mutation testing (Stryker), LLM mutator frozen to cached mutants |
| `bun run mutate:discover` | Mutation testing with the LLM mutator unfrozen, growing the cache within its per-run budget — see [docs/mutation-testing.md](docs/mutation-testing.md) |
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
│   ├── session/                         # Long-lived conductor session core (conversation + perch) — see docs/architecture.md's Session Architecture section
│   │   ├── conductor.ts             # Conductor: the only writer into a session's ledger/journal
│   │   ├── session.ts               # Session handle wrapping one SDK query() call for its whole life
│   │   ├── ledger.ts                # Pure, clock-free reducer over raw SDK frames into Ledger state
│   │   ├── journal.ts               # SessionJournal port implementation over the DynamoDB backend
│   │   ├── recovery.ts              # Crash-recovery computation over a journal read (lost tasks, undelivered turns)
│   │   ├── delivery-guard.ts        # In-memory guard against re-delivering an already-delivered envelope
│   │   ├── envelope.ts              # Pure envelope builders for the session core
│   │   ├── types.ts                 # Shared types for the session core
│   │   ├── ports.ts                 # Port interfaces the conductor writes through (journal, resume store)
│   │   ├── boot-bundle.ts           # Boot bundle composer (fresh/compact/restart_resume/reopen kinds)
│   │   ├── boot-sequence.ts         # Conductor-mode boot sequencing beyond a bare open()
│   │   ├── shutdown.ts              # Cross-session shutdown orchestration
│   │   ├── clock.ts                 # Real-time Clock implementation over Date.now/setTimeout
│   │   ├── query-options.ts         # Per-session Agent SDK query() options builder
│   │   ├── input-queue.ts           # Host-owned input queue fed to the SDK query() prompt iterable
│   │   ├── interrupt-flag.ts        # Mutable in-flight-interrupt flag read by query options
│   │   ├── result-echo.ts           # Which host-pushed user messages a result frame answers
│   │   ├── result-frame-error.ts    # Adapts a result frame's failure shape to an Error
│   │   ├── activity-phase.ts        # Within-turn activity phase mapping from raw SDK frames
│   │   ├── ambient-lines.ts         # Per-turn ambient context lines (quota note, etc.)
│   │   ├── context-policy.ts        # ContextPolicy: per-user memory/events/state/calendar/health delta gates
│   │   ├── calendar-delta.ts        # Calendar agenda delta primitive (diffing, day-window)
│   │   ├── catchup-text.ts          # Platform-neutral catch-up envelope body text
│   │   ├── discord-envelope-input.ts # Discord message input translated at the integration boundary
│   │   ├── compaction-guard.ts      # Host-driven /compact submission at a context-usage threshold
│   │   ├── compaction-telemetry.ts  # Per-compaction interval telemetry records
│   │   ├── compaction-tuner.ts      # Nudges the live compaction threshold toward a target interval
│   │   ├── cost-ceiling.ts          # Daily cost ceiling: a day-bucketed spend accumulator
│   │   ├── cost-ceiling-store.ts    # Persistence adapter for the daily cost ceiling
│   │   ├── health-notification.ts   # Pure health-outage predicate and coalescer
│   │   ├── notification-bridge.ts   # Source-agnostic notification submission seam
│   │   ├── quota-notes.ts           # Quota threshold notifications and the perch quota-pause guard
│   │   ├── quota-poller.ts          # Process-wide vendor quota polling via utraque
│   │   ├── resume-store.ts          # Role-bound convenience store over session-resume rows
│   │   ├── task-launch-registry.ts  # In-memory registry of background-work launches
│   │   ├── turn-synopsis.ts         # attachTurnSynopsis + SynopsisBudget: THE ONE turn synopsis producer (wired per session in app/sessions.ts)
│   │   ├── synopsis-stream-handler.ts # Per-turn stream handler: dispatches turn_synopsis into the session ledger
│   │   ├── synopsis-generator.ts    # Haiku turn synopsis generator, one per session (P14)
│   │   └── index.ts                 # Long-lived session core barrel
│   ├── hooks/                           # Claude Agent SDK hook callbacks (session lifecycle, task tracking)
│   │   ├── agent-naming.ts          # PreToolUse hook: stamps `Izzy-` onto Agent/Workflow launch names
│   │   ├── boot-bundle.ts           # SessionStart hook: injects the compact-kind boot bundle
│   │   ├── compaction.ts            # PreCompact/PostCompact hooks driving the compaction lifecycle
│   │   ├── lifecycle.ts             # SessionEnd and other lifecycle hook callbacks
│   │   ├── peer-message.ts          # UserPromptSubmit hook adopting cross-session peer messages
│   │   ├── task-launch.ts           # PostToolUse hook recording sub-agent/workflow/background-shell launches
│   │   ├── task-tracking.ts         # TaskCreated/TaskCompleted observational logging hooks
│   │   └── index.ts                 # Hooks module barrel export
│   ├── browser/                         # Browser automation adapter (conversation-role MCP server only, when configured)
│   │   ├── types.ts                 # BrowserAdapter interface and host policy types
│   │   ├── host-guard.ts            # URL allowlist/host guard for browser navigation
│   │   ├── webview-adapter.ts       # BrowserAdapter implementation over Bun.WebView
│   │   └── index.ts                 # Public exports
│   ├── types.ts                        # Platform-agnostic message types (MessageContext, PlatformImage)
│   ├── context-builder.ts              # Memory context loading and user message prefix assembly
│   ├── continuation-prompt-builder.ts  # Continuation note built when human-wait escalation interrupts a running turn
│   ├── bsky-mcp-server.ts              # MCP server: Bluesky operations
│   ├── browser-mcp-server.ts           # MCP server: browser automation (conversation role only, when configured)
│   ├── caldav-mcp-server.ts            # MCP server: CalDAV calendar operations
│   ├── claude-retry.ts                 # Retry logic for Claude API calls
│   ├── contacts-mcp-server.ts          # MCP server: contacts/address book operations
│   ├── discord-mcp-server.ts           # MCP server: Discord message history
│   ├── email-mcp-server.ts             # MCP server: email operations
│   ├── event-summarizer.ts             # LLM-based event summarization for context compression
│   ├── health-mcp-server.ts            # MCP server: read-only per-service health status
│   ├── identity-cache.ts               # Write-through in-memory cache for the agent's core identity context
│   ├── discord-inbox-mcp-server.ts     # MCP server: Discord inbox operations
│   ├── discord-ports.ts                # Discord-specific MCP port contracts
│   ├── live-signals.ts                 # LiveSignals aggregator
│   ├── mcp-helpers.ts                  # Shared MCP server utilities
│   ├── media-mcp-server.ts             # MCP server: video/audio media processing
│   ├── memory-mcp-server.ts            # MCP server: memory tools (view, store, search, list)
│   ├── multimodal-message-builder.ts   # Builds multimodal messages with image support
│   ├── person-context-mcp-server.ts    # MCP server: getPersonContext cross-platform person history (wire name user-context)
│   ├── plugin-loader.ts                # Plugin loading for Agent SDK
│   ├── session-cleanup.ts              # Extracts session IDs from SDK stream events
│   ├── skill-agent-loader.ts           # Syncs agents/skills to scratch/.claude/ at startup
│   ├── stream-event-logger.ts          # Per-instance stream-event logger for partial-work capture
│   ├── stream-extractors.ts            # Typed extractors over raw SDK stream frames
│   ├── stream-tracker.ts               # StreamTracker: streaming progress capture
│   ├── task-list-reader.ts             # TaskListReader: reads Claude task list state
│   ├── text-generator.ts               # Lightweight LLM text generation (Haiku)
│   ├── time-header.ts                  # The product's bound time-header formatter
│   ├── wikipedia-mcp-server.ts         # MCP server: Wikipedia article retrieval
│   ├── index.ts                        # Agent module exports
│   ├── prompts/                        # Agent system prompts
│   │   ├── system-prompt.ts         # Main conductor-session system prompt (identity, peer names)
│   │   ├── subagent-prompt.ts       # System prompt every Isambard sub-agent runs under
│   │   ├── shared-sections.ts       # Prompt fragments shared between session and sub-agent prompts
│   │   ├── helpers.ts               # Shared prompt formatting helpers
│   │   └── index.ts                 # Public exports
│   ├── answer-classifier/              # Answer classification subsystem
│   │   ├── types.ts                 # ClassificationResult enum and MessageToClassify interface
│   │   ├── haiku-classifier.ts      # LLM-based classification using Haiku
│   │   ├── classifier.ts            # AnswerClassifier class
│   │   └── index.ts                 # Public exports
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
│       ├── prompts.ts               # Slot name/suggestion-level text for perch turn envelopes
│       ├── envelope.ts              # Perch slot/wrap-up envelope builders
│       ├── perch-driver.ts          # Slot turn lifecycle: submit + wrap-up/interrupt timers
│       ├── scheduler.ts             # PerchScheduler: cron-based hourly trigger with jitter
│       ├── index.ts                 # Public exports
│       └── README.md                # Perch time scheduling design documentation
├── integrations/                    # External service integrations
│   ├── discord/                     # Discord bot integration
│   │   ├── bot.ts                   # Thin bot orchestrator with start/stop lifecycle
│   │   ├── handlers.ts              # Event handlers (ready, error, messageCreate)
│   │   ├── client.ts                # Discord.js client factory
│   │   ├── types.ts                 # Branded IDs plus ChannelScope/DM_SCOPE and DiscordMessageContext schema
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
│   │   ├── colors.ts                # Shared embed color constants (change-detector tested)
│   │   ├── ingress-gate.ts          # Gate that opens once boot recovery has resolved before processing live turns
│   │   ├── map-bounded.ts           # Bounded-concurrency async map helper
│   │   ├── outbox-replay.ts         # Replays queued outbox items as Discord sends on reconnect
│   │   ├── contact-commands.ts      # Contact management Discord slash commands
│   │   ├── allowlist-commands.ts    # Person-allowlist Discord slash commands
│   │   ├── allowlist-interaction-handler.ts # Modal/button interactions for the allowlist saga flow
│   │   ├── history-provider.ts      # Discord history provider for cross-platform context
│   │   ├── setup/                   # Bot initialization setup modules
│   │   │   ├── presence-setup.ts          # Presence manager, per-session status generators, ledger subscriptions + synopsis attachment
│   │   │   ├── perch-setup.ts             # Perch conductor driver + scheduler configuration
│   │   │   ├── catchup-setup.ts           # Boot-time inbox init and merged conductor catch-up envelope submission
│   │   │   ├── coordinator-setup.ts       # MessageCoordinator wiring to the conversation conductor; attachment processing
│   │   │   ├── conductor-processor.ts     # Bridges the conversation conductor onto MessageProcessor
│   │   │   ├── discord-envelope-provider.ts # Builds the platform-agnostic DiscordEnvelopeInput a Discord turn hands to the conductor
│   │   │   ├── event-handler-setup.ts     # Channel registry init, message processing, cleanup handlers
│   │   │   ├── email-setup.ts             # Email MCP server init and WildDuck SSE listener lifecycle
│   │   │   ├── bsky-setup.ts              # Bluesky integration setup and approval callbacks
│   │   │   ├── bsky-dm-poller.ts          # Health-gated poller raising an accumulate notification for new Bluesky DMs
│   │   │   └── wake-delivery.ts           # Delivers a background-work wake turn's reply to Discord
│   │   ├── presence/                # Dynamic status updates reflecting agent activity
│   │   │   ├── index.ts                    # Barrel: the module's named exports
│   │   │   ├── types.ts                    # PresencePhase types (idle, thinking, responding, tool-use)
│   │   │   ├── manager.ts                  # PresenceManager: debouncing and rate limiting
│   │   │   ├── presence-view.ts            # composePresence: the ledger -> presence-line projection (renders the turn synopsis) + PresenceThrottle
│   │   │   ├── status-generator-active.ts  # Static status labels for active phases
│   │   │   └── status-generator-idle.ts    # LLM-powered idle status text
│   │   ├── task-board/              # Live-edited Discord embed showing sub-agents, workflows and background shell commands
│   │   │   ├── types.ts                    # Ledger-shaped inputs, view types, and render output types
│   │   │   ├── compose.ts                  # composeTaskBoards: ledgers -> one TaskBoardView per (channel, turn)
│   │   │   ├── render.ts                   # renderTaskBoardEmbed: pure TaskBoardView -> Discord embed renderer
│   │   │   ├── manager.ts                  # TaskBoardManager: posts/edits one embed per board on a trailing throttle
│   │   │   ├── setup.ts                    # Subscribes to the session ledgers and wires the manager
│   │   │   └── index.ts                    # Public exports
│   │   ├── message-history/         # Message search and caching for context
│   │   │   ├── types.ts             # Search types (DiscordSearchResult, SearchParams)
│   │   │   ├── snowflake.ts         # Discord snowflake ID utilities
│   │   │   ├── fetcher.ts           # Discord API message fetcher
│   │   │   ├── search.ts            # Message search service
│   │   │   └── summarizer.ts        # Overflow message summarization
│   │   ├── channel-registry/        # DynamoDB-backed channel registry with in-memory cache
│   │   │   ├── types.ts             # ChannelStorageRecord, ChannelMetadata, WellKnownChannel types
│   │   │   ├── backend.ts           # ChannelRegistryBackend: DynamoDB CRUD with GSI1/GSI2 lookup
│   │   │   ├── manager.ts           # ChannelRegistryManager: write-through cache + shouldProcess filtering
│   │   │   ├── discovery.ts         # Guild channel discovery + channelCreate/Update/Delete handlers
│   │   │   ├── dm-tracker.ts        # DMTracker: on-demand DM channel creation by user ID/username
│   │   │   ├── resolve.ts           # Resolves a channel identifier to a numeric channel ID
│   │   │   ├── response-router.ts   # Maps conductor-mode EnvelopeKinds to their well-known channel targets
│   │   │   ├── sentinel.ts          # @@NO_RESPONSE@@ sentinel detection and stripping
│   │   │   └── key-generator.ts     # ChannelRegistryKeyGenerator for DynamoDB key construction
│   │   ├── inbox/                   # Unread message tracking with checkpoint persistence
│   │   │   ├── types.ts              # DiscordChannelCheckpoint, UnreadMessage, UnreadOverview schemas
│   │   │   ├── config.ts             # InboxConfig schema with defaults
│   │   │   ├── checkpoint-manager.ts # CheckpointManager: last-seen timestamps per channel
│   │   │   ├── inbox-manager.ts      # InboxManager: unread queue + startup catch-up loading
│   │   │   └── index.ts              # Public exports
│   │   └── attachments/             # Image fetching, conversion, and formatting
│   │       ├── types.ts             # AttachmentMetadata, FetchedImage, StoredAttachment types
│   │       ├── converter.ts         # HEIC/HEIF to PNG conversion
│   │       ├── fetcher.ts           # Fetches image attachments from Discord URLs
│   │       └── formatting.ts        # Byte formatting and attachment info appending
│   ├── email/                       # Email integration (WildDuck HTTP API + SSE)
│   │   ├── types.ts                     # Email types (EmailFolder, WildDuckMessage, SearchCriteria)
│   │   ├── wildduck-client.ts           # WildDuck HTTP API client (search, flags, drafts, send)
│   │   ├── wildduck-listener.ts         # WildDuck SSE listener with poll fallback
│   │   ├── email-processor.ts           # Email processing pipeline
│   │   ├── outbound-approval-handler.ts # Admin approval workflow for outbound email
│   │   ├── draft-review-state.ts        # Persisted review state for a draft awaiting admin approval
│   │   ├── auth-checker.ts              # Authorization checking for outbound email
│   │   ├── classifier.ts                # Email classification
│   │   ├── classifier-prompt.ts         # LLM prompt for email classification
│   │   ├── review-embed-builder.ts      # Discord embed builder for approval review
│   │   ├── review-handler.ts            # Handles admin approval/rejection responses
│   │   ├── history-provider.ts          # Email history provider for cross-platform context
│   │   └── index.ts                     # Public exports (error hierarchy lives in src/errors/email.ts; rate limiter in src/services/rate-limiters/)
│   ├── bsky/                          # Bluesky AT Protocol integration
│   │   ├── types.ts                     # Domain types (BskyPost, BskyNotification, BskyConversation, etc.)
│   │   ├── client.ts                    # BlueskyClient: feeds, posts, DMs, follow/unfollow, validation
│   │   ├── classifier.ts                # Error classifier for Bluesky client errors
│   │   ├── embeds.ts                    # Embed types, normalization, and facet support
│   │   ├── history-provider.ts          # Bluesky history provider for cross-platform context
│   │   ├── rejection-backend.ts         # DynamoDB backend for admin-rejected posts/DMs
│   │   ├── review-embed-builder.ts      # Discord embed builder for reply/DM approval requests
│   │   ├── outbound-approval-handler.ts # Discord approval workflow for outbound replies and DMs
│   │   ├── index.ts                     # Public exports (error hierarchy lives in src/errors/bsky.ts)
│   │   └── checkpoint/                  # Notification/feed checkpoint tracking
│   │       ├── types.ts                 # Checkpoint types
│   │       ├── checkpoint-manager.ts    # Checkpoint persistence
│   │       ├── uri-sanitizer.ts         # AT URI sanitization
│   │       └── index.ts                 # Public exports
│   └── caldav/                        # CalDAV calendar integration
│       ├── client.ts                    # CalDAV client via tsdav
│       ├── types.ts                     # Calendar domain types, including the CalendarTimeRange union
│       ├── formatter.ts                 # Calendar event formatting with timezone support
│       ├── time-range.ts                # The one display-zone policy for CalendarTimeRange (formatter, agenda, change list)
│       ├── calendar-commands.ts         # Discord slash commands for calendar management
│       ├── index.ts                     # Public exports (error hierarchy lives in src/errors/caldav.ts)
│       └── calendar-registry/           # Per-user/shared calendar DynamoDB registry
│           ├── backend.ts               # DynamoDB CRUD for calendar credentials
│           ├── key-generator.ts         # DynamoDB key construction
│           ├── resolve.ts               # Resolves a server identifier to a CalendarServerEntry
│           ├── types.ts                 # CalendarRegistryScope and registry record types
│           └── index.ts                 # Public exports
├── storage/                         # DynamoDB data access layer
│   ├── client.ts                    # DynamoDB client factory
│   ├── client-holder.ts             # Swappable DynamoDB client holder for reconnect
│   ├── dynamo-retry.ts              # Retry/timeout logic for DynamoDB operations; module-level health notifier (the one DI exception, installed/cleared by src/index.ts)
│   ├── dynamo-probe-callback.ts     # Self-contained event-sender interface for the DynamoDB startup probe
│   ├── activity-log.ts              # ActivityLogger and ActivityType values for cross-platform auto-logging
│   ├── person-allowlist.ts          # Person-ID-keyed allowlist gating outbound writes
│   ├── repositories/                # Shared DynamoDB access primitives
│   │   ├── base.ts                  # DynamoTableAccess: abstract base wrapping common get/put/query/scan primitives
│   │   └── types.ts                 # EpochSeconds branded type and shared repository types
│   ├── utils/                       # Storage utilities
│   │   ├── key-builder.ts           # Generic DynamoDB prefixed-key helpers
│   │   ├── strip-dynamo-keys.ts     # Strips DynamoDB internal keys (PK/SK/GSI*) from items
│   │   └── index.ts                 # Public exports
│   ├── contacts/                    # Cross-platform contacts/address book
│   │   ├── backend.ts               # DynamoDB CRUD for contacts, including resolveIdentifier's primary-key lookup query
│   │   ├── key-generator.ts         # Contact DynamoDB key construction (CONTACT_LOOKUP PK, GSI2 CONTACTS/CONTACT_LOOKUPS)
│   │   ├── find-or-create.ts        # Resolves an identifier to an existing contact or creates one
│   │   ├── utils.ts                 # Kebab-case PersonId generation from a display name
│   │   ├── types.ts                 # Contact types, schemas, and identifier-equivalence helpers
│   │   ├── index.ts                 # Public exports
│   │   └── reconciliation/          # Two-phase lookup-row reconciliation (orphan cleanup + missing-lookup repair)
│   │       ├── reconciler.ts        # Phase A/B reconciler implementation (queries GSI2 CONTACT_LOOKUPS/CONTACTS)
│   │       ├── scheduler.ts         # Interval-based reconciliation scheduler with abort support
│   │       └── index.ts             # Public exports
│   ├── memory-tool/                 # Three-layer memory system (identity/state/events)
│   │   ├── types.ts                 # Zod schemas, branded types, type guards, factory functions
│   │   ├── key-generator.ts         # DynamoDB key structure (PK/SK/GSI1) and tag index keys
│   │   ├── backend.ts               # Main backend facade
│   │   ├── backend-core.ts          # Core CRUD operations
│   │   ├── backend-query.ts         # Query operations (list, search, getAutoLoadItems)
│   │   ├── backend-tag-index.ts     # Tag index CRUD with BatchWriteItem + atomic counters (GSI2 TAG_COUNTS partition)
│   │   ├── decode-stored-item.ts    # Tolerant decode of one raw DynamoDB record into MemoryToolItemData
│   │   ├── sigmoid.ts               # sigmoidScore(): frequency × recency decay for state prioritization
│   │   ├── index.ts                 # Public exports
│   │   └── reconciliation/          # Tag index reconciliation (three phases: completeness/orphan/count)
│   │       ├── types.ts             # Reconciliation config, state, and result types
│   │       ├── reconciler.ts        # Three-phase reconciler implementation
│   │       ├── scheduler.ts         # Interval-based reconciliation scheduler with abort support
│   │       └── index.ts             # Public exports
│   ├── memory-vec/                  # Production embedding library (node-llama-cpp)
│   │   ├── embedder.ts              # Embedder: wraps node-llama-cpp to produce packed binary embeddings
│   │   ├── ubinary.ts               # Sign-bit packing: float32 vectors -> packed binary (ubinary) format
│   │   ├── paths.ts                 # Cache directory resolution and GGUF filename construction
│   │   ├── version-check.ts         # Bundled llama.cpp version validation
│   │   ├── types.ts                 # Types for the memory-vec embedding library
│   │   └── index.ts                 # Public exports
│   ├── memory-vec-store/            # SQLite-backed vector index for semantic memory search
│   │   ├── backend.ts               # VectorIndex: SQLite-backed vector index
│   │   ├── indexer.ts               # AsyncIndexer: non-blocking vector index worker
│   │   ├── schema.ts                # SQLite DDL for the memory vector index
│   │   ├── hash.ts                  # SHA-256 hex digest utility
│   │   ├── types.ts                 # Types for the memory-vec-store module
│   │   └── index.ts                 # Public exports
│   ├── session-journal/             # Write-through session-lifecycle journal (SESSION_JOURNAL#<role> partition)
│   │   ├── backend.ts               # Write-through backend: append/readSince over the journal partition
│   │   ├── types.ts                 # DynamoDB item shape and validation schema for journal entries
│   │   └── index.ts                 # Public exports
│   ├── session-resume/              # Claude Agent SDK session ID persistence (role-keyed)
│   │   ├── backend.ts               # SessionResumeBackend: role-keyed store for storing/retrieving session ID
│   │   ├── types.ts                 # SessionId branded type and SessionResumeItem DynamoDB record
│   │   └── index.ts                 # Public exports
│   └── index.ts                     # Public exports
├── app/                             # Application composition root
│   ├── storage-layer.ts             # createStorageLayer: DynamoDB client, memory backend, reconciliation
│   ├── discord-infrastructure.ts    # createDiscordInfrastructure: client, registry, history, inbox
│   ├── context-layer.ts             # createContextLayer: context builder for memory-aware agent operation
│   ├── mcp-servers.ts               # createMcpSharedDeps + createMcpServerInstances: builds every MCP server set
│   ├── identity-loader.ts           # loadIdentityContext: bot identity from memory for presence
│   ├── sessions.ts                  # Assembles the conversation and perch conductors and their shared session ambience
│   ├── lifecycle.ts                 # Process-lifecycle seams: signal handlers, Discord recovery handler
│   ├── hot-reload-guard.ts          # Hot-reload guard for the composition root (survives Bun --hot)
│   └── index.ts                     # Composition-root barrel: re-exports every factory above
├── errors/                          # Centralized error hierarchy
│   ├── base.ts                      # IsambardError base class with ErrorCode and typed context
│   ├── codes.ts                     # ErrorCode enum (storage, memory, Discord, presence, email, ...)
│   ├── storage.ts                   # StorageError subtree (ItemNotFound, Validation, DynamoTimeout, contacts, ...)
│   ├── discord.ts                   # DiscordError subtree (InvalidToken, Permission, RateLimit, ...)
│   ├── email.ts                     # EmailError subtree (WildDuck, classifier, processing errors)
│   ├── bsky.ts                      # BskyError subtree (AT Protocol auth, rate limit, validation errors)
│   ├── caldav.ts                    # CaldavError subtree (calendar auth, fetch, timeout, ambiguous-match errors)
│   ├── browser.ts                   # BrowserError subtree (navigation timeout errors)
│   ├── config.ts                    # ConfigValidationError
│   ├── memory-vec.ts                # MemoryVecError: embedding library error hierarchy
│   ├── vector-index.ts              # Error hierarchy for the memory-vec-store module
│   ├── utils.ts                     # PathSecurityError for file path security validation
│   ├── index.ts                     # Barrel: exports every error class from this module
│   └── README.md                    # Error hierarchy diagram, naming conventions, usage patterns
├── services/                        # Service layer and infrastructure
│   ├── health-registry.ts              # ServiceHealthRegistryImpl: registers services, tracks health, sendEvent()
│   ├── lifecycle-orchestrator.ts       # serviceLifecycleMachine: per-service xstate health/reconnect state machine
│   ├── reconnection-loop.ts            # Reconnection handling with exponential backoff
│   ├── error-boundary.ts               # Process-level uncaughtException/unhandledRejection boundary handlers
│   ├── outbound-approval-handler-base.ts # BaseOutboundApprovalHandler shared by email/Bluesky approval handlers
│   ├── types.ts                        # Service types (ServiceName, HealthState, minimal logger interface)
│   ├── index.ts                        # Public exports
│   ├── outbox/                         # Reliable message delivery (outbox pattern)
│   │   ├── backend.ts                  # DynamoDB outbox storage; paginated priority-ordered dequeue
│   │   ├── drainer.ts                  # Outbox message drainer
│   │   ├── discord-payload.ts          # Discord-api-types-typed outbox payload schemas
│   │   ├── key-generator.ts            # Outbox DynamoDB key construction
│   │   ├── types.ts                    # Outbox types
│   │   └── index.ts                    # Public exports
│   ├── approval-saga/                  # Distributed approval workflow
│   │   ├── backend.ts                  # Approval saga storage
│   │   ├── executor.ts                 # Saga executor
│   │   ├── types.ts                    # Saga types
│   │   └── index.ts                    # Public exports
│   ├── allowlist-saga/                 # Multi-step Discord UI flow for adding a contact to the person allowlist
│   │   ├── backend.ts                  # Strongly-consistent read/conditional-put saga row storage
│   │   ├── executor.ts                 # Saga step executor and typed transitions
│   │   ├── starter.ts                  # Minimal interface for kicking off a saga from an approval handler
│   │   ├── types.ts                    # Zod discriminated union of saga states
│   │   └── index.ts                    # Public exports
│   └── rate-limiters/                  # Generic rate limiting primitives
│       ├── token-bucket.ts             # TokenBucketRateLimiter: refill-over-time token bucket
│       └── index.ts                    # Public exports
├── config/                          # Zod-validated configuration
│   ├── schemas.ts                   # Configuration schemas (including quota thresholds, task board, inbox)
│   ├── loader.ts                    # Configuration loader from SST Resource / env-var
│   ├── retry-config.ts              # Claude retry policy config (imports retryPolicySchema from @/utils)
│   ├── discord-ids.ts               # Branded ChannelId/GuildId/UserId Zod schemas shared by config/services/agent/Discord
│   ├── interaction-routes.ts        # Closed prefix vocabularies for the Discord interaction-route grammar
│   ├── email-folders.ts             # EmailFolder enum (WildDuck top-level folders)
│   └── index.ts                     # Public exports
└── utils/                           # Shared utilities
    ├── time.ts                      # Time formatting (formatRelativeTime, getCurrentTimeContext, ...)
    ├── text.ts                      # truncateToWordBoundary and HARD_MAX_STATUS_LENGTH
    ├── filename.ts                  # sanitizeFilename and deduplicateFilename
    ├── path-validator.ts            # validateFilePath: CWD containment + symlink security checks
    ├── safe-async-handler.ts        # safeAsyncHandler: async event handler → void with error logging
    ├── assert-never.ts              # assertNever(): exhaustiveness helper for discriminated union switches
    ├── interaction-route.ts         # CustomId branded type: encodeCustomId/parseCustomId codec
    ├── index.ts                     # Public exports
    ├── media/                       # Media processing utilities
    │   ├── types.ts                 # Media types and interfaces
    │   ├── fetcher.ts                # Media file fetching
    │   ├── converters/               # Format conversion
    │   │   └── heic.ts              # HEIC/HEIF to PNG conversion
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
    └── retry/                       # Retry utilities with exponential backoff (Discord + Bluesky only — see Cross-Cutting Patterns)
        ├── types.ts                 # Retry configuration types
        ├── classifier.ts            # Error classification for retry decisions
        ├── delay.ts                 # Exponential backoff delay calculation
        ├── defaults.ts               # Validates the retry policy and merges deps with defaults
        ├── retry-async.ts           # Retry wrapper for async functions
        └── retry-async-generator.ts # Retry wrapper for async generators
```

## Roadmaps

- [Short-term (Weeks 1-2)](roadmaps/short-term.md) - Foundation
- [Mid-term (Weeks 3-8)](roadmaps/mid-term.md) - Integrations
- [Long-term (Months 3+)](roadmaps/long-term.md) - Production

## License

MIT
