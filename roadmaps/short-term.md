# Short-Term Roadmap

## Current Focus: Social & Content Feeds

### Bluesky Integration
- AT Protocol client library integration
- Read timeline and notifications
- Search posts and profiles
- MCP tools: `getFeed`, `searchPosts`, `getNotifications`

### RSS Feed Aggregation
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
