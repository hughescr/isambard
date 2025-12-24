import Anthropic from '@anthropic-ai/sdk';

/**
 * Creates an Anthropic Claude client instance.
 *
 * Uses the ANTHROPIC_API_KEY environment variable for authentication.
 * Validates that the API key is set before creating the client.
 *
 * @param options - Optional configuration for the client
 * @param options.apiKey - API key override (defaults to ANTHROPIC_API_KEY env var)
 * @returns Configured Anthropic client
 * @throws {Error} If ANTHROPIC_API_KEY is not set and no override provided
 */
export function createClaudeClient(options?: { apiKey?: string }): Anthropic {
    const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if(!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    return new Anthropic({
        apiKey,
    });
}
