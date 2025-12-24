import Anthropic from '@anthropic-ai/sdk';

/**
 * Creates an Anthropic Claude client instance.
 *
 * Uses the ANTHROPIC_API_KEY environment variable for authentication.
 * The SDK handles validation and will throw if the key is missing.
 *
 * @returns Configured Anthropic client
 * @throws {Error} If ANTHROPIC_API_KEY is not set
 */
export function createClaudeClient(): Anthropic {
    return new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });
}
