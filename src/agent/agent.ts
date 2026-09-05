import { query, type McpServerConfig, type Options, type SDKUserMessage, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import { createRetryableQuery } from './claude-retry';
import type { ContextBuilder } from './context-builder';
import { createCompactionHooks, type CompactionSink } from './hooks/compaction';
import { mergeHookMaps } from './hooks/index';
import { createLifecycleHooks, type StopCallback, type StopFailureCallback } from './hooks/lifecycle';
import { createTaskTrackingHooks } from './hooks/task-tracking';
import { buildMultimodalContent, hasImages } from './multimodal-message-builder';
import { buildSystemPrompt } from './prompts/index.js';
import { type ResumeContext, buildResumePrompt  } from './resume-prompt-builder';
import { buildSessionQueryOptions, type SessionMcpServers } from './session/query-options';
import { cleanupSession, extractSessionId } from './session-cleanup';
import { createStreamEventLogger, logResultErrors, logAssistantErrors, logToolUsage } from './stream-event-logger';
import { extractAssistantText } from './stream-extractors';
import { StreamTracker } from './stream-tracker';
import type { TaskPersistenceCoordinator } from './task-persistence-coordinator';
import { type AgentStreamEvent, type MessageContext, type PlatformImage  } from './types';
import { loadRetryConfig } from '@/config';
import { InvariantViolationError } from '@/errors';
import { formatLocalDateTime, resolveTimezone, type RetryDeps } from '@/utils';

const MAX_AUTO_RESUME_ATTEMPTS = 3;

export interface ClaudeAgentOptions {
    /** Context builder for loading memory (core identity + recent context) */
    contextBuilder?:             ContextBuilder
    /** Memory MCP server instance for deep memory access */
    memoryMcpServer?:            McpServerConfig
    /** Discord MCP server instance for message history access */
    discordMcpServer?:           McpServerConfig
    /** Inbox MCP server instance for inbox management */
    inboxMcpServer?:             McpServerConfig
    /** Email MCP server instance for email inbox access */
    emailMcpServer?:             McpServerConfig
    /** Bluesky MCP server instance for AT Protocol feed reading and interaction */
    bskyMcpServer?:              McpServerConfig
    /** CalDAV MCP server instance for calendar queries */
    caldavMcpServer?:            McpServerConfig
    /** Wikipedia MCP server instance for random article discovery */
    wikipediaMcpServer?:         McpServerConfig
    /** Media MCP server instance for video and audio processing */
    mediaMcpServer?:             McpServerConfig
    /** Contacts MCP server instance for address book access */
    contactsMcpServer?:          McpServerConfig
    /** User context MCP server instance for cross-platform person history */
    userContextMcpServer?:       McpServerConfig
    /** Browser MCP server instance for web browser automation */
    browserMcpServer?:           McpServerConfig
    /** Plugins to load (from plugin-loader.ts) */
    plugins?:                    SdkPluginConfig[]
    /** Task persistence coordinator for maintaining tasks across sessions */
    taskPersistenceCoordinator?: TaskPersistenceCoordinator
    /** Claude model to use (defaults to 'sonnet' if not provided; normally set from IsambardMainModel SST secret via config) */
    mainModel?:                  string
    /** Fallback model to use when primary model is unavailable (rate limit, overload, 5xx) */
    fallbackModel?:              string
    /** Optional compaction lifecycle sink (PreCompact/PostCompact hooks report here) */
    compactionSink?:             CompactionSink
    /** Retry dependency overrides (sleep/now/logger) for the Claude query retry wrapper — test injection point, defaults to real timers in production */
    retryDeps?:                  Partial<RetryDeps>
}

/** Options for handleInput processing */
export interface HandleInputOptions {
    /** Session ID to resume (for SDK session continuity) */
    sessionId?:       string
    /** Resume context from interrupted processing */
    resumeContext?:   ResumeContext
    /** AbortController for cancellation */
    abortController?: AbortController
    /** Callback for stream events */
    onStreamEvent?:   (event: AgentStreamEvent) => void
    /** Optional images to include in the first message */
    images?:          PlatformImage[]
    /** Special mode for selecting the session prompt */
    specialMode?:     'catchup' | 'perching'
    /** Optional catch-up prompt to use instead of building from contexts */
    catchUpPrompt?:   string
    /** Optional perch prompt for autonomous perch time */
    perchPrompt?:     string
    /** Optional list of available channels for system prompt context */
    channelList?:     string[]
    /** Optional context note prepended to the user message (e.g., perch-time interruption notice) */
    contextNote?:     string
    /** Optional cross-platform history for the person in the conversation, prepended before contextNote */
    personHistory?:   string
    /**
     * Optional callback invoked when the agent session stops normally (Stop hook fires).
     * Callers can use this as the primary signal that the session completed cleanly,
     * instead of relying on the return-value `wasInterrupted` flag.
     */
    onStop?:          StopCallback
    /**
     * Optional callback invoked when the agent session stops with a failure (StopFailure hook fires).
     */
    onStopFailure?:   StopFailureCallback
}

/** Result from handleInput processing */
export interface HandleInputResult {
    /** Final response text (null if interrupted or error) */
    response:       string | null
    /** Session ID for resuming */
    sessionId?:     string
    /** Whether processing was interrupted */
    wasInterrupted: boolean
    /** Stream tracker with captured progress and background task collection state */
    streamTracker:  StreamTracker
}

export interface ClaudeAgent {
    /**
     * Process multiple messages in batch with interruption support.
     *
     * @param contexts Array of Discord message contexts to process
     * @param options Optional configuration for batch processing
     * @returns Result with final response, interruption status, and stream tracker
     */
    handleInput: (
        contexts: MessageContext[],
        options?: HandleInputOptions
    ) => Promise<HandleInputResult>
}

/**
 * Creates a Claude agent for processing Discord messages using the Agent SDK.
 *
 * The agent uses a hybrid memory approach:
 * - Core identity loaded into system prompt (always present)
 * - Recent context injected into user message (user-specific)
 * - Deep memory archive available via MCP tools (on-demand)
 *
 * @param options Agent configuration
 * @returns Claude agent instance
 */
/**
 * Maps the eleven per-server ClaudeAgentOptions fields onto the session core's
 * `SessionMcpServers` shape (src/agent/session/query-options.ts), keyed by server name.
 * @param options Claude agent options carrying the per-server MCP configs
 * @returns MCP servers keyed by session server name
 */
function toSessionMcpServers(options: ClaudeAgentOptions): SessionMcpServers {
    return {
        memory:         options.memoryMcpServer,
        discord:        options.discordMcpServer,
        inbox:          options.inboxMcpServer,
        email:          options.emailMcpServer,
        bsky:           options.bskyMcpServer,
        caldav:         options.caldavMcpServer,
        wikipedia:      options.wikipediaMcpServer,
        media:          options.mediaMcpServer,
        contacts:       options.contactsMcpServer,
        'user-context': options.userContextMcpServer,
        browser:        options.browserMcpServer,
    };
}

/**
 * Module-level stream-event logger instance for the one-shot path. Owns its own
 * `pendingToolRequests` correlation state (see ./stream-event-logger.ts); `logStreamEvent` and
 * `resetLogStreamState` below are thin delegates to it so this file's public surface — and the
 * existing tests that exercise it via `createClaudeAgent` — are unchanged. `openSession`
 * (./session/session.ts) creates its own instance per long-lived session instead of using this
 * one, so the two never share tool-correlation state.
 */
const streamEventLoggerInstance = createStreamEventLogger();

/**
 * Logs stream events with descriptive messages based on event type. Delegates to the
 * module-level {@link streamEventLoggerInstance}; see ./stream-event-logger.ts for behaviour.
 * @param message Stream event to log
 */
export function logStreamEvent(message: AgentStreamEvent): void {
    streamEventLoggerInstance.logStreamEvent(message);
}

/**
 * Resets the log stream event state for testing purposes.
 */
export function resetLogStreamState(): void {
    streamEventLoggerInstance.reset();
}

/**
 * Build user message content for batch processing.
 * Handles resume context, catch-up prompts, perch prompts, and normal message formatting.
 * @param contexts Array of Discord message contexts
 * @param contextBuilder Context builder for loading memories
 * @param timezone Optional user timezone (already loaded)
 * @param resumeContext Optional resume context from interruption
 * @param catchUpPrompt Optional catch-up prompt (used in catch-up mode)
 * @param perchPrompt Optional perch prompt (used in perching mode)
 * @returns Formatted user message text
 */
async function buildUserMessageTextForBatch(
    contexts: MessageContext[],
    contextBuilder: ContextBuilder | undefined,
    timezone?: string,
    resumeContext?: ResumeContext,
    catchUpPrompt?: string,
    perchPrompt?: string
): Promise<string> {
    if(resumeContext) {
        // Use resume prompt when resuming after interruption
        return buildResumePrompt(resumeContext);
    }

    if(catchUpPrompt) {
        // Use catch-up prompt when in catch-up mode
        return catchUpPrompt;
    }

    if(perchPrompt) {
        // Use perch prompt when in perching mode
        return perchPrompt;
    }

    // Build context prefix from memories and events
    const firstContext = contexts[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — caller guarantees non-empty contexts array; unreachable in practice
    if(firstContext === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('buildAgentQuery', 'contexts is empty in normal message flow');
    }
    const contextPrefix = contextBuilder
        ? await contextBuilder.buildUserMessagePrefix(firstContext.userId, timezone)
        : '';

    // Format multiple messages with timezone fallback
    const resolvedTz = resolveTimezone(timezone);
    const messageBlocks = contexts.map((ctx) => {
        const timeStr = `${formatLocalDateTime(ctx.timestamp, resolvedTz)} ${resolvedTz} (UTC: ${ctx.timestamp})`;
        return `User @${ctx.userId} in #${ctx.channelId} at ${timeStr}: ${ctx.content}`;
    });

    return contextPrefix + messageBlocks.join('\n\n');
}

/**
 * Build prompt for SDK query as async generator for multimodal support.
 * Creates an async generator yielding a single SDKUserMessage with content blocks (images + text).
 * @param textContent The text content of the message
 * @param images Optional images to include
 * @returns Async generator yielding SDKUserMessage
 */
async function* buildPromptForSdk(
    textContent: string,
    images?: PlatformImage[]
): AsyncGenerator<SDKUserMessage> {
    const sessionId = crypto.randomUUID();

    const content = hasImages(images)
        ? buildMultimodalContent(textContent, images)
        : textContent;

    // Stryker disable ObjectLiteral,StringLiteral: Protocol constants for Claude SDK
    yield {
        type:    'user',
        message: {
            role: 'user',
            content,
        },
        parent_tool_use_id: null,
        session_id:         sessionId,
    };
    // Stryker restore ObjectLiteral,StringLiteral
}

/**
 * Handles session ID extraction and task persistence setup.
 * @param message Stream message to check for session ID
 * @param taskPersistenceCoordinator Optional coordinator for task copying
 * @param taskPersistenceCompleted Whether persistence has already been performed
 * @returns Object with extracted session ID and whether persistence was completed
 */
async function handleSessionIdExtraction(
    message: unknown,
    taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined,
    taskPersistenceCompleted: boolean
): Promise<{ sessionId?: string, persistenceCompleted: boolean }> {
    const extractedSessionId = extractSessionId(message);
    if(!extractedSessionId) {
        return { sessionId: undefined, persistenceCompleted: taskPersistenceCompleted };
    }

    // IMMEDIATELY copy tasks from previous session when we get the session ID
    // This ensures TaskList calls during the stream see the copied tasks
    if(taskPersistenceCoordinator && !taskPersistenceCompleted) {
        try {
            await taskPersistenceCoordinator.prepareNewSession(extractedSessionId);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn({ error, sessionId: extractedSessionId }, `Task persistence failed: ${errorMessage}`);
        }
        return { sessionId: extractedSessionId, persistenceCompleted: true };
    }

    return { sessionId: extractedSessionId, persistenceCompleted: taskPersistenceCompleted };
}

/**
 * Processes a single stream message.
 * @param message Stream message to process
 * @param tracker Stream tracker to update
 * @param options Optional batch processing options
 */
function processSingleStreamMessage(
    message: unknown,
    tracker: StreamTracker,
    options?: HandleInputOptions
): void {
    // Update tracker with stream progress
    tracker.update(message as AgentStreamEvent);

    // Log descriptive stream events
    logStreamEvent(message as AgentStreamEvent);

    // Log errors from stream events
    logResultErrors(message as { type: string, is_error?: boolean, subtype?: string, errors?: unknown[] });
    logAssistantErrors(message as { type: string, error?: unknown });
    logToolUsage(message as { type: string, message?: { content?: unknown } });

    // Invoke stream event callback if provided
    if(options?.onStreamEvent) {
        options.onStreamEvent(message as AgentStreamEvent);
    }
}

/**
 * Checks if processing should be aborted.
 * @param options Optional batch processing options
 * @param capturedSessionId Current session ID
 * @returns true if processing should abort, false otherwise
 */
function shouldAbortProcessing(
    options: HandleInputOptions | undefined,
    capturedSessionId: string | undefined
): boolean {
    if(options?.abortController?.signal.aborted) {
        logger.info({
            sessionId: capturedSessionId,
            msg:       'Batch processing interrupted by abort signal',
        });
        return true;
    }
    return false;
}

/**
 * Process stream events from Agent SDK response.
 * Handles session ID extraction, tracker updates, logging, callbacks, and abort checking.
 * @param response Async iterable stream from Agent SDK
 * @param tracker Stream tracker to update with progress
 * @param options Optional batch processing options
 * @param taskPersistenceCoordinator Optional task persistence coordinator for immediate task copying
 * @returns Object with last assistant text and whether processing was interrupted
 */
async function processStreamEvents(
    response: AsyncIterable<unknown>,
    tracker: StreamTracker,
    options?: HandleInputOptions,
    taskPersistenceCoordinator?: TaskPersistenceCoordinator,
    sessionRef?: { capturedSessionId: string | undefined }
): Promise<{ lastAssistantText: string, wasInterrupted: boolean, capturedSessionId?: string }> {
    let lastAssistantText = '';
    let wasInterrupted = false;
    let capturedSessionId: string | undefined;
    let taskPersistenceCompleted = false;

    try {
        // Session ID extraction race condition prevention:
        // The session ID is extracted from the first stream event (system init message),
        // which always arrives before any tool_use events. The sequential for-await loop
        // combined with the await on handleSessionIdExtraction() ensures the session ID
        // is always captured and persisted before any tool calls execute. This prevents
        // tool calls from running with an undefined session ID.
        for await (const message of response) {
            // Handle session ID extraction and task persistence
            const { sessionId, persistenceCompleted } = await handleSessionIdExtraction(
                message,
                taskPersistenceCoordinator,
                taskPersistenceCompleted
            );
            if(sessionId) {
                capturedSessionId = sessionId;
                // Propagate session ID to caller ref immediately so it is visible even if we throw
                if(sessionRef) {
                    sessionRef.capturedSessionId = sessionId;
                }
                taskPersistenceCompleted = persistenceCompleted;
            }

            // Process the stream message
            processSingleStreamMessage(message, tracker, options);

            // Check for abort signal
            if(shouldAbortProcessing(options, capturedSessionId)) {
                wasInterrupted = true;
                break;
            }

            // Extract assistant text
            const text = extractAssistantText(message as { type: string, message?: { content?: unknown } });
            if(text) {
                lastAssistantText = text;
            }
        }
    } catch (error) {
        // Check for AbortError OR any error when abort signal was triggered
        // The Claude Agent SDK may throw non-standard errors on abort
        if((error instanceof Error && error.name === 'AbortError') || options?.abortController?.signal.aborted) {
            wasInterrupted = true;
            // All abort-signal errors are expected — SDK throws "Operation aborted" (not standard AbortError)
            logger.info({
                sessionId: capturedSessionId,
                msg:       'Batch processing interrupted by abort',
            });
        } else {
            // Re-throw other errors
            throw error;
        }
    }

    return { lastAssistantText, wasInterrupted, capturedSessionId };
}

/**
 * Build query options for Agent SDK. Delegates the full options shape to
 * `buildSessionQueryOptions` (src/agent/session/query-options.ts) — the same builder the
 * long-lived session core uses — and spreads in `abortController`, which has no place in the
 * session core (sessions interrupt via `SessionQuery.interrupt()`, not an AbortController; this
 * one-shot path still cancels via AbortController until P13b).
 * @param mainModel Model name to use for this query
 * @param systemPrompt System prompt with core identity
 * @param mcpServers MCP servers configured for this session, by name
 * @param plugins Plugin configurations
 * @param tracker Stream tracker used to gate the per-task stop affordance
 * @param options Optional batch processing options
 * @param compactionSink Optional compaction lifecycle sink (PreCompact/PostCompact report here)
 * @param fallbackModel Fallback model to use when the primary model is unavailable
 * @returns Query options object for Agent SDK
 */
function buildQueryOptions(
    mainModel: string,
    systemPrompt: string,
    mcpServers: SessionMcpServers,
    plugins: SdkPluginConfig[] | undefined,
    tracker: StreamTracker,
    options?: HandleInputOptions,
    compactionSink?: CompactionSink,
    fallbackModel?: string
) {
    return {
        ...buildSessionQueryOptions({
            role:  'conversation',
            systemPrompt,
            mcpServers,
            plugins,
            // Stryker disable ObjectLiteral,ArrayDeclaration: Hook map structure — merging factories, mutations don't change behavior
            hooks: mergeHookMaps(
                createTaskTrackingHooks(),
                createLifecycleHooks(() => tracker.hasUncollectedBackgroundTasks(), options?.onStop, options?.onStopFailure),
                ...(compactionSink ? [createCompactionHooks(compactionSink)] : [])
            ),
            // Stryker restore ObjectLiteral,ArrayDeclaration
            resume:         options?.sessionId,
            mainModel,
            fallbackModel,
            isInterrupting: () => options?.abortController?.signal.aborted ?? false,
        }),
        abortController: options?.abortController,
    } satisfies Options;
}

/**
 * Build result object for handleInput.
 * @param lastAssistantText Final response text from assistant
 * @param wasInterrupted Whether processing was interrupted
 * @param capturedSessionId Session ID for resuming
 * @param tracker Stream tracker with captured progress
 * @returns HandleInputResult object
 */
function buildHandleInputResult(
    lastAssistantText: string,
    wasInterrupted: boolean,
    capturedSessionId: string | undefined,
    tracker: StreamTracker
): HandleInputResult {
    return {
        response:      wasInterrupted ? null : (lastAssistantText || null),
        sessionId:     capturedSessionId,
        wasInterrupted,
        streamTracker: tracker,
    };
}

/**
 * Load user timezone for normal message flows.
 * Returns undefined for catch-up/perch/resume flows which use server timezone.
 * @param contextBuilder Context builder with timezone loading capability
 * @param options Handle input options
 * @param contexts Message contexts (may be empty for catch-up/perch)
 * @returns User timezone or undefined
 */
async function loadUserTimezoneForFlow(
    contextBuilder: ContextBuilder | undefined,
    options: HandleInputOptions | undefined,
    contexts: MessageContext[]
): Promise<string | undefined> {
    // Only load user timezone for normal message flows — catch-up/perch/resume use server TZ
    const isNormalFlow = !options?.catchUpPrompt && !options?.perchPrompt && !options?.resumeContext;
    // Stryker disable next-line ConditionalExpression: Equivalent mutant - contexts.length === 0 → false is untestable without also crashing downstream code that accesses contexts[0]
    if(!contextBuilder || !isNormalFlow || contexts.length === 0) {
        return undefined;
    }

    const firstCtx = contexts[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — contexts.length === 0 guard above makes this unreachable in practice
    if(firstCtx === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('loadUserTimezoneForFlow', 'contexts[0] undefined after contexts.length === 0 guard');
    }
    // Stryker disable BlockStatement: Equivalent mutant - catch block with empty body still returns undefined implicitly
    try {
        return await contextBuilder.loadUserTimezone(firstCtx.userId);
    } catch (error) {
        /* Stryker disable StringLiteral,ObjectLiteral: Logging for observability */
        logger.warn({ error, userId: firstCtx.userId }, 'Failed to load user timezone, falling back to server timezone');
        /* Stryker restore StringLiteral,ObjectLiteral */
        return undefined;
    }
    // Stryker restore BlockStatement
}

/**
 * Build prompt for Agent SDK (string for text-only, async generator for images).
 * @param userMessageText Text content of the message
 * @param images Optional images to include
 * @returns String or async generator of SDK messages
 */

/**
 * Prepend optional person history and context note to the user message text.
 * Person history comes first (outer context), then context note, then the message body.
 * @param userMessageText The base user message text
 * @param options HandleInputOptions containing optional personHistory and contextNote
 * @returns The annotated message text
 */
function prependMessageAnnotations(userMessageText: string, options?: HandleInputOptions): string {
    let text = userMessageText;
    if(options?.contextNote) {
        text = `[${options.contextNote}]\n\n${text}`;
    }
    if(options?.personHistory) {
        text = `${options.personHistory}\n\n${text}`;
    }
    return text;
}

function buildPromptForHandleInput(
    userMessageText: string,
    images: PlatformImage[] | undefined
): string | AsyncIterable<SDKUserMessage> {
    return hasImages(images)
        ? buildPromptForSdk(userMessageText, images)
        : userMessageText;
}

/**
 * Build error result for handleInput catch block.
 * Checks for abort signal and returns appropriate result.
 * @param error The caught error
 * @param options Handle input options
 * @param capturedSessionId Session ID if captured
 * @param tracker Stream tracker
 * @param contextCount Number of contexts being processed
 * @returns HandleInputResult for error case
 */
function buildErrorHandleInputResult(
    error: unknown,
    options: HandleInputOptions | undefined,
    capturedSessionId: string | undefined,
    tracker: StreamTracker,
    contextCount: number
): HandleInputResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error, contextCount }, `Failed to process batch: ${errorMessage}`);
    // Check abort signal — SDK may throw non-AbortError on abort
    const abortedBySignal = options?.abortController?.signal.aborted ?? false;
    return buildHandleInputResult('', abortedBySignal, capturedSessionId, tracker);
}

/**
 * Result from auto-resume attempt to collect background tasks.
 */
interface AutoResumeResult {
    /** Updated response text (original preserved if resume fails) */
    lastAssistantText: string
    /** Updated session ID (original preserved if resume fails) */
    capturedSessionId: string | undefined
}

/**
 * Attempt to auto-resume a session to collect uncollected background tasks.
 *
 * This function is called when the agent ends its turn with background tasks
 * that were launched but not collected via TaskOutput. It attempts to resume
 * the session with a prompt instructing the agent to collect the results.
 *
 * @param tracker - StreamTracker instance for monitoring the resume
 * @param lastAssistantText - Original response text to preserve on failure
 * @param capturedSessionId - Session ID to resume
 * @param retryableQuery - Retryable query function for Claude API calls
 * @param queryOptions - Query options for the agent
 * @param options - HandleInput options (including abort controller)
 * @param taskPersistenceCoordinator - Task persistence coordinator if available
 * @returns Updated text and sessionId (original values preserved on failure)
 *
 * @remarks
 * - Max 1 auto-resume attempt per handleInput call
 * - Preserves initial response text on failure (try-catch wrapper)
 * - Logs warnings for incomplete collection or errors
 */
async function attemptAutoResume(
    tracker: StreamTracker,
    lastAssistantText: string,
    capturedSessionId: string,
    retryableQuery: typeof query,
    queryOptions: ReturnType<typeof buildQueryOptions>,
    options: HandleInputOptions | undefined,
    taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined
): Promise<AutoResumeResult> {
    /* Stryker disable StringLiteral,ObjectLiteral: Observability - logging for debugging auto-resume */
    logger.warn({
        sessionId: capturedSessionId,
        msg:       'Stream ended with uncollected background tasks, resuming to collect results',
    });
    /* Stryker restore StringLiteral,ObjectLiteral */

    let updatedText = lastAssistantText;
    let updatedSessionId: string | undefined = capturedSessionId;

    // Stryker disable BlockStatement: try-catch wraps resume to preserve initial response on failure
    try {
        const resumeResponse = retryableQuery({
            prompt:  'You launched background tasks but ended your turn without collecting the results. Use the TaskOutput tool to collect the results from each background task you launched, then provide your final response incorporating those results.',
            options: {
                ...queryOptions,
                resume: capturedSessionId,
            },
        });

        const resumeResult = await processStreamEvents(resumeResponse, tracker, options, taskPersistenceCoordinator);

        // Use resumed text if available, otherwise keep original
        if(resumeResult.lastAssistantText) {
            updatedText = resumeResult.lastAssistantText;
        }
        // Stryker disable next-line ConditionalExpression: Defensive guard — resume always returns sessionId in practice
        if(resumeResult.capturedSessionId) {
            updatedSessionId = resumeResult.capturedSessionId;
        }
    } catch (resumeError) {
        /* Stryker disable StringLiteral,ObjectLiteral: Observability - error logging for debugging auto-resume failures */
        const errorMessage = resumeError instanceof Error ? resumeError.message : String(resumeError);
        logger.error({ error: resumeError, sessionId: capturedSessionId }, `Auto-resume failed: ${errorMessage}`);
        /* Stryker restore StringLiteral,ObjectLiteral */
    }
    // Stryker restore BlockStatement

    return { lastAssistantText: updatedText, capturedSessionId: updatedSessionId };
}

/**
 * Collect uncollected background tasks by auto-resuming the session.
 * Iterates up to MAX_AUTO_RESUME_ATTEMPTS times, stopping early if no progress.
 *
 * @param tracker - StreamTracker instance for monitoring background task collection
 * @param lastAssistantText - Current response text to update with resumed text
 * @param capturedSessionId - Session ID to resume (undefined if interrupted or no session)
 * @param wasInterrupted - Whether processing was interrupted
 * @param retryableQuery - Retryable query function for Claude API calls
 * @param resolvedModel - Resolved model name for queries
 * @param systemPrompt - System prompt with core identity
 * @param mcpServers - MCP servers configured for this session, by name
 * @param plugins - Plugin configurations
 * @param options - HandleInput options (including abort controller)
 * @param taskPersistenceCoordinator - Task persistence coordinator if available
 * @param compactionSink - Optional compaction lifecycle sink
 * @param fallbackModel - Fallback model to use when the primary model is unavailable
 * @returns Updated lastAssistantText and capturedSessionId
 */
async function collectBackgroundTasks(
    tracker: StreamTracker,
    lastAssistantText: string,
    capturedSessionId: string | undefined,
    wasInterrupted: boolean,
    retryableQuery: typeof query,
    resolvedModel: string,
    systemPrompt: string,
    mcpServers: SessionMcpServers,
    plugins: SdkPluginConfig[] | undefined,
    options: HandleInputOptions | undefined,
    taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined,
    compactionSink: CompactionSink | undefined,
    fallbackModel: string | undefined
): Promise<{ lastAssistantText: string, capturedSessionId: string | undefined }> {
    if(wasInterrupted || !capturedSessionId) {
        return { lastAssistantText, capturedSessionId };
    }

    let updatedText = lastAssistantText;
    let updatedSessionId: string | undefined = capturedSessionId;
    let autoResumeAttempts = 0;

    // Stryker disable BlockStatement: empty while body causes infinite loop (autoResumeAttempts never increments past cap)
    while(tracker.hasUncollectedBackgroundTasks() && autoResumeAttempts < MAX_AUTO_RESUME_ATTEMPTS) {
        autoResumeAttempts++;
        const uncollectedBefore = tracker.getProgress().uncollectedBackgroundTasks;
        const queryOptions = buildQueryOptions(resolvedModel, systemPrompt, mcpServers, plugins, tracker, options, compactionSink, fallbackModel);
        // eslint-disable-next-line no-await-in-loop -- sequential: each resume attempt depends on prior result
        const resumeResult = await attemptAutoResume(
            tracker, updatedText, updatedSessionId,
            retryableQuery, queryOptions, options, taskPersistenceCoordinator
        );
        updatedText = resumeResult.lastAssistantText;
        updatedSessionId = resumeResult.capturedSessionId ?? updatedSessionId;
        // Break if no progress was made (error or agent didn't collect anything)
        if(tracker.getProgress().uncollectedBackgroundTasks >= uncollectedBefore) {
            break;
        }
    }
    // Stryker restore BlockStatement

    // M-R6: warn when we give up with tasks still outstanding
    // Stryker disable next-line ConditionalExpression,BlockStatement: Observability — warn log fires only when tasks still outstanding after attempts exhausted; behavior (cleanupSession) unchanged
    if(tracker.hasUncollectedBackgroundTasks()) {
        /* Stryker disable StringLiteral,ObjectLiteral: Observability — warning log for lost background task results */
        logger.warn({
            uncollectedTasks: tracker.getProgress().uncollectedBackgroundTasks,
            autoResumeAttempts,
            msg:              `Cleaning up session with ${tracker.getProgress().uncollectedBackgroundTasks.toString()} outstanding background tasks after ${autoResumeAttempts.toString()} auto-resume attempts — results lost`,
        });
        /* Stryker restore StringLiteral,ObjectLiteral */
    }

    return { lastAssistantText: updatedText, capturedSessionId: updatedSessionId };
}

export function createClaudeAgent(options: ClaudeAgentOptions): ClaudeAgent {
    const { contextBuilder, plugins, taskPersistenceCoordinator, mainModel, compactionSink, fallbackModel, retryDeps } = options;
    const mcpServers = toSessionMcpServers(options);
    const resolvedModel = mainModel ?? 'sonnet';

    // Load retry configuration
    const retryConfig = loadRetryConfig();

    // Create retryable query function
    // Stryker disable next-line ObjectLiteral: Retry policy config object is structural, mutations don't affect behavior
    const retryableQuery = createRetryableQuery(query, {
        policy: retryConfig.claude,
        deps:   retryDeps,
    });

    const agent: ClaudeAgent = {
        handleInput: async (
            contexts: MessageContext[],
            handleOptions?: HandleInputOptions
        ): Promise<HandleInputResult> => {
            const tracker = new StreamTracker();
            // Ref object lets processStreamEvents propagate capturedSessionId even when it throws
            const sessionRef: { capturedSessionId: string | undefined } = { capturedSessionId: undefined };

            try {
                // 1. Load user timezone for user message localization
                const userTimezone = await loadUserTimezoneForFlow(contextBuilder, handleOptions, contexts);

                // 2. Build system prompt with core identity and channel list
                const channelList = handleOptions?.channelList;
                const systemPrompt = await buildSystemPrompt({ contextBuilder, channelList });

                // 3. Build user message text
                const userMessageText = await buildUserMessageTextForBatch(
                    contexts,
                    contextBuilder,
                    userTimezone,
                    handleOptions?.resumeContext,
                    handleOptions?.catchUpPrompt,
                    handleOptions?.perchPrompt
                );

                // 3.5. Prepend person history and/or context note if provided
                const finalMessageText = prependMessageAnnotations(userMessageText, handleOptions);

                // 4. Build prompt (string for text-only, async generator for images or text)
                const prompt = buildPromptForHandleInput(finalMessageText, handleOptions?.images);

                // 5. Log start of processing
                logger.info({
                    contextCount: contexts.length,
                    messageIds:   contexts.map(ctx => ctx.messageId),
                    hasImages:    hasImages(handleOptions?.images),
                    msg:          'Agent starting batch processing',
                });

                // 6. Query with MCP servers, plugins, and sandboxed execution (with retry)
                const response = retryableQuery({
                    prompt,
                    options: buildQueryOptions(resolvedModel, systemPrompt, mcpServers, plugins, tracker, handleOptions, compactionSink, fallbackModel),
                });

                // 7. Process stream events and track progress
                const { lastAssistantText: initialText, wasInterrupted: initialInterrupted }
                    = await processStreamEvents(response, tracker, handleOptions, taskPersistenceCoordinator, sessionRef);
                let lastAssistantText = initialText;
                const wasInterrupted = initialInterrupted;

                // 8. Auto-resume: collect background tasks
                const resumeCollected = await collectBackgroundTasks(
                    tracker, lastAssistantText, sessionRef.capturedSessionId, wasInterrupted,
                    retryableQuery, resolvedModel, systemPrompt, mcpServers, plugins, handleOptions, taskPersistenceCoordinator, compactionSink, fallbackModel
                );
                lastAssistantText = resumeCollected.lastAssistantText;
                sessionRef.capturedSessionId = resumeCollected.capturedSessionId;

                // 9. Deferred cleanup: SessionEnd hook skips cleanup when background tasks are
                //    pending (to avoid racing the resume pass in collectBackgroundTasks).
                //    After the resume pass finishes above, call cleanup unconditionally for the
                //    non-interrupted path. Interrupted sessions are skipped — SessionEnd's hook
                //    fires before handleInput returns, so interrupted sessions are cleaned up by
                //    the hook itself (which won't defer, as tasks are only deferred when the
                //    resume pass can reasonably run). The ENOENT case (already cleaned by hook)
                //    is handled gracefully inside cleanupSession.
                // Stryker disable next-line BlockStatement,ConditionalExpression,LogicalOperator: I/O side effect — cleanup outcome does not affect return value; guard prevents double-cleanup on interrupt
                if(!wasInterrupted && sessionRef.capturedSessionId) {
                    void cleanupSession(sessionRef.capturedSessionId);
                }

                // 10. Log completion
                /* Stryker disable StringLiteral,ObjectLiteral: Logging for observability */
                logger.info({
                    contextCount:   contexts.length,
                    wasInterrupted,
                    responseLength: lastAssistantText.length,
                    msg:            `Batch processing ${wasInterrupted ? 'interrupted' : 'completed'} (${lastAssistantText.length} chars)`,
                });
                /* Stryker restore StringLiteral,ObjectLiteral */

                // 11. Return result
                return buildHandleInputResult(lastAssistantText, wasInterrupted, sessionRef.capturedSessionId, tracker);
            } catch (error) {
                // If resume attempt failed before session was established, retry fresh
                // Guard: handleOptions?.sessionId is falsy on retry, preventing infinite recursion
                if(handleOptions?.sessionId && !sessionRef.capturedSessionId) {
                    // Stryker disable StringLiteral,ObjectLiteral: Observability - warn logging for debugging resume retry
                    logger.warn({
                        sessionId: handleOptions.sessionId,
                        msg:       'Resume failed before session established, retrying with fresh session',
                    });
                    // Stryker restore StringLiteral,ObjectLiteral
                    return agent.handleInput(contexts, { ...handleOptions, sessionId: undefined });
                }
                return buildErrorHandleInputResult(error, handleOptions, sessionRef.capturedSessionId, tracker, contexts.length);
            }
        },
    };
    return agent;
}
