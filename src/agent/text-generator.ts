import _ from 'lodash';
import removeMarkdown from 'remove-markdown';
import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';
import { cleanupSession } from './session-cleanup';

/**
 * Options for text generation functions.
 */
export interface TextGeneratorOptions {
    /**
     * If true, strips markdown formatting from the result.
     * Useful for Discord status text that shouldn't contain markdown.
     * @default false
     */
    stripMarkdown?: boolean
}

/**
 * Lightweight text generation using Agent SDK V2 preview.
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
 * @returns Generated text, trimmed of whitespace, or empty string on error
 */
export async function generateText(
    prompt: string,
    options?: TextGeneratorOptions
): Promise<string> {
    const result = await unstable_v2_prompt(prompt, {
        model: 'haiku',
    });

    // Clean up session file (fire-and-forget)
    // Stryker disable next-line all: Cleanup is fire-and-forget, not observable in tests
    if(result.session_id) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget cleanup
        cleanupSession(result.session_id);
    }

    if(result.subtype === 'success') {
        let text = _.trim(result.result);
        if(options?.stripMarkdown) {
            text = _.trim(removeMarkdown(text));
        }
        return text;
    }
    return '';
}

/**
 * Generate text with separate system and user prompts for richer context.
 *
 * Since the V2 API doesn't support systemPrompt directly, this function
 * combines them into a single formatted prompt with clear delimiters.
 *
 * @param systemPrompt - Instructions for how the LLM should behave
 * @param userPrompt - The actual user request/question
 * @param options - Optional configuration
 * @param options.stripMarkdown - If true, strips markdown formatting from result
 * @returns Generated text, trimmed of whitespace, or empty string on error
 */
export async function generateTextWithSystemPrompt(
    systemPrompt: string,
    userPrompt: string,
    options?: TextGeneratorOptions
): Promise<string> {
    const combinedPrompt = `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`;

    const result = await unstable_v2_prompt(combinedPrompt, {
        model: 'haiku',
    });

    // Clean up session file (fire-and-forget)
    // Stryker disable next-line all: Cleanup is fire-and-forget, not observable in tests
    if(result.session_id) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget cleanup
        cleanupSession(result.session_id);
    }

    if(result.subtype === 'success') {
        let text = _.trim(result.result);
        if(options?.stripMarkdown) {
            text = _.trim(removeMarkdown(text));
        }
        return text;
    }
    return '';
}
