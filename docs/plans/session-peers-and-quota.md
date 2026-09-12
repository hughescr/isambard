# Session peers and quota awareness

Status: implemented (2026-09-09). Two features that share one delivery surface (the per-turn
time header) and one data source (the session ledgers).

1. **Peers**: the conversation and perch sessions know each other by name, can message each
   other through the SDK's cross-session tools, receive those messages as proper envelopes, and
   see a one-line ambient summary of what the other is doing on every turn.
2. **Quota**: both sessions see the Claude Max subscription's five-hour and weekly utilization on
   every turn, get accumulate-only notes at thresholds, and perch pauses at a quota ceiling.

## Verified facts (SDK 0.3.258 + bundled CLI 2.1.266; corrected by the block-0 probe 2026-09-09)

- Every Claude Code process registers a unix socket under `/tmp/cc-socks/<pid>.sock` **plus a pid
  record carrying `cwd`, `startedAt`, `kind`, `status`, `sessionId`, `name`, `nameSource`,
  `formerNames`, `messagingSocketPath`**. The `SendMessage` and `ListAgents` tools reach any live
  process on the machine. Izzy's allowed tool list (`src/agent/session/query-options.ts`) already
  includes both.
- **CORRECTED.** A peer does *not* see a session under `Options.title`. The peer-list name is
  `record.name || <cwd basename>-<hash>`, and `Options.title` never reaches `record.name`. The only
  knob the probe found that does set it is the environment variable
  **`CLAUDE_CODE_SESSION_NAME`**, passed through `Options.env`. See "Probe results".
- An inbound message arrives as a user prompt wrapped
  `<cross-session-message from="uds:/tmp/cc-socks/<pid>.sock" from-name="…" from-mode="bypass">\n<text>\n</cross-session-message>`.
  The `from` attribute is the reply address for `SendMessage` (verified: a reply addressed to the
  raw `uds:` path succeeded). `from-mode` is the **sender's** permission-mode class, observed as
  `bypass` for a `permissionMode: 'bypassPermissions'` sender.
- The Agent tool input has `name?: string`; a `PreToolUse` hook may return
  `hookSpecificOutput.updatedInput` to rewrite tool input. A Workflow's name is `meta.name` inside
  the script string.
- The SDK emits `{ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType, utilization,
  resetsAt, isUsingOverage, unifiedWindows } }` when the API's rate-limit headers change.
  **`utilization` is a 0-1 fraction, not a percent**, and `resetsAt` is **unix seconds**.
  `rate_limit_info.unifiedWindows` (undeclared in `sdk.d.ts`) carries *both* windows in every
  frame. Nothing in `src/` consumes it yet.
- **UNVERIFIED.** `GET https://api.anthropic.com/api/oauth/usage`: the probe could not reach it —
  `op read "op://Private/Anthropic/Isambard API Key"` failed with `authorization timeout`, so no
  token was available and the curl was skipped. Its required headers and response shape are still
  unconfirmed. Because `unifiedWindows` already delivers both windows per turn, block 3 should
  treat the poller as optional/secondary rather than the primary source.

## Block 1: session identity

- `query-options.ts`: `title` per role, `Izzy-main` for conversation and `Izzy-perch` for perch.
- `src/agent/prompts/system-prompt.ts`: each role prompt states its own name, the other's name,
  that `SendMessage` to that name reaches the other session as the SDK's raw
  `<cross-session-message>` wrapper, and the rule: any listed session without the `Izzy-` prefix
  is most likely one of Craig's own Claude sessions; Izzy may talk to it when that clearly makes
  sense, but doing so can confuse that agent's own work. Also the shared-quota reminder (block 5).
- `src/agent/hooks/agent-naming.ts`: a `PreToolUse` hook on `Agent` that sets or prefixes
  `name` so it starts with `Izzy-` (missing name → `Izzy-<subagent_type or 'agent'>-<n>`), and on
  `Workflow` that rewrites the `name:` literal inside `meta = { … }` in `script` to carry an
  `Izzy-workflow-` prefix when it does not already. Narrow regex, no-op when the literal is not
  found. Registered next to `createTaskLaunchHooks` in `src/app/sessions.ts` for both roles.
  **Amended (review, 2026-09-09):** "narrow" has to mean narrow in the MISS direction only —
  rewriting the *wrong* `name` token is worse than rewriting none, because it leaves the real
  `meta.name` unprefixed while reporting success. So the pattern is anchored to the start of a
  line (`^…m`, after optional indentation and any run of lower-case leading keywords), which
  excludes a `meta = {` inside a comment or a string; the gap before `name` excludes `{` as well
  as `}`, so it can neither leave the `meta` literal nor descend into a nested object's `name`;
  and the rewrite splices at `match.index` rather than going through
  `String.replace(<matched substring>, …)`, which rewrites the first *textual* occurrence and can
  therefore land on an earlier, deliberately-unmatched copy of the same text.

## Block 2: peer envelopes

- `EnvelopeKind` gains `'peer'`; `Envelope` gains `peer?: { from: string, fromName?: string }`.
- `src/agent/session/envelope.ts`: `buildPeerEnvelope({ from, fromName, text, now, timezone,
  timeHeader })` renders a host-only `[PEER · <fromName> · <stamp>]` journal/ledger record plus
  the text. The SDK-visible input remains the raw `<cross-session-message>` wrapper.
- `src/agent/hooks/task-launch.ts`'s `UserPromptSubmit` matcher (or a sibling
  `peer-message.ts`): parse the cross-session tag; on a match call
  `conductor.adoptPeerTurn({ from, fromName, text })`, modelled on `adoptWakeTurn`: the SDK has
  already started a turn from the raw prompt, so the conductor records a `peer` envelope for the
  ledger and journal, never re-submits the text, and fails the turn instead of retrying if a
  turn is already open (same reasoning as `beginAdoptedWakeTurn`). Whatever the probe found about
  hook `prompt` shape and mid-turn queuing is the contract here.
- Ledger: `turn.kind === 'peer'` flows through existing `EnvelopeKind` handling; `renderTaskCounts`
  and presence need no change.
- **Amended (review, 2026-09-09):** pending adoptions (task wakes and peer messages) are ONE
  ordered queue served strictly first-in-first-out, because the SDK serves spontaneous turns in
  arrival order; a peer never jumps a wake or the wake's Discord delivery lands on the wrong turn.
  Peer messages queue (cap 8, oldest dropped with a warn) rather than overwrite each other; a wake
  stays single-slot but keeps its place in arrival order when replaced.
- **Amended (routing fix, 2026-09-11):** an idle peer turn has no automatic outbound delivery.
  Its `UserPromptSubmit` hook injects `hookSpecificOutput.additionalContext` telling the model to
  call `SendMessage` to the wrapper's exact `from` address only when a peer reply is needed;
  messages needing no response are not acknowledged. Discord origin carried in a peer message is
  preserved in replies and handoffs but creates no duty by itself. A result that completes a
  follow-up this session already owes or promised, or one the peer explicitly requests, is
  delivered with the known channel/user and optional message id. Ordinary, malformed, and failed
  hook inputs inject no context. A peer folded into an active turn still fires no hook and retains
  that turn's existing route; a matching route carries an owed/requested response without a
  duplicate tool send, while a different or absent route requires explicit `sendDiscordMessage`.
  Missing channel/user origin never defaults to a general or recent channel. Discord envelope
  headers expose their exact `channelId`, `authorId`, and every source `messageId` supplied to the
  builder. The live debounce adapter currently supplies its first representative message id,
  while multi-context callers such as catch-up preserve the full supplied id list.

## Block 3: quota into the ledger

- `Ledger.quota?: { fiveHour?: Window, sevenDay?: Window, perModel?: Record<string, Window>,
  source: 'headers' | 'poll', at: Date }` with `Window = { utilization: number (0-100),
  resetsAt?: Date }`.
- `reduceSdkFrame`: a `rate_limit_event` frame updates the window named by `rateLimitType`
  (`five_hour` → `fiveHour`, `seven_day` → `sevenDay`; the `seven_day_*` per-model types go to
  `perModel`), `source: 'headers'`. Utilization in the event is whatever unit the probe
  observed; normalise to 0-100.
  **Amended (review, 2026-09-09):** a utilization outside the 0-1 fraction is REJECTED, never
  clamped — a percent-shaped `87` from the unverified usage endpoint would otherwise clamp to 100%,
  pause perch and fire threshold notes with no log. A rejected window is worth one warn per
  poller instance; `resetsAt` accepts unix seconds or an ISO-8601 string. An identical reading
  returns the ledger by reference so subscribers are not woken twice every poll interval, and the
  poller does nothing once stopped.
- New `LedgerEvent` `{ type: 'quota_polled', quota, at }` from a poller
  `src/agent/session/quota-poller.ts`: fetches the usage endpoint every `pollIntervalMs`
  (default 300 000) and once after every `result` frame (debounced to at most once per 30 s),
  dispatching to every ledger it is given. Injected `fetch` and clock; never throws; a failed
  poll logs at debug and keeps the last value.
- Both roles share one poller instance (one subscription, both ledgers).
- **The recurring timer must actually be armed.** `createSessionAmbience` builds the poller but
  the caller owns its lifecycle: `src/index.ts` calls `ambience.quotaPoller.start()` in
  `app.start()` (next to `sagaExecutor.start()`) and `.stop()` in `app.stop()` (next to
  `outboxDrainer.stop()`). Leaving it unarmed makes `pollIntervalMs` dead config and leaves an
  idle process with NO refresh path at all — `rate_limit_event` frames and `noteResult()` both
  require Izzy to be taking turns, while the subscription is being spent by Craig's own sessions
  meanwhile. That is exactly the staleness probe P4 anticipated, and it defeats the block-5 perch
  ceiling, which reads the (stale) ledger peak.

## Block 4: ambient lines in the time header

- `src/utils/time.ts` `formatTimeHeader` stays pure. A new
  `src/agent/session/ambient-lines.ts` exports `composeAmbientLines({ self: Ledger, other?:
  Ledger, now, timezone }): string[]`:
  - other-session line: `Perch: idle since 14:02` / `Perch: slot "reflection" until 15:00,
    working on <digest>, 1 workflow running` / `Conversation: replying in #general` — from the
    other ledger's turn, phase digest, tasks, and (for perch) the envelope's slot fields.
  - quota block: provider-keyed JSON under `Quota:`, with `quota_lookup.status`, explicit `observed_at`,
    `window`, `used_percent`, `remaining_percent`, and `resets_at` fields; omitted when
    no quota is known; adds a `note` about quota sharing only the first time after boot.
    **Amended (review, 2026-09-09):** each window is taken from whichever of the two ledgers holds
    the FRESHER reading of it (`LedgerQuota.at`; a tie goes to `self`), rather than preferring
    `self.quota` wholesale. `rate_limit_event` frames fold only into the emitting role's ledger
    and are change-driven, and nothing mirrors a reading across the stores, so `self` is not
    reliably the fresher one — and a frame with no `unifiedWindows` files only the window that
    tripped the emit, so one ledger can legitimately know a window the other does not.
- Every producer of `timeHeader` (`perch-driver.ts`, `discord/handlers.ts`,
  `conductor-processor.ts`, `catchup-setup.ts`, `notification-bridge.ts`, the boot bundle) gets
  the lines appended through one helper `withAmbientLines(timeHeader, lines)`, wired at the
  composition root (`src/app/sessions.ts`) so the producers receive a `() => string` that already
  includes them.
- The boot bundle's share of that: `createBootBundleBuilder` takes an optional `timeHeader:
  () => string` (both conductor factories pass `() => timeHeader(config.timezone)`), and
  `formatBootBundle` renders it verbatim after the `[BOOT BUNDLE …]` marker and the reset notice,
  ahead of every section. It is deliberately NOT one of the sections the empty-`resume` test
  consults, so a resume with nothing to report still renders `''`. `ContextBuilder.buildPerchContext`
  stays ledger-unaware (its own `formatTimeHeader()` is untouched), so a perch `fresh`/`compact`
  bundle carries a bare header inside the perch-context block as well as the ambient one — the
  same harmless duplication the perch SLOT envelope already has.

## Block 5: thresholds and the perch ceiling

- `src/agent/session/quota-notes.ts`: a coalescer in the style of
  `createHealthOutageCoalescer` that watches ledger quota and calls the notification bridge
  (accumulate only, `wake: false`) when a window crosses 75% or 90% upward, and when it resets
  after having been ≥ 75%. Dedupe key `${window}:${threshold}:${resetsAt}`.
  **Amended (review, 2026-09-09):** only a FORWARD move of `resetsAt` opens a new window instance.
  A reading whose `resetsAt` is older than the tracked instance's is dropped whole — it neither
  raises the peak nor re-opens an instance. `Ledger.quota` is sticky per role, so the quieter
  role keeps re-delivering the ended window's numbers long after the other role has seen the
  reset; treating that as a rollover would reinstate the ended peak (re-asserting `isPaused()`
  after a real reset) and then suppress the genuine rollover note.
- Config `agent.quota: { pollIntervalMs, perchPauseAtPercent (default 90), notifyAtPercents
  ([75, 90]) }` in `src/config/schemas.ts` + loader defaults.
- Perch: `scheduler.ts`'s `isCostPaused` predicate is OR-ed with `fiveHour.utilization >=
  perchPauseAtPercent`; presence's `⏸ perch` marker already renders from `isCostPaused`.
- System prompt (block 1 owns the text): the subscription is shared with Craig's own Claude
  Code sessions and any sub-agents, so utilization can move without Izzy doing anything; a jump
  is not evidence of Izzy's own spend.

## Gates

Every block: `bun test`, `bun run typecheck`, `bun run lint`, mutation 100% on touched files
(`src/agent/session/` included). The probe is the only stage that talks to the real SDK; it
uses the operator's own Claude Code login (no `CLAUDE_CODE_OAUTH_TOKEN` set) and must clean up
the sessions it opens.

## Left unverified (2026-09-09)

All five blocks are implemented, `bun test` (147/147 on the new/changed files), `bun run
typecheck` and `bun run lint` are clean, and `git status --short` shows only this feature's
files. What neither the block-0 probe nor the implementation itself confirmed:

- **The usage endpoint (P5)**: `GET https://api.anthropic.com/api/oauth/usage` was never
  reached — the probe's 1Password read timed out, so its auth header, response shape and even
  whether that URL is correct remain unconfirmed. `quota-poller.ts`'s `parseUsageWindows` is
  written defensively against the one shape that IS verified (the SDK's own
  `rate_limit_info.unifiedWindows`), and a failed/malformed response degrades to a logged
  `debug` line with the last known quota kept — but the poller has never actually been driven by
  a real response from that endpoint, only by fakes in tests.
- **Mid-turn peer delivery (P3), by design**: a peer message that arrives while the receiver is
  already mid-turn fires no `UserPromptSubmit` hook at all, so `adoptPeerTurn` never sees it and
  it never becomes its own `peer` turn in the ledger/journal — the model still reads and can act
  on the text (verified in the probe), but the host-side record of that exchange is silently
  incomplete. This is a known, accepted gap, not a bug to chase, but it is not "verified working"
  in the way the idle-receiver path is.
- **The finished hooks against a live second process**: the block-0 probe validated the SDK's
  peer-messaging and naming *mechanisms* with disposable scratch scripts, before
  `agent-naming.ts`, `peer-message.ts` and `Conductor.adoptPeerTurn` existed. Nothing has since
  re-run two real `Izzy-main`/`Izzy-perch` processes against the actual production hooks to watch
  a `SendMessage` land as a `[PEER · …]` envelope end to end, or a real `Agent`/`Workflow` launch
  get renamed by `agent-naming.ts`'s `PreToolUse` hook — that code path is exercised only by the
  unit-test fakes.
- **The perch quota ceiling and threshold notes against real quota data**: `quota-notes.ts`'s
  `isPaused()` (perch pause at `perchPauseAtPercent`, default 90) and its 75%/90% threshold notes
  have only been driven by synthetic `Ledger.quota` fixtures in tests; no real five-hour window
  has been run up to those levels to confirm perch actually skips a scheduled turn and presence
  actually renders `⏸ perch` from it in production.
- **Housekeeping (P6)**: unrelated to runtime correctness, but the probe's own leftover
  transcripts under `~/.claude/projects/-private-tmp-claude-501-izzy-probe/` were never cleaned
  up (the permission classifier refused the delete) and are still on disk for the operator to
  remove by hand.

## Probe results

Run 2026-09-09 against the repo's `@anthropic-ai/claude-agent-sdk` 0.3.258 (bundled CLI 2.1.266,
`claude-sonnet-5`), two live streaming-input sessions on the operator's own Claude Code login
(no `CLAUDE_CODE_OAUTH_TOKEN`), `permissionMode: 'bypassPermissions'`, `settingSources: []`,
`allowedTools: ['Bash','SendMessage','ListAgents']`, `cwd` a scratch dir. Scripts and raw logs:
`$TMPDIR/izzy-probe/probe{,2..6}.mjs`, `log{,3..6}.jsonl`. Both sessions were closed; no probe
`claude` process or `/tmp/cc-socks` entry survived.

### P0. The Bash sandbox silently breaks peer registration

The first run registered no socket and both sessions were invisible to `ListAgents`. Cause: the
agent's Bash sandbox does not allow writes to `/tmp/cc-socks`, so the CLI's socket bind fails
silently (the CLI logs `bind_failed`/`key_publish_failed` internally; the SDK surfaces nothing).
Any future probe or any Izzy process must be able to write `/tmp/cc-socks` or peer messaging is
dead with no error. Re-running unsandboxed produced `/tmp/cc-socks/<pid>.sock` per session.

### P1. `Options.title` is NOT the peer name — `CLAUDE_CODE_SESSION_NAME` is

Three mechanisms tested:

| tried | peer name observed |
| --- | --- |
| `Options.title: 'Izzy-probe-B'` | `izzy-probe-78` (cwd basename + hash) |
| `title` + `UserPromptSubmit` hook returning `hookSpecificOutput.sessionTitle` | `izzy-probe-4e` |
| `Options.env: { ...process.env, CLAUDE_CODE_SESSION_NAME: 'Izzy-probe-B' }` | **`Izzy-probe-B`** |

With only `title` set, `SendMessage({ to: 'Izzy-probe-B' })` returned verbatim:

```json
{"success":false,"message":"No agent named 'Izzy-probe-B' is reachable. Did you mean: izzy-probe-4e?\nUse ListAgents to see everyone you can message."}
```

With `CLAUDE_CODE_SESSION_NAME` set, `ListAgents` returned verbatim (redacted only by trimming
unrelated peers):

```
This session is Izzy-probe-A [9449b0] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).

Peer sessions (8):
  scratch-c9 [a0740b]  ·  interactive  ·  started 10h ago
  isambard-23 [aa839f]  ·  interactive  ·  busy  ·  started 14h ago
  Izzy-probe-B [3e3348]  ·  interactive  ·  started 14s ago
```

and the send succeeded:

```json
{"success":true,"message":"“BUSY-PING-BRAVO-2” → Izzy-probe-B (another Claude session on this machine)","msg_id":"f2cfe670-…"}
```

Notes for block 1:
- `Options.title` is still useful and still works — it sets the persisted session title and appears
  as `session_title` on every hook payload — it is just not the messaging identity.
- All of Craig's own sessions and the live Izzy sessions currently list as `<cwd basename>-<hash>`
  (`scratch-c9`, `isambard-23`), so the "no `Izzy-` prefix ⇒ probably Craig's own session" rule in
  the block-1 system prompt holds today only because nothing else sets the env var.
- `kind` is reported as `interactive` for SDK-spawned sessions too; it does not distinguish Izzy
  from a human's terminal.
- The registry supports a `nameSource` of `user|peer|derived|collision|auto|hook`; the `hook`
  source was not reachable from the SDK's `UserPromptSubmit` `sessionTitle` output.

### P2. The inbound envelope, verbatim

The `UserPromptSubmit` hook payload for a peer message (whole `prompt` field, verbatim):

```
<cross-session-message from="uds:/tmp/cc-socks/94548.sock" from-name="Izzy-probe-A" from-mode="bypass">
MIDTURN-PING-CHARLIE-3
</cross-session-message>
```

Newlines separate the tag from the body; the body is the sender's `message` argument unmodified.
`from-mode` was `bypass` for a `bypassPermissions` sender (the spec previously guessed
`prompting`). Full hook input, verbatim apart from ids:

```json
{"session_id":"9301c9ba-…","transcript_path":"/Users/craig/.claude/projects/-private-tmp-claude-501-izzy-probe/9301c9ba-….jsonl",
 "cwd":"/private/tmp/claude-501/izzy-probe","prompt_id":"b97f95dd-…","permission_mode":"bypassPermissions",
 "hook_event_name":"UserPromptSubmit","prompt":"<cross-session-message …>…</cross-session-message>",
 "session_title":"Izzy-probe-B"}
```

`source` was **absent** on every hook payload observed (ordinary prompts and peer messages alike),
so block 2 cannot key on `source === 'system'`; it must match the `<cross-session-message` prefix.

Replying to the raw `from` address works: `SendMessage({ to: 'uds:/tmp/cc-socks/93594.sock' })`
returned `{"success":true,"message":"“Ack …” → uds:/tmp/cc-socks/93594.sock", …}` and the peer's
hook fired with the reciprocal envelope.

### P3. Delivery depends on whether the receiver is mid-turn — this is the block-2 hazard

**Receiver idle** (verified twice): the SDK emits, in order,
`{type:'command_lifecycle', command_uuid, state:'started'}` → the `UserPromptSubmit` hook fires
with the envelope → a fresh `system/init` frame → the assistant turn → `result` →
`{type:'command_lifecycle', command_uuid, state:'completed'}`. This is the case `adoptPeerTurn`
can hook.

**Receiver mid-turn** (verified): the message is *folded into the running turn*. The SDK emitted
only `{type:'command_lifecycle', state:'started'}` at delivery time; **the `UserPromptSubmit` hook
did not fire**, no `user` frame carried the envelope, and no extra `result` was produced. The model
saw the peer text at the end of the in-flight turn and acted on it there (it called `SendMessage`
back and mentioned "a ping from another session that arrived while I was working"), and the single
`result` closed both the original prompt and the peer message. Timeline from `log5.jsonl`
(receiver B): prompt at t=6.7 s, `SendMessage` from A at t=19.4 s, B `command_lifecycle` t=19.5 s
(**no hook**), B reply `SendMessage` t=48.9 s, single `result` t=51.2 s, `command_lifecycle` again
t=51.2 s.

Consequences for block 2:
- A hook-driven `adoptPeerTurn` will silently miss every message that lands while the receiving
  session is mid-turn — which is the common case (perch working, conversation pinging it). The
  ledger/journal would then have no `peer` envelope for a message the model demonstrably read.
- `command_lifecycle` (`{type, command_uuid, state:'started'|'completed', uuid, session_id}`) is
  **not** in `sdk.d.ts`'s `SDKMessage` union but is emitted on the stream, and is the only frame
  that marks a folded-in peer message. If block 2 wants complete coverage it must reduce this frame
  (untyped, so guard it), not rely on the hook alone.
- The mid-turn case also means "fails the turn if a turn is already open" (the `beginAdoptedWakeTurn`
  rule) is the wrong contract for peers: for peers the correct behaviour is that no new turn exists
  at all.
- `SendMessage` never blocked or errored on a busy receiver; it returned `success:true` immediately.

### P4. `rate_limit_event`, verbatim

```json
{"type":"rate_limit_event",
 "rate_limit_info":{"status":"allowed_warning","resetsAt":1789466400,"rateLimitType":"seven_day",
   "utilization":0.53,"isUsingOverage":false,
   "unifiedWindows":{"five_hour":{"utilization":0.02,"resetsAt":1788993000},
                     "seven_day":{"utilization":0.53,"resetsAt":1789466400}}},
 "uuid":"222a99c1-…","session_id":"9301c9ba-…"}
```

- **`utilization` is a 0-1 fraction.** `0.53` = 53 %. Confirmed independently in the CLI binary,
  which reads the `anthropic-ratelimit-unified-*-utilization` headers through
  `n => Math.min(1, n)`. Block 3 must multiply by 100, not treat it as a percent.
- **`resetsAt` is unix seconds** (not ms): `1788993000` → 2026-09-09T22:30:00Z (five-hour),
  `1789466400` → 2026-09-15T10:00:00Z (seven-day).
- `rate_limit_info.unifiedWindows` is undeclared in `sdk.d.ts` but was present on every frame and
  carries **both** windows, so one frame is enough to refresh the whole `Ledger.quota` — the
  top-level `utilization`/`resetsAt`/`rateLimitType` only name the window that tripped the emit.
  Per-model weekly windows (`seven_day_opus`, `seven_day_sonnet`) were never observed in this run.
- Emission is change-driven, not per turn: it appeared on the first turn of each session and again
  when a value moved; several turns produced none. A ledger that only reads these frames can go
  stale, which is the argument for keeping some poll — but the poller is no longer load-bearing for
  having *any* quota value.
- `status` was `allowed_warning` at 53 % weekly / 2 % five-hour, so `status` is not a useful
  threshold signal on its own.

### P5. Usage endpoint — not tested

`op read "op://Private/Anthropic/Isambard API Key"` (60 s budget) failed:

```
[ERROR] could not read secret 'op://Private/Anthropic/Isambard API Key': error initializing client: authorization timeout
```

No token, so the `GET /api/oauth/usage` call was skipped. The endpoint's headers and response shape
remain unverified; block 3 must either re-probe with an unlocked 1Password or build the poller
behind an injected `fetch` that is allowed to fail (which the block already specifies).

### P6. Housekeeping

The probe's sessions persisted transcripts under
`~/.claude/projects/-private-tmp-claude-501-izzy-probe/`; deleting that directory was refused by the
permission classifier, so it is left for the operator to remove. `persistSession: false` was tried
and made no difference to peer registration, so later runs left it at the default.
