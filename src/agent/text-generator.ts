import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import removeMarkdown from 'remove-markdown';
import type { TextBlock } from './stream-extractors';

/**
 * Process-lifetime singleton promise for the temp directory.
 * Intentionally cached: we only need one temp dir per process.
 * In tests, the first call to getTmpDir() populates this and subsequent calls
 * return the same path (so mockFsPromises.mkdtemp is only called once per test suite).
 */
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
    /**
     * Short call-site label (e.g. `'idle-status'`) included in the warning logged whenever a
     * generation produces no text. Purely diagnostic — never sent to the model.
     */
    label?:           string
}
/**
 * Extracts accumulated text from a query assistant event.
 */
function extractTextFromEvent(event: SDKMessage): string {
    if(event.type !== 'assistant') {
        return '';
    }
    const textBlocks = event.message.content.filter((block): block is TextBlock => block.type === 'text');
    return textBlocks.map(block => block.text).join('');
}

/**
 * Builds an internal AbortController wired to the caller's signal and a timeout.
 * We never mutate the caller's controller — all abort sources are forwarded to our own.
 */
function buildAbortController(options?: TextGeneratorOptions): { controller: AbortController, cleanup: () => void } {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sources: AbortSignal[] = [];
    const forwardAbort = (): void => controller.abort();

    // Wire caller's abort signal to our internal controller (never mutate caller's)
    if(options?.abortController) {
        if(options.abortController.signal.aborted) {
            controller.abort(); // Already aborted — short-circuit
        } else {
            // The caller's signal is one-shot; cleanup also removes the listener on completion.
            options.abortController.signal.addEventListener('abort', forwardAbort);
            // Stryker disable next-line ArrayMethodSwap: sources is used only to remove the same listener from every signal; cleanup order is unobservable.
            sources.push(options.abortController.signal);
        }
    }

    // Wire timeout to our internal controller using AbortSignal.timeout (auto-cleanup)
    if(timeoutMs > 0) {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        timeoutSignal.addEventListener('abort', forwardAbort);
        // Stryker disable next-line ArrayMethodSwap: sources is used only to remove the same listener from every signal; cleanup order is unobservable.
        sources.push(timeoutSignal);
    }

    return {
        controller,
        cleanup: () => {
            for(const source of sources) {
                source.removeEventListener('abort', forwardAbort);
            }
        },
    };
}

/**
 * Which of the two abort sources wired into the internal controller by
 * {@link buildAbortController} ended this call. The caller's own controller is the only source
 * other than our deadline, so a caller signal that has fired means the caller cancelled and
 * anything else means the deadline did.
 *
 * @param callerSignal - The caller's own abort signal, when one was supplied
 * @returns `'aborted'` for a caller cancellation, `'timeout'` for our own deadline
 */
function abortReason(callerSignal: AbortSignal | undefined): string {
    return callerSignal?.aborted ? 'aborted' : 'timeout';
}

/**
 * Warns that a generation produced nothing.
 *
 * Every caller already treats `''` as "no text this time" and degrades gracefully, so the empty
 * return stays; what did not exist before was any record that the call had failed at all. A
 * 16-second boot-time Haiku call silently swallowed by the 15s deadline surfaced only as a
 * Discord status rendered with an empty body.
 *
 * @param reason - `'timeout'`, `'aborted'` (logged at debug, see below), or the SDK result subtype that was not `'success'`
 * @param startedAt - `Date.now()` as of the start of this call
 * @param options - The caller's options, read for its diagnostic {@link TextGeneratorOptions.label}
 */
function warnEmptyResult(reason: string | undefined, startedAt: number, options?: TextGeneratorOptions): void {
    // A caller cancellation is routine — the dynamic status generator aborts an in-flight call on
    // every phase change (cancel-and-replace) — so it is recorded at debug, not warn.
    const log = reason === 'aborted' ? logger.debug.bind(logger) : logger.warn.bind(logger);
    log({
        reason,
        elapsedMs: Date.now() - startedAt,
        label:     options?.label,
        msg:       'Text generation produced no text',
    });
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
    const { controller, cleanup } = buildAbortController(options);
    const callerSignal = options?.abortController?.signal;
    const startedAt = Date.now();

    try {
        let resultText = '';
        let successResult: string | undefined;
        const tmpDir = await getTmpDir();

        const events = query({
            prompt,
            options: {
                model:           options?.model ?? 'haiku',
                fallbackModel:   options?.fallbackModel,
                executable:      'bun',
                cwd:             tmpDir,
                persistSession:  false,
                tools:           [],
                thinking:        { type: 'disabled' },
                effort:          'low',
                maxTurns:        1,
                abortController: controller,
                ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
            },
        });
        for await (const event of events) {
            resultText += extractTextFromEvent(event);
            if(event.type === 'result') {
                if(event.subtype !== 'success') {
                    warnEmptyResult(event.subtype, startedAt, options);
                    return ''; // Non-success result — discard any partial text
                }
                // Capture canonical result text as fallback in case no assistant events were streamed
                successResult = event.result;
                break; // Success — return accumulated text below
            }
        }

        // Guard: if aborted during iteration, discard result
        if(controller.signal.aborted) {
            warnEmptyResult(abortReason(callerSignal), startedAt, options);
            return '';
        }

        // Use successResult as fallback if no assistant events were streamed
        let text = (resultText.length > 0 ? resultText : (successResult ?? '')).trim();
        if(options?.stripMarkdown) {
            text = removeMarkdown(text).trim();
        }
        return text;
    } catch (error) {
        // If aborted (by timeout or caller), return empty string
        if(controller.signal.aborted) {
            warnEmptyResult(abortReason(callerSignal), startedAt, options);
            return '';
        }
        throw error;
    } finally {
        cleanup();
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
 * @param options.label - Short call-site label included in the empty-result warning
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
    const flatPrompt = Array.isArray(systemPrompt)
        ? systemPrompt.filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n')
        : systemPrompt;
    return executePrompt(`System:\n${flatPrompt}\n\nUser:\n${userPrompt}`, { ...options, systemPrompt });
}
