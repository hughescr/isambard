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

### Channel Discovery and Registration
Replace hardcoded channel IDs with dynamic discovery using Discord APIs.

**Problems with current approach:**
- Channel IDs hardcoded in SST config
- Must redeploy to add/remove monitored channels
- Izzy can't discover or choose channels to send to
- No way to initiate DMs with users

**Implementation:**
- [ ] Dynamic channel discovery via Discord API
  - Use `client.guilds` to get all guilds bot is in
  - Use `guild.channels` to enumerate accessible channels
  - Filter by channel type and permissions
- [ ] Auto-register channels Izzy has access to (or configurable allowlist)
- [ ] Add `listChannels` tool to Discord MCP server
  - Returns channels Izzy can see/send to
  - Include channel type (text, voice, DM, thread)
  - Include guild name for context
- [ ] Add `getDMChannel` tool (or extend listChannels)
  - Given a user ID or username, return/create DM channel
  - Allows Izzy to initiate DMs with users
- [ ] Consider: Should monitored channels (for inbox) be separate from sendable channels?

**Priority:** Medium (current hardcoded approach is limiting)

### State/Status System Overhaul (Technical Debt)
The current presence/status system is a confused mess with ad-hoc state tracking scattered across multiple components (presence manager, catch-up state manager, stream event handler). Status generation receives inconsistent context depending on code path.

**Problems:**
- State tracked in multiple places with no single source of truth
- Status context varies by code path (rich for normal messages, poor for catch-up)
- Race conditions between state transitions and status generation
- Catch-up mode flag is separate from presence phase, causing coordination issues
- Stream event handler doesn't know about catch-up context

**Proposed Solution:**
- [ ] Design proper state machine with clearly defined states:
  - `idle` - waiting for activity
  - `processing_message` - handling a direct message
  - `catching_up` - processing inbox backlog
  - `perching` - autonomous activity (future)
  - Consider: Is "interrupted" a separate state or a flag/modifier?
    - Could have `catching_up_interrupted`, `processing_message_interrupted`, `perching_interrupted`
    - Or: base state + `interrupted: boolean` flag
    - Need to think through which approach is cleaner for state transitions and status generation
- [ ] Each state defines:
  - Available tools/capabilities
  - Status prefix (💤, 💬, 📥, etc.)
  - Context available for status generation
  - Valid transitions to other states
- [ ] Single state manager as source of truth
- [ ] Status generator receives full context from state manager
- [ ] Presence updates driven by state transitions, not scattered code paths

**Priority:** Low (current system works adequately, but fragile)

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
