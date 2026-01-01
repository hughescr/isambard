# Short-Term Roadmap

## Current Focus

### Session Gap Tracking
Catch up on messages posted while offline when connecting to any service.

**Implementation:**
- [ ] Detect connection events (Discord ready, future: email connect, calendar sync, etc.)
- [ ] Query for messages/events since last known timestamp
- [ ] Summarize missed activity and present context to agent
- [ ] Update "last seen" markers per channel/service

**Scope:** Initially Discord, but design for extensibility to email, calendar, Bluesky, RSS feeds.

### Perch Time (Autonomous Activity)
Allow Isambard to wake up and pursue its own interests and goals.

**Implementation:**
- [ ] Timer/scheduler for autonomous wake-up cycles
- [ ] Design system prompt for autonomous mode
  - Encourage exploration and self-directed activity
  - Avoid prescribing specific activities
  - Discourage sloth/inaction without being directive
  - Strike balance between initiative and restraint
- [ ] Define boundaries for autonomous actions (what requires human approval)
- [ ] Logging/journaling of autonomous activity for transparency

**Note:** Prompt design is critical - must encourage agency without undue influence on direction.

### Calendar Access (Read-Only)
Read-only access to Apple Calendar for scheduling context.

**Implementation:**
- [ ] CalDAV connection via tsdav
- [ ] Read-only event queries
- [ ] MCP tools for calendar context (upcoming events, availability)
- [ ] Integration with session gap tracking (catch up on calendar changes)

---

## Previously Completed
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
