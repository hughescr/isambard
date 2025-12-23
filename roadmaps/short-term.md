# Short-Term Roadmap (Weeks 1-2)

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
- [ ] Discord.js client wrapper
- [ ] Message event handling
- [x] Basic Claude Agent SDK integration (betaMemoryTool)
- [x] Memory loading on conversation start (memory-tool MCP)
- [ ] Simple response loop
- [ ] Integration tests

### Memory Tool Implementation (Completed)
- [x] MCP-compliant memory-tool implementation
- [x] CRUD operations (create, read, update, delete)
- [x] Entity-relation storage pattern
- [x] Comprehensive unit tests with 92.82% mutation coverage
- [x] Integration with Claude Agent SDK via betaMemoryTool

## Success Criteria
- Bot responds to Discord messages
- Conversations persist across restarts
- 70%+ mutation test coverage
- Zero TypeScript/lint errors
