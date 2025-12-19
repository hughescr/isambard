# Isambard

A self-improving agentic thought partner built with the Claude Agent SDK.

Named after Isambard Kingdom Brunel, the visionary Victorian engineer, and from Germanic roots meaning "iron-bright" (isan + beraht) - symbolizing strength and illumination.

## Features

- **Discord Interface** - Communicate via Discord
- **Persistent Memory** - DynamoDB-backed three-layer memory system
- **Self-Improvement** - Proposes enhancements via PRs (requires human approval)
- **Integrations** - Apple Calendar, Email, Box Documents

## Tech Stack

- **Runtime**: Bun + TypeScript
- **LLM**: Claude Agent SDK
- **Infrastructure**: SST (AWS CDK)
- **Database**: DynamoDB (single-table design)
- **Interface**: Discord.js

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Docker](https://docker.com/) (for local DynamoDB)
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
   ```bash
   # Discord
   bunx sst secret set DiscordBotToken <token>
   bunx sst secret set DiscordApplicationId <app-id>

   # Apple Calendar
   bunx sst secret set CaldavUsername <apple-id@icloud.com>
   bunx sst secret set CaldavPassword <app-specific-password>

   # Email
   bunx sst secret set EmailUser <email@icloud.com>
   bunx sst secret set ImapPassword <app-specific-password>

   # Box
   bunx sst secret set BoxClientId <client-id>
   bunx sst secret set BoxClientSecret <client-secret>
   ```

4. **Start development**
   ```bash
   # Option A: Full stack with SST
   bun run sst-dev

   # Option B: Local DynamoDB only
   bun run dev:docker
   bun run dev
   ```

## Development

### Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Development with hot reload |
| `bun run dev:docker` | Start local DynamoDB |
| `bun test` | Run tests |
| `bun run mutate` | Mutation testing (Stryker) |
| `bun run lint` | ESLint check |
| `bun run typecheck` | TypeScript validation |
| `bun run sst-dev` | SST development mode |
| `bun run sst-deploy` | Deploy to AWS |

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
- Mutation score >= 70%

## Architecture

```
src/
├── agent/          # Claude Agent SDK core
│   ├── handlers/   # Message/event handlers
│   ├── tools/      # Custom MCP tools
│   └── middleware/ # Request/response middleware
├── integrations/   # External services
│   └── discord/    # Discord adapter
├── storage/        # DynamoDB layer
│   ├── models/     # Entity definitions
│   └── repositories/ # Data access
├── config/         # Zod-validated configuration
└── utils/          # Shared utilities
```

## Roadmaps

- [Short-term (Weeks 1-2)](roadmaps/short-term.md) - Foundation
- [Mid-term (Weeks 3-8)](roadmaps/mid-term.md) - Integrations
- [Long-term (Months 3+)](roadmaps/long-term.md) - Production

## License

MIT
