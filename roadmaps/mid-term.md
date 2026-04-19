# Mid-Term Roadmap (Weeks 3–8)

## Completed: Bluesky Write Capabilities
- ✅ Bluesky posting and replying (AT Protocol — full read/write/DM integration complete)
- ✅ Bluesky DM support (listConversations, getDirectMessages, sendDirectMessage with approval)

## Completed: Calendar Access (Read-Only)
- ✅ CalDAV read-only access with per-user registry via Discord `/calendar` slash commands

## Upcoming: Calendar Write
- Calendar event creation (CalDAV write)

## Upcoming: Box Documents
- Box Documents integration (box-node-sdk)

## Upcoming: Self-Improvement Loop
- PR generation workflow for self-proposed changes
- Safety validation checks before PR submission
- GitHub integration for creating and managing PRs
- Learning from PR review feedback to improve future proposals

## Upcoming: Knowledge & Context
- Advanced context window management
- Cross-conversation knowledge synthesis
- Proactive context suggestions during conversations

## Deferred: Session Introspection & Forking (claude-agent-sdk)
- The SDK exposes `listSessions`, `getSessionInfo`, `getSessionMessages`, and `forkSession` top-level functions
- Today Izzy tracks session IDs via `src/storage/task-session/backend.ts` but cannot introspect her own past transcripts except through memory-logged summaries
- Build a new MCP server (e.g. `src/agent/session-mcp-server.ts`) exposing tools to list past sessions, inspect their metadata/messages, and branch from a past point via `forkSession`
- Useful for richer self-reflection and parallel exploration (e.g. perch forks from last interactive session instead of linear resume)
- Evaluate once the Phase 2 hook foundation is stable and a concrete use case emerges

## Deferred: Centralized Tool Permission Gate (canUseTool)
- The SDK exposes a `canUseTool` callback (and overlapping `PermissionRequest` hook) for fine-grained per-call permission decisions
- Today outbound Bluesky (reply, DM) and email send flows implement approval inside each MCP server — logic is scattered across per-MCP handlers
- Route all outbound write tools through a single `canUseTool` callback that delegates to `ApprovalSagaExecutor`, replacing per-MCP approval routing
- Security-critical cutover — not worth rushing until the hooks foundation has bedded in
- Evaluate after Phase 2 hooks have soaked and approval-saga integration is confirmed stable
