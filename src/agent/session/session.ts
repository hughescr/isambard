/**
 * The long-lived session handle: calls a {@link SessionQueryFn} exactly once for its whole
 * lifetime (the reopen policy — deciding whether/when to open a fresh query — lives in the
 * conductor, P7+, never here) and runs a reader loop over the resulting frame stream for as
 * long as the session lives. Every log line this module emits, and every log line its
 * per-session {@link createStreamEventLogger} instance emits, carries the session's `role` so
 * the two concurrent sessions (`conversation`/`perch`) are distinguishable in logs.
 *
 * No file under src/agent imports from src/app.
 *
 * @module agent/session/session
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import { extractSessionId } from '../session-cleanup';
import { createRoleLogger, createStreamEventLogger, type FieldLogger } from '../stream-event-logger';
import type { AgentStreamEvent, AssistantEvent } from '../types';
import type { InputQueue } from './input-queue';
import type { InterruptFlag } from './interrupt-flag';
import type { ContextUsageSummary, SessionQueryFn, SessionRole } from './types';

/** Lifecycle state of a {@link SessionHandle}. */
export type SessionState = 'opening' | 'open' | 'closed' | 'failed';

/**
 * Adapts a raw SDK frame to the narrower observability event consumed by legacy observers.
 * Assistant content remains the SDK union so thinking blocks retain their `thinking` payload.
 */
export function sdkFrameToAgentStreamEvent(frame: SDKMessage): AgentStreamEvent {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- observability intentionally ignores non-observability SDK frames.
    switch(frame.type) {
        case 'assistant': {
            const content: NonNullable<NonNullable<AssistantEvent['message']>['content']> = [];
            for(const block of frame.message.content) {
                // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- adapter intentionally ignores SDK blocks outside the observability view.
                switch(block.type) {
                    case 'text': {
                        content.push({ type: block.type, text: block.text });
                        break;
                    }
                    case 'thinking': {
                        content.push({ type: block.type, thinking: block.thinking });
                        break;
                    }
                    case 'tool_use': {
                        content.push({ type: block.type, id: block.id, name: block.name, input: block.input });
                        break;
                    }
                }
            }
            return { type: 'assistant', message: { content } };
        }
        case 'user': {
            return { type: 'user', message: { content: frame.message.content } };
        }
        case 'tool_progress': {
            return {
                type:                 'tool_progress',
                tool_use_id:          frame.tool_use_id,
                tool_name:            frame.tool_name,
                elapsed_time_seconds: frame.elapsed_time_seconds,
            };
        }
        case 'result': {
            return {
                type:              'result',
                subtype:           frame.subtype,
                duration_ms:       frame.duration_ms,
                total_cost_usd:    frame.total_cost_usd,
                is_error:          frame.is_error,
                usage:             frame.usage,
                queued_turn_count: frame.queued_turn_count,
            };
        }
        case 'system': {
            return frame;
        }
        default: {
            return { type: 'system' };
        }
    }
}
/** Parameters for {@link openSession}. */
export interface OpenSessionParams {
    /** Which of the two concurrent sessions this is. */
    role:         SessionRole
    /** Factory matching the real Agent SDK `query()` function; {@link openSession} calls it exactly once. */
    queryFn:      SessionQueryFn
    /** Full Agent SDK options for this query (typically built by ./query-options.ts). */
    options:      Options
    /** Host-owned input queue, passed to `queryFn` as the prompt iterable. */
    queue:        InputQueue
    /**
     * Interrupt-in-flight flag, owned by this session for its whole lifetime: {@link interrupt}
     * sets it, the reader loop clears it. The same flag object is read by the query options'
     * stderr classifier (built before this session exists), which is how a flag owned by the
     * session reaches options built ahead of it.
     */
    interrupting: InterruptFlag
    /** Base logger every line this session emits is stamped with `role` and written through; defaults to the shared `@hughescr/logger` logger. */
    logger?:      FieldLogger
    /** Called with every frame the query yields, in order, after this session's own bookkeeping. */
    onFrame:      (frame: SDKMessage) => void
    /** Called once, when the query ends cleanly (no argument) or throws (the thrown value). */
    onClosed:     (error?: unknown) => void
}

/** Handle returned by {@link openSession}. */
export interface SessionHandle {
    /** Which of the two concurrent sessions this handle is for. */
    role:            SessionRole
    /** The session id captured from the query's system/init frame, once seen. */
    sessionId:       () => string | undefined
    /** Current lifecycle state. */
    state:           () => SessionState
    /** Sets the interrupt flag and asks the underlying query to interrupt; resolves once the SDK acknowledges. */
    interrupt:       () => Promise<void>
    /** Proxies the underlying query's context-usage query. */
    getContextUsage: (opts?: { detail?: 'summary' | 'full' }) => Promise<ContextUsageSummary>
    /** Closes the input queue, then the underlying query. */
    close:           () => void
    /** True while an {@link interrupt} is in flight (set immediately, cleared on the next result frame observed after it resolves, or on session end/failure). */
    isInterrupting:  () => boolean
}

/**
 * Opens a long-lived session.
 * @param params See {@link OpenSessionParams}
 * @returns A {@link SessionHandle}
 */
export function openSession(params: OpenSessionParams): SessionHandle {
    const { role, queryFn, options, queue, interrupting, onFrame, onClosed } = params;
    const log = createRoleLogger(role, params.logger ?? logger);
    const streamEventLogger = createStreamEventLogger(log);

    const query = queryFn({ prompt: queue, options });

    let state: SessionState = 'opening';
    let sessionId: string | undefined;
    // True once interrupt()'s await on query.interrupt() has resolved, until the next result
    // frame clears both it and the interrupt flag. SDK result frames carry no interrupt marker,
    // so "the first result frame observed after interrupt() resolved" is the clearing signal.
    let awaitingResultToClearInterrupt = false;

    function handleFrame(frame: SDKMessage): void {
        const capturedId = extractSessionId(frame);
        if(capturedId !== undefined) {
            sessionId = capturedId;
            if(state === 'opening') {
                state = 'open';
                log.info({ sessionId: capturedId, msg: 'Session opened' });
            }
        }

        // A throw from either the stream-event logger or the caller's onFrame observer is a bug
        // in that observer, not a transport failure: catching it here keeps a healthy query from
        // being torn down (state 'failed', onClosed(error)) by someone else's mistake.
        try {
            streamEventLogger.logStreamEvent(sdkFrameToAgentStreamEvent(frame));
            onFrame(frame);
        } catch (error) {
            log.error({ error, msg: 'Frame observer threw' });
        }

        if(awaitingResultToClearInterrupt && frame.type === 'result') {
            interrupting.value = false;
            awaitingResultToClearInterrupt = false;
        }
    }

    async function runReaderLoop(): Promise<void> {
        try {
            for await (const frame of query) {
                handleFrame(frame);
            }
            state = 'closed';
            interrupting.value = false;
            // Stryker disable next-line BooleanLiteral: the reader has ended normally, so this private frame-clearing latch is never read again
            awaitingResultToClearInterrupt = false;
            log.info({ msg: 'Session closed' });
            onClosed();
        } catch (error) {
            state = 'failed';
            interrupting.value = false;
            // Stryker disable next-line BooleanLiteral: the reader has terminated on this throw, so this private frame-clearing latch is never read again
            awaitingResultToClearInterrupt = false;
            log.error({ error, msg: 'Session failed' });
            onClosed(error);
        }
    }

    // Fire-and-forget: this loop runs for the session's whole lifetime, driven entirely by the
    // query's frame stream, not by anything openSession's caller awaits.
    void runReaderLoop();

    return {
        role,
        sessionId: () => sessionId,
        state:     () => state,
        interrupt: async () => {
            interrupting.value = true;
            log.debug({ msg: 'Session interrupt requested' });
            try {
                await query.interrupt();
                awaitingResultToClearInterrupt = true;
            } catch (error) {
                // The SDK never acknowledged the interrupt, so nothing will ever clear the flag
                // via a result frame: clear it here instead of leaving isInterrupting() stuck
                // true (and the stderr classifier demoting real errors) for the rest of the
                // session's life.
                interrupting.value = false;
                log.error({ error, msg: 'Session interrupt failed' });
                throw error;
            }
        },
        getContextUsage: opts => query.getContextUsage(opts),
        close:           () => {
            queue.close();
            query.close();
        },
        isInterrupting: () => interrupting.value,
    };
}
