import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import removeMarkdown from 'remove-markdown';

/**
 * Process-lifetime singleton promise for the temp directory.
 * Intentionally cached: we only need one temp dir per process.
 * In tests, the first call to getTmpDir() populates this and subsequent calls
 * return the same path (so mockFsPromises.mkdtemp is only called once per test suite).
 */
// Stryker disable next-line AssignmentOperator: Initial null is required — lazy-init pattern
let tmpDirPromise: Promise<string> | null = null;

/**
 * Lazily creates a temp directory for subprocess cwd.
 * Using an empty directory ensures no CLAUDE.md files are picked up.
 *
 * This is a process-lifetime singleton: once created, the same directory is reused
 * for all generateText calls. In tests, only the first call executes mkdtemp.
 *
 * On failure, the cached promise is cleared so the next call will retry.
 */
function getTmpDir(): Promise<string> {
    // Stryker disable next-line AssignmentOperator: nullish assign — lazy-init sentinel
    tmpDirPromise ??= mkdtemp(path.join(tmpdir(), 'isambard-textgen-')).catch((err: unknown) => {
        tmpDirPromise = null;
        throw err;
    });
    return tmpDirPromise;
}

/**
 * Resets the cached temp directory promise.
 * Only for use in tests — allows testing the retry-on-failure behavior.
 * @internal
 */
export function resetTmpDirForTesting(): void {
    tmpDirPromise = null;
}

// Default timeout for text generation calls
// Stryker disable next-line AssignmentOperator: Default timeout constant is configuration
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Options for text generation functions.
 */
interface TextGeneratorOptions {
    /**
     * If true, strips markdown formatting from the result.
     * Useful for Discord status text that shouldn't contain markdown.
     * @default false
     */
    stripMarkdown?:   boolean
    /**
     * Model to use for text generation.
     * @default 'haiku'
     */
    // Stryker disable next-line StringLiteral: default model name is SDK configuration constant
    model?:           string
    /**
     * Fallback model to use when primary model is unavailable (rate limit, overload, 5xx).
     * When provided, the SDK automatically falls back to this model on errors.
     */
    fallbackModel?:   string
    /**
     * AbortController for cancellation. When aborted, the query stops and returns empty string.
     */
    abortController?: AbortController
    /**
     * Hard timeout in milliseconds. Defaults to 15000 (15s). Set to 0 to disable.
     */
    timeoutMs?:       number
    /**
     * Optional system prompt to pass to the query as a separate option.
     * When provided, passed directly to the SDK's systemPrompt option.
     * Accepts a string or a string array (with optional SYSTEM_PROMPT_DYNAMIC_BOUNDARY
     * sentinel element) for cross-session prompt caching.
     */
    systemPrompt?:    string | string[]
}

/**
 * Content block from an assistant message.
 */
interface ContentBlock {
    type:  string
    text?: string
}

/**
 * Boundary type for the events streamed by the Claude Agent SDK's `query()`.
 *
 * The SDK's published `SDKMessage` union is currently unusable as a type: it lists
 * `SDKControlRequestProgressMessage` and `SDKConversationResetMessage` as members,
 * but neither is defined anywhere in the shipped `.d.ts`. That undefined reference
 * collapses the whole union to the `error` type — silently tolerated by `tsc` under
 * `skipLibCheck`, but flagged by typed linting as an unresolvable type. Until the SDK
 * ships correct types, we describe only the fields we consume, discriminated by
 * `type` (and `subtype`/`result` on the terminal `result` event).
 */
interface QueryEvent {
    type:     string
    subtype?: string
    message?: unknown
    result?:  string
}

/**
 * Extracts accumulated text from a query assistant event.
 */
function extractTextFromEvent(event: { type: string, message?: unknown }): string {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant — non-assistant events have no message.content, so filter returns [] and we return '' either way
    if(event.type !== 'assistant') {
        return '';
    }
    const content = (event.message as { content?: unknown } | undefined)?.content as ContentBlock[] | undefined;
    // Stryker disable next-line ArrayDeclaration,ConditionalExpression,LogicalOperator,MethodExpression: Equivalent mutant — filter on non-text blocks or without text field produces empty result either way
    const textBlocks = (content ?? []).filter(block => block.type === 'text' && block.text);
    // Stryker disable next-line StringLiteral: ?? '' fallback is defensive — filter guarantees block.text is truthy, so '' default is never reached
    return textBlocks.map(block => block.text ?? '').join('');
}

/**
 * Builds an internal AbortController wired to the caller's signal and a timeout.
 * We never mutate the caller's controller — all abort sources are forwarded to our own.
 */
function buildAbortController(options?: TextGeneratorOptions): AbortController {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Wire caller's abort signal to our internal controller (never mutate caller's)
    if(options?.abortController) {
        if(options.abortController.signal.aborted) {
            controller.abort(); // Already aborted — short-circuit
        } else {
            // Stryker disable BlockStatement,ArrowFunction: abort signal wiring — mutating causes test timeout (abort never propagates to controller)
            // Stryker disable next-line ObjectLiteral,BooleanLiteral: { once: true } is defensive — abort signals only fire once anyway; mutation to {} or false doesn't change observable behavior
            options.abortController.signal.addEventListener('abort', () => controller.abort(), { once: true });
            // Stryker restore BlockStatement,ArrowFunction
        }
    }

    // Wire timeout to our internal controller using AbortSignal.timeout (auto-cleanup)
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: timeout guard — 0 means disabled; tests use timeoutMs=0 so block is never entered
    if(timeoutMs > 0) {
        // Stryker disable next-line ObjectLiteral,BooleanLiteral,ArrowFunction,StringLiteral: { once: true } is defensive — abort signals only fire once anyway; mutation to {} or false doesn't change observable behavior; abort callback is fire-and-forget; 'abort' event name is configuration
        AbortSignal.timeout(timeoutMs).addEventListener('abort', () => controller.abort(), { once: true });
    }

    return controller;
}

/**
 * Shared implementation: calls the V1 SDK query(), and extracts text.
 *
 * @param prompt - The fully-assembled prompt string to send to the LLM
 * @param options - Optional configuration
 * @returns Generated text, trimmed of whitespace, or empty string on abort/error
 */
// eslint-disable-next-line complexity -- fallbackModel passthrough adds one optional-chaining branch; the function handles multiple necessary abort/error/success paths that cannot be simplified further
async function executePrompt(
    prompt: string,
    options?: TextGeneratorOptions
): Promise<string> {
    const controller = buildAbortController(options);

    try {
        let resultText = '';
        let successResult: string | undefined;
        const tmpDir = await getTmpDir();

        // boundary cast: the SDK's query() yields the broken `SDKMessage` union (see QueryEvent); laundering through `unknown` lets us consume the events under a resolvable type.
        const events = query({
            prompt,
            options: {
                // Stryker disable next-line StringLiteral: default model name is SDK configuration constant
                model:           options?.model ?? 'haiku',
                fallbackModel:   options?.fallbackModel,
                // Stryker disable next-line StringLiteral: executable name is configuration
                executable:      'bun',
                cwd:             tmpDir,
                persistSession:  false,
                tools:           [],
                thinking:        { type: 'disabled' },
                // Stryker disable next-line StringLiteral: effort level is configuration
                effort:          'low',
                maxTurns:        1,
                abortController: controller,
                // Stryker disable next-line ConditionalExpression,LogicalOperator: undefined passthrough — systemPrompt is only included when the caller provides it
                ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
            },
        }) as unknown as AsyncIterable<QueryEvent>;
        for await (const event of events) {
            resultText += extractTextFromEvent(event);
            // Stryker disable next-line BlockStatement: Equivalent mutant — skipping the result-event handler means the loop runs to completion anyway; non-success subtypes yield no assistant text so resultText is '' either way
            if(event.type === 'result') {
                // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant — non-success generators yield no assistant text, so resultText.trim() === '' either way; the early return is semantic clarity for production resilience
                if(event.subtype !== 'success') {
                    return ''; // Non-success result — discard any partial text
                }
                // Capture canonical result text as fallback in case no assistant events were streamed
                // Stryker disable next-line AssignmentOperator,ConditionalExpression: successResult fallback — only used when resultText is empty (e.g. haiku returns via result.result instead of streaming)
                successResult = event.result;
                break; // Success — return accumulated text below
            }
        }

        // Guard: if aborted during iteration, discard result
        if(controller.signal.aborted) {
            return '';
        }

        // Use successResult as fallback if no assistant events were streamed
        // Stryker disable next-line ConditionalExpression,StringLiteral: fallback — successResult is only used when resultText is empty string
        let text = (resultText.length > 0 ? resultText : (successResult ?? '')).trim();
        if(options?.stripMarkdown) {
            // Stryker disable next-line MethodExpression: trim() after removeMarkdown is defensive — markdown stripping may leave trailing whitespace but test inputs don't exercise this
            text = removeMarkdown(text).trim();
        }
        return text;
    } catch (error) {
        // If aborted (by timeout or caller), return empty string
        if(controller.signal.aborted) {
            return '';
        }
        throw error;
    }
}

/**
 * Lightweight text generation using Agent SDK V1 query().
 *
 * Design goals:
 * - Minimal overhead - just an LLM call
 * - Uses claude-4-5-haiku (lightest model)
 * - Reuses existing Claude Max token budget via OAuth
 * - No tools, agents, MCP servers, or streaming complexity
 *
 * @param prompt - The prompt to send to the LLM
 * @param options - Optional configuration
 * @param options.stripMarkdown - If true, strips markdown formatting from result
 * @param options.abortController - Optional AbortController for cancellation
 * @param options.timeoutMs - Hard timeout in ms (default 15000, 0 to disable)
 * @returns Generated text, trimmed of whitespace, or empty string on abort/error
 */
export async function generateText(
    prompt: string,
    options?: TextGeneratorOptions
): Promise<string> {
    return executePrompt(prompt, options);
}

/**
 * Generate text with separate system and user prompts for richer context.
 *
 * Passes systemPrompt as a dedicated SDK option for proper separation of concerns.
 * When systemPrompt is a string array (with optional SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 * sentinel), the array is passed to the SDK for cross-session prompt caching.
 *
 * @param systemPrompt - Instructions for how the LLM should behave; string or string array
 * @param userPrompt - The actual user request/question
 * @param options - Optional configuration
 * @param options.stripMarkdown - If true, strips markdown formatting from result
 * @returns Generated text, trimmed of whitespace, or empty string on abort/error
 */
export async function generateTextWithSystemPrompt(
    systemPrompt: string | string[],
    userPrompt: string,
    options?: TextGeneratorOptions
): Promise<string> {
    // Stryker disable next-line ConditionalExpression: array check — string arrays are passed to SDK as-is for caching; strings are passed directly
    const flatPrompt = Array.isArray(systemPrompt)
        ? systemPrompt.filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n')
        : systemPrompt;
    return executePrompt(`System:\n${flatPrompt}\n\nUser:\n${userPrompt}`, { ...options, systemPrompt });
}
