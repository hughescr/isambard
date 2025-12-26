# Mid-Term Roadmap (Weeks 3-8)

## Goals
Expand integrations and enable self-improvement capabilities.

## Weeks 3-4: Memory Enhancement ✅ COMPLETE

**Foundation:** Memory-tool MCP implementation completed in Week 2 provides CRUD operations and entity-relation storage pattern.

- [x] Three-layer memory system (Identity, State, Events)
- [x] Memory search and recall tools
- [x] TTL for ephemeral data
- [x] Context builder for hybrid memory loading
- [x] Memory MCP server integration
- [ ] Semantic search via Pinecone integration (deferred - future enhancement)
- [ ] Advanced conversation context management (future enhancement)

### Memory Enhancement Implementation (Completed)

**Three-Layer Memory System:**
- Identity layer: Permanent storage, 10 versions, auto-loaded
- State layer: 60-day TTL, 5 versions, conditionally loaded
- Events layer: 14-day TTL, 1 version, explicit recall only

**Search & Recall Tools:**
- `search` handler: Search by tags, layer, time range
- `recall` handler: Get auto-load items as formatted context
- `list_by_layer` handler: List all items in a layer
- `consolidate` handler: Summarize multiple events

**TTL Support:**
- Automatic TTL based on layer configuration
- DynamoDB TTL attribute for automatic expiration

**Backend Enhancements:**
- GSI2 for tag-based queries
- Version history with automatic pruning
- Context builder for agent integration

**Quality Metrics:**
- 910 tests passing
- 99.37% mutation score

## Agent SDK Migration ✅ COMPLETE

**OAuth Authentication:**
- Migrated from `@anthropic-ai/sdk` to `@anthropic-ai/claude-agent-sdk`
- OAuth via `CLAUDE_CODE_OAUTH_TOKEN` (uses Max subscription)
- No separate API billing

**Hybrid Memory Architecture:**
- Core identity (< 500 tokens) injected into system prompt
- Recent context (< 1KB) injected into user message
- Deep archive accessible via memory MCP tools
- Token-efficient: ~300 tokens/message savings vs pure injection

**Implementation:**
- Created memory MCP server with view/store/search tools
- Context builder with loadCoreIdentity() and loadRecentContext()
- Agent using query() streaming API
- Comprehensive tests: 910 passing, 99.37% mutation coverage

## Weeks 5-6: External Integrations
- [ ] Apple Calendar (CalDAV via tsdav)
- [ ] IMAP Email (imapflow + nodemailer)
- [ ] Box Documents (box-node-sdk)
- [ ] MCP tools for each integration

## Weeks 7-8: Self-Modification
- [ ] PR generation workflow
- [ ] Safety validation checks
- [ ] GitHub integration for PRs
- [ ] Autonomous "perch time" timer

## Success Criteria
- All integrations functional with tests
- Self-modification creates valid PRs
- Perch time triggers reflection cycles
