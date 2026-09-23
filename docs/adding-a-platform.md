# Adding a New Platform Integration

## Overview

This guide explains how to add a new communication platform to Isambard's cross-platform awareness system. Following these steps ensures the new platform participates in:

- Agent-facing MCP tools (if the platform supports interactive operations)
- Cross-platform person history (`getPersonContext`)
- Automatic activity logging
- Contact identifier resolution

The patterns established by Discord, Email, and Bluesky are the canonical examples. This guide references those implementations throughout.

---

## Architecture

### Where platform code lives

Each platform integration lives under `src/integrations/{platform}/`. For example:

- `src/integrations/discord/` — Discord bot integration
- `src/integrations/email/` — WildDuck email integration
- `src/integrations/bsky/` — Bluesky AT Protocol integration

### Module boundary rules

Module boundaries are enforced by `eslint-plugin-boundaries` via `eslint-boundaries.config.mjs`. The hierarchy from least to most dependent is:

```
utils → errors → config → storage → agent → {discord, email, bsky, your-platform} → app
```

**Key rules:**

1. Add a `boundaryElements` entry for your platform:
   ```js
   { type: 'yourplatform', pattern: 'src/integrations/yourplatform/**' }
   ```

2. Add an `allow` rule for your platform (permitted to depend on `utils`, `errors`, `config`, `storage`, `agent`):
   ```js
   { from: { type: 'yourplatform' }, allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'agent'] } } },
   ```

3. If `discord` needs to reference your platform (e.g., for approval flows), add it to the `discord` allow list too.

4. Add your type to the `app` allow list so the composition root can wire it in.

Boundary violations are caught at lint time — run `bun run lint` to verify.

### How the platform connects to the agent layer

The agent receives platform data through three channels:

1. **MCP servers** — agent-callable tools for interactive operations (read, write, send)
2. **History providers** — passive history fetched by `getPersonContext` and auto-injected context
3. **Activity logger** — fire-and-forget event recording at action sites

The composition root (`src/index.ts` and `src/app/`) wires all three together.

---

## Components to Implement

### 1. Platform Client

Create the core API wrapper under `src/integrations/{platform}/`:

**`types.ts`** — domain types for the platform (posts, messages, users, etc.)

**`src/errors/<platform>.ts`** — every existing platform's error hierarchy lives here (not inside `src/integrations/<platform>/`), re-exported from the `@/errors` barrel. See `src/errors/bsky.ts` for a complete example with `BskyError`, `BskyAuthError`, and `BskyRateLimitError`. Add your new platform's error subtree there, extending `IsambardError` (`src/errors/base.ts`), rather than creating an integration-local `errors.ts`.

**`client.ts`** — wraps the platform SDK or HTTP API. Design principles:
- Accept credentials via constructor (injected from config)
- Return typed domain objects from `types.ts`
- Throw errors from `src/errors/<platform>.ts`
- Expose methods that mirror what the MCP tools need

See `src/integrations/bsky/client.ts` for a complete example wrapping `@atproto/api`.

### 2. History Provider

The history provider is how your platform participates in `getPersonContext`.

Implement `PlatformHistoryProvider` from `src/agent/history-providers/types.ts`:

```typescript
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryEntry } from '@/agent';

export class YourPlatformHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'yourplatform';

    constructor(private readonly client: YourPlatformClient) {}

    async fetchHistory(params: HistoryFetchParams): Promise<HistoryEntry[]> {
        try {
            // fetch using params.identifier (the platform-specific identifier for this person)
            // use params.maxMessages, params.startTime, params.endTime for filtering
            // params.metadata may carry platform-specific extras (e.g. convoId, parentUri)
            const items = await this.client.getMessages(params.identifier, params.maxMessages ?? 10);
            return items.map((item): HistoryEntry => ({
                platform:  'yourplatform',
                timestamp: item.createdAt,   // ISO 8601 string
                summary:   item.text,
                direction: 'inbound',        // or 'outbound' or 'mutual'
            }));
        } catch (err: unknown) {
            logger.warn({ err }, 'YourPlatformHistoryProvider: failed to fetch history');
            return [];   // always return empty array on error — never throw
        }
    }
}
```

**Key points:**

- `params.identifier` is the platform-specific value stored in the contact record (e.g., a handle, email address). It is already resolved from the contact by the `PersonHistoryCoordinator`.
- Return `[]` on errors — a failing provider must not break history for other platforms.
- `direction` values: `'inbound'` (received from person), `'outbound'` (sent to person), `'mutual'` (shared interaction like a reaction).

See `src/integrations/bsky/history-provider.ts` for a complete example with thread, DM, and feed fetch modes.

### 3. Contact Identifiers

Add your platform name to the `PlatformType` enum in `src/storage/contacts/types.ts`:

```typescript
// Current:
export const platformTypeSchema = z.enum(['name', 'nickname', 'discord', 'email', 'bsky']);

// After adding your platform:
export const platformTypeSchema = z.enum(['name', 'nickname', 'discord', 'email', 'bsky', 'yourplatform']);
```

**What the agent sees vs internal IDs:**

- Contact identifiers exposed to the agent should be human-readable (e.g., handles, display names, email addresses).
- Internal platform IDs (e.g., Discord user IDs, Bluesky DIDs) that the agent must never see go in `contact._internal`. Add optional fields there:
  ```typescript
  const contactInternalSchema = z.object({
      discordUserId:       z.string().optional(),
      bskyDid:             z.string().optional(),
      yourPlatformUserId:  z.string().optional(),  // add here
  }).optional();
  ```
- The `PersonHistoryCoordinator` and MCP tools call `stripInternal()` before returning contacts to the agent.
- This rule is about contact identifiers specifically, not every internal ID in the system: Discord's branded `ChannelId`/`UserId` (`src/config/discord-ids.ts`) are part of the routing API the session bridge and Discord send port use directly, not something MCP tools hide. Bluesky's DID-hiding is per-tool rather than a blanket rule — `listConversations`/`getDirectMessages` resolve DIDs to handles before returning, while `getProfile`/`getPost`/`getAuthorFeed`/`searchPosts`/`getFeed` return the DID unprojected (see `docs/architecture.md`'s Platform Integrations section); follow whichever shape fits your platform's own tools rather than assuming every read must hide its native ID.

**Identifier format guidance:** The value stored in `ContactIdentifier.value` is what the history provider receives as `params.identifier`. It should be the natural identifier that uniquely addresses a person on the platform (e.g., `@handle`, `user@example.com`).

### 4. MCP Tools (if interactive)

If the platform supports agent-initiated actions (send a message, read a feed, follow a person), create an MCP server under `src/agent/`:

```
src/agent/yourplatform-mcp-server.ts
```

Follow the patterns in `src/agent/bsky-mcp-server.ts` or `src/agent/email-mcp-server.ts`:

- Use `createSdkMcpServer` and `tool` from `@anthropic-ai/claude-agent-sdk`
- Return results via `mcpTextResult`, `mcpJsonResult`, `mcpErrorResult` from `src/agent/mcp-helpers.ts`
- Accept human-readable identifiers (names, handles) where you can; hiding a native ID is about `Contact._internal` specifically, not a blanket rule for every MCP tool — expose a platform's own native ID when its routing API needs one back (see "What the agent sees vs internal IDs" above)
- For outbound actions that need admin approval, build a Discord embed and route through `BaseOutboundApprovalHandler` (see `EmailOutboundApprovalHandler` in `src/integrations/email/outbound-approval-handler.ts` or `BskyOutboundApprovalHandler` in `src/integrations/bsky/outbound-approval-handler.ts`)

### 5. Activity Logger Hooks

When your platform client performs an action (send, reject, etc.), log it via the activity logger.

First, add `ActivityType` values for your platform in `src/storage/activity-log.ts`:

```typescript
export type ActivityType
    = | 'email-sent' | 'email-rejected'
      | 'bsky-post-sent' | 'bsky-post-rejected'
      | 'bsky-dm-sent' | 'bsky-dm-rejected'
      | 'discord-exchange'
      | 'perch-start' | 'perch-end'
      | 'catchup-start' | 'catchup-complete'
      | 'yourplatform-sent' | 'yourplatform-rejected';  // add here
```

(There is no `perch-suspend`/`perch-resume`/`catchup-suspend` — the conductor's perch driver and startup catch-up turn don't suspend/resume; see the Session Architecture section of `docs/architecture.md`.)

Then wire fire-and-forget logging at the action site (typically in the MCP server handler or outbound approval handler):

```typescript
void activityLogger.log({
    type:    'yourplatform-sent',
    summary: `Sent message to ${recipient}: ${truncate(text)}`,
    tags:    ['yourplatform', recipient],
}).catch(() => undefined);
```

The logger stores entries at `/events/activity/{type}/{timestamp}` with an `[auto]` prefix so the agent knows these are framework-generated. The agent's system prompt tells it not to duplicate these with manual `logEvent` calls.

### 6. Wiring

Wire everything together in the composition root.

**`src/app/mcp-servers.ts`** — add your MCP server to the instance set `createMcpServerInstances` returns (it builds a fresh set of server instances per session role from the shared dependencies `createMcpSharedDeps` builds once). Add an optional `yourPlatformClient` field to `MCPServersOptions` (mirroring `bskyClient`), then follow the existing pattern inside `createMcpServerInstances(shared, params)`, which destructures `shared` into `options` (plus the other shared singletons) at the top of the function body:

```typescript
import { createYourPlatformMCPServer } from '@/agent';

// In createMcpServerInstances(shared, params), after `const { options, ... } = shared;`:
const yourPlatformMcpServer = options.yourPlatformClient
    ? createYourPlatformMCPServer({
        client: options.yourPlatformClient,
    })
    : undefined;
```

Fire-and-forget activity logging is called inline in the MCP tool handler itself (see "5. Activity Logger Hooks" above), not injected as a dependency here.

**`src/index.ts`** (or the relevant `src/app/*.ts` factory) — instantiate your client and history provider, then register the provider with `PersonHistoryCoordinator`:

```typescript
const yourPlatformClient   = new YourPlatformClient(config.yourPlatform);
const yourPlatformHistory  = new YourPlatformHistoryProvider(yourPlatformClient);

const coordinator = new PersonHistoryCoordinator({
    contactBackend:       contactBackend,
    providers: [
        discordHistoryProvider,
        emailHistoryProvider,
        bskyHistoryProvider,
        yourPlatformHistory,  // add here
    ],
});
```

**`src/integrations/{platform}/index.ts`** — export public API via barrel:

```typescript
export { YourPlatformClient }              from './client.js';
export { YourPlatformHistoryProvider }     from './history-provider.js';
export type { YourPlatformMessage, ... }   from './types.js';
```

Export only what other modules need. Run `bun dead-code` (knip) to verify no unused exports accumulate.

**`eslint-boundaries.config.mjs`** — add your platform element and allow rules (see Architecture section above).

---

## Checklist

- [ ] `src/integrations/{platform}/types.ts` — domain types
- [ ] `src/errors/{platform}.ts` — error hierarchy extending `IsambardError`, re-exported from `@/errors`
- [ ] `src/integrations/{platform}/client.ts` — API/SDK wrapper
- [ ] `src/integrations/{platform}/history-provider.ts` — implements `PlatformHistoryProvider`
- [ ] `src/integrations/{platform}/index.ts` — barrel exports (public API only)
- [ ] `src/storage/contacts/types.ts` — add platform to `platformTypeSchema`
- [ ] `src/agent/{platform}-mcp-server.ts` — MCP tools (if platform supports interactive ops)
- [ ] `src/storage/activity-log.ts` — add `ActivityType` values for platform actions
- [ ] Activity logger calls wired at action sites (fire-and-forget)
- [ ] `src/app/mcp-servers.ts` — register MCP server
- [ ] `src/index.ts` / `src/app/*.ts` — instantiate client, register history provider
- [ ] `eslint-boundaries.config.mjs` — add boundary element and allow rules
- [ ] All barrel exports updated; run `bun dead-code` to check for leaks
- [ ] Tests for client, history provider, and MCP server with 100% mutation score
- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero warnings
- [ ] `bun run mutate` — 100% mutation score for changed files (static/module-level mutants always re-execute locally — `tools/run-stryker.sh` prunes their stale cached verdicts before every run — so a killing test you just added will actually be picked up)
