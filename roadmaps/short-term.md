# Short-Term Roadmap (Weeks 1-2) ✅ COMPLETE

## Status
**All objectives achieved.** Ready to proceed to [Mid-Term Roadmap](./mid-term.md).

## Goals
Establish foundation for Isambard with working Discord bot and memory system.

## Week 1: Foundation
- [x] Project scaffolding
- [x] Configuration system with Zod validation
- [x] Structured logging utility
- [x] DynamoDB client setup
- [x] Basic memory repository (CRUD operations)
- [x] Unit tests for all above

## Week 2: Discord + Agent
- [x] Discord.js client wrapper
- [x] Message event handling
- [x] Basic Claude Agent SDK integration (betaMemoryTool)
- [x] Memory loading on conversation start (memory-tool MCP)
- [x] Simple response loop (connect Discord → Claude Agent)
- [x] Integration tests

### Memory Tool Implementation (Completed)
- [x] MCP-compliant memory-tool implementation
- [x] CRUD operations (create, read, update, delete)
- [x] Entity-relation storage pattern
- [x] Comprehensive unit tests with 100% mutation coverage
- [x] Integration with Claude Agent SDK via betaMemoryTool

### Discord Integration (Completed)
- [x] discord.js client with proper intents (Guilds, GuildMessages, MessageContent)
- [x] Branded types (GuildId, ChannelId, UserId) with Zod validation
- [x] Error hierarchy (InvalidTokenError, PermissionError, etc.)
- [x] Event handlers (ready, error, messageCreate)
- [x] Bot factory with lifecycle management (start/stop)
- [x] Message routing: DMs, @mentions, monitored channels
- [x] Comprehensive unit tests with 100% mutation coverage

### Claude Agent Integration (Completed)
- [x] Claude Agent SDK with OAuth authentication (Max subscription)
- [x] Hybrid memory architecture (core identity + recent context injected)
- [x] Memory MCP server for on-demand deep archive access
- [x] Claude agent with chat() method using query() streaming API
- [x] Message formatting: "User @{userId} in #{channelId}: {content}"
- [x] Response truncation at 1900 chars for Discord limits
- [x] Context builder for loading core identity and recent user context
- [x] Application entry point with graceful startup/shutdown (SIGINT/SIGTERM)
- [x] 20 integration tests for full bot lifecycle
- [x] 910 total tests passing with 99.37% mutation coverage

### Time Awareness (Completed)
- [x] Time utility module (formatRelativeTime, getTimeOfDay, etc.)
- [x] Discord message chunking (split long messages instead of truncating)
- [x] Current time injection into context prefix (UTC + day + time of day)
- [x] Timestamps on memory tool responses (view, search, list)
- [x] Timestamps on auto-loaded context (user memories, bot memories, events)
- [x] User timezone storage and loading
- [x] Temporal reasoning guidance in system prompt

## Success Criteria
- Bot responds to Discord messages
- Conversations persist across restarts
- 99.37% mutation test coverage
- Zero TypeScript/lint errors
