import type Anthropic from '@anthropic-ai/sdk';
import _ from 'lodash';
import type { DiscordMessageContext } from '../integrations/discord/types';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2048;
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const TRUNCATION_BUFFER = 100; // Leave room for "..." and safety margin
const MAX_RESPONSE_LENGTH = DISCORD_MAX_MESSAGE_LENGTH - TRUNCATION_BUFFER;

export interface ClaudeAgentOptions {
    /** Anthropic client instance */
    client:      Anthropic
    /** Optional memory tool for persistent context (can be beta or standard tool) */
    memoryTool?: Anthropic.Messages.Tool
}

export interface ClaudeAgent {
    /**
   * Process a Discord message and generate a response.
   *
   * @param context Discord message context
   * @returns Claude's response text, or null if an error occurred
   */
    chat: (context: DiscordMessageContext) => Promise<string | null>
}

/**
 * Creates a Claude agent for processing Discord messages.
 *
 * The agent:
 * - Formats messages with user context
 * - Calls Claude API with configured model
 * - Truncates responses to fit Discord limits
 * - Optionally uses memory tool for persistent context
 * - Returns null on errors (logged but not thrown)
 *
 * @param options Agent configuration
 * @returns Claude agent instance
 */
export function createClaudeAgent(options: ClaudeAgentOptions): ClaudeAgent {
    const { client, memoryTool } = options;

    return {
        chat: async (context: DiscordMessageContext): Promise<string | null> => {
            try {
                // Format message with user context
                const formattedMessage = `User @${context.userId} said: ${context.content}`;

                // Build API request
                const requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
                    model:      CLAUDE_MODEL,
                    max_tokens: MAX_TOKENS,
                    messages:   [
                        {
                            role:    'user',
                            content: formattedMessage,
                        },
                    ],
                };

                // Add memory tool if provided
                if(memoryTool) {
                    requestParams.tools = [memoryTool];
                }

                // Call Claude API
                const response = await client.messages.create(requestParams);

                // Extract text content from response
                const textContent = _.find(response.content, { type: 'text' });

                if(textContent?.type !== 'text') {
                    // eslint-disable-next-line no-console -- Logging expected response structure
                    console.log(`Claude response contained no text content for message ${context.messageId}`);
                    return null;
                }

                // Truncate if necessary to fit Discord limits
                const text = textContent.text;
                if(text.length > MAX_RESPONSE_LENGTH) {
                    // eslint-disable-next-line no-console -- Logging truncation for debugging
                    console.log(`Truncating Claude response for message ${context.messageId}: ${text.length} -> ${MAX_RESPONSE_LENGTH}`);
                    return text.slice(0, MAX_RESPONSE_LENGTH - 3) + '...';
                }

                return text;
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                // eslint-disable-next-line no-console -- Error logging
                console.error(`Failed to get Claude response for message ${context.messageId} from user ${context.userId}: ${errorMessage}`, error);
                return null;
            }
        },
    };
}
