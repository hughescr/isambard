# Long-Lived Session — Phase 2 & Phase 4 Plan

**Date:** 2026-09-06

**Design artifact:** [izzy-long-lived-session.html](../../../../../private/tmp/claude-501/-Users-craig-code-hughescr-isambard/558c1214-5bef-47c8-95da-5234cf1d56f4/scratchpad/izzy-long-lived-session.html) — read section 10 for the Phase 2 ("Memory tuning and pull tools") and Phase 4 ("Notification routing") scope this plan implements, including the 3.1 table and the standing decisions (no pre-compaction checkpoint turn, post-compaction boot bundle, cross-platform history is tool-only, presence only for visibility, cron tools stay off, one shared conversation session, perch is its own session).

**Phase 1 plan:** [long-lived-session-phase1.md](./long-lived-session-phase1.md) — read its Plan amendments and the Q6–Q12 sections for the landed primitive names this plan builds on (`conductor.submit`, envelope builders, `createContextPolicy`, `createBootBundleBuilder`, the ledger, session journal partitions, the WildDuck/Bluesky integrations, `LiveSignals`, the health registry, and the perch `buildPerchContext` sections).

**Scope note:** every package here builds on conductor mode only — the one-shot session path is assumed gone (P13b in the Phase 1 numbering).

**Total points: 106**

---

## Plan amendments (binding on every package)

Added 2026-09-06 after the completeness critic, before any package starts. Package ids in this plan are Q1-Q12 so they never collide with the Phase 1 plan's P1-P14.

- **B1. Notification core is assembled in the composition root.** Q5 includes wiring the bridge into `src/app/` (the same place the conductors are built) so sources have one entry point; no source package wires its own bridge.
- **B2. One notify contract.** Every source calls `notify({ source, priority: 'accumulate'|'wake', dedupeKey: string, text, at })`; `dedupeKey` is required, and the coalescer keys on it. Q5 owns the type; Q6-Q8 conform.
- **B3. State delta diffs the top set with previews.** Q9 tracks the same top-8-full plus 30-preview set the boot bundle renders, not path names alone, and emits only items that entered the top set or whose content changed.
- **B4. Cost ceiling survives restart and is visible.** Q3 persists the day's spend and the paused flag in the session journal partition (or the resume-store item), restores them at boot, and the pause is rendered in presence and logged; Discord turns are never paused.
- **B5. Shared health test double.** Q2 adds `tests/helpers/fake-health-registry.ts`; Q6 and later reuse it.
- **B6. New package Q12 — Phase 2 leftovers.** Calendar diff in envelopes (hourly host poll, inject only when the day's agenda changed), service health pushed into the envelope on change (not only pulled), and the perch envelope receiving the same memory tuning (state delta, health on change) as Discord envelopes. Depends on Q9. Points: 8.
- **B7. Scope note.** "Injection windows tuned from observed compaction events" is delivered as compaction-threshold observability and tuning (Q4, Q11); tuning the per-user memory window and the boot-bundle event window from evidence is a follow-on once compaction data exists.

## Package order

| ID | Title | Points | Depends on |
|----|-------|--------|------------|
| Q1 | Rejected-drafts pull tool | 5 | — |
| Q2 | Service-health pull tool | 8 | — |
| Q3 | Daily cost ceiling pauses perch, never Discord | 13 | — |
| Q4 | Compaction threshold observability | 10 | — |
| Q5 | Notification core: bridge, outage predicate, coalescer, and the conductor's non-turn append seam | 13 | — |
| Q6 | Health-outage notification source | 6 | Q5 |
| Q7 | Email and approval-outcome notification routing | 13 | Q5 |
| Q8 | Bluesky DM accumulate poller and rejection wake | 16 | Q5 |
| Q9 | State top-set delta tracker | 11 | — |
| Q11 | Compaction threshold tuning from observed events | 11 | Q3, Q4 |

(Q10 was dropped during challenge — see Challenge Outcomes below. Numbering is preserved from the working set rather than renumbered, so Q11 follows Q9 directly.)

---

## Q1 — Rejected-drafts pull tool

**Design phase:** 2

**Goal:** Add a `getRejectedDrafts` tool to the email MCP server that reuses context-builder's existing admin-rejected/gave-up subsection builders, so pull-tool and push-section text cannot drift.

**Depends on:** none · **Deployable:** yes · **Points:** 5

### Files & changes

- `src/agent/context-builder.ts` — Export `buildAdminRejectedSubsection` (L215) and `buildGaveUpSubsection` (L238) unchanged; `loadUnifiedContext`'s own use at L568/L576 is untouched.
- `src/agent/email-mcp-server.ts` — Register a `getRejectedDrafts` tool (`readOnlyHint`, wrapped in `withHealthGuard(healthRegistry,'email',reconnectionLoop)` like the other read tools at L383/L421) calling `searchByKeyword('Drafts','SendRejectedByAdmin')` and `('Drafts','DiscordNotifyGaveUp')`, then the two exported builders.
- `tests/unit/agent/email-mcp-server.test.ts` — Add a `getRejectedDrafts` describe block using the existing `getToolHandler()`/`getText()` idiom.

### Tests first

- `getRejectedDrafts` with both searches empty returns an empty-but-valid result
- admin-rejected-only, gave-up-only and both-populated outputs are byte-identical to `buildAdminRejectedSubsection`/`buildGaveUpSubsection` for the same fixture
- health-guard: returns the unavailable result when email is offline

### Acceptance

- `bun test tests/unit/agent/email-mcp-server.test.ts` passes
- Pull text asserted byte-for-byte against the shared exported builders (no duplicate formatter)
- `GITHUB_SHA=local-sandbox bun mutate` scores 100% on the touched files

---

## Q2 — Service-health pull tool

**Design phase:** 2

**Goal:** Expose `ServiceHealthRegistry.getAll()`/`buildStatusSummary()` as a read-only `getServiceHealth` MCP tool, deliberately NOT wrapped in `withHealthGuard` so it still answers during an outage, and wire it all the way through session `allowedTools`/`mcpServers` for both the conversation and perch conductors so the model can actually reach it.

**Depends on:** none · **Deployable:** yes · **Points:** 8

### Files & changes

- `src/agent/health-mcp-server.ts` — New: `createHealthMCPServer({ healthRegistry })` with one `getServiceHealth` tool (`readOnlyHint:true`, `destructiveHint:false`) returning `getAll()` entries plus `buildStatusSummary()`; no `withHealthGuard`/`withWriteHealthGuard` wrapper of any kind.
- `src/agent/index.ts` — Barrel-export `createHealthMCPServer` alongside the other MCP server exports.
- `src/app/mcp-servers.ts` — Add `healthMcpServer?: McpServerConfig` to `MCPServers` (near `emailMcpServer` ~L245) and instantiate it in `createMcpServerInstances` (L335+, return ~L451-463) from the existing `options.healthRegistry` (L125), constructed whenever a registry is supplied.
- `src/agent/session/query-options.ts` — Add `'health'` to the closed `SessionMcpServerName` union (L22-33) and to `OPTIONAL_MCP_SERVER_ORDER` (L105-107) so `buildAllowedTools` emits `mcp__health__*` whenever a health server is configured.
- `src/app/sessions.ts` — Add `health: mcpInstances.healthMcpServer` to the `SessionMcpServers` literal in BOTH `createConversationConductor` (~L107-119) and `createPerchConductor` (~L296-306) — perch is exactly where visibility into an outage matters most.
- `tests/unit/agent/health-mcp-server.test.ts` — New: uses `mcp-helpers.test.ts`'s `makeRegistry()`/`makeEntry()` mock shape (copy the file-local helpers; they are not exported).
- `tests/unit/app/mcp-servers.test.ts` — Assert `healthMcpServer` is returned when `healthRegistry` is supplied and omitted when it is not.
- `tests/unit/agent/session/query-options.test.ts` — Add `'health'` to the pinned `names` array (L52) so the `SessionMcpServerName`/`OPTIONAL_MCP_SERVER_ORDER` additions are covered; add/extend a case asserting `mcp__health__*` appears in `allowedTools` only when a health server is configured.
- `tests/unit/app/sessions.test.ts` — Extend `FULL_MCP_SERVERS` (~L43-53) with a `healthMcpServer` entry and assert both `createConversationConductor` (~L242-252) and `createPerchConductor` (~L419-431) map `health:` through into `sessionMcpServers`/`mcpServersOption`.

### Tests first

- `getServiceHealth` returns state/epoch/lastError per `ServiceName`
- `buildStatusSummary` text is included when it is defined and omitted when undefined
- the tool is reachable while a service is `'offline'` (no health guard), including when every registered service is offline/disabled
- `createMcpServerInstances` wires `healthMcpServer` into the returned object when `healthRegistry` is supplied, and omits it otherwise
- `buildAllowedTools` includes `mcp__health__*` when the health server is configured, and `OPTIONAL_MCP_SERVER_ORDER`/`SessionMcpServerName` additions are covered by the existing pinned-list test
- both `createConversationConductor` and `createPerchConductor` pass health through into their `SessionMcpServers`/`mcpServers` output

### Acceptance

- `bun test` on all listed test files passes
- grep confirms no `withHealthGuard`/`withWriteHealthGuard` wrapper in `health-mcp-server.ts`
- mutation 100% on `health-mcp-server.ts` and the touched hunks in `mcp-servers.ts`, `query-options.ts`, and `sessions.ts`
- `getServiceHealth` is present in a live session's `allowedTools`/`mcpServers` for both conversation and perch roles when a `healthRegistry` is configured (not just constructed as a standalone MCP server object)

---

## Q3 — Daily cost ceiling pauses perch, never Discord

**Design phase:** 2

**Goal:** A day-bucketed spend accumulator (independent of `ledger.cost.cumulativeUsd`'s `session_opened` reset at `ledger.ts:336-341`) tracks per-store `cumulativeUsd` deltas across the conversation AND perch ledger stores; when the day's total crosses a configured USD ceiling, the perch scheduler's trigger paths skip via an injected `isCostPaused()` predicate that is threaded from `src/index.ts` through `DiscordBotOptions` and `setupPerchDriverAndScheduler` into `createPerchScheduler`'s deps — WITHOUT ever stopping the scheduler's own reschedule loop, so the pause self-clears at local midnight with no restart. Discord's `priority:'human'` path and `conductor-processor.ts` are structurally untouched.

**Depends on:** none · **Deployable:** yes · **Points:** 13

### Files & changes

- `src/agent/session/cost-ceiling.ts` — New: `createCostCeiling({ clock, timezone, ceilingUsd })` → `{ record(ledger, event), isPaused() }`. Internally keeps, per distinct `LedgerStore` identity passed to `record`, a `lastSeenCumulativeUsd` baseline (initialized on first `record()` call for that store, not assumed 0), and on each call computes `delta = Math.max(0, ledger.cost.cumulativeUsd - lastSeen)`, adds `delta` to the current local-calendar-day bucket (via `DateTime.fromMillis(clock.now(), { zone: timezone })`), then sets `lastSeen = ledger.cost.cumulativeUsd`. Deliberately event-type-agnostic: a `session_opened` reset (`ledger.ts:336-341`, which zeroes `cumulativeUsd` only) makes the next delta negative, which clamps to 0 and re-baselines cleanly — no special-casing of `event.type` needed, and repeat notifications with unchanged `cumulativeUsd` add nothing. Rolls the bucket over (and clears `isPaused()`) when clock-derived local day changes. `ceilingUsd` undefined = never paused. `at >=` not `>` per test 1.
- `src/agent/session/index.ts` — Barrel-export `createCostCeiling` and its types (`CostCeiling`, `CreateCostCeilingParams` or similar).
- `src/agent/perch/scheduler.ts` — Add optional `isCostPaused?: () => boolean` to `PerchSchedulerDeps` (L20 area). Extend ONLY the `onScheduledTrigger` guard (~L150, currently `if(!config.enabled) { scheduleNextTrigger(); return; }`): add a second, separately-mutation-visible statement immediately after it — `if(deps.isCostPaused?.()) { logger.debug('Perch trigger skipped - cost ceiling reached'); scheduleNextTrigger(); return; }` — so it still reschedules (do NOT reuse `config.enabled`'s `Stryker disable next-line` comment for this new arm). Do NOT touch `start()`'s guard at L291 (`if(!config.enabled) { logger.info(...); return; }`) — gating `start()` there would skip `scheduleNextTrigger()` and the `stateManager` subscription permanently for any process that boots already over the ceiling, since nothing else re-enters `start()`. `config.enabled` semantics are unchanged.
- `src/config/schemas.ts` — Add `dailyCostCeilingUsd: z.number().positive().optional()` AND `timezone: z.string().default(resolveTimezone())` to `sessionConfigSchema` (L281-294); undefined ceiling disables the ceiling entirely. `timezone` mirrors `perchConfigSchema`'s existing pattern (`schemas.ts:164`) and gives the ceiling a config-sourced timezone independent of whether perch is configured.
- `src/config/loader.ts` — Add `dailyCostCeilingUsd: env.get('SESSION_DAILY_COST_CEILING_USD').asFloatPositive()` and `timezone: resolveTimezone()` to the session block (L94-99), matching perch's existing direct `timezone: resolveTimezone()` assignment (`loader.ts:81`).
- `src/integrations/discord/setup/perch-setup.ts` — Add `isCostPaused?: () => boolean` to `SetupPerchDriverParams` (interface at ~L159-173) and forward it into the `createPerchScheduler({...})` call at L272 ONLY. Leave `setupPerchSessionRunnerAndScheduler`'s L134 call (the oneshot path) untouched — P13b deletes that path.
- `src/integrations/discord/bot.ts` — Add `isCostPaused?: () => boolean` to `DiscordBotOptions` (interface at L89) and forward `options.isCostPaused` into the `setupPerchDriverAndScheduler({...})` call at L997. Do NOT thread it into the L1012 `setupPerchSessionRunnerAndScheduler` call (oneshot path, unchanged).
- `src/index.ts` — Construct the ceiling (`config.session.dailyCostCeilingUsd`, `config.session.timezone`, `systemClock`) once, subscribe it to `conversationLedgerStore` and `perchLedgerStore` via `?.subscribe((ledger, event) => ceiling.record(ledger, event))` (optional chaining only — both stores are `LedgerStore | undefined`, assigned only inside existing conductor-mode blocks at L831/L889, which the acceptance below now permits), and pass `isCostPaused: ceiling.isPaused` into the `createDiscordBot(...)` options object at L936. No new `if`/ternary beyond that existing optional chaining.
- `tests/unit/agent/session/cost-ceiling.test.ts` — New, FakeClock-driven.
- `tests/unit/agent/perch/scheduler.test.ts` — Add: (a) cost-paused-skips-but-still-reschedules — `isCostPaused()` true means `onScheduledTrigger` does not call `onPerchTrigger` but DOES call `scheduleNextTrigger` again (assert via a second advance); (b) unpaused-still-triggers; (c) `isCostPaused()` flips false→true→false across two scheduled ticks without any `stop()`/`start()` and the scheduler still fires on the third tick — proves pause is not permanent.
- `tests/unit/integrations/discord/setup/perch-setup.test.ts` — Extend the existing captured-deps assertion (~L100) to assert `isCostPaused` is forwarded to `createPerchScheduler`'s deps by identity when passed, and that omitting it from params leaves it undefined (kills add/drop-property mutants).
- `tests/unit/integrations/discord/bot.test.ts` — Add a case asserting `options.isCostPaused` reaches the `setupPerchDriverAndScheduler` call by identity, if `bot.ts`'s perch-setup call site is mutation-reachable from an existing test harness there; otherwise document why it is covered transitively via `perch-setup.test.ts`.

### Tests first

- turns from both roles accumulate into one day bucket via `cumulativeUsd` deltas; crossing `ceilingUsd` flips `isPaused()` at `>=` not `>`
- a second `record()` call with an unchanged `cumulativeUsd` (e.g. a non-cost ledger notification, or a bare result frame with no turn open per `ledger.ts:122-129` leaving `lastTurnUsd` stale) adds nothing — no double count
- a `session_opened` reset (`cumulativeUsd` drops to 0) does not book a negative delta and does not zero the day bucket; the next turn's delta is measured from the new baseline
- advancing FakeClock past local midnight resets the bucket and clears `isPaused()`
- a DST 23-hour and a 25-hour local day each roll over exactly once
- `ceilingUsd` undefined leaves `isPaused()` false for any spend
- scheduler's `onScheduledTrigger` skips `onPerchTrigger` when `isCostPaused()` is true and `enabled` is true, but still calls `scheduleNextTrigger`; still triggers normally when `isCostPaused()` is false or absent
- `isCostPaused()` toggling false/true/false across successive scheduled ticks (no stop/start) is honored on each tick — pause is never permanent
- `perch-setup.ts` forwards `isCostPaused` to `createPerchScheduler`'s deps by identity; omitted param leaves it undefined

### Acceptance

- `bun test` on all listed test files passes; typecheck and lint clean
- No cost-ceiling symbol appears in `conductor-processor.ts` or any `priority:'human'` submit path (grep-checked)
- `start()`'s L291 `config.enabled` guard in `scheduler.ts` is byte-for-byte unchanged
- `src/index.ts` hunk adds no `if`/ternary beyond the pre-existing optional chaining required by `conversationLedgerStore`/`perchLedgerStore` already being `LedgerStore | undefined`
- mutation 100% on `cost-ceiling.ts`, the new `onScheduledTrigger` cost-paused arm (not reusing `config.enabled`'s existing Stryker-disable comment), and the `isCostPaused` pass-through in `perch-setup.ts` and `bot.ts`

---

## Q4 — Compaction threshold observability

**Design phase:** 2

**Goal:** Make `CompactionGuard`'s threshold a live, state-preserving value, expose it on the `Conductor` surface so a future caller (Q11) can actually reach it, and record structured per-compaction telemetry fed only by ledger events the system genuinely dispatches today (`compaction_started`, `compaction_failed`, and the `sdk_frame` carrying `system`/`compact_boundary` — never the never-dispatched `compaction_finished` event type). Deploying this changes no runtime behaviour: the new accessors are additive and nothing yet calls the setter.

**Depends on:** none · **Deployable:** yes · **Points:** 10

### Files & changes

- `src/agent/session/compaction-guard.ts` — Replace the destructured `const thresholdPercent` (L64) with a mutable cell; add `getThresholdPercent()`/`setThresholdPercent(n)` to the `CompactionGuard` interface (L43-58) and its implementation (return object at L105). The setter must not touch `skipRemaining` (L69) or `nextBackoffSkips` (L68), and `onTurnEnd`'s L124 comparison must read the live cell.
- `src/agent/session/compaction-telemetry.ts` — New: `createCompactionTelemetry({ getThresholdPercent, maxRecords? })` returns `{ record(event: LedgerEvent): void, getRecords(): readonly CompactionTelemetryRecord[] }`. `record()` opens a `{ startedAt, thresholdAtStart: getThresholdPercent() }` entry on `'compaction_started'` UNLESS a record is already open (no `finishedAt`/`failedAt` yet) — a second `compaction_started` while one is open is ignored, not a new record — because both `compaction-guard.ts`'s own `submit()` (L93) and `sessions.ts`'s PreCompact-hook `compactionSink.onCompactionStart` (`sessions.ts` L168, L352) dispatch `compaction_started` for the same real compaction, and `createLedgerStore.dispatch`'s reference-equality gate (`ledger.ts` L452-454) does not reliably collapse the duplicate (`reduceCompactionStarted` returns a new reference whenever `ledger.turn` is non-null, `ledger.ts` L288-297, so both dispatches usually DO reach a subscriber). Closes the open record's `finishedAt` on an `'sdk_frame'` event whose frame is `{type:'system', subtype:'compact_boundary'}` (the actual, currently-only, production success signal — `ledger.ts` L216-218) or on the declared-but-currently-undispatched `'compaction_finished'` event type (kept for forward compatibility, harmless no-op today). Closes with `failedAt`/`failureReason` on `'compaction_failed'`. A terminal event with no open record (e.g. a lone `compaction_failed`) is a documented no-op, not an error. Keeps at most `maxRecords` (default e.g. 50) records, evicting the oldest completed-or-open record first.
- `src/agent/session/index.ts` — Barrel-export `createCompactionTelemetry` and its types next to the existing compaction-guard export block (L98-103).
- `src/agent/session/conductor.ts` — Add `getCompactionThresholdPercent(): number` and `setCompactionThresholdPercent(n: number): void` to the `Conductor` interface (L203-229) and to the returned object (L1075-1077), delegating to the private guard instance (constructed at L452-459) via `guard.getThresholdPercent()`/`guard.setThresholdPercent()`. This is the piece the original package omitted: the guard is private to `createConductor` and was never reachable from `src/app/sessions.ts` or any caller, so `setThresholdPercent` as originally scoped was dead API on landing.
- `src/app/sessions.ts` — In `createConversationConductor` (~L100-237) and `createPerchConductor` (~L290-402): construct `createCompactionTelemetry` with `getThresholdPercent: () => conductorRef?.getCompactionThresholdPercent() ?? config.compactThresholdPercent` (mirroring the existing late-bound `conductorRef` pattern already used for `recordCompactionSummary` at L175/L357 — `conductorRef` is assigned immediately after `createConductor` returns, L220/L399, before any turn can dispatch a ledger event), subscribe it to that role's `ledgerStore` via `ledgerStore.subscribe((_ledger, event) => telemetry.record(event))`, and return it alongside `conductor`/`ledgerStore` (extend `ConversationConductorResult` and `PerchConductorResult`).
- `tests/unit/agent/session/compaction-guard.test.ts` — Add `setThresholdPercent` cases: mid-backoff change affects future `onTurnEnd` comparisons without touching `skipRemaining`/`nextBackoffSkips`; `getThresholdPercent` returns the constructor value before any setter call.
- `tests/unit/agent/session/compaction-telemetry.test.ts` — New, table-driven, against the real event shapes: started → `sdk_frame(compact_boundary)` success interval; failed-then-succeeded pair; an unterminated in-flight start; duplicate `compaction_started` while one record is open (ignored, single record, `thresholdAtStart` from the first); `compaction_failed` with no open record (no-op); `sdk_frame(compact_boundary)` with no open record (no-op); N+1 records evicts the oldest; `getThresholdPercent` is invoked per-start so two compactions with a threshold change between them keep distinct `thresholdAtStart` values.
- `tests/unit/agent/session/conductor.test.ts` — Add cases: `getCompactionThresholdPercent()` returns `config.compactThresholdPercent` immediately after construction; `setCompactionThresholdPercent(n)` followed by `getCompactionThresholdPercent()` returns `n`, round-tripping through the `Conductor` surface into the private guard.

### Tests first

- `setThresholdPercent` mid-backoff changes future `onTurnEnd` comparisons and leaves `skipRemaining`/`nextBackoffSkips` unchanged
- `getThresholdPercent` returns the constructor value before any setter call
- `conductor.getCompactionThresholdPercent`/`setCompactionThresholdPercent` round-trip through to the private guard
- telemetry closes an open record on an `sdk_frame` carrying `system`/`compact_boundary`, not on a fictional `compaction_finished` dispatch
- telemetry records a failed-then-succeeded pair as two distinct records
- telemetry leaves an unterminated `compaction_started` as a single in-flight record with no `finishedAt`/`failedAt`
- telemetry ignores a second `compaction_started` while one record is already open (guard + PreCompact-hook duplicate dispatch), producing one record with the first start's `thresholdAtStart`
- telemetry no-ops a `compaction_failed` or `compact_boundary` `sdk_frame` that arrives with no open record
- telemetry keeps at most `maxRecords` records, evicting the oldest
- `thresholdAtStart` reflects the value `getThresholdPercent()` returned at each start, not a value cached once at telemetry construction

### Acceptance

- `bun test` on all touched test files passes; typecheck and lint clean
- No caller invokes `setCompactionThresholdPercent` in this package — the new accessors are additive to the `Conductor` interface and change no runtime behaviour
- Telemetry is driven only by `LedgerEvent` variants actually dispatched in `src` today (`compaction_started`, `compaction_failed`, `sdk_frame`) plus the already-declared-but-unused `compaction_finished` as a harmless forward-compatible no-op path; no new `LedgerEvent` variant or `ledger.ts` reducer change is introduced
- `getCompactionThresholdPercent`/`setCompactionThresholdPercent` are reachable from any `Conductor` returned by `createConversationConductor` and `createPerchConductor`, not just from code inside `conductor.ts`
- mutation 100% on `compaction-guard.ts`, `compaction-telemetry.ts`, and the touched lines of `conductor.ts` and `sessions.ts`

---

## Q5 — Notification core: bridge, outage predicate, coalescer, and the conductor's non-turn append seam

**Design phase:** 4

**Goal:** Build the source-agnostic notification submission seam and the pure health-transition/coalescing logic, fully covered. Wake is carried by the envelope's `shouldQuery` (`hostPriority` is inert metadata read by no production code outside `envelope.ts`/`types.ts`). A `wake:true` notification is submitted at `priority:'other'` so it can never preempt a live Discord turn (`conductor.ts`'s human-only fast-path at enqueue/routeIncoming). A `wake:false` notification is NOT submitted — `conductor.submit()` unconditionally opens a turn via `beginTurn` regardless of `shouldQuery`, and the SDK contract for `shouldQuery:false` is "appended to the transcript without triggering an assistant turn" (no result frame), so a `submit()`'d accumulate envelope would permanently wedge the one-turn-in-flight invariant (`processQueue` never resumes) and starve every later Discord message. Instead this package adds `Conductor.appendWithoutTurn(envelope)` — mirroring the existing (private) boot-bundle push — which pushes the envelope onto the live SDK queue without touching `currentTurn`, and the bridge routes `wake:false` through it instead of `submit()`. No production call site wires the bridge into app assembly yet.

**Depends on:** none · **Deployable:** yes · **Points:** 13

### Files & changes

- `src/agent/session/conductor.ts` — Modify (landed file): add `appendWithoutTurn(envelope: Envelope): void` to the `Conductor` interface and its implementation. Mirrors `pushBootBundle` — no-op when `currentQueue === undefined`, `shuttingDown`, or `reopening`; otherwise `currentQueue.push(toSdkUserMessage(envelope))` plus a `ledgerStore.dispatch({ type: 'envelope_queued', kind: envelope.kind, at: now() })` for observability (same event type `enqueue()` already dispatches). Must NOT set/read `currentTurn` and must NOT call `beginTurn`/`processQueue`. Throws `InvariantViolationError` (same pattern as the existing `beginTurn` guard) if `envelope.shouldQuery !== false` — this seam is accumulate-only. Symmetrically, add a guard to `submit()` that throws `InvariantViolationError` if `envelope.shouldQuery !== true`, so the two seams can never be crossed by a future caller (safe today: grep confirms every existing `submit()` call site builds a `shouldQuery:true` envelope).
- `src/agent/session/notification-bridge.ts` — New: `createNotificationBridge({ conductor, clock, timezone, timeHeader, dedupeCapacity, logger })` → `{ notify({ source, text, wake, dedupeKey }) }`. `timeHeader` is `() => string` (e.g. wired as `() => formatTimeHeader(timezone)`), called fresh inside `notify()` for every envelope — matching every existing call site (perch-driver.ts, discord/handlers.ts, conductor-processor.ts, catchup-setup.ts), none of which precompute it once. `dedupeCapacity` is an explicit optional factory parameter defaulting to an exported `DEFAULT_NOTIFICATION_DEDUPE_CAPACITY` constant; a bounded FIFO `Set<string>` of `dedupeKey`s evicts the oldest entry once size exceeds capacity. Builds the envelope via `buildNotificationEnvelope({ source, text, now: clock.now(), timezone, timeHeader: timeHeader(), wake })`, then routes on `wake`: `true` → `conductor.submit(envelope, { priority: 'other' })`, fire-and-forget with `.catch(err => logger.warn(...))` (matches the existing fire-and-forget precedent at `perch-driver.ts:139`); `false` → synchronous `try { conductor.appendWithoutTurn(envelope) } catch(err) { logger.warn(...) }`. Never calls `submit` for `wake:false` or `appendWithoutTurn` for `wake:true`. `notify()` always returns without throwing.
- `src/agent/session/health-notification.ts` — New: pure `shouldNotifyHealthChange(change: ServiceHealthChange): boolean` — `change.newState === 'offline' && change.previousState !== 'offline'` — imported off `ServiceHealthChange` from the `@/services` barrel (not `@/services/types`, to satisfy the boundaries `fileInternalPath` entry-point rule). TSDoc states the decision explicitly: EVERY non-offline predecessor wakes on transition into offline, including `starting` (a service that fails during its own startup connect, reachable via the lifecycle machine's `starting` state `CONNECT_FAIL`/`CONNECTION_LOST` transitions) — this is a deliberate "never silently fail to notify a boot-time outage" choice, not an oversight. `disabled -> offline` is noted as structurally unreachable per `src/services/lifecycle-orchestrator.ts` (disabled only transitions to `starting`) and is not asserted. `createHealthOutageCoalescer({ clock, windowMs, notify })` batches same-window offline transitions into ONE envelope naming every affected service, keyed `${service}:${epoch}`. `windowMs` is an optional factory parameter defaulting to an exported `DEFAULT_HEALTH_OUTAGE_WINDOW_MS` constant (a low single-digit-seconds value, documented as the outage-notification latency bound). Module doc states the epoch semantics precisely: per `src/services/lifecycle-orchestrator.ts`, `epoch` increments only on `CONFIGURE`/`CONNECTION_LOST`, never on `CONNECT_FAIL`/`RECOVERY_FAIL` — so a service that flaps `online->offline->recovering->offline` within one connection-loss episode keeps one epoch and is intentionally coalesced/deduped to a single outage notice, not one per transition.
- `src/agent/session/index.ts` — Barrel-export `createNotificationBridge` and its types, `shouldNotifyHealthChange`, `createHealthOutageCoalescer` and its types, `DEFAULT_NOTIFICATION_DEDUPE_CAPACITY`, and `DEFAULT_HEALTH_OUTAGE_WINDOW_MS`. Also add `appendWithoutTurn` to the re-exported `Conductor` interface's documented surface (the interface itself lives in `conductor.ts`; if `Conductor` is already barrel-exported as a type, no separate action is needed beyond the interface change in `conductor.ts`).
- `tests/unit/agent/session/conductor.test.ts` — Modify (existing 1796-line file): add a test group for `appendWithoutTurn` — (1) after `appendWithoutTurn(shouldQuery:false envelope)`, `status().turn` is unchanged/undefined and no `beginTurn`-driven queue push with a turn-opening side effect occurs; (2) a subsequently `submit()`'d Discord envelope still begins and completes a turn normally (proves no wedge); (3) `appendWithoutTurn` is a no-op (does not throw, does not push) when called before `open()` (`currentQueue === undefined`); (4) `appendWithoutTurn` throws `InvariantViolationError` when given a `shouldQuery:true` envelope; (5) `submit()` throws `InvariantViolationError` when given a `shouldQuery:false` envelope.
- `tests/unit/agent/session/notification-bridge.test.ts` — New.
- `tests/unit/agent/session/health-notification.test.ts` — New, FakeClock-driven.

### Tests first

- `notify()` with `wake:true` always calls `conductor.submit` with `priority:'other'` (never `'human'`), and never calls `appendWithoutTurn`
- `notify()` with `wake:false` always calls `conductor.appendWithoutTurn` (never `submit`); the built envelope has `hostPriority` `'accumulate'` and `shouldQuery` false, and the `wake:true` envelope has `hostPriority` `'wake'` and `shouldQuery` true
- `timeHeader()` is invoked fresh on every `notify()` call: two `notify()` calls separated by a FakeClock advance carry two different header strings in their envelope text
- a repeated `dedupeKey` suppresses the second `notify()` (no submit/append call); a distinct key goes through
- the dedupe set evicts the oldest key once past `dedupeCapacity`: at-capacity the oldest key still suppresses a resubmit; one more distinct key past capacity evicts it and a resubmit of the evicted key goes through
- a synchronously-rejecting `conductor.submit` (`wake:true`) is caught via `.catch` and logged, never thrown out of `notify()`
- a throwing `conductor.appendWithoutTurn` (`wake:false`) is caught and logged, never thrown out of `notify()`
- `conductor.appendWithoutTurn` pushes onto the SDK queue without opening a turn: `status().turn` stays as it was, and a Discord envelope submitted immediately afterward still runs to completion
- `conductor.appendWithoutTurn` throws `InvariantViolationError` given a `shouldQuery:true` envelope; `conductor.submit` throws `InvariantViolationError` given a `shouldQuery:false` envelope
- `shouldNotifyHealthChange` table-driven truth table covering: offline←online true, offline←degraded true, offline←starting true, offline←recovering true, degraded←online false, online←offline false, online←degraded false, recovering←offline false, offline←offline false
- two services going offline inside the window submit exactly one envelope naming both
- a transition at exactly `windowMs` is still coalesced into the pending batch; a transition one tick past `windowMs` submits a second envelope
- one service flapping online→offline→recovering→offline within a single connection-loss epoch produces exactly one notification (epoch-keyed coalescing/dedupe), pinning the documented epoch semantics

### Acceptance

- `bun test` on all new and modified files passes; typecheck and lint clean (including the boundaries `fileInternalPath` rule on the `@/services` import)
- `windowMs` and `dedupeCapacity` are explicit, overridable factory parameters, each with a documented exported default constant; `DEFAULT_HEALTH_OUTAGE_WINDOW_MS` is a low single-digit-seconds value documented as the outage-notification latency bound
- mutation 100% on `notification-bridge.ts`, `health-notification.ts`, and the `appendWithoutTurn`/submit-guard additions to `conductor.ts`
- `Conductor.appendWithoutTurn` is additive and non-breaking: no existing `submit()` call site passes a `shouldQuery:false` envelope (verified by grep), so the new guard changes no current production behavior, and the package remains deployable with no production call site wiring the bridge into app assembly yet

---

## Q6 — Health-outage notification source

**Design phase:** 4

**Goal:** Add `createHealthNotificationListener(deps)`: a `HealthChangeListener` that uses Q5's `shouldNotifyHealthChange` predicate — not `newState === 'offline'` alone — as the sole authority on which `ServiceHealthChange` events are outage-worthy: qualifying changes are handed verbatim to Q5's coalescer (which owns dedupe/cascade suppression and eventually calls `notify` with `wake:true`), and every other change (including a predicate-rejected offline transition, e.g. a failed first boot connect) is turned into an immediate accumulate envelope via `notify`. Wire it with exactly one unconditional `healthRegistry.subscribe` call at the same composition-root scope as the existing `unsubscribeOutboxDrain`/`unsubscribeSagaRetry` subscriptions, with matching teardown, so the wiring itself never branches on session mode and stays correct whether or not conductor mode's conductor instance exists.

**Depends on:** Q5 · **Deployable:** yes · **Points:** 6

### Files & changes

- `src/agent/session/health-notification.ts` — Add `createHealthNotificationListener({ shouldNotifyHealthChange, coalescer, notify }): HealthChangeListener`. For each `ServiceHealthChange`: if `shouldNotifyHealthChange(change)` is true, call `coalescer.report(change)` (or Q5's equivalent hand-off) unmodified — this file performs no epoch arithmetic, no time window, no per-service memory of its own. Otherwise call `notify(buildNotificationEnvelope({ ..., wake: false, ... }))` immediately. Export the listener factory plus its params/dep types (the coalescer and `shouldNotifyHealthChange` shapes are provisional pending Q5's actual exports — confirm signatures against the landed Q5 file before implementing).
- `src/agent/session/index.ts` — Add a named-export block re-exporting `createHealthNotificationListener` and its param/listener types from `./health-notification`, following the existing per-module export blocks in this barrel (e.g. the `buildNotificationEnvelope` block). Required because `eslint-boundaries.config.mjs`'s entry-point policy disallows `src/index.ts` importing any `fileInternalPath` other than an element's `index.ts`, and `src/agent/index.ts:39` (`export * from './session'`) only re-exports what this barrel exposes.
- `src/index.ts` — Add exactly one line, `const unsubscribeHealthNotifications = healthRegistry.subscribe(createHealthNotificationListener({ shouldNotifyHealthChange, coalescer, notify: (envelope) => { conversationConductor?.submit(envelope, { priority: /* see Q5/precedent */ }); } }));`, placed immediately after the `unsubscribeSagaRetry` block closes (~L1037) and before `let unsubscribeDiscordRecovery` (~L1038) — the same unconditional file scope as `unsubscribeOutboxDrain` (L994) and `unsubscribeSagaRetry` (L1003), NOT inside the `if(config.session.mode === 'conductor')` block (L831-878). The `notify` closure captures the function-scoped `conversationConductor` (declared L826) and uses `?.` so it is a no-op while conductor mode is off or not yet resolved — no `if` appears in this hunk. Add the matching `unsubscribeHealthNotifications();` call in `stop()` beside the existing `unsubscribeOutboxDrain(); unsubscribeSagaRetry();` pair (~L1176-1177).
- `tests/unit/agent/session/health-notification.test.ts` — Add listener cases against fake `shouldNotifyHealthChange`/`coalescer`/`notify` doubles — no real timers, no real coalescer, no epoch arithmetic asserted here (that belongs to Q5's own suite).

### Tests first

- online → offline with `shouldNotifyHealthChange(change) === true`: `coalescer.report` is called once with that exact change object; `notify` is not called
- degraded ↔ online flap with `shouldNotifyHealthChange(change) === false` in both directions: `notify` is called once per transition with an accumulate envelope (`wake:false`); `coalescer.report` is never called
- starting → offline (a failed first boot connect) with `shouldNotifyHealthChange(change) === false`: `notify` is called with an accumulate envelope, `coalescer.report` is NOT called — pins the predicate, not `newState === 'offline'`, as the sole wake authority; a mutant that drops the predicate check or forces it true must fail this test
- offline → online (recovery) with `shouldNotifyHealthChange(change) === false`: `notify` is called with an accumulate envelope
- the object passed to `coalescer.report` on a qualifying change is reference-equal / deep-equal to the input `ServiceHealthChange` (service, previousState, newState, epoch, timestamp) — this file adds, drops, or mutates none of its fields

### Acceptance

- `bun test tests/unit/agent/session/health-notification.test.ts` passes; typecheck and lint clean
- The `src/index.ts` hunk is exactly one `const unsubscribeHealthNotifications = healthRegistry.subscribe(...)` statement at the same unconditional scope as `unsubscribeOutboxDrain`/`unsubscribeSagaRetry` (between L1037 and L1038), with no `if` in that hunk, plus one matching `unsubscribeHealthNotifications();` teardown call beside the existing pair in `stop()` (~L1176-1177)
- `createHealthNotificationListener` and its types are exported from `src/agent/session/index.ts` so `src/index.ts` imports it via `'@/agent'` with no deep-path import, satisfying the boundaries entry-point policy's `fileInternalPath: '!index.ts'` restriction
- mutation 100% on `src/agent/session/health-notification.ts`
- `health-notification.ts` contains no epoch comparison, timer, or per-service memory of its own — confirmed by reading the diff — since dedupe-within-an-episode and cross-service cascade suppression are owned and tested by Q5's coalescer, not duplicated here

---

## Q7 — Email and approval-outcome notification routing

**Design phase:** 4

**Goal:** The four `EmailProcessor` Discord callbacks (`onSafe`/`onReview`/`onUnsafe`/`onAuthFailed`) and the outbound-approval outcomes (`performRejection`, `handleApprove`, and the select-menu approve+allowlist path) each submit a `notify()` call alongside their existing Discord/activityLogger side effects: `onSafe`/`onReview`/`onAuthFailed` accumulate (`wake:false`), `onUnsafe` wakes (`wake:true`), and every admin approval outcome (approve, approve+allowlist, reject) wakes (`wake:true`) — matching the design's "admin approval outcomes" wake row, not rejection alone. Every `notify` call is fire-and-forget (mirrors the existing `void this.activityLogger?.log(...).catch(...)` pattern already in this file) so a stalled or failed notify can never block a Discord reply or serialize email intake behind an agent turn. Wiring is unconditional in `src/index.ts` — the one-shot path is gone — and is a single added property, not a new conditional. The four callbacks are extracted into an exported, directly-testable factory so mutation coverage on `wake` and `dedupeKey` is real rather than absorbed by the pre-existing integration-wiring Stryker disable block.

**Depends on:** Q5 · **Deployable:** yes · **Points:** 13

### Files & changes

- `src/integrations/email/email-processor.ts` — Export the `ProcessEmailCallbacks` interface (L15, currently unexported) so `email-setup.ts`'s new factory can declare it as a return type.
- `src/integrations/discord/setup/email-setup.ts` — Add a REQUIRED `notify: NotifyFn` field to `EmailSetupOptions` (near L37-76; type imported from wherever Q5 exports its notification-bridge function — verify the exact name/module at pickup). Extract the current inline callbacks (L153-197) into a new exported `export function buildEmailProcessorCallbacks(deps: { client: Client, adminDiscordChannelId: string, discordCapability?: DiscordCapability, notify: NotifyFn }): ProcessEmailCallbacks` in this same file, narrowing the enclosing `// Stryker disable ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral` comment (L153) to cover only the remaining `new EmailProcessor(...)` wiring, not the factory body, so the factory's BooleanLiteral/StringLiteral mutants are live. Inside the factory: `onSafe`/`onReview`/`onAuthFailed` each add `void deps.notify({ source: 'email', wake: false, dedupeKey: \`email-safe:${email.uid}\` | \`email-review:${email.uid}\` | \`email-auth-failed:${email.uid}\`, text: <short human-readable summary already derivable from the existing embed/content strings at L161/167/190> }).catch((err) => logger.warn({ err, msg: 'Notify failed for <case>' }));`; `onUnsafe` (L176) does the same with `wake: true` and dedupeKey `email-unsafe:${email.uid}`. `setupEmail` calls `buildEmailProcessorCallbacks({ client, adminDiscordChannelId: emailConfig.adminDiscordChannelId, discordCapability: options.discordCapability, notify: options.notify })` in place of the inline object. Also thread `notify: options.notify` into the existing `new OutboundApprovalHandler({...})` construction at L269 (this file, NOT `src/index.ts` — the only construction site in the tree).
- `src/integrations/email/outbound-approval-handler.ts` — Add a REQUIRED `notify: NotifyFn` field to `OutboundApprovalHandlerDeps` (L9-13) and store it as `private readonly notify` in the constructor, alongside the existing `wildDuckClient` assignment. In `performRejection` (L93), AFTER the Discord `interaction.editReply` try/catch block (after L133, not immediately after the L109 WildDuck flag write, so a stuck/failed notify can never be mistaken for a WildDuck-persist failure or delay the "Rejected" embed), add `void this.notify({ source: 'email-approval', wake: true, dedupeKey: \`email-approval-rejected:${uid}\`, text: \`Outbound email (uid ${uid}) rejected by admin. Reason: ${reason}\` }).catch((err) => { logger.warn({ err, uid, msg: 'Notify failed for email rejection' }); });` mirroring the existing fire-and-forget activityLogger pattern a few lines above. In `handleApprove` (L230), add the same fire-and-forget notify call (`wake:true`, dedupeKey `email-approval-approved:${uid}`) beside its existing activityLogger call (L247), placed after `interaction.editReply` (L254-257) succeeds. In `handleSelectMenu`'s approve+allowlist success path (L167-224), add one fire-and-forget notify call (`wake:true`, dedupeKey `email-approval-approved:${uid}`) after its `interaction.editReply` (L201-205) — once per uid, not once per recipient in the `for(const emailAddress of interaction.values)` loop (L194-197).
- `src/index.ts` — Branch-free, single-property change: add `notify: notificationBridge.notify` (or whatever Q5 names its bridge accessor — verify at pickup) to the `setupEmail({...})` options object at L339. This requires Q5 to supply a bridge constructed BEFORE L339 whose `notify` is usable immediately (buffering, queuing, or no-oping until the conductor exists) and is attached to the real conductor via a late-bound call (e.g. `notificationBridge.attachConductor(builtConductor.conductor)`) AFTER `createConversationConductor` resolves at L859 — the conductor cannot exist at L339 (email setup's own `createEmailMcpServerInstance` is itself consumed by that later conductor construction, so the dependency runs the other way). Do NOT add a "log once if notify is missing" branch — `notify` is a required field on `EmailSetupOptions`, so a mis-ordered construction is a typecheck error, not a runtime log, keeping this file's diff genuinely branch-free. Do NOT touch `OutboundApprovalHandler` construction here — it lives entirely inside `email-setup.ts:269` and needs no separate `index.ts` edit.
- `tests/unit/integrations/discord/setup/email-setup.test.ts` — Import `buildEmailProcessorCallbacks` directly (no more reaching into private `EmailProcessor` state) and: (1) call it with a mock `notify` and mock `discordCapability`/`client`, invoke `onSafe`/`onReview`/`onAuthFailed`, and assert `notify` was called with `wake:false` and the correct uid-keyed dedupeKey, while the admin-channel embed/content payload is unchanged from current behaviour; (2) same for `onUnsafe` with `wake:true`; (3) add the new required `notify` field to every existing `EmailSetupOptions` literal in this file's setup/`beforeEach` so the real `setupEmail()` calls used elsewhere in the file keep typechecking.
- `tests/unit/integrations/email/outbound-approval-handler.test.ts` — Add a mock `notify` to `OutboundApprovalHandlerDeps` in this file's setup. Assert: (1) `performRejection` calls `notify` with `wake:true` and dedupeKey `email-approval-rejected:${uid}` AFTER the Discord editReply is observed to have run; (2) a `notify` mock that returns a never-resolving promise does not prevent `performRejection`'s own returned promise from resolving (proving fire-and-forget, not the old "awaits notify" requirement); (3) a `notify` mock that rejects is caught and logged, and does NOT trigger `buildRejectionFailedLog`'s failure path or leave the rejection unpersisted; (4) `handleApprove` and the select-menu approve+allowlist path each call notify with `wake:true` and dedupeKey `email-approval-approved:${uid}`, exactly once even though the allowlist path may loop over multiple recipient addresses; (5) existing Discord embed/activityLogger behaviour is unchanged in every case.

### Tests first

- `buildEmailProcessorCallbacks`: `onSafe`, `onReview` and `onAuthFailed` call `notify` with `wake:false` and a uid-keyed dedupeKey; admin-channel embed/message payloads are unchanged
- `buildEmailProcessorCallbacks`: `onUnsafe` calls `notify` with `wake:true` and a uid-keyed dedupeKey; still posts the unsafe alert embed unchanged
- `performRejection` fires notify (`wake:true`) after the Discord editReply, not before and not awaited — a never-resolving notify does not block `performRejection`'s own resolution, and a rejecting notify is caught/logged without failing the rejection
- `handleApprove` and the select-menu approve+allowlist path each fire notify (`wake:true`, dedupeKey `email-approval-approved:<uid>`) exactly once, fire-and-forget, alongside the existing activityLogger call
- `EmailSetupOptions.notify` and `OutboundApprovalHandlerDeps.notify` are required fields (typecheck fails if omitted, catching a mis-ordered construction at compile time instead of a runtime log)
- existing Discord embed/message and activityLogger behaviour is unchanged in every touched case

### Acceptance

- `bun test` on both listed test files passes; typecheck and lint clean
- No new conditional in `src/index.ts` — its only diff is one added property in the `setupEmail` options literal
- mutation 100% on `buildEmailProcessorCallbacks` in `email-setup.ts` (now outside the integration-wiring Stryker disable block) and on the three new notify call sites in `outbound-approval-handler.ts` (`performRejection`, `handleApprove`, `handleSelectMenu`); `src/index.ts` remains outside the mutate glob and carries no mutation burden
- `ProcessEmailCallbacks` is exported from `email-processor.ts` and used as `buildEmailProcessorCallbacks`'s declared return type

---

## Q8 — Bluesky DM accumulate poller and rejection wake

**Design phase:** 4

**Goal:** Add a message-keyed DM checkpoint (mirroring the feed/notification checkpoints) driven by a new health-gated poller that raises an accumulate notification exactly once per batch of newly-unread Bluesky conversations, and route the Bluesky approval-rejection outcome as a wake notification — both delivered through a conductor-backed notify bridge threaded from the composition root, since no poll tick, notify bridge, or approval-handler construction site previously existed at the locations the prior draft assumed.

**Depends on:** Q5 · **Deployable:** yes · **Points:** 16

### Files & changes

- `src/integrations/bsky/checkpoint/types.ts` — Add `bskyDmCheckpointSchema` alongside `bskyFeedCheckpointSchema` (L15) and `bskyNotificationCheckpointSchema` (L38): `{ service:'bsky', type:'dm', lastSeenSentAt: iso datetime optional, processedUris: string[] (field name kept for reuse with the existing generic save/FIFO helpers, but holds lastMessage.id values, not AT URIs), updatedAt }`. Export the inferred `BskyDmCheckpoint` type.
- `src/integrations/bsky/checkpoint/checkpoint-manager.ts` — Add `getDmCheckpointPath()` (private, mirrors L44-47, path `/state/services/bsky/dm/checkpoint`), `loadDmCheckpoint()`/`saveDmCheckpoint()` (mirror L120-142 exactly via the existing `loadCheckpoint`/`saveCheckpoint` generics — those generics are unchanged), and `processDirectMessages(convos: BskyConversation[]): Promise<{ newConvos: BskyConversation[], totalFetched: number, lastSeenSentAt: string|undefined, hadExistingCheckpoint: boolean }>` mirroring `processNotifications` (L191-217) in structure and signature (pure: takes already-fetched conversations, never touches a client — `BskyCheckpointManagerOptions` stays `{ backend }` only). Candidates = `convos.filter(c => c.unreadCount > 0 && c.lastMessage !== undefined)` — a convo with no `lastMessage` cannot be an unread event and is skipped. Dedupe key is per-message: `processedSet.has(c.lastMessage.id)`, NOT `convo.id`, so a later new message in an already-processed conversation raises a row again instead of being permanently suppressed. `lastSeenSentAt` is the lexicographic max of candidates' `lastMessage.sentAt` (same technique as L199), falling back to the existing checkpoint's `lastSeenSentAt` when this poll has no candidates. `processedUris` is the deduplicated union of the existing set and candidates' `lastMessage.id` values (same construction as L204-205), FIFO-evicted at `MAX_PROCESSED_URIS` via `saveDmCheckpoint`.
- `src/integrations/discord/setup/bsky-dm-poller.ts` — NEW FILE — no existing Bluesky poll tick exists anywhere in `src/` (verified: `bsky-setup.ts` has no timer; the only `setInterval` users are `index.ts`'s DynamoDB probe, `presence/manager.ts`'s idle refresh, and `message-coordinator.ts`'s typing indicator). Export `BskyDmPollerOptions { client: BlueskyClient, checkpointManager: BskyCheckpointManager, notify: (params: { source: string, text: string, wake: boolean }) => Promise<void>, healthRegistry: ServiceHealthRegistry, intervalMs: number, logger?: Logger }` and `BskyDmPoller { start(): void, stop(): void }`, plus `DEFAULT_DM_POLL_INTERVAL_MS`. `createBskyDmPoller(options)` uses `setInterval`/`clearInterval` with the same idempotent `start()`/`stop()` shape as `presence/manager.ts:178-205` (a second `start()` while running is a no-op; `stop()` before any `start()` is a no-op). Each tick: skip entirely when `!healthRegistry.isAvailable('bluesky')`; otherwise fetch `const { conversations } = await client.listConversations(undefined, undefined, 'unread')` (same call `context-builder.ts:606` already makes), call `checkpointManager.processDirectMessages(conversations)`, and when `newConvos.length > 0` call `notify({ source: 'bluesky-dm', text: \`${newConvos.length} new unread Bluesky conversation(s)\`, wake: false })` exactly once (never per-convo); an empty or unhealthy tick notifies nothing. Tick errors are caught and logged, never thrown into the interval callback.
- `src/integrations/discord/setup/bsky-setup.ts` — Add to `BskySetupOptions`: `memoryBackend: MemoryToolBackend`, `healthRegistry: ServiceHealthRegistry`, `notify: (params: { source: string, text: string, wake: boolean }) => Promise<void>`, and optional `dmPollIntervalMs?: number`. Inside `setupBsky`: construct `const checkpointManager = new BskyCheckpointManager({ backend: options.memoryBackend })`; construct `const dmPoller = createBskyDmPoller({ client: bskyClient, checkpointManager, notify: options.notify, healthRegistry: options.healthRegistry, intervalMs: options.dmPollIntervalMs ?? DEFAULT_DM_POLL_INTERVAL_MS })`; thread `notify: options.notify` into the existing `new BskyOutboundApprovalHandler({...})` call at L196 (this is where the handler is actually constructed — the prior draft wrongly targeted `src/index.ts` for this). Add `dmPoller` to `BskySetupResult`; `setupBsky` does not start it (mirrors `bskyReconnectionLoop`, which is started/stopped by the caller, not by the function that builds it).
- `src/integrations/bsky/outbound-approval-handler.ts` — Add optional `notify?: (params: { source: string, text: string, wake: boolean }) => Promise<void>` to `BskyOutboundApprovalHandlerDeps`, store as `this.notify`. In `performRejection` (L122), after `await this.rejectionBackend.recordRejection(rejectionItem)` (L156) and before the fire-and-forget activity-log call (L160), add `await this.notify?.({ source: 'bsky-approval', text: \`Bluesky ${rejectionItem.type} rejected: ${reason}\`, wake: true })`. No dedupeKey: the prior draft's dedupeKey param has no landed consumer (`buildNotificationEnvelope` and `conductor.submit` take no dedupe field) and is dropped rather than plumbed to nowhere; a future notification-routing package can add it.
- `src/index.ts` — `src/index.ts` never constructs `BskyOutboundApprovalHandler` (that happens at `bsky-setup.ts:196`) and has no conductor available yet at the `setupBsky` call site (L463) — `conversationConductor` is built later, at L826-875. Fix: near `let bskySetup: BskySetupResult | undefined;` (L456) add `let notifyConductor: Conductor | undefined;`, the same late-binding-variable idiom already used for `conductorForTaskReader` (L833/874/835). Pass into the `setupBsky` call (L463-474): `memoryBackend: storage.memoryBackend, healthRegistry, notify: async (params) => { if (!notifyConductor) { return; } await notifyConductor.submit(buildNotificationEnvelope({ source: params.source, text: params.text, now: new Date(), timezone: resolveTimezone(), timeHeader: formatTimeHeader(resolveTimezone()), wake: params.wake }), { priority: 'other' }); }`. After `conversationConductor = builtConductor.conductor;` (L875) add `notifyConductor = builtConductor.conductor;`. Start the poller once setup succeeds (inside the existing try block, after the `setupBsky` call, before its closing brace): `bskySetup.dmPoller.start();`. In the shutdown block, beside `bskyReconnectionLoop.stop()` (L1166-1168), add `bskySetup?.dmPoller.stop();`. Import `buildNotificationEnvelope` from `'@/agent'` (already re-exported via `src/agent/session/index.ts` → `src/agent/index.ts`) alongside the existing `Conductor` type import (L10); `Conductor` and `resolveTimezone` are already imported.
- `tests/unit/integrations/bsky/checkpoint/checkpoint-manager.test.ts` — Add `processDirectMessages` cases per the restated test list below, including the message-level re-trigger case the prior draft's convo-id keying silently dropped.
- `tests/unit/integrations/discord/setup/bsky-dm-poller.test.ts` — NEW FILE (the touched logic is new and lives outside `bsky-setup.ts`'s Stryker-disabled wiring blocks, so it is measured at 100% directly). FakeClock/fake-timer tests: health-gated skip when `!isAvailable('bluesky')`; one notify call per non-empty batch; none for an empty batch; `start()`/`stop()` idempotency; a tick's rejection is caught and logged, not thrown.
- `tests/unit/integrations/discord/setup/bsky-setup.test.ts` — Add assertions that `setupBsky` threads `options.notify` into both the `BskyOutboundApprovalHandler` construction and `createBskyDmPoller`'s options, and returns an unstarted `dmPoller`.
- `tests/unit/integrations/bsky/outbound-approval-handler.test.ts` — Assert the awaited wake notification (`source:'bsky-approval'`, `wake:true`) after rejection, for both reply and DM rejection types; assert `performRejection` still resolves when `notify` is omitted.

### Tests first

- empty conversation list and no existing DM checkpoint returns `hadExistingCheckpoint:false` and no new convos
- a convo with `unreadCount>0` and a `lastMessage` newer than `lastSeenSentAt` is returned once; a second poll with no activity returns nothing
- a NEW message in an already-processed conversation (`lastMessage.id` changed) raises a new row rather than being suppressed by convo id
- a convo with `unreadCount>0` but no `lastMessage` is never treated as a new event and never updates the checkpoint
- processed message ids FIFO-evict at `MAX_PROCESSED_URIS`
- the poller calls notify exactly once per non-empty batch of new convos; none for an empty batch; none while `healthRegistry.isAvailable('bluesky')` is false
- `start()`/`stop()` are idempotent and a tick's thrown/rejected error is caught and logged, not propagated
- `performRejection` calls notify with `wake:true` for both reply and DM rejection types, and resolves normally when notify is undefined

### Acceptance

- `bun test` on all listed test files passes; typecheck and lint clean
- the DM checkpoint persists under the same key convention as the feed/notification checkpoints (`/state/services/bsky/dm/checkpoint`)
- mutation 100% on the new checkpoint methods, `checkpoint-manager.ts`'s DM logic, `bsky-dm-poller.ts` in full, and the touched notify call sites in `outbound-approval-handler.ts` and `bsky-setup.ts`

---

## Q9 — State top-set delta tracker

**Design phase:** 2

**Goal:** Add a `stateTopSetDelta` gate to `ContextPolicy` mirroring `eventsDelta`'s shape (empty before first mark, `resetAll()` re-arms it), so per-turn Discord envelopes carry a "[State changed]" section listing only the top-set state paths that changed since the last non-withdrawn turn, instead of Claude having no signal at all about hot-state churn between turns. Fully wired into the one real per-turn envelope path (`conductor-processor.ts`) — no boot-bundle involvement, since `boot-bundle.ts` has no `ContextPolicy` dependency and the empty-before-first-mark rule already prevents a spurious full-set delta after a restart.

**Depends on:** none · **Deployable:** yes · **Points:** 11

### Files & changes

- `src/agent/context-builder.ts` — Add `loadStateTopPaths(now?: Date): Promise<string[]>` to the `ContextBuilder` interface and impl. Calls `this.#backend.getStateItemsScored({ now, maxItems: this.#maxStateFullItems + this.#maxStatePreviewItems })` (default 8+30=38, TSDoc'd explicitly as the same total `loadHotState` renders, L717-763) and maps the result to `item.path`, in score order, with no further slicing needed since `getStateItemsScored` already caps its return at `maxItems`. Passing this explicit (tighter) `maxItems`, rather than reusing `loadHotState`'s own uncapped call (which deliberately over-fetches at the backend default of 50 so it can report an overflow count), keeps `loadStateTopPaths`'s backend query bounded at `cap*2` rows via the existing `maxItems*2` `listByLayer` invariant (`backend-query.ts` L336-362) without touching `loadHotState`'s own call or its overflow-count behavior, which stay byte-for-byte unchanged.
- `src/agent/session/context-policy.ts` — Add `StateTopSetSource = Pick<ContextBuilder,'loadStateTopPaths'>`; widen `CreateContextPolicyParams.contextBuilder` to `EventsDeltaSource & StateTopSetSource`. Add `stateTopSetDelta(): Promise<{added: string[], removed: string[]}>`, documented as returning the empty delta before the first mark (matching `eventsDelta`, L49) and, after a mark, diffing the CURRENT top-set (`loadStateTopPaths(now)`) against the path set captured AT that mark. Add `markStateTopSetSeen(): Promise<void>` — deliberately async and fetching, unlike the synchronous `markEventsSeen(): void`: a timestamp is enough to drive `eventsDelta`'s time-windowed query, but a path-set diff has no "since" query equivalent, so the mark must itself call `loadStateTopPaths(now)` and store the resulting set as the next comparison baseline. TSDoc this asymmetry explicitly so it isn't mistaken for an oversight. `resetAll()` (L76) additionally clears the new stored baseline, so the next `stateTopSetDelta()` after a reset behaves exactly like the first-ever call.
- `src/integrations/discord/setup/conductor-processor.ts` — Add `contextPolicy.stateTopSetDelta()` to the existing `Promise.all` at L110-116 (alongside `eventsDelta()`), and pass its result into `buildDiscordEnvelope` as a new `stateChanged` param — undefined when both `added` and `removed` are empty, matching the existing `newEvents.length > 0 ? ... : undefined` pattern used for `newEvents`. Inside the existing `if(result.outcome !== 'withdrawn')` block (L191-198), add `await contextPolicy.markStateTopSetSeen();` next to the existing `contextPolicy.markEventsSeen();` call, so a withdrawn turn (whose delta was never shown to Claude) does not advance the baseline, exactly mirroring the events-mark gating already documented at "Gap 2" in that block's comment.
- `src/agent/session/envelope.ts` — Add `stateChanged?: {added: string[], removed: string[]}` to `BuildDiscordEnvelopeParams`. Render a "[State changed]" section (via the existing `renderSection`/`joinSections` helpers) only when `added.length > 0 || removed.length > 0`, with body lines `+<path>` for each added path followed by `-<path>` for each removed path, placed in the existing section order immediately after "[Recent events]" and before "[Channels]".
- `tests/unit/agent/context-builder-loading.test.ts` — Add a `describe('loadStateTopPaths')` block alongside the existing `describe('loadHotState')` (L427): empty backend returns `[]`; returns paths in score order for exactly the `maxStateFullItems+maxStatePreviewItems` items (default 38), excluding anything beyond that cap; a custom-constructed builder with non-default `maxStateFullItems`/`maxStatePreviewItems` options gets a proportionally different cap; asserts the backend `getStateItemsScored` mock was called with `maxItems` equal to that same total, pinning the shared-cap invariant against drift from `loadHotState`'s own (uncapped) call.
- `tests/unit/agent/session/context-policy.test.ts` — Update every existing `createContextPolicy({..., contextBuilder: {...}})` object literal in this file to also stub `loadStateTopPaths` (now required by the widened `contextBuilder` type). Add a new `describe('createContextPolicy — stateTopSetDelta / markStateTopSetSeen')` block covering: `{added:[],removed:[]}` before `markStateTopSetSeen` has ever been called; a path present now but absent from the last mark's set appears in `added`, and the reverse in `removed`; a path unchanged across two calls appears in neither; `resetAll()` clears the mark so the next delta again behaves like the first-ever call; `markStateTopSetSeen()` itself calls `loadStateTopPaths` (mutation-proofing the async fetch).
- `tests/unit/agent/session/envelope.test.ts` — Add `buildDiscordEnvelope` cases: no "[State changed]" section when `stateChanged` is undefined or both arrays empty; section present and correctly formatted for added-only; for removed-only; for both, pinning the `+`/`-` line format and section placement.
- `tests/unit/integrations/discord/setup/conductor-processor.test.ts` — Add `stateTopSetDelta`/`markStateTopSetSeen` fakes to `makeContextPolicy()` (L88, currently missing them would fail typecheck once `ContextPolicy` grows). Add a test asserting `stateTopSetDelta()` is awaited alongside `eventsDelta()` and its resolved value reaches `buildDiscordEnvelope`'s `stateChanged` param, and tests asserting `markStateTopSetSeen()` is called when `result.outcome !== 'withdrawn'` and NOT called when it is `'withdrawn'` — mirroring this file's existing `markEventsSeen` assertions.
- `tests/unit/integrations/discord/bot.test.ts` — Add `stateTopSetDelta`/`markStateTopSetSeen` mock fields to the inline `contextPolicy` object literal inside `conductorDeps()` (~L1687), required to keep this file typechecking once `ContextPolicy` grows; no new behavioral assertions needed here.
- `tests/unit/integrations/discord/setup/coordinator-setup.test.ts` — Add `stateTopSetDelta`/`markStateTopSetSeen` mock fields to the inline `contextPolicy` object literal (~L336), required to keep this file typechecking once `ContextPolicy` grows; no new behavioral assertions needed here.
- `tests/unit/agent/agent-context.test.ts` — Add `loadStateTopPaths: mock(() => Promise.resolve([]))` to the `mockContextBuilder` object literal (L35-...), required to keep this file typechecking once `ContextBuilder` grows.
- `tests/unit/agent/perch/session-runner.test.ts` — Add `loadStateTopPaths` to `createMockContextBuilder()`'s default return object (L28), required to keep this file typechecking once `ContextBuilder` grows.

### Tests first

- `stateTopSetDelta()` returns `{added:[],removed:[]}` before `markStateTopSetSeen` has ever been called
- a path present now but not at last mark appears in `added`; the reverse appears in `removed`
- a path unchanged across two calls is reported in neither
- `resetAll()` clears the mark; the next delta behaves as first-mark again
- `loadStateTopPaths` returns exactly the `maxStateFullItems+maxStatePreviewItems`-capped slice `loadHotState` renders, excluding overflow, and drives that cap explicitly via `getStateItemsScored`'s `maxItems` option
- conductor-processor: `stateTopSetDelta()` is fetched in the same `Promise.all` as `eventsDelta()` and its result reaches `buildDiscordEnvelope`'s `stateChanged` param
- conductor-processor: `markStateTopSetSeen()` is called when `outcome !== 'withdrawn'` and is NOT called when `outcome === 'withdrawn'`
- `buildDiscordEnvelope` renders no "[State changed]" section when `stateChanged` is undefined or both arrays are empty, and renders it correctly for added-only/removed-only/both

### Acceptance

- `bun test` on the changed test files passes; typecheck and lint clean across the repo (the `ContextBuilder`/`ContextPolicy` interface widenings ripple into `bot.test.ts`, `coordinator-setup.test.ts`, `agent-context.test.ts` and `session-runner.test.ts`, all listed above)
- `loadStateTopPaths`'s cap is explicit and TSDoc'd as `maxStateFullItems + maxStatePreviewItems` (default 38), passed as an explicit `maxItems` to `getStateItemsScored` — a bounded backend query (`cap*2` rows via the existing `maxItems*2` invariant), not an unbounded scan, and independent of `loadHotState`'s own (deliberately uncapped, overflow-reporting) call, which is otherwise unchanged
- `stateTopSetDelta()`/`markStateTopSetSeen()` are wired end-to-end through `conductor-processor.ts` into every real Discord turn envelope, gated on non-withdrawn outcome exactly like the existing `markEventsSeen()` call — no boot-bundle involvement, since `boot-bundle.ts` has no `ContextPolicy` dependency to hang a mark off and the empty-before-first-mark rule already rules out a spurious full-set delta after a restart
- `resetAll()` clears the state-top-set baseline the same as it does the events mark
- mutation 100% on `loadStateTopPaths`, `stateTopSetDelta`, `markStateTopSetSeen`, the new conductor-processor wiring, and `envelope.ts`'s new conditional section

---

## Q11 — Compaction threshold tuning from observed events

**Design phase:** 2

**Goal:** Nudge the live threshold toward a configured target compaction interval using Q4's telemetry, clamped to a configured band. With no new env vars set the band collapses to `compactThresholdPercent`, so deployed behaviour is provably unchanged and the rollback is unsetting env vars. Reaching the guard requires threading a setter through `compaction-guard.ts` and `conductor.ts`, which prior scoping omitted; both are now in this package.

**Depends on:** Q3, Q4 · **Deployable:** yes · **Points:** 11

### Files & changes

- `src/agent/session/compaction-guard.ts` — Change `thresholdPercent` from a destructured immutable const to a mutable closure variable (e.g. `let currentThresholdPercent = params.thresholdPercent`), read from `onTurnEnd`'s comparison unchanged otherwise. Add `setThresholdPercent: (percent: number) => void` to the exported `CompactionGuard` interface and its implementation: a non-finite or non-positive `percent` is ignored (logged at warn via the existing injected logger), otherwise it replaces the current value. No other behaviour changes.
- `tests/unit/agent/session/compaction-guard.test.ts` — Add cases for the new setter: setting a value below the next polled usage percentage causes the following `onTurnEnd` to submit a compaction that would not have fired at the old threshold, and vice versa (above → no submit); an invalid (NaN/zero/negative) input is a no-op and is logged; the setter has no effect on an in-flight compaction. Needed so the file's existing 100% mutation gate covers the new hunk.
- `src/agent/session/conductor.ts` — Add `setCompactThresholdPercent: (percent: number) => void` to `interface Conductor` (near `recordCompactionSummary`), and in the object literal `createConductor` returns, delegate it to `guard.setThresholdPercent(percent)`. No change to `CreateConductorParams` or guard construction (still seeded from `config.compactThresholdPercent`).
- `tests/unit/agent/session/conductor.test.ts` — Add a case asserting `conductor.setCompactThresholdPercent(n)` delegates to the guard and changes subsequent compaction-trigger behaviour (reuse the file's existing guard-triggering fixture). Covers the touched `conductor.ts` hunk under the 100% mutation gate.
- `src/agent/session/compaction-tuner.ts` — New. Pure `computeTunedThreshold(history, currentPercent, { targetIntervalMs, min, max }) -> number`: fewer than two entries in `history` (an array of compaction timestamps/intervals sourced from Q4's telemetry — verify Q4's exact exported shape at pickup and adapt this signature to it rather than assuming) returns `currentPercent` unchanged; otherwise takes a bounded step up when the observed interval is shorter than `targetIntervalMs` and down when longer, then clamps to `[min, max]`. Also exports `createCompactionThresholdTuner(params: { ledgerStore: Pick<LedgerStore, 'subscribe' | 'get'>, config: SessionConfig, setThresholdPercent: (percent: number) => void, clock: Clock }) -> () => void` (returns an unsubscribe): resolves the band itself from `config` — `min = config.compactThresholdMinPercent ?? config.compactThresholdPercent`, `max = config.compactThresholdMaxPercent ?? config.compactThresholdPercent`, `targetIntervalMs = config.compactTargetIntervalMs ?? Infinity` (a missing target makes every history a no-op step) — so the schema stays flat and no cross-field default lives in `schemas.ts`. Subscribes to `ledgerStore.subscribe`, recomputes on every relevant event, and calls `setThresholdPercent` only when the computed value differs from the guard's last-set value (tracked locally) to keep the collapsed-default case call-count-quiet, though the acceptance only requires value-equality.
- `tests/unit/agent/session/compaction-tuner.test.ts` — New, table-driven. Every case widens the band explicitly (`min < currentPercent < max`) so no mutant is equivalent under the collapsed default. Cases: shorter-than-target intervals raise by a bounded step, longer lower by a bounded step; result never leaves `[min,max]` for any history, including pathological histories that would overshoot in one step; fewer than two observed compactions leaves `currentPercent` unchanged; a collapsed band (`min==max==compactThresholdPercent`, or `targetIntervalMs` unset) makes every input a no-op; `createCompactionThresholdTuner` with all three new fields unset never calls `setThresholdPercent` with a value different from `config.compactThresholdPercent`, for a range of synthetic histories — this is the test that makes "deployed behaviour is provably unchanged" real.
- `src/config/schemas.ts` — Add `compactThresholdMinPercent: z.number().int().positive().max(100).optional()`, `compactThresholdMaxPercent: z.number().int().positive().max(100).optional()`, `compactTargetIntervalMs: z.number().int().positive().optional()` to `sessionConfigSchema`, inside the existing `Stryker disable BooleanLiteral,ArithmeticOperator,StringLiteral` block (these have no defaults to disable-cover, so no new disable comments are needed — add schema-rejection tests instead: non-integer, non-positive, and >100 on the two percent fields). No transform/superRefine and no change to `compactThresholdPercent` itself: the band's default-collapse and any min<=max relationship are resolved in `compaction-tuner.ts`, not in the schema, so the inferred `SessionConfig` type gains three independently-optional numbers and nothing else changes shape.
- `src/config/loader.ts` — In the `session` block, add `compactThresholdMinPercent: env.get('SESSION_COMPACT_THRESHOLD_MIN_PERCENT').asIntPositive()`, `compactThresholdMaxPercent: env.get('SESSION_COMPACT_THRESHOLD_MAX_PERCENT').asIntPositive()`, `compactTargetIntervalMs: env.get('SESSION_COMPACT_TARGET_INTERVAL_MS').asIntPositive()`, matching the existing `compactThresholdPercent` line's style (all undefined when unset, per envalid's behaviour on optional-without-default).
- `src/app/sessions.ts` — In `createConversationConductor` and `createPerchConductor`, after constructing `ledgerStore` and the conductor, call `createCompactionThresholdTuner({ ledgerStore, config, setThresholdPercent: conductor.setCompactThresholdPercent, clock })` (for the wrapped conversation `conductor` object — the spread `{ ...innerConductor, submit: ... }` carries the new method through automatically, verify this in the RED test rather than assuming) and keep the returned unsubscribe alive for the process lifetime (no explicit disposal path exists today for conductor-scoped subscriptions; match whatever pattern Q3's cost-ceiling subscriber uses once that lands, so the two don't diverge).

### Tests first

- intervals shorter than target raise the threshold, longer lower it, both by a bounded step
- the result never leaves `[min,max]` for any history, including histories that would overshoot the band in a single naive step
- fewer than two observed compactions leaves `currentPercent` unchanged
- a collapsed default band (`min==max==compactThresholdPercent`, or `targetIntervalMs` unset) makes every input a no-op, asserted at both the pure `computeTunedThreshold` level and the `createCompactionThresholdTuner` subscriber level with all three env vars unset
- compaction-guard.ts: `setThresholdPercent` changes the next `onTurnEnd`'s submit decision in both directions; invalid input (NaN/<=0) is a no-op; has no effect while a compaction is in flight
- conductor.ts: `conductor.setCompactThresholdPercent` delegates to the guard and is observable via a subsequent `onTurnEnd`-triggered compaction
- tuner and cost-ceiling subscribers (Q3) produce identical results under either `ledgerStore` listener registration order

### Acceptance

- `bun test` on the new and touched test files passes; typecheck and lint clean
- With no new env vars set, no `setThresholdPercent` call (from the tuner or otherwise) ever changes the guard's threshold away from `compactThresholdPercent` (asserted)
- mutation 100% on `compaction-tuner.ts` and the touched hunks in `compaction-guard.ts`, `conductor.ts`, and `sessions.ts`
- eslint-plugin-boundaries clean: `compaction-tuner.ts` stays in `src/agent/session` and takes no dependency on `src/app` or `src/integrations`

---

## Durable session crons — evaluation

Design note only; no implementation, consistent with the standing "cron tools stay off" decision. Perch's host scheduler (`src/agent/perch/scheduler.ts`) is coupled to in-process state a durable cron cannot see: `stateManager` idle gating, `perchSessionRunner.isSuspended()` (L114), live `PerchConfig.enabled` (L150/L291), Q3's `isCostPaused()` predicate, and the same-process conductor object identity that `submit()` needs. Replacing it would first have to prove four falsifiable things:

1. A durable cron can trigger back INTO the running process — a webhook or IPC contract — rather than starting an isolated session, or it cannot reach `conductor.submit` at all.
2. The idle/suspend/cost gates can be evaluated BEFORE the fire, so a paused or non-idle slot never enqueues, rather than inside an already-woken turn.
3. The per-hour random-minute jitter across five named slots (pre-dawn, mid-morning, afternoon, evening, late-night) is expressible without reimplementing `scheduler.ts`'s jitter elsewhere.
4. Durable firing across a restart or redeploy neither double-fires nor drops a slot, which the current recomputed `setTimeout` handles harmlessly.

None is evidenced today. One positive observation: durable crons are a plausible fit for the NEW source polls this plan adds (Bluesky DM checkpoint polling in Q8, and any future health probe cadence), which are stateless and idempotent, and a poor fit for perch's slot-timing engine.

**Recommendation:** keep the host scheduler; revisit only after a time-boxed spike proving (1)–(4) against a real process restart. Note that the `CronCreate` tool available to this planning session is a different feature from the Agent SDK cron Izzy would consume, so its local `durable:true` no-op is not evidence either way.

---

## Challenge outcomes

- **Q2** — Original scope built a `healthMcpServer` config that was never attached to a session and never allow-listed, so `getServiceHealth` would have been unreachable by the model. Fixed by extending `SessionMcpServerName`/`OPTIONAL_MCP_SERVER_ORDER` and wiring `health:` into both `sessions.ts` conductor literals, plus extending the three existing pinned-literal test files. Points raised 5 → 8.
- **Q3** — Three defects found and fixed: (1) wiring only reachable via `perch-setup.ts`/`bot.ts`, not directly from `index.ts` — threaded through both; (2) the originally-targeted `start()` guard would make a boot-time-crossed ceiling permanent — moved to the `onScheduledTrigger` guard instead, `start()` left untouched; (3) a naive `lastTurnUsd`-summing accumulator is unsound against `ledger.ts`'s actual reducers — replaced with a per-store `cumulativeUsd` delta tracker that self-heals through `session_opened` resets. Also added a session-level `timezone` config field. Points raised 9 → 13.
- **Q4** — Kept, rescoped: the real production compaction-success signal is the `sdk_frame`/`compact_boundary` event, not the never-dispatched `compaction_finished`; `thresholdAtStart` is sourced via an injected `getThresholdPercent` accessor rather than widening `LedgerEvent`; and `conductor.ts` gained `getCompactionThresholdPercent`/`setCompactionThresholdPercent` since the guard was otherwise unreachable from any composition root (which Q11 needs). Also specified idempotent handling of the duplicate `compaction_started` dispatch (guard + PreCompact hook). Points raised 7 → 10.
- **Q5** — Original design would have submitted `wake:false` notifications via `conductor.submit()`, permanently wedging the one-turn-in-flight invariant since `shouldQuery:false` emits no result frame. Fixed by adding a new `Conductor.appendWithoutTurn` seam (mirroring the existing private `pushBootBundle`) and routing `wake:false` through it instead, with mutual `InvariantViolationError` guards preventing the two seams from being crossed. Also fixed: `timeHeader` must be a per-call function, the health truth table needed a `starting→offline` case, `ServiceHealthChange` must come from the `@/services` barrel, and `windowMs`/`dedupeCapacity` are parameters with documented defaults. Points raised 9 → 13.
- **Q6** — Rewritten for two defects: (1) the wiring was scoped as "branch-free after L859" but the conductor-mode `if` block still exists (one-shot isn't deleted until P13b) — moved to the unconditional file-scope region beside `unsubscribeOutboxDrain`/`unsubscribeSagaRetry`, tolerating an undefined conductor via optional chaining inside the closure; (2) the package cannot own epoch arithmetic or cross-service cascade suppression using only its own pieces — rescoped to route qualifying transitions to Q5's coalescer verbatim, with `shouldNotifyHealthChange` (not bare `newState==='offline'`) as the sole wake authority, closing a boot-time false-wake gap (`starting→offline`). Points unchanged at 6 (rescoped, not enlarged).
- **Q7** — Fixed a fatal ordering cycle: `setupEmail` (L339) runs before `createConversationConductor` (L859), which itself consumes email setup's own MCP server instance — a conductor-backed `notify` cannot exist at L339. Fixed via a late-bound bridge attached to the conductor after construction. Also moved `OutboundApprovalHandler` notify-wiring into `email-setup.ts` (its actual construction site, not `src/index.ts`), extracted the four inline callbacks into an exported, mutation-testable factory, switched every notify call to fire-and-forget, and expanded wake coverage to all three approval outcomes (approve, approve+allowlist, reject) per the design's "admin approval outcomes" wording. Points raised 9 → 13.
- **Q8** — Original package assumed a Bluesky poll tick, notify bridge, and approval-handler construction site that didn't exist anywhere in the tree, and its convo-id dedupe key would have permanently suppressed all messages in a conversation after its first unread one. Rebuilt with a new poller module (mirroring `presence/manager.ts`'s interval idiom), a per-message dedupe key, and a late-bound conductor-backed notify bridge threaded through `index.ts` using the existing `conductorForTaskReader` late-binding pattern. Dropped the unlanded `dedupeKey` notify param. Points raised 9 → 16.
- **Q9** — Original package targeted `boot-bundle.ts`, which has no `ContextPolicy` dependency at all — the fix rewires everything through `conductor-processor.ts` (the actual per-turn envelope path), makes `markStateTopSetSeen` async (a path-set diff has no "since" query, unlike `markEventsSeen`), and corrects the render cap to `maxStateFullItems + maxStatePreviewItems` = 38 (not 40). Ripple typecheck fixes added to five additional test files. Points raised 7 → 11.
- **Q10 (calendar diff)** — Dropped rather than patched. Perch has no `ContextPolicy` to hang a delta on (`sessions.ts:285` states this explicitly), `agent/perch/envelope.ts` is a documented thin wrapper with a fixed section list that cannot render a new section without threading a param through three production files, the claimed single `loadCalendarEvents(now?)` method conflates two different user-list fetches, and the CalDAV rolling time window would produce spurious added/removed churn at every window edge that no listed test would catch. Needs re-derivation as two smaller packages (a pure primitive package, and a separate perch-wiring package) rather than one patched diff. **This is a gap — see below.**
- **Q11** — Fixed the same missing-setter gap as Q4: `guard.setThresholdPercent` didn't exist and `sessions.ts` had no way to reach any guard. Added the setter to `compaction-guard.ts` and `conductor.ts` (reusing Q4's newly-added `Conductor` surface) into this package's file list. Replaced a schema-level cross-field default (which would have needed a `superRefine`) with independently-optional, `.max(100)`-capped fields, resolving the band collapse inside the tuner module instead. Re-pointed `dependsOn` to add Q3, since the tuner-vs-cost-ceiling ordering test needs it. Points raised 7 → 11.

---

## Gaps from the completeness critic (open TODOs)

These items were identified as missing from the package set and are **not yet scoped as packages**. They should be triaged into new packages (or explicit scope-exclusion notes) before Phase 2/4 is considered complete.

- [ ] **Calendar diff is entirely unaddressed.** Design section 10 / the 3.1 table specifies an envelope only when the day's agenda changes (perch turns always get the full agenda), diffed hourly against the last injected agenda. No package touches `#buildCalendarSection`/`#buildPerchCalendarSection`, `ContextPolicy`, or a poll. This is Q10 as originally scoped, dropped during challenge (see above) — needs re-derivation as two packages: a pure primitive (perch-scoped calendar event listing + delta tracker, CalDAV-window-slide-safe) and a wiring package (perch-scoped `ContextPolicy` construction in `sessions.ts`, new params on `perch-driver.ts` and `session/envelope.ts`).
- [ ] **Service health "envelope, on change only" push-side change never lands.** Q2/Q5/Q6 add pull + notify, but nothing gates or removes `#buildServiceHealthSection` (L496-510) from the per-turn Discord prefix, so the stated token saving isn't realized and Claude may see both a live outage notice and the same static text again next turn. Needs a package (extend Q6, or new) that gates the section behind a `ContextPolicy` health-change mark, or removes it from the Discord path now that pull/push notification exist.
- [ ] **State delta (Q9) diffs the wrong set and carries no content.** Design says "top 8 full at session start/after compaction; then only items that entered the top 8 or were written since last injection" — i.e. new/changed *content*, not just path names, and only against the top-8 full tier (not the 38-item full+preview set Q9 uses). Also missing: a "written since last injection" (mtime-based) re-injection trigger independent of set membership. Needs a Q9 follow-up or amendment.
- [ ] **Perch envelopes get none of the Phase 2 tuning.** Q9 wires `stateTopSetDelta` only into `conductor-processor.ts` (Discord); perch's own conductor/`ContextPolicy` (via `createPerchConductor`) is untouched, and the design explicitly says calendar diffs are "always" full for perch — implying a deliberate, but currently unstated, perch behaviour for state deltas too. Needs an explicit decision (pinned in `agent/perch/envelope.ts` + its tests): wire the delta into perch, or assert perch intentionally always carries the full set.
- [ ] **"Perch context block in perch envelopes (partly landed in P12 of the Phase 1 plan)" has no completion check.** No package in this plan verifies what Q12 left outstanding or closes the remainder now that Q1/Q2 add pull tools for rejections and health. Needs either a small verification package or an explicit note folded into Q1/Q2 that the existing push sections are intentionally left as-is. **Note folded into Q1 (2026-09-06):** `ContextBuilder#buildRejectedDraftSection` (context-builder.ts, `loadUnifiedContext`'s L568/L576 use per the Q1 file list above) is deliberately left untouched and keeps firing unconditionally on every perch turn; `getRejectedDrafts` is a pull-tool twin documented as such at its call site in email-mcp-server.ts. The two paths share `buildAdminRejectedSubsection`/`buildGaveUpSubsection` so formatting cannot drift, but the outer composition (searches + empty-result wording) is duplicated by design rather than unified, since unifying it would touch the push path this item says to leave alone. Known accepted limitation carried over unchanged from the push path: if a flagged draft's message fails to format (missing metadata, deleted between search and fetch), both paths report "nothing pending" rather than surfacing the fetch/format failure — this is pre-existing behavior, not introduced by Q1. Q2 should leave the same kind of note for the health section. The broader completion-check (verifying what Q12 left outstanding) is still open.
- [ ] **No package assembles the notification bridge in the composition root consistently.** Q6, Q7, and Q8 each hand-roll their own `notify`/bridge-construction story in `src/index.ts` (a subscribe closure, a "verify at pickup" bridge accessor, and a separate `notifyConductor` late-binding variable, respectively) rather than sharing one bridge instance and its dedupe/coalescing. Needs a package between Q5 and its three consumers that defines the single late-bound bridge (`attachConductor`), constructs it once, and makes Q6/Q7/Q8 all consume it — otherwise Q5's dedupe and coalescer are bypassed by Q6 and Q8.
- [ ] **Notify contract is inconsistent across sources.** Q5's bridge type is `{ source, text, wake, dedupeKey }`; Q7 supplies dedupeKeys; Q8 explicitly types its own local `notify` as `{ source, text, wake }` (no `dedupeKey`) and will not typecheck against a shared `NotifyFn`. Needs Q5's `NotifyFn` type to be the single shared type, imported everywhere, with Q8 supplying `dedupeKey`s (`bsky-dm:<lastMessage.id>`, `bsky-approval-rejected:<uuid>`) once that's possible.
- [ ] **"Injection windows tuned from observed compaction events" is reduced to the compaction threshold only.** Q4/Q11 tune `compactThresholdPercent` alone. The design also names the per-user memory window, the events-delta window, and boot-bundle spans as tunable from observed compaction events — none of these consume Q4's telemetry. Needs a Q11 extension (or sibling package) with the same collapsed-default, behaviour-unchanged guarantee.
- [ ] **Daily cost ceiling (Q3) doesn't survive a restart and its pause is invisible.** The day bucket is in-memory, seeded from live ledger deltas; a mid-day restart zeroes today's spend and un-pauses perch silently. Nothing rehydrates from the journal or a persisted total, and nothing notifies Craig that perch paused or resumed — only a `logger.debug`. Needs a Q3 follow-up: boot-time rehydration (journal `readSince` or a persisted daily total) and an admin-visible notice (Discord message or a Q5 accumulate notification) on first pause and on midnight resume.
- [ ] **Reconcile the duplicated compaction-setter scope between Q4 and Q11 and confirm the Q10 numbering gap.** Both packages independently add a threshold setter to `compaction-guard.ts` and a delegating method to the `Conductor` interface (Q4 as `getCompactionThresholdPercent`/`setCompactionThresholdPercent`, Q11 as `setCompactThresholdPercent`) — these will collide on landing. Reconcile so the guard+conductor setter lands exactly once (in Q4, since Q11 depends on it) and Q11 only consumes it. Separately confirm whether the missing "Q10" slot in the numbering was meant to be the calendar-diff package, the cron evaluation, or something else, and restore/renumber accordingly.
- [ ] **No shared test double for `ServiceHealthRegistry`.** Q2 copies `mcp-helpers.test.ts`'s file-local `makeRegistry()`/`makeEntry()`; Q6 and Q8 each need another copy, adding three more near-identical, independently-drifting mocks on top of the ones already hand-duplicated across email/bsky/inbox tests. Needs a small extraction (ideally as a first step inside Q2): `tests/helpers/fake-health-registry.ts`, consumed by Q2, Q6, and Q8.

