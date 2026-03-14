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

## Current Focus: RSS Feed Aggregation

### RSS Feed Reader
- Configurable feed list (stored in DynamoDB)
- Periodic polling with change detection
- MCP tools: `getFeeds`, `searchArticles`

### Unified Feed Abstraction
- Common feed item type across Bluesky and RSS
- Unified search and filtering
- Integration with perch time for richer autonomous content

## Next: Calendar Access (Read-Only)

### CalDAV Connection
- Read-only event queries via `tsdav`
- MCP tools: `getUpcomingEvents`, `checkAvailability`
- Integration with session gap tracking for time-aware context
