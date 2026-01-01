import _ from 'lodash';
import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';

/**
 * Lightweight text generation using Agent SDK V2 preview.
 *
 * Design goals:
 * - Minimal overhead - just an LLM call
 * - Uses claude-4-5-haiku (lightest model)
 * - Reuses existing Claude Max token budget via OAuth
 * - No tools, agents, MCP servers, or streaming complexity
 */
export async function generateText(prompt: string): Promise<string> {
    const result = await unstable_v2_prompt(prompt, {
        model: 'haiku',
    });

    if(result.subtype === 'success') {
        return _.trim(result.result);
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
 * @returns Generated text, trimmed of whitespace, or empty string on error
 */
export async function generateTextWithSystemPrompt(
    systemPrompt: string,
    userPrompt: string
): Promise<string> {
    const combinedPrompt = `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`;

    const result = await unstable_v2_prompt(combinedPrompt, {
        model: 'haiku',
    });

    if(result.subtype === 'success') {
        return _.trim(result.result);
    }
    return '';
}
