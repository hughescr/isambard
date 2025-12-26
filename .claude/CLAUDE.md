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
The agent subsystem connects Discord to Claude with optional persistent memory:
- `src/agent/client.ts` - Anthropic SDK client factory
- `src/agent/agent.ts` - Claude agent with `chat()` method for message processing
- `src/agent/claude.ts` - betaMemoryTool integration with Claude SDK
- `src/index.ts` - Application entry point with lifecycle management

### Discord Integration
The Discord integration provides bot functionality:
- `src/integrations/discord/types.ts` - Branded types (GuildId, ChannelId, UserId)
- `src/integrations/discord/errors.ts` - Error hierarchy
- `src/integrations/discord/client.ts` - Discord.js client factory
- `src/integrations/discord/handlers.ts` - Event handlers (ready, error, messageCreate)
- `src/integrations/discord/bot.ts` - Bot factory with start/stop lifecycle
- `src/integrations/discord/index.ts` - Public exports

### Memory Tool Subsystem
The memory tool implements Claude's betaMemoryTool with a DynamoDB backend:
- `src/storage/memory-tool/` - Complete memory tool implementation
  - `types.ts` - Zod schemas, branded MemoryPath type, MemoryToolItem
  - `errors.ts` - MemoryToolError hierarchy (PathNotFoundError, TextNotUniqueError, etc.)
  - `key-generator.ts` - DynamoDB key structure (DIR#/FILE#/PATH#/CREATED#)
  - `backend.ts` - DynamoDB CRUD operations with optimistic locking
  - `handlers.ts` - SDK handlers: view, create, str_replace, insert, delete, rename
  - `index.ts` - Public exports

### Key Patterns
- **Repository Pattern** for data access
- **Dependency Injection** for testability
- **Zod Schemas** for runtime validation
- **Structured Logging** with correlation IDs
- **betaMemoryTool Integration** for self-editing agent memory
- **Filesystem-like paths** with `/memories/` prefix

## Roadmaps
- [Short-term (Weeks 1-2)](../roadmaps/short-term.md)
- [Mid-term (Weeks 3-8)](../roadmaps/mid-term.md)
- [Long-term (Months 3+)](../roadmaps/long-term.md)

## Commands
```bash
bun run dev          # Development with hot reload
bun run dev:docker   # Full stack with DynamoDB
bun test             # Run tests
bun run mutate       # Mutation testing
bun run lint         # Check linting
bun run typecheck    # TypeScript validation
```
