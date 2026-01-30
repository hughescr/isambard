# Short-Term Roadmap

## Current Focus

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

### Perch Time Phase 1 (Completed January 2026)
Autonomous activity system allowing Isambard to wake up and pursue its own interests.

**What was implemented:**
- 5 time slots with graduated suggestion levels:
  - Early Morning (5-7am): gentle nudge (10% chance)
  - Morning (8am-12pm): moderate suggestion (30% chance)
  - Afternoon (1-5pm): strong suggestion (50% chance)
  - Evening (6-9pm): very strong suggestion (70% chance)
  - Late Evening (10pm-12am): moderate suggestion (30% chance)
- Hourly triggers with random jitter (0-14 minutes, using cron-parser `H` syntax)
- Deferral when busy (checks inbox queue and recent conversation activity)
- Interruption handling (graceful pause/resume when user sends message)
- Presence indicators:
  - 🦉 - Autonomous perch mode
  - 🦉💬 - Perch interrupted by user message
- System prompt encouraging exploration and self-directed activity
- Logging and transparency for autonomous actions

**Future work (Phase 2):**
- External integrations for richer content:
  - News feeds and current events
  - Weather conditions
  - RSS feed aggregation
  - Bluesky timeline
- Digest generation with real content from external sources
- Enhanced perch activities beyond simple musings

### Earlier Completed Features
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
