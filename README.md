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
- **Email Integration** - IMAP inbox reading and outbound email via WildDuck API with admin approval workflow
- **Self-Improvement** - Proposes enhancements via PRs (requires human approval)

### Planned Integrations (Not Yet Implemented)
- Apple Calendar (CalDAV)
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
   bunx sst secret set ImapHost <imap-host>
   bunx sst secret set ImapPort <imap-port>
   bunx sst secret set EmailUser <email-user>
   bunx sst secret set EmailPassword <email-password>
   bunx sst secret set AdminDiscordUserId <admin-discord-user-id>
   bunx sst secret set AdminDiscordChannelId <admin-discord-channel-id>
   bunx sst secret set WildDuckApiUrl <wildduck-api-url>
   ```

   **Planned integrations (not yet implemented - secrets commented out in `sst/secrets.ts`):**
   - Apple Calendar (CalDAV): `CaldavUrl`, `CaldavUsername`, `CaldavPassword`
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
├── agent/                    # Claude Agent SDK integration
│   ├── agent.ts              # Main agent with handleInput() method
│   ├── types.ts              # Agent stream event types
│   ├── context-builder.ts    # Memory context loading
│   ├── memory-mcp-server.ts  # MCP server for memory tools
│   ├── discord-mcp-server.ts # MCP server for message history
│   ├── email-mcp-server.ts   # MCP server for email operations
│   ├── inbox-mcp-server.ts   # MCP server for Discord inbox
│   ├── text-generator.ts     # Lightweight LLM text generation
│   ├── claude-retry.ts       # Retry logic for Claude API
│   ├── plugin-loader.ts      # Plugin loading for Agent SDK
│   ├── session-cleanup.ts    # Session lifecycle management
│   └── prompts/              # System prompts
├── integrations/             # External services
│   ├── discord/              # Discord bot integration
│   │   ├── presence/         # Dynamic status updates
│   │   │   ├── manager.ts    # Presence state management
│   │   │   ├── middleware.ts # Activity state transitions
│   │   │   └── status-generator-*.ts  # Status text generators
│   │   ├── message-history/  # Message search/caching
│   │   │   ├── search.ts     # Search service
│   │   │   ├── fetcher.ts    # Discord API fetcher
│   │   │   └── summarizer.ts # Overflow summarization
│   │   ├── rate-limiter.ts   # Rate limiting
│   │   └── retry.ts          # Retry logic
│   └── email/                # Email integration (IMAP + WildDuck API)
│       ├── imap-connection.ts # IMAP connection with IDLE
│       ├── imap-listener.ts  # IDLE listener and inbox polling
│       ├── wildduck-client.ts # WildDuck HTTP API client
│       └── outbound-approval-handler.ts  # Admin approval workflow
├── storage/                  # DynamoDB layer
│   ├── memory-tool/          # Three-layer memory system
│   │   ├── backend*.ts       # Backend operations
│   │   └── handlers.ts       # Memory tool handlers
│   ├── models/               # Entity definitions
│   ├── repositories/         # Data access
│   ├── client.ts             # DynamoDB client
│   └── dynamo-retry.ts       # Retry logic
├── config/                   # Zod-validated configuration
│   ├── schemas.ts            # Configuration schemas
│   ├── loader.ts             # Config loader
│   └── retry-config.ts       # Retry configuration
└── utils/                    # Shared utilities
    ├── time.ts               # Time formatting utilities
    └── retry/                # Retry with exponential backoff
```

## Roadmaps

- [Short-term (Weeks 1-2)](roadmaps/short-term.md) - Foundation
- [Mid-term (Weeks 3-8)](roadmaps/mid-term.md) - Integrations
- [Long-term (Months 3+)](roadmaps/long-term.md) - Production

## License

MIT
