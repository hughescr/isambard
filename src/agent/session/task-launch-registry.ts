/**
 * In-memory registry of background-work launches (R2, plan `docs/plans/long-lived-session-phase2-4.md`):
 * the {@link import('../hooks/task-launch').createTaskLaunchHooks} PostToolUse hook records one
 * {@link TaskLaunch} per Agent/Workflow/Bash-background launch made during a live turn, keyed by
 * both the launch id (`taskId` — the SDK's `agentId`/`taskId`/`backgroundTaskId`) and the
 * launching `tool_use_id`, so the eventual `<task-notification>` wake (parsed by
 * {@link parseTaskNotification}) can look either one up and hand the launching turn's
 * channel/author back to {@link import('./conductor').Conductor.adoptWakeTurn}.
 *
 * Bounded FIFO by `taskId` (mirrors `notification-bridge.ts`'s dedupe set): a long-lived process
 * launching background work for weeks must not grow this registry without bound, and a launch
 * evicted before its wake arrives simply means the eventual adopted turn carries no
 * channel/author (see `conductor.ts`'s `adoptWakeTurn` doc) rather than losing the reply
 * entirely.
 *
 * @module agent/session/task-launch-registry
 */
import type { SessionJournal } from './ports';
import type { EnvelopeKind, JournalEntry } from './types';

/** Default bounded-FIFO capacity — see {@link CreateTaskLaunchRegistryParams.capacity}. */
export const DEFAULT_TASK_LAUNCH_CAPACITY = 200;

/**
 * One background-work launch: recorded from the launching turn's own context
 * ({@link import('./conductor').ConductorStatus.turn}) at the moment PostToolUse observes the
 * launch, so `kind`/`channelId`/`authorId` describe the turn the work was launched FROM (a
 * launch made from a `task`-kind turn — chained background work — inherits that turn's own
 * channel/author).
 */
export interface TaskLaunch {
    taskId:       string
    toolUseId:    string
    toolName:     string
    envelopeId:   string
    kind:         EnvelopeKind
    channelId?:   string
    authorId?:    string
    description?: string
    launchedAt:   Date
}

/** Dependencies and configuration for {@link createTaskLaunchRegistry}. */
export interface CreateTaskLaunchRegistryParams {
    /** When given, {@link TaskLaunchRegistry.record} also appends a `task_launched` row — omitted, `record` only updates the in-memory registry. */
    journal?:  Pick<SessionJournal, 'append'>
    /** Bounded-FIFO capacity by distinct `taskId`; defaults to {@link DEFAULT_TASK_LAUNCH_CAPACITY}. */
    capacity?: number
}

/** What {@link createTaskLaunchRegistry} returns. */
export interface TaskLaunchRegistry {
    /** Records `launch`, evicting the oldest entry if the registry is now over capacity, and appends `task_launched` to the journal (when one was given). */
    record: (launch: TaskLaunch) => void
    /** Looks up a launch by its wake's `{ taskId, toolUseId }` — matches `toolUseId` first, then `taskId`; `undefined` when neither matches (never recorded, or evicted). */
    lookup: (query: { taskId: string, toolUseId: string }) => TaskLaunch | undefined
    /** Folds `task_launched` journal rows (read at boot) into the registry, in the given order — the same bounded-FIFO/eviction rule as {@link record} applies, without re-appending to the journal. */
    seed:   (entries: readonly JournalEntry[]) => void
    /** Removes `taskId`'s launch, if any — called once its wake has been adopted, so a repeat `<task-notification>` (should one ever arrive) finds nothing to re-adopt. */
    forget: (taskId: string) => void
}

/**
 * Attempts `JSON.parse(text)`, or `undefined` when `text` is not valid JSON. Split out of
 * {@link parseToolResponse} so the two field-shape checks below share one ternary instead of
 * duplicating it per branch.
 */
function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    // eslint-disable-next-line @stylistic/brace-style -- `catch` deliberately on its own line, not `} catch{`: a comment placed immediately before "} catch{" attaches (per Babel's comment-attachment rules) to the try block's last statement, not to the catch clause, so a Stryker `disable next-line` comment there silently fails to suppress the mutant on the (equivalent) catch body below. Verified empirically: only with `catch` starting its own line does the Stryker comment attach to the right node.
    }
    // Stryker disable next-line BlockStatement: equivalent — emptying this catch body still returns `undefined` from `tryParseJson` (falling off the end of a function with a non-`void`/`any` return type but at least one other reachable `return` is an implicit `return undefined` here, since this project does not enable `noImplicitReturns`), and every caller already treats `tryParseJson`'s return as `unknown`, so no caller can observe a thrown-and-caught JSON parse error from a non-throwing "just didn't parse" case.
    catch{
        return undefined;
    }
}

/** Parses `toolResponse` (object or JSON string) into a plain object, or `undefined` when it is neither. */
function parseToolResponse(toolResponse: unknown): Record<string, unknown> | undefined {
    const parsed = typeof toolResponse === 'string' ? tryParseJson(toolResponse) : toolResponse;
    // Stryker disable next-line ConditionalExpression: equivalent — forcing this to `parsed !== null` (dropping the `typeof parsed === 'object'` half) only changes behavior for a non-null PRIMITIVE `parsed` (string/number/boolean — neither `JSON.parse` nor a raw `tool_response` field ever yields a function or symbol); the ternary would then return that primitive itself instead of `undefined`. That primitive flows into `launchIdFromToolResponse`'s three `typeof response.<field> === 'string'` checks, which JS evaluates via safe auto-boxing on any primitive (e.g. `(42).agentId` is `undefined`, never a throw), so every check is `false` regardless and the function still falls through to `return undefined`. No caller can observe `parseToolResponse` returning `undefined` vs. a bare primitive.
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
}

/**
 * Extracts the launch id from a PostToolUse `tool_response` for the three tools that can launch
 * background work (real-SDK facts, probe `probe-task-wake.ts`, SDK 0.3.258): `Agent` carries
 * `agentId`, `Workflow` carries `taskId`, `Bash` (with `run_in_background`) carries
 * `backgroundTaskId`. `toolResponse` may arrive as an object or as a JSON string; both are
 * parsed. Any other tool, or a response missing the expected field, yields `undefined`.
 * @param toolName The PostToolUse hook input's `tool_name`
 * @param toolResponse The PostToolUse hook input's `tool_response`
 * @returns The launch id, or `undefined` when `toolName`/`toolResponse` do not describe a background-work launch
 */
export function launchIdFromToolResponse(toolName: string, toolResponse: unknown): string | undefined {
    const response = parseToolResponse(toolResponse);
    if(response === undefined) {
        return undefined;
    }
    if(toolName === 'Agent' && typeof response.agentId === 'string') {
        return response.agentId;
    }
    if(toolName === 'Workflow' && typeof response.taskId === 'string') {
        return response.taskId;
    }
    if(toolName === 'Bash' && typeof response.backgroundTaskId === 'string') {
        return response.backgroundTaskId;
    }
    return undefined;
}

/**
 * Parses a UserPromptSubmit `prompt` for the `<task-notification>` wake shape (real-SDK facts,
 * probe `probe-task-wake.ts`): `undefined` unless `prompt` starts with `<task-notification>` and
 * both a non-empty `<task-id>`/`<tool-use-id>` tag are present.
 * @param prompt The UserPromptSubmit hook input's `prompt`
 * @returns The parsed `{ taskId, toolUseId }`, or `undefined` when `prompt` is not a task-notification wake
 */
export function parseTaskNotification(prompt: string): { taskId: string, toolUseId: string } | undefined {
    if(!prompt.startsWith('<task-notification>')) {
        return undefined;
    }
    const taskId = /<task-id>([\s\S]*?)<\/task-id>/.exec(prompt)?.[1];
    const toolUseId = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(prompt)?.[1];
    if(taskId === undefined || taskId === '' || toolUseId === undefined || toolUseId === '') {
        return undefined;
    }
    return { taskId, toolUseId };
}

/**
 * Creates a {@link TaskLaunchRegistry}.
 * @param params See {@link CreateTaskLaunchRegistryParams}.
 * @returns A {@link TaskLaunchRegistry}.
 */
export function createTaskLaunchRegistry(params: CreateTaskLaunchRegistryParams = {}): TaskLaunchRegistry {
    const { journal, capacity = DEFAULT_TASK_LAUNCH_CAPACITY } = params;

    const byTaskId = new Map<string, TaskLaunch>();
    const byToolUseId = new Map<string, string>();
    // Stryker disable next-line ArrayDeclaration: a non-empty initializer here is equivalent — `evictOverCapacity`'s own tolerant guard (see its doc) silently absorbs any entry with no matching `byTaskId` record on the very first eviction it triggers, with no effect on any real, live entry thereafter; no `lookup()` result can distinguish an empty start from a garbage one.
    /** `taskId`s in insertion order, for FIFO eviction. */
    const order: string[] = [];

    /**
     * Evicts the oldest entries until the registry is back within `capacity`. Relies on the
     * invariant `insert`/`forget` maintain: every `taskId` in `order` has exactly one live entry
     * in `byTaskId`, and vice versa (`insert` only pushes to `order` for a genuinely new
     * `taskId`; `forget` removes from both `byTaskId`/`byToolUseId` AND splices `order` in the
     * same call) — so both defensive checks below are unreachable-false in practice, kept only
     * in case that invariant is ever broken by a future change.
     */
    function evictOverCapacity(): void {
        while(order.length > capacity) {
            const oldestTaskId = order.shift();
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: unreachable by construction — the `while` guard (`order.length > capacity`, and capacity is never negative) guarantees `order` is non-empty here, so `shift()` always returns a value.
            if(oldestTaskId === undefined) {
                break;
            }
            const evicted = byTaskId.get(oldestTaskId);
            byTaskId.delete(oldestTaskId);
            // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable by construction per this function's own doc — `oldestTaskId` came from `order`, which only ever holds `taskId`s with a live `byTaskId` entry. The `byToolUseId.delete` call itself is NOT covered by this disable (and must not be — dropping it is a real bug, see `tests/unit/agent/session/task-launch-registry.test.ts`'s "eviction ... removes the toolUseId index entry too" case): a stale `byToolUseId` entry would outlive its `byTaskId` record and let a LATER launch that reuses the evicted `taskId` under a different `toolUseId` be reached, incorrectly, via the old, evicted `toolUseId`.
            if(evicted !== undefined) {
                byToolUseId.delete(evicted.toolUseId);
            }
        }
    }

    /**
     * Inserts/overwrites `launch` in both indexes and enforces `capacity`. Shared by
     * `record`/`seed`. When `taskId` was already present under a DIFFERENT `toolUseId` (a launch
     * re-recorded with a new tool-use id), the superseded `toolUseId` index entry is removed
     * first — otherwise it would outlive `forget(taskId)` and let a later, unrelated wake query
     * resolve through the stale mapping to this (still-live) launch.
     */
    function insert(launch: TaskLaunch): void {
        const existing = byTaskId.get(launch.taskId);
        if(existing === undefined) {
            order.push(launch.taskId);
        } else {
            // Stryker disable next-line ConditionalExpression: equivalent — forcing this branch to always run when the taskId already existed only matters when `existing.toolUseId` genuinely differs from `launch.toolUseId`; when it does not, this deletes `byToolUseId`'s entry for that key and the very next line (`byToolUseId.set(launch.toolUseId, ...)`, unconditional below) immediately re-adds the SAME key with the SAME value — a delete-then-re-add with no observable effect on any `lookup()` result. (Written as `else { if }` rather than `else if` so this disable comment precedes a standalone statement Stryker's next-line disable can attach to — an `else if` clause continues the enclosing `if` statement instead.)
            if(existing.toolUseId !== launch.toolUseId) {
                byToolUseId.delete(existing.toolUseId);
            }
        }
        byTaskId.set(launch.taskId, launch);
        byToolUseId.set(launch.toolUseId, launch.taskId);
        evictOverCapacity();
    }

    function record(launch: TaskLaunch): void {
        insert(launch);
        journal?.append({
            type: 'task_launched', at: launch.launchedAt, taskId: launch.taskId, toolUseId: launch.toolUseId, toolName: launch.toolName, envelopeId: launch.envelopeId, kind: launch.kind,
            ...(launch.channelId === undefined ? {} : { channelId: launch.channelId }),
            ...(launch.authorId === undefined ? {} : { authorId: launch.authorId }),
            ...(launch.description === undefined ? {} : { description: launch.description }),
        });
    }

    function lookup(query: { taskId: string, toolUseId: string }): TaskLaunch | undefined {
        const taskIdViaToolUseId = byToolUseId.get(query.toolUseId);
        const viaToolUseId = taskIdViaToolUseId === undefined ? undefined : byTaskId.get(taskIdViaToolUseId);
        return viaToolUseId ?? byTaskId.get(query.taskId);
    }

    function seed(entries: readonly JournalEntry[]): void {
        for(const entry of entries) {
            if(entry.type === 'task_launched') {
                insert({
                    taskId: entry.taskId, toolUseId: entry.toolUseId, toolName: entry.toolName, envelopeId: entry.envelopeId, kind: entry.kind, channelId: entry.channelId, authorId: entry.authorId, description: entry.description, launchedAt: entry.at,
                });
            }
        }
    }

    function forget(taskId: string): void {
        const launch = byTaskId.get(taskId);
        if(launch === undefined) {
            return;
        }
        byTaskId.delete(taskId);
        byToolUseId.delete(launch.toolUseId);
        const index = order.indexOf(taskId);
        // Stryker disable next-line ConditionalExpression: unreachable by construction — reaching this point means `taskId` was found in `byTaskId` (the early return above), and `insert()` only ever pushes a `taskId` to `order` at the same moment it first adds it to `byTaskId`, so the two share exactly the same key set; `index` is never -1 here.
        if(index !== -1) {
            order.splice(index, 1);
        }
    }

    return { record, lookup, seed, forget };
}
