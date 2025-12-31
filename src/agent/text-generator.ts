import _ from 'lodash';
import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';

/**
 * Lightweight text generation using Agent SDK V2 preview.
 *
 * Design goals:
 * - Minimal overhead - just an LLM call
 * - Uses claude-3-5-haiku (lightest model)
 * - Reuses existing Claude Max token budget via OAuth
 * - No tools, agents, MCP servers, or streaming complexity
 */
export async function generateText(prompt: string): Promise<string> {
    const result = await unstable_v2_prompt(prompt, {
        model: 'claude-3-5-haiku-20241022',
    });

    if(result.subtype === 'success') {
        return _.trim(result.result);
    }
    return '';
}
