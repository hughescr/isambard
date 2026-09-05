/**
 * Phase 0 spike for the long-lived session design (docs: Izzy Long-Lived Session artifact).
 *
 * Runs against the REAL Agent SDK and spends real tokens. Not a test; never run under `bun test`.
 *
 *   env -u ANTHROPIC_BASE_URL bun scripts/spike-long-lived-session.ts [q1,q2,...] [--record[=dir]]
 *
 * Questions answered (each prints a VERDICT line):
 *   q1  streaming session: several turns through one process; a background Task launched in
 *       turn 1 completes and notifies while later turns run; does the notification start a
 *       turn on its own (no host input)?
 *   q2  interrupt() with perTaskStopAffordance: does a running background task survive?
 *   q3  SessionStart(source='compact') additionalContext: does it reach the model after auto-compaction?
 *   q4  shouldQuery:false: is the appended message visible in the next real turn?
 *   q5  resume by session id in a fresh process: is the transcript continuous?
 *   q6  two concurrent query() calls sharing ONE in-process MCP server instance vs two instances.
 *
 * --record[=dir]: also write committed SDK fixtures (default dir tests/fixtures/sdk-frames/) so
 * tests/helpers/fake-query.ts and tests/helpers/sdk-frames.ts can replay real frame shapes with
 * no network access. Two channels: every SDKMessage the iterator yields (<dir>/frames/<label>.json)
 * and every hook-callback `input` argument (<dir>/hook-inputs/<label>.json). Volatile fields
 * (ids, timestamps, model/tool lists, transcript paths, compaction summary text — see
 * normaliseVolatileFields below) are rewritten to stable placeholders before writing so fixtures
 * diff cleanly across re-recordings. RE-RECORD THESE FIXTURES ON EVERY @anthropic-ai/claude-agent-sdk
 * BUMP: run `env -u ANTHROPIC_BASE_URL bun scripts/spike-long-lived-session.ts q1,q2,q3 --record`
 * again and commit the result — the fixture drift guard (tests/unit/helpers/sdk-frames.test.ts)
 * compares each written `sdkVersion` against the installed SDK version and fails loudly on drift.
 * Recording never writes unless --record is passed; nothing else about the spike's behaviour changes.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, createSdkMcpServer, tool, type Options, type SDKMessage, type SDKUserMessage, type HookCallbackMatcher, type HookInput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseSpikeArgs } from './spike-argv';

// eslint-disable-next-line n/no-sync, sonarjs/publicly-writable-directories -- startup-only fixture creation, per-run mkdtemp under TMPDIR
const WORKDIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'izzy-spike-'));
const MODEL = 'haiku';

// ---------------------------------------------------------------- argv: question list + --record
const { recording, recordDir: RECORD_DIR, questionArg } = parseSpikeArgs(process.argv.slice(2));
const wanted = new Set(questionArg.split(','));

// eslint-disable-next-line n/no-sync -- startup-only: read the installed SDK's exact version so recorded fixtures carry real provenance for the drift guard
const SDK_VERSION = (JSON.parse(readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    'utf8'
)) as { version: string }).version;

// ---------------------------------------------------------------- --record fixture writer
/** Field names whose string value is replaced wholesale with a `<key>` placeholder. */
const VOLATILE_STRING_KEYS = new Set([
    'uuid', 'session_id', 'task_id', 'tool_use_id', 'hook_id', 'output_file',
    'transcript_path', 'cwd', 'claude_code_version', 'model', 'compact_summary', 'prompt_id',
    'path', 'messaging_socket_path', 'output', 'stdout',
]);
/** Field names whose entire array value carries no fixture-relevant information. */
const VOLATILE_ARRAY_KEYS = new Set(['tools', 'mcp_servers', 'slash_commands']);

/**
 * Rewrites volatile fields (ids, timestamps, model/tool lists, paths, compaction summary text)
 * to stable placeholders so committed fixtures diff cleanly across re-recordings. Walks the
 * whole structure recursively; `message.id` is handled as a special case since `id` alone is
 * too common a key to blanket-normalise.
 */
function normaliseVolatileFields(node: unknown): unknown {
    if(Array.isArray(node)) {
        return node.map(item => normaliseVolatileFields(item));
    }
    if(node !== null && typeof node === 'object') {
        const entries = Object.entries(node as Record<string, unknown>);
        return Object.fromEntries(entries.map(([key, value]) => [key, normaliseEntry(key, value)]));
    }
    return node;
}

function normaliseEntry(key: string, value: unknown): unknown {
    if(VOLATILE_STRING_KEYS.has(key) && typeof value === 'string') {
        return `<${key}>`;
    }
    if(VOLATILE_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        // A placeholder ARRAY, not a string: these fields are declared as string[] on the SDK
        // types (e.g. SDKSystemMessage.tools), and a placeholder string here would let a consumer
        // call .map/.filter/.includes on what looks like a string[] and get a TypeError or a
        // silently wrong answer at runtime instead of a type error at compile time.
        return [`<${key}>`];
    }
    if(key === 'timestamp') {
        return typeof value === 'number' ? 0 : '<timestamp>';
    }
    if(key.endsWith('_ms') && typeof value === 'number') {
        return 0;
    }
    if(key === 'message' && value !== null && typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
        return normaliseVolatileFields({ ...(value as Record<string, unknown>), id: '<message.id>' });
    }
    return normaliseVolatileFields(value);
}

const frameRecordings = new Map<string, SDKMessage[]>();
const hookInputRecordings = new Map<string, HookInput[]>();

/** Iterator channel: append a normalised, deep-cloned copy of `frame` under `label`. */
function recordFrame(label: string, frame: SDKMessage): void {
    if(!recording) {
        return;
    }
    const bucket = frameRecordings.get(label) ?? [];
    bucket.push(normaliseVolatileFields(structuredClone(frame)) as SDKMessage);
    frameRecordings.set(label, bucket);
}

/** Hook-callback channel: append a normalised, deep-cloned copy of a hook's `input` under `label`. */
function recordHookInput(label: string, input: HookInput): void {
    if(!recording) {
        return;
    }
    const bucket = hookInputRecordings.get(label) ?? [];
    bucket.push(normaliseVolatileFields(structuredClone(input)) as HookInput);
    hookInputRecordings.set(label, bucket);
}

/**
 * Classifies a streamed SDKMessage into one of the fixed fixture labels, or undefined when the
 * frame is not one we record. `result_interrupted` and `bare_result_should_query_false` are
 * positional (the next `result` after an armed session event) and are handled by the caller via
 * `pendingLabel`, taking priority over this table when set.
 */
function classifyFrame(m: SDKMessage, pendingLabel: string | undefined): string | undefined {
    if(pendingLabel !== undefined) {
        return pendingLabel;
    }
    if(m.type === 'result') {
        return (m as { subtype?: string }).subtype === 'success' ? 'result_success' : undefined;
    }
    if(m.type === 'assistant') {
        const content = (m as unknown as { message: { content: { type: string, text?: string }[] } }).message.content;
        if(content.some(b => b.type === 'tool_use')) {
            return 'assistant_tool_use';
        }
        if(content.some(b => b.type === 'text' && (b.text ?? '').length > 0)) {
            return 'assistant_text';
        }
        return undefined;
    }
    if(m.type === 'system') {
        const subtype = (m as { subtype?: string }).subtype;
        const recordedSystemSubtypes = new Set(['init', 'task_started', 'task_progress', 'task_notification', 'background_tasks_changed', 'compact_boundary', 'hook_started', 'hook_response']);
        return subtype !== undefined && recordedSystemSubtypes.has(subtype) ? subtype : undefined;
    }
    return undefined;
}

/**
 * Classifies and records one streamed frame (a no-op when --record is off), returning the
 * pendingResultLabel value the caller's loop should carry into the next frame — cleared once a
 * 'result' frame has consumed it, otherwise passed through unchanged.
 */
function recordIncomingFrame(m: SDKMessage, pendingResultLabel: string | undefined): string | undefined {
    const pending = m.type === 'result' ? pendingResultLabel : undefined;
    const label = classifyFrame(m, pending);
    if(label !== undefined) {
        recordFrame(label, m);
    }
    return m.type === 'result' ? undefined : pendingResultLabel;
}

/** Writes every non-empty recorded label as a committed fixture file. Called once, at exit. */
function writeFixtures(): void {
    if(!recording) {
        return;
    }
    const framesDir = path.join(RECORD_DIR, 'frames');
    const hookInputsDir = path.join(RECORD_DIR, 'hook-inputs');
    // eslint-disable-next-line n/no-sync -- one-shot end-of-run fixture write, not a hot path
    mkdirSync(framesDir, { recursive: true });
    // eslint-disable-next-line n/no-sync -- one-shot end-of-run fixture write, not a hot path
    mkdirSync(hookInputsDir, { recursive: true });
    for(const [label, frames] of frameRecordings) {
        if(frames.length === 0) {
            continue;
        }
        // eslint-disable-next-line n/no-sync -- one-shot end-of-run fixture write, not a hot path
        writeFileSync(path.join(framesDir, `${label}.json`), `${JSON.stringify({ sdkVersion: SDK_VERSION, label, frames }, null, 4)}\n`);
        log('record', `wrote ${frames.length} frame(s) for label '${label}'`);
    }
    for(const [label, inputs] of hookInputRecordings) {
        if(inputs.length === 0) {
            continue;
        }
        // eslint-disable-next-line n/no-sync -- one-shot end-of-run fixture write, not a hot path
        writeFileSync(path.join(hookInputsDir, `${label}.json`), `${JSON.stringify({ sdkVersion: SDK_VERSION, label, inputs }, null, 4)}\n`);
        log('record', `wrote ${inputs.length} hook input(s) for label '${label}'`);
    }
    const observed = new Set([...frameRecordings.keys(), ...hookInputRecordings.keys()]);
    const expected = ['init', 'assistant_text', 'assistant_tool_use', 'result_success', 'result_interrupted', 'bare_result_should_query_false', 'task_started', 'task_progress', 'task_notification', 'background_tasks_changed', 'compact_boundary', 'hook_started', 'hook_response', 'hook_session_start_startup', 'hook_session_start_compact', 'pre_compact', 'post_compact'];
    for(const label of expected) {
        if(!observed.has(label)) {
            log('record', `label '${label}' was NOT observed this run — no fixture written for it`);
        }
    }
}

// ---------------------------------------------------------------- helpers
function log(tag: string, ...rest: unknown[]): void {
    // eslint-disable-next-line no-console -- this script's output IS its result
    console.log(`[${new Date().toISOString().slice(11, 23)}] ${tag}`, ...rest);
}
function verdictLabel(ok: boolean | 'unclear'): string {
    if(ok === true) {
        return 'YES';
    }
    if(ok === false) {
        return 'NO';
    }
    return 'UNCLEAR';
}
function verdict(q: string, ok: boolean | 'unclear', detail: string): void {
    // eslint-disable-next-line no-console -- this script's output IS its result
    console.log(`\nVERDICT ${q}: ${verdictLabel(ok)} — ${detail}\n`);
}
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** Host-owned input queue that the SDK consumes as the prompt iterable. */
class Inbox {
    private queue:   SDKUserMessage[] = [];
    private waiters: (() => void)[] = [];
    private closed = false;
    push(text: string, extra: Partial<SDKUserMessage> = {}): void {
        this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...extra });
        for(const w of this.waiters.splice(0)) {
            w();
        }
    }

    close(): void {
        this.closed = true;
        for(const w of this.waiters.splice(0)) {
            w();
        }
    }

    async* [Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
        for(;;) {
            if(this.queue.length > 0) {
                yield this.queue.shift()!;
                continue;
            }
            if(this.closed) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop -- this loop IS the host's wait-for-next-input mechanism; there's nothing to parallelize
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }
}

interface Session {
    q:                           ReturnType<typeof query>
    inbox:                       Inbox
    events:                      SDKMessage[]
    /** Wait for the next 'result' message (one turn end). */
    nextResult:                  (timeoutMs?: number) => Promise<SDKMessage | undefined>
    /** Wait until a predicate matches an event, scanning new events as they arrive. */
    waitFor:                     (pred: (m: SDKMessage) => boolean, timeoutMs?: number) => Promise<SDKMessage | undefined>
    sessionId:                   () => string | undefined
    stop:                        () => void
    /** --record only: labels the next 'result' frame observed 'result_interrupted' regardless of its real subtype (recorded as-is). */
    armInterruptedResultCapture: () => void
}

function baseOptions(extra: Partial<Options> = {}): Options {
    return {
        model:                           MODEL,
        cwd:                             WORKDIR,
        permissionMode:                  'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        perTaskStopAffordance:           true,
        strictMcpConfig:                 true,
        agentProgressSummaries:          false,
        includePartialMessages:          false,
        stderr:                          (d: string) => {
            if(!d.includes('Operation aborted')) {
                log('stderr', d.trim().slice(0, 300));
            }
        },
        env: { ...process.env, ANTHROPIC_BASE_URL: undefined as unknown as string, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        ...extra,
    };
}

function openSession(opts: Partial<Options> = {}): Session {
    const inbox = new Inbox();
    const events: SDKMessage[] = [];
    const listeners = new Set<(m: SDKMessage) => void>();
    let sid: string | undefined;
    // --record only: the label the NEXT 'result' frame should carry (positional: armed by an
    // interrupt() call or a shouldQuery:false send), cleared as soon as a result frame arrives.
    let pendingResultLabel: string | undefined;
    if(recording) {
        const originalPush = inbox.push.bind(inbox);
        inbox.push = (text: string, extra: Partial<SDKUserMessage> = {}): void => {
            if(extra.shouldQuery === false) {
                pendingResultLabel = 'bare_result_should_query_false';
            }
            originalPush(text, extra);
        };
    }
    const q = query({ prompt: inbox, options: baseOptions(opts) });
    void (async () => {
        try {
            for await (const m of q) {
                events.push(m);
                if('session_id' in m && typeof m.session_id === 'string') {
                    sid = m.session_id;
                }
                if(recording) {
                    pendingResultLabel = recordIncomingFrame(m, pendingResultLabel);
                }
                const short = summarise(m);
                if(short) {
                    log('evt', short);
                }
                for(const l of listeners) {
                    l(m);
                }
            }
            log('gen', 'generator ended');
        } catch (e) {
            log('gen', 'generator threw', String(e));
        }
    })();
    const waitFor = (pred: (m: SDKMessage) => boolean, timeoutMs = 120_000): Promise<SDKMessage | undefined> => new Promise((resolve) => {
        const box: { timer?: ReturnType<typeof setTimeout> } = {};
        const listener = (m: SDKMessage): void => {
            if(pred(m)) {
                clearTimeout(box.timer);
                listeners.delete(listener);
                resolve(m);
            }
        };
        box.timer = setTimeout(() => {
            listeners.delete(listener);
            resolve(undefined);
        }, timeoutMs);
        listeners.add(listener);
    });
    return {
        q,
        inbox,
        events,
        waitFor,
        nextResult: t => waitFor(m => m.type === 'result', t),
        sessionId:  () => sid,
        stop:       () => {
            inbox.close();
            q.close();
        },
        armInterruptedResultCapture: () => {
            if(recording) {
                pendingResultLabel = 'result_interrupted';
            }
        },
    };
}

function summariseBlock(b: { type: string, text?: string, name?: string }): string {
    if(b.type === 'text') {
        return b.text ?? '';
    }
    if(b.type === 'tool_use') {
        return `<tool_use ${b.name}>`;
    }
    return `<${b.type}>`;
}

function summariseAssistant(m: SDKMessage): string {
    const anyM = m as Record<string, unknown>;
    const content = (anyM.message as { content?: { type: string, text?: string, name?: string }[] }).content;
    const text = content?.map(b => summariseBlock(b)).join(' ');
    return `assistant: ${text?.slice(0, 160)}`;
}

function summariseSystem(m: SDKMessage): string | undefined {
    const anyM = m as Record<string, unknown>;
    const st = String(anyM.subtype);
    if(st === 'init') {
        return `system/init session=${String(anyM.session_id)}`;
    }
    const taskLike = st.startsWith('task_') || st === 'background_tasks_changed' || st === 'compact_boundary' || st === 'session_state_changed' || st === 'status';
    if(taskLike) {
        return `system/${st} ${JSON.stringify({ task_id: anyM.task_id, status: anyM.status, state: anyM.state, tasks: anyM.tasks, summary: typeof anyM.summary === 'string' ? anyM.summary.slice(0, 80) : undefined, compact: anyM.compact_metadata })}`;
    }
    return undefined;
}

function summariseUser(m: SDKMessage): string | undefined {
    const anyM = m as Record<string, unknown> & { origin?: unknown };
    if(anyM.isSynthetic || anyM.origin) {
        return `user(synthetic/origin=${JSON.stringify(anyM.origin)}): ${JSON.stringify(anyM.message).slice(0, 120)}`;
    }
    return undefined;
}

function summarise(m: SDKMessage): string | undefined {
    if(m.type === 'assistant') {
        return summariseAssistant(m);
    }
    if(m.type === 'result') {
        const anyM = m as Record<string, unknown>;
        return `result subtype=${String(anyM.subtype)} queued=${String(anyM.queued_turn_count)}`;
    }
    if(m.type === 'system') {
        return summariseSystem(m);
    }
    if(m.type === 'user') {
        return summariseUser(m);
    }
    return undefined;
}

function lastAssistantText(events: SDKMessage[], since = 0): string {
    for(let i = events.length - 1; i >= since; i--) {
        const m = events[i];
        if(m.type === 'assistant') {
            const content = (m as unknown as { message: { content: { type: string, text?: string }[] } }).message.content;
            const t = content.filter(b => b.type === 'text').map(b => b.text ?? '').join(' ');
            if(t) {
                return t;
            }
        }
    }
    return '';
}

// ---------------------------------------------------------------- q1 + q2 (same session)
// eslint-disable-next-line sonarjs/function-return-type -- tri-state verdict (boolean | 'unclear') matches the verdict() helper's own parameter type used throughout this file
function autoTurnVerdict(autoTurn: SDKMessage | undefined, notif: SDKMessage | undefined): boolean | 'unclear' {
    if(autoTurn) {
        return true;
    }
    if(notif) {
        return false;
    }
    return 'unclear';
}

function isTaskNotification(m: SDKMessage): boolean {
    return m.type === 'system' && (m as { subtype?: string }).subtype === 'task_notification';
}

async function q1q2(): Promise<void> {
    const s = openSession();
    log('q1', 'turn 1: launch a background task that sleeps 30s');
    s.inbox.push('Use the Task tool with run_in_background: true and subagent_type "general-purpose" to run this exactly: "Run the shell command `sleep 30 && echo SPIKE-TASK-DONE-7731` with Bash and report its output verbatim." Do not wait for it. After launching it, reply with just the word LAUNCHED.');
    await s.nextResult();
    const started = s.events.find(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'task_started');
    log('q1', 'task_started seen:', Boolean(started));

    log('q1', 'turn 2: unrelated turn while the task runs');
    const before2 = s.events.length;
    s.inbox.push('Reply with just the word PONG.');
    await s.nextResult();
    log('q1', 'turn 2 reply:', lastAssistantText(s.events, before2));

    log('q1', 'waiting for task_notification (up to 90s) with NO host input');
    const mark = s.events.length;
    const notif = await s.waitFor(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'task_notification', 90_000);
    const autoTurn = notif ? await s.waitFor(m => m.type === 'result', 60_000) : undefined;
    const autoText = autoTurn ? lastAssistantText(s.events, mark) : '';
    log('q1', 'notification:', Boolean(notif), 'auto turn result:', Boolean(autoTurn), 'auto text:', autoText.slice(0, 200));

    const before3 = s.events.length;
    s.inbox.push('What did the background task report? Quote the marker string exactly.');
    await s.nextResult();
    const t3 = lastAssistantText(s.events, before3);
    verdict('q1a (task survives turns)', Boolean(notif) && t3.includes('SPIKE-TASK-DONE-7731'), `notification=${String(Boolean(notif))}; turn 3 reply: ${t3.slice(0, 200)}`);
    verdict('q1b (notification starts a turn by itself)', autoTurnVerdict(autoTurn, notif), `auto-turn text: ${autoText.slice(0, 200) || '(none)'}`);

    // q2: launch a 40s background task, then a long foreground Bash, interrupt it, see whether the task still notifies.
    log('q2', 'turn 4: launch a second 40s background task');
    s.inbox.push('Use the Task tool with run_in_background: true and subagent_type "general-purpose" to run this exactly: "Run `sleep 40 && echo SPIKE-TASK-DONE-9902` with Bash and report its output verbatim." Reply with just LAUNCHED.');
    await s.nextResult();
    log('q2', 'turn 5: foreground sleep 90, interrupting after 5s');
    s.inbox.push('Run `sleep 90` with the Bash tool, then reply DONE.');
    await s.waitFor(m => m.type === 'assistant', 60_000);
    await sleep(5000);
    const receipt = await s.q.interrupt();
    s.armInterruptedResultCapture();
    log('q2', 'interrupt receipt:', JSON.stringify(receipt));
    await s.nextResult(30_000);
    const notif2 = await s.waitFor((m) => {
        const forSecondTask = isTaskNotification(m) && JSON.stringify(m).includes('9902');
        const forAnyOtherTask = isTaskNotification(m) && !JSON.stringify(m).includes('7731');
        return forSecondTask || forAnyOtherTask;
    }, 90_000);
    const status = notif2 ? (notif2 as { status?: string }).status : undefined;
    verdict('q2 (interrupt spares background task)', notif2 ? status === 'completed' : false, `second task notification status=${String(status)}`);
    s.stop();
}

// ---------------------------------------------------------------- q3 compaction re-injection
async function q3(): Promise<void> {
    // Eight files of ~180KB each (under the Read tool's 256KB cap); each read adds ~25k tokens against the 200k window.
    // NOTE: settings.autoCompactWindow passed via Options.settings was NOT honoured in the spike run; the model window applied.
    const files = [0, 1, 2, 3, 4, 5].map((n) => {
        const f = path.join(WORKDIR, `big-${n}.txt`);
        // eslint-disable-next-line n/no-sync -- startup-only fixture creation
        writeFileSync(f, Array.from({ length: 1100 }, (_, i) => `file ${n} line ${i}: ${'lorem ipsum dolor sit amet consectetur '.repeat(4)}`).join('\n'));
        return f;
    });
    const state = { compactHookFired: false };
    const hooks: Partial<Record<'SessionStart' | 'PreCompact' | 'PostCompact', HookCallbackMatcher[]>> = {
        SessionStart: [{ hooks: [async (input) => {
            const src = (input as { source?: string }).source;
            log('q3', 'SessionStart hook source=', src);
            recordHookInput(src === 'compact' ? 'hook_session_start_compact' : 'hook_session_start_startup', input);
            if(src === 'compact') {
                state.compactHookFired = true;
                return { 'continue': true, hookSpecificOutput: { hookEventName: 'SessionStart' as const, additionalContext: 'BOOT BUNDLE: the codeword for this session is TANGERINE-4410. Remember it.' } };
            }
            return { 'continue': true, hookSpecificOutput: undefined };
        }] }],
        PreCompact: [{ hooks: [async (input) => {
            log('q3', 'PreCompact fired');
            recordHookInput('pre_compact', input);
            return { 'continue': true };
        }] }],
        PostCompact: [{ hooks: [async (input) => {
            log('q3', 'PostCompact fired, summary len', String((input as { compact_summary?: string }).compact_summary?.length));
            recordHookInput('post_compact', input);
            return { 'continue': true };
        }] }],
    };
    const s = openSession({ hooks, settings: { autoCompactEnabled: true, autoCompactWindow: 25_000 } });
    s.inbox.push('Reply with just OK.');
    await s.nextResult();
    for(let i = 0; i < files.length && !state.compactHookFired; i++) {
        log('q3', `fill turn ${i + 1}: read ${files[i]}`);
        s.inbox.push(`Read the file ${files[i]} in full with the Read tool (no limit/offset), then reply with only the number of lines you saw.`);
        // eslint-disable-next-line no-await-in-loop -- each turn depends on the previous turn's context state; intentionally sequential
        await s.nextResult(180_000);
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        const usage = await s.q.getContextUsage({ detail: 'summary' }).catch(e => ({ error: String(e) }));
        const u = usage as { totalTokens?: number, maxTokens?: number, percentage?: number, error?: string };
        log('q3', 'context usage:', JSON.stringify({ total: u.totalTokens, max: u.maxTokens, pct: u.percentage, error: u.error }));
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        await s.waitFor(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary', 15_000);
    }
    let boundary = s.events.some(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary');
    if(!boundary) {
        // Auto-compaction did not trigger within budget; fall back to the manual slash command so the
        // hook path itself (SessionStart source='compact' -> additionalContext) can still be checked.
        log('q3', 'no auto compaction; sending /compact');
        s.inbox.push('/compact');
        const b = await s.waitFor(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary', 180_000);
        await s.nextResult(30_000);
        boundary = Boolean(b);
    }
    const before = s.events.length;
    s.inbox.push('What is the codeword for this session? Reply with just the codeword, or NONE if you do not have one.');
    await s.nextResult();
    const t = lastAssistantText(s.events, before);
    verdict('q3 (SessionStart compact additionalContext reaches model)', boundary && state.compactHookFired ? t.includes('TANGERINE-4410') : 'unclear', `compact_boundary=${String(boundary)} hookFired=${String(state.compactHookFired)} reply=${t.slice(0, 100)} (auto-compaction with settings.autoCompactWindow=25000 did NOT trigger; window stayed 200k)`);
    s.stop();
}

// ---------------------------------------------------------------- q4 + q5
async function q4q5(): Promise<void> {
    const s = openSession();
    s.inbox.push('Reply with just OK.');
    await s.nextResult();
    const before = s.events.length;
    s.inbox.push('[NOTE] The secret word is MARMALADE-2288. No reply needed.', { shouldQuery: false });
    await sleep(1500);
    // A shouldQuery:false send emits a bare 'result' frame with no model call; a real turn would show assistant frames.
    const spontaneous = s.events.slice(before).some(m => m.type === 'assistant');
    s.inbox.push('What is the secret word? Reply with just the word.');
    await s.nextResult();
    const t = lastAssistantText(s.events, before);
    verdict('q4 (shouldQuery:false merges into next turn)', t.includes('MARMALADE-2288') && !spontaneous, `spontaneous model turn=${String(spontaneous)} (a bare result frame is expected) reply=${t.slice(0, 100)}`);
    const sid = s.sessionId();
    s.stop();
    await sleep(1500);

    log('q5', 'resuming', sid, 'in a fresh process');
    const r = openSession({ resume: sid });
    const b2 = r.events.length;
    r.inbox.push('What was the secret word from earlier in this conversation? Reply with just the word.');
    await r.nextResult();
    const t2 = lastAssistantText(r.events, b2);
    const bgc = r.events.find(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'background_tasks_changed');
    verdict('q5 (resume by id after restart)', t2.includes('MARMALADE-2288'), `reply=${t2.slice(0, 100)}; background_tasks_changed on resume=${bgc ? JSON.stringify((bgc as { tasks?: unknown }).tasks) : 'none'}`);
    r.stop();
}

// ---------------------------------------------------------------- q6 shared vs separate MCP instances
function makeServer(name: string): ReturnType<typeof createSdkMcpServer> {
    return createSdkMcpServer({
        name,
        version: '0.0.1',
        tools:   [tool('echo_spike', 'Echoes the input back with a marker', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `SPIKE-ECHO:${text}` }] }))],
    });
}
async function q6(): Promise<void> {
    const shared = makeServer('spike');
    const a = openSession({ mcpServers: { spike: shared }, allowedTools: ['mcp__spike__echo_spike'] });
    const b = openSession({ mcpServers: { spike: shared }, allowedTools: ['mcp__spike__echo_spike'] });
    const ask = 'Call the mcp__spike__echo_spike tool with text "hello" and reply with the tool output verbatim.';
    const [ba, bb] = [a.events.length, b.events.length];
    a.inbox.push(ask);
    b.inbox.push(ask);
    await Promise.all([a.nextResult(90_000), b.nextResult(90_000)]);
    const ta = lastAssistantText(a.events, ba);
    const tb = lastAssistantText(b.events, bb);
    const sharedOk = ta.includes('SPIKE-ECHO:hello') && tb.includes('SPIKE-ECHO:hello');
    log('q6', 'shared instance replies:', ta.slice(0, 80), '|', tb.slice(0, 80));
    a.stop();
    b.stop();

    const c = openSession({ mcpServers: { spike: makeServer('spike') }, allowedTools: ['mcp__spike__echo_spike'] });
    const d = openSession({ mcpServers: { spike: makeServer('spike') }, allowedTools: ['mcp__spike__echo_spike'] });
    const [bc, bd] = [c.events.length, d.events.length];
    c.inbox.push(ask);
    d.inbox.push(ask);
    await Promise.all([c.nextResult(90_000), d.nextResult(90_000)]);
    const tc = lastAssistantText(c.events, bc);
    const td = lastAssistantText(d.events, bd);
    const separateOk = tc.includes('SPIKE-ECHO:hello') && td.includes('SPIKE-ECHO:hello');
    log('q6', 'separate instance replies:', tc.slice(0, 80), '|', td.slice(0, 80));
    c.stop();
    d.stop();
    verdict('q6 (one in-process MCP instance can serve two sessions)', sharedOk, `shared=${String(sharedOk)} separate=${String(separateOk)}`);
}

// ---------------------------------------------------------------- main
log('spike', 'workdir', WORKDIR, 'model', MODEL, 'questions', [...wanted].join(','), 'record', recording ? RECORD_DIR : 'off');
try {
    if(wanted.has('q1') || wanted.has('q2')) {
        await q1q2();
    }
    if(wanted.has('q3')) {
        await q3();
    }
    if(wanted.has('q4') || wanted.has('q5')) {
        await q4q5();
    }
    if(wanted.has('q6')) {
        await q6();
    }
} catch (e) {
    log('spike', 'FAILED', e instanceof Error ? e.stack : String(e));
}
writeFixtures();
log('spike', 'done');
// eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- the SDK's child processes keep the event loop alive; exit is deliberate
process.exit(0);
