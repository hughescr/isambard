# Short-Term Roadmap

## Completed: Bluesky Integration (Full Read/Write/DM)
- ✅ AT Protocol client library (`@atproto/api`) integration
- ✅ Read timeline, feeds, and notifications
- ✅ Search posts and profiles
- ✅ Like posts
- ✅ Idempotent `follow` and `unfollow` (split from `toggleFollow`)
- ✅ Write capabilities: `sendPost`, `replyToPost` with allowlist-gated Discord approval workflow
- ✅ DM support: `listConversations`, `getDirectMessages`, `sendDirectMessage` with approval
- ✅ Safety rails: fail-closed guard, DID resolution, self-reply bypass
- ✅ Grapheme-based text validation (`validatePostText`, `validateDMText`)
- ✅ 14 MCP tools: `getFeed`, `getNotifications`, `searchPosts`, `getPost`, `getProfile`, `getAuthorFeed`, `likePost`, `follow`, `unfollow`, `sendPost`, `replyToPost`, `listConversations`, `getDirectMessages`, `sendDirectMessage`
- ✅ Config via SST secrets (`BskyHandle`, `BskyAppPassword`)
- ✅ 100% mutation score

## Completed: Calendar Access (Read-Only)
- ✅ Read-only event queries via `tsdav` (CalDAV)
- ✅ MCP tools: `getCalendarEvents`, `getUpcomingEvents`, `listUserCalendars`
- ✅ Calendar context injected into user message prefix and perch context via `context-builder.ts`

## Completed: Contacts System
- ✅ DynamoDB-backed contact storage with cross-platform identity resolution
- ✅ Contact key generator with CONTACT_LOOKUP GSI for identifier-based lookups
- ✅ Discord slash commands: `/contact add`, `/contact list`, `/contact delete` with confirmation buttons
- ✅ Contacts MCP server for agent access (lookupContact, searchContacts, createContact, updateContact, deleteContact)
- ✅ Fuzzy name matching and multi-platform identifier support (Discord, Email, Bluesky)
- ✅ 100% mutation score

## Completed: Cross-Platform History & Activity Logging
- ✅ `PersonHistoryCoordinator` aggregating history from Discord, Email, and Bluesky providers
- ✅ Platform-specific history providers (Discord message history, Bluesky feed, email)
- ✅ Activity auto-logger for recording cross-platform interactions
- ✅ User context MCP server for cross-platform awareness
- ✅ 100% mutation score

## Completed: Video/Media Processing
- ✅ Full video processing pipeline: scene detection, frame extraction, transcription, spectrogram
- ✅ Media MCP server extracted as generic cross-platform tool (analyzeVideoFromUrl, analyzeLocalVideo, getVideoFrames, generateSpectrogramFromAudio)
- ✅ ffmpeg-based processing with spawn runner and timeout protection
- ✅ Video analysis markdown builder for structured output
- ✅ 100% mutation score

## Completed: Service Infrastructure
- ✅ Health registry for service status monitoring
- ✅ Reconnection loop with exponential backoff for external service resilience
- ✅ Lifecycle orchestrator for startup sequencing and graceful shutdown
- ✅ Outbox pattern for reliable message delivery (DynamoDB-backed with drainer)
- ✅ Approval saga for distributed multi-step approval workflows
- ✅ 100% mutation score

## Current Focus: RSS Feed Aggregation

### RSS Feed Reader
- Configurable feed list (stored in DynamoDB)
- Periodic polling with change detection
- MCP tools: `getFeeds`, `searchArticles`

### Unified Feed Abstraction
- Common feed item type across Bluesky and RSS
- Unified search and filtering
- Integration with perch time for richer autonomous content

## Tech Debt: TypeScript Strictness

- Enable `noUncheckedIndexedAccess` in `tsconfig.json` to get compile-time safety for array/object index access. Will require fixing all sites where TypeScript infers `T | undefined` for array element access.

## Upcoming: Person-Based Allowlists

Currently email and Bluesky allowlists use raw identifiers (email addresses, Bluesky handles). With the contacts system in place, allowlists should reference person IDs instead: "craig-hughes is allowed to receive emails" rather than per-address entries.

### Benefits
- Adding a new email address to a contact automatically extends that person's allowlist coverage
- Revoking a person revokes all their identifiers in one operation
- Single source of truth — contact record is the authority on who a person is

### Work Items
- Migrate email allowlist storage from raw addresses to person IDs
- Migrate Bluesky allowlist storage from raw handles to person IDs
- Update allowlist check logic to resolve person ID → current identifiers at check time
- Update Discord slash commands (`/allowlist add`, `/allowlist remove`) to accept person names/IDs
- Maintain backwards-compatible read path during migration

## Upcoming: Memory Path Migration: `/users/{discordUserId}/` → `/users/{personId}/`

Currently per-user memories use Discord numeric user IDs as path keys (e.g. `/users/123456789/`). With the contacts system, migrate to person IDs for platform-agnostic user memory loading.

### Benefits
- Memory survives platform changes — a person's memory doesn't fragment if their Discord ID changes
- Cross-platform: same memory path regardless of whether the message came from Discord, email, or Bluesky
- Human-readable paths (`/users/craig-hughes/` vs `/users/123456789/`)

### Work Items
- Add contact resolver bridge: map incoming Discord user ID → person ID at the point memory paths are constructed
- Write migration script to rename existing `/users/{discordUserId}/` paths to `/users/{personId}/`
- Update `context-builder.ts` to use person ID when loading user memory context
- Update memory MCP server path handling to accept person IDs
- Handle the unmapped case (no contact for a given Discord user ID) gracefully
