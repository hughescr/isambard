# Short-Term Roadmap

## Completed: Bluesky Integration (Read-Only + Like)
- ✅ AT Protocol client library (`@atproto/api`) integration
- ✅ Read timeline, feeds, and notifications
- ✅ Search posts and profiles
- ✅ Like posts, follow/unfollow users
- ✅ MCP tools: `getFeed`, `getAuthorFeed`, `searchPosts`, `getPost`, `getProfile`, `getNotifications`, `likePost`, `toggleFollow`
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
