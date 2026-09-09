# Task board: a live-edited Discord embed for Izzy's background work

Status: implemented 2026-09-09 (ledger tracking, composer/renderer, Discord manager, wiring); the first real workflow launch is still to be checked against the ledger's debug log of the raw workflow_progress frame. Mockup: https://claude.ai/code/artifact/a37143aa-57d5-4dc2-b9b2-180a99993f79

## Goal

When Izzy launches sub-agents, workflows, or background shell commands, the person talking to
Izzy sees one Discord embed in that channel that updates every few seconds with what is running,
how far along it is, and when it finishes. The embed is system-posted from ledger state; Izzy's
own words about the work arrive as ordinary messages, separately.

## Data source: SDK frames the ledger already receives

All `system` frames, SDK 0.3.258 (`src/agent/types.ts` `SystemEvent`, and the CLI binary):

| subtype | fields used |
|---|---|
| `task_started` | `task_id`, `tool_use_id`, `task_type` (`local_agent` / `local_workflow` / `local_bash` / monitor), `description`, `subagent_type`, `is_backgrounded`, `ambient`, `workflow_name` |
| `task_progress` | `task_id`, `summary` (AI one-liner, ~every 30 s), `last_tool_name`, `usage { total_tokens, tool_uses, duration_ms }`, `workflow_progress` (workflows only, see below) |
| `task_notification` | `task_id`, `status` (`completed` / `failed` / `stopped`), `usage` |
| `background_tasks_changed` | `tasks[]` — REPLACE semantics for the **background** set only |

`workflow_progress` is not in the SDK `.d.ts` yet but is emitted by the CLI on every workflow
`task_progress`. It is an array of entries, each with a `type`:

- `workflow_phase`: `{ index, title, kind }` — every declared `meta.phases` entry is announced up front.
- `workflow_agent`: `{ index, label, phaseIndex, phaseTitle, agentType?, model?, state, tokens?, toolCalls?, startedAt?, lastProgressAt?, queuedAt?, cached?, error?, blocked? }` where `state` is `'start' | 'done' | 'error'` (treat unknown strings as running).
- `workflow_log`: ignored.

Everything about this field is typed optional and parsed defensively: a malformed entry is
skipped, never thrown on. The first real workflow launch after this ships should be checked
against the debug log line the ledger emits for the raw frame.

### Foreground vs background tasks

A foreground `Agent` (Task tool without `run_in_background`) still emits `task_started` (with
`is_backgrounded: false`) and `task_progress`, but never `task_notification`, and is absent from
`background_tasks_changed`. It ends when the `user` frame carrying the `tool_result` for its
`tool_use_id` arrives. The ledger today drops foreground tasks entirely; the board needs them,
so the ledger now tracks both, distinguished by `background: boolean`:

- `applyBackgroundTasksChanged` replaces only the background subset and keeps foreground entries.
- A foreground task is finished by the matching `tool_result` (`status: 'completed'`; the SDK
  reports `is_error` on the result block, which maps to `'failed'`).

## Ledger contract (block 1, `src/agent/session/ledger.ts`)

```ts
export interface LedgerTask {
    id:           string
    toolUseId?:   string
    taskType:     string
    kind:         'subagent' | 'workflow' | 'shell' | 'monitor' | 'other'
    description:  string
    /** subagent_type for sub-agents, workflow_name for workflows */
    label?:       string
    background:   boolean
    /** Channel of the turn that was open when the task started; undefined for perch or turn-less launches. */
    channelId?:   string
    /** Id of the turn that was open at task_started — groups tasks into one board. */
    turnId?:      string
    startedAt:    Date
    /** Latest task_progress payload, when any has arrived. */
    progress?: {
        summary?:      string
        lastToolName?: string
        totalTokens?:  number
        toolUses?:     number
        durationMs?:   number
        at:            Date
    }
    /** Workflows only: derived from workflow_progress on each task_progress. */
    workflow?: {
        phases:        { index: number, title: string }[]
        agents:        { index: number, label: string, phaseIndex: number, state: 'running' | 'done' | 'error', tokens: number, toolCalls: number }[]
    }
    status:       'running' | 'completed' | 'failed' | 'stopped'
    finishedAt?:  Date
}
```

Rules:
- `ledger.tasks` keeps **running** tasks, as today, so `renderTaskCounts` in presence is unchanged
  in meaning (it now also counts foreground sub-agents; that is intended).
- Finished tasks move to `ledger.finishedTasks: LedgerTask[]`, capped at the 20 most recent, so
  the board can render a finished row and a later boot does not accumulate them. `task_lost`
  moves the task there with `status: 'stopped'`.
- `task_progress` for an unknown id is ignored (never creates a task).
- A `result` frame that closes a turn stops every running **foreground** task (they cannot outlive
  their turn, and an interrupted turn never delivers the finishing `tool_result`); `session_opened`
  with a new session id stops every running task, foreground and background alike.
- `task_started` for an id `background_tasks_changed` already created enriches that entry
  (`toolUseId`, `label`, `channelId`, `turnId` when missing, `background` from the frame) rather
  than being dropped; `task_notification` for an id that already moved to `finishedTasks` corrects
  that row in place, keeping its `finishedAt`.
- A `workflow_progress` entry with no finite `index` cannot be keyed and is skipped; its other
  fields still fall back to their defaults.
- The existing `LedgerEvent` set is unchanged; every new fact comes from `sdk_frame`.

## Board composition and rendering (block 2, `src/integrations/discord/task-board/`)

Pure functions, no I/O, no LLM:

- `composeTaskBoards(ledgers: readonly Ledger[], now: Date): TaskBoardView[]` — one view per
  **board key** `${channelId}:${turnId}` over running + finished tasks that have a `channelId`.
  Tasks with no channel produce no board. A view carries: `key`, `channelId`, `tasks` (launch
  order, never reordered), `state: 'running' | 'done' | 'failed'` (failed if any task failed or
  stopped, done when none running), `startedAt`, `finishedAt?`, and per-task derived fields
  (elapsed ms, meter fraction for workflows).
- `renderTaskBoardEmbed(view, now): { title, color, fields[], footer }` — a plain object the
  Discord layer maps onto `EmbedBuilder`. Text conventions, from the approved mockup:
  - Title: `⏳ Working in the background · N running[, M done]` / `✅ Background work finished · N tasks · m:ss` / `❌ Background work stopped · …`.
  - One field per task. Name: kind emoji (**the same table as presence**: 🔬 sub-agent, 🪾 workflow, ⌚ monitor; shell gets 🐚) or ✅/❌ once finished, then ` · ` label (route or workflow name) ` · ` description (capped at 60 chars).
  - Workflow value: fixed ten-cell meter `▰▰▰▱▱▱▱▱▱▱` where fraction = (agents done) / (agents seen), followed by `p / P phases · a / A agents finished`, a second line with the running phase title and `Nk tokens so far`, and a third grey line `↳ label · summary` for the most recent running agent when a summary exists.
  - Sub-agent/shell value: `summary` (or `Starting up`) ` · Nk tokens · m:ss`; finished: `Nk tokens · T tool calls · m:ss`.
  - Footer: `Updates every few seconds · Last update h:mm:ss` while running; `Finished h:mm:ss` when done.
  - Limits: at most 25 fields, 256 chars per field name, 1024 chars per value, 6000 total (names
    counting towards it alongside values, title and footer); truncate rather than throw.
- A rendered embed must be deterministic for a given (view, now) so the Discord layer can skip
  an edit when nothing changed.

## Discord layer and wiring (block 3)

- `task-board/manager.ts`: `TaskBoardManager` with `applyViews(views)`. Per key: first sight →
  `channel.send({ embeds })` and remember the `Message`; subsequent → `message.edit({ embeds })`
  through a **trailing-edge** throttle (`editIntervalMs`, default 3000) so the last state always
  lands; identical rendered embed → no edit. When a view reaches a terminal state it gets one
  final edit, bypassing the throttle, and once that edit **lands** the board is frozen: further
  terminal views are ignored. Frozen is not closed — a later `running` view for the same key (a
  second sub-agent launched in the same turn) thaws it and resumes throttled edits on the **same
  message**. A key is forgotten only when it leaves `views` or on `stop()`.
  A final edit that fails is retried once an `editIntervalMs` later, rendering whatever the latest
  view is by then; a second failure warns and gives up. That retry has to be the manager's own
  timer, because `setup.ts`'s refresh interval stops as soon as nothing is running. Views for keys
  whose message send failed are retried once on the next apply, then abandoned with a warn log
  (the entry is kept so the board is never re-sent). Every fire-and-forget completion re-checks
  that its entry is still the live one for its key before editing Discord or arming a timer, so a
  send or edit that lands after the board was dropped (or after `stop()`) is discarded with a
  debug log. Uses `withDiscordRetry`; add an `editMessage` method to `DiscordRateLimiter` next to
  `sendToChannel`.
- `task-board/setup.ts`: `setupTaskBoard({ readyClient, ledgers, config, logger, now })`
  subscribes to every ledger (like `presence-setup.ts`) and additionally ticks every
  `refreshIntervalMs` (default 10 000) while any board is running so elapsed time advances.
  Returns `{ stop }`.
- Config: `discord.taskBoard: { enabled: boolean (default true), editIntervalMs, refreshIntervalMs }`
  in `src/config/schemas.ts` with loader defaults.
- `bot.ts`: wire next to `setupConductorPresence`, same `conductorLedgers`, gated on the same
  `conductorOpened` condition and `config.taskBoard?.enabled !== false`.
- Restart: boards are in-memory only. After a restart, tasks still tracked by the ledger get a
  new message; the old one stays as-is.

## Out of scope for this pass

Perch-session launches (no channel → no board), per-task stop buttons, reading the workflow
journal file, DM channels beyond what `channels.fetch` already handles.
