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
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryFetchResult, HistoryEntry } from '@/agent';

export class YourPlatformHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'yourplatform';

    constructor(private readonly client: YourPlatformClient) {}

    async fetchHistory(params: HistoryFetchParams): Promise<HistoryFetchResult> {
        try {
            // fetch using params.identifier (the platform-specific identifier for this person)
            // use params.maxMessages, params.startTime, params.endTime for filtering
            // params.scope carries your platform's typed HistoryScope variant, if it has one
            const { items, more } = await this.client.getMessages(params.identifier, params.maxMessages ?? 10);
            return {
                platform:  'yourplatform',
                entries:   items.map((item): HistoryEntry => ({
                    platform:  'yourplatform',
                    timestamp: item.createdAt,   // ISO 8601 string
                    summary:   item.text,
                    direction: 'inbound',        // or 'outbound' or 'mutual'
                })),
                coverage:  'complete',           // zero entries here means genuinely no matches
                truncated: more,                 // more may exist: a fetch cap, a page, or sources skipped by a cap
                failures:  [],
            };
        } catch (err: unknown) {
            logger.warn({ err }, 'YourPlatformHistoryProvider: failed to fetch history');
            // never return an empty "complete" result for a failure, and never throw
            return {
                platform:  'yourplatform',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [{ source: 'messages', category: 'transient', error: err }],
            };
        }
    }
}
```

**Key points:**

- `params.identifier` is the platform-specific value stored in the contact record (e.g., a handle, email address). It is already resolved from the contact by the `PersonHistoryCoordinator`.
- Report errors in the result, not as an empty list: `coverage: 'unavailable'` when nothing could be read, `'partial'` when some sources (channels, mailboxes) failed and others were read, with one `failures` entry per failed source. `source` is a non-sensitive label (it reaches the model); `error` stays internal. Discovery steps (looking up a DM channel, listing channels) are sources too: catch their failures per source so the others still contribute, rather than letting one reject the whole fetch. A failing provider must still not break history for other platforms — the coordinator also turns a rejected call into an unavailable result.
- If your platform needs extra per-contact data from `Contact._internal`, add a variant to `HistoryScope` in `src/agent/history-providers/types.ts` and a case to `buildHistoryScope` in the coordinator (the exhaustive switch fails typecheck until you do, once the platform is added to `knownPlatformSchema`).
- `direction` values: `'inbound'` (received from person), `'outbound'` (sent to person), `'mutual'` (shared interaction like a reaction, or when you cannot tell).
- Cursor-backed providers must continue fetching until the requested time window is covered or the cursor exhausts. If a local fetch or discovery page cap stops a cursor while matching records may remain, set `truncated: true`; a zero-entry result with `truncated: true` is not proof that no history exists. Use `complete` with `truncated: true` for a successfully read but bounded source set, rather than treating that bounded observation as an unqualified empty result.
- The coordinator reports your platform in the tool's `coverage` block: `notConfigured` when no provider is registered, `notApplicable` when the contact has no identifier on it, `unavailable` without a call when service health already reports it down.

See `src/integrations/bsky/history-provider.ts` for a complete example with author-feed and direct-conversation scopes, and `src/integrations/discord/history-provider.ts` for per-channel partial coverage.

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
- Never put a zod `.default()` (or `.optional().default()`) in a tool's input shape. The SDK validates tool arguments with its own bundled zod, which rejects an omitted defaulted field ("expected nonoptional, received undefined") even though the schema advertised to the model marks it optional. Declare the field `.optional()`, apply the default in the handler (`args.limit ?? 5`), and state it in the `.describe()` text. `tests/unit/agent/mcp-tool-input-schema-guard.test.ts` enforces this for every registered tool; add your server factory to it.
- Return results via `mcpTextResult`, `mcpJsonResult`, `mcpErrorResult` from `src/agent/mcp-helpers.ts`
- Accept human-readable identifiers (names, handles) where you can; hiding a native ID is about `Contact._internal` specifically, not a blanket rule for every MCP tool — expose a platform's own native ID when its routing API needs one back (see "What the agent sees vs internal IDs" above)
- For outbound actions that need admin approval, expose plain approval operations from your integration — inputs are identifiers and decisions, never Discord interactions, and approvals are recorded through `ApprovedOutboundActionWriter` (see `EmailOutboundApprovals` in `src/integrations/email/outbound-approvals.ts` or `BskyOutboundApprovals` in `src/integrations/bsky/outbound-approvals.ts`). Then add a Discord adapter under `src/integrations/discord/approvals/` that extends `DiscordOutboundApprovalInteractionHandler` and owns the card, buttons, modal and embed parsing (see `email-adapter.ts` / `bsky-adapter.ts`). Your integration folder must not import `discord.js` or `@discordjs/*`.

### 5. Activity Logger Hooks

When your platform performs an action (send, reject, etc.), log it via the activity logger. The event must describe what has actually happened — an admin approval is not a successful send.

First, add `ActivityType` values for your platform in `src/agent/activity-types.ts` (storage's activity logger is generic; the agent owns the action vocabulary):

```typescript
export type ActivityType
    = | 'email-send-approved' | 'email-sent' | 'email-rejected'
      | 'bsky-reply-approved' | 'bsky-post-sent' | 'bsky-post-rejected'
      | 'bsky-dm-approved' | 'bsky-dm-sent' | 'bsky-dm-rejected'
      | 'discord-exchange'
      | 'perch-start' | 'perch-end'
      | 'catchup-start' | 'catchup-complete'
      | 'yourplatform-send-approved' | 'yourplatform-sent' | 'yourplatform-rejected';  // add here
```

(There is no `perch-suspend`/`perch-resume`/`catchup-suspend` — the conductor's perch driver and startup catch-up turn don't suspend/resume; see the Session Architecture section of `docs/architecture.md`.)

For a direct action that does not need approval, log the `*-sent` event only after the client call succeeds. For an approval-backed action, inject the activity logger into both the approval service and the `ApprovedOutboundActionExecutor` when wiring them in `src/index.ts`:

1. After the approval service has durably created its `ApprovedOutboundAction`, fire-and-forget a `*-approved` event. This records the admin decision, not delivery.
2. Extend the executor's action-to-activity mapping for the new action type. It emits the `*-sent` event only after the executor has successfully sent and durably settled the action as `executed`; it must not be emitted by the approval handler.
3. Log a `*-rejected` event after a rejection is recorded.

For example, an approval handler logs this after its `actionWriter.create()` completes:

```typescript
void activityLogger.log({
    type:    'yourplatform-send-approved',
    summary: `Message to ${recipient} approved for sending`,
    tags:    ['yourplatform', recipient],
}).catch(() => undefined);
```

The executor owns the eventual sent event, using the same fire-and-forget pattern only from its settled-success path:

```typescript
void activityLogger.log({
    type:    'yourplatform-sent',
    summary: `Message sent to ${recipient}`,
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

For direct MCP actions, fire-and-forget activity logging can be called inline after the client action succeeds. Approval-backed actions need the activity logger injected into the approval service and the `ApprovedOutboundActionExecutor` here, so approval and settled-success events occur at their respective lifecycle points (see "5. Activity Logger Hooks" above).

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
- [ ] `src/agent/activity-types.ts` — add `*-approved`, `*-sent`, and rejection `ActivityType` values as applicable
- [ ] Direct actions log `*-sent` only after the client action succeeds (fire-and-forget)
- [ ] Approval handlers log `*-approved` after their durable approval write; never `*-sent`
- [ ] `ApprovedOutboundActionExecutor` maps approval-backed actions to `*-sent` and logs only from the settled-success path
- [ ] `src/app/mcp-servers.ts` — register MCP server
- [ ] `src/index.ts` / `src/app/*.ts` — instantiate client, register history provider
- [ ] `eslint-boundaries.config.mjs` — add boundary element and allow rules
- [ ] All barrel exports updated; run `bun dead-code` to check for leaks
- [ ] Tests for client, history provider, and MCP server with 100% mutation score
- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero warnings
- [ ] `bun run mutate` — 100% mutation score for changed files (static/module-level mutants always re-execute locally — `tools/run-stryker.sh` prunes their stale cached verdicts before every run — so a killing test you just added will actually be picked up)
