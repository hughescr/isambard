/**
 * Message Summarizer
 *
 * Generates brief synopses for Discord messages using Claude Haiku.
 * Used to summarize overflow messages when search results exceed the limit.
 *
 * Key design principle: Message IDs are maintained by our code, NOT passed through Haiku.
 * This prevents any possibility of ID hallucination or mangling.
 */

import type Anthropic from '@anthropic-ai/sdk';
import _ from 'lodash';
import type { DiscordSearchResult, OverflowSummary } from './types';

/**
 * Error thrown when Haiku returns an unexpected response format.
 */
export class SummarizerResponseError extends Error {
    constructor(message: string) {
        super(message);
        // Stryker disable next-line StringLiteral: Error class name is not behavior
        this.name = 'SummarizerResponseError';
    }
}

/**
 * Options for creating a message summarizer.
 */
export interface SummarizerOptions {
    /** Anthropic API client for Haiku calls */
    anthropicClient: Anthropic
    /** Maximum concurrent Haiku requests (default: 10) */
    maxConcurrent?:  number
}

/**
 * Interface for the message summarizer.
 */
export interface MessageSummarizer {
    /**
     * Summarize multiple Discord messages in parallel using Claude Haiku.
     *
     * @param messages Array of Discord search results to summarize
     * @returns Array of overflow summaries in the same order as input
     * @throws Error if any Haiku API call fails
     */
    summarizeMessages(messages: DiscordSearchResult[]): Promise<OverflowSummary[]>
}

// Stryker disable next-line StringLiteral: Configuration string for Haiku model
const HAIKU_MODEL = 'claude-3-5-haiku-20241022';

// Stryker disable next-line StringLiteral: Configuration prompt template
const SUMMARIZATION_PROMPT = `Summarize this Discord message in 1-2 sentences (~50 words max).
Focus on: key topics, questions asked, decisions made, action items.

Message:
{content}`;

/**
 * Simple semaphore for limiting concurrent operations.
 */
function createSemaphore(maxConcurrent: number): {
    acquire: () => Promise<void>
    release: () => void
} {
    let current = 0;
    const queue: (() => void)[] = [];

    return {
        acquire: () => new Promise<void>((resolve) => {
            if(current < maxConcurrent) {
                current++;
                resolve();
            } else {
                queue.push(resolve);
            }
        }),
        release: () => {
            current--;
            const next = queue.shift();
            if(next) {
                current++;
                return next();
            }
            return undefined;
        },
    };
}

/**
 * Creates a message summarizer that uses Claude Haiku to generate synopses.
 *
 * The summarizer processes messages in parallel with configurable concurrency.
 * Message IDs are preserved by our code and never passed to Haiku, preventing
 * any possibility of ID hallucination or mangling.
 *
 * @param options Summarizer configuration
 * @returns MessageSummarizer instance
 *
 * @example
 * ```typescript
 * const summarizer = createMessageSummarizer({
 *   anthropicClient: myAnthropicClient,
 *   maxConcurrent: 5,
 * });
 *
 * const summaries = await summarizer.summarizeMessages(overflowMessages);
 * // Returns: [{ id, timestamp, author, synopsis }, ...]
 * ```
 */
export function createMessageSummarizer(options: SummarizerOptions): MessageSummarizer {
    const { anthropicClient, maxConcurrent = 10 } = options;

    /**
     * Summarize a single message using Haiku.
     * @param content The message content to summarize
     * @returns The synopsis text
     */
    async function summarizeContent(content: string): Promise<string> {
        const prompt = _.replace(SUMMARIZATION_PROMPT, '{content}', content);

        const response = await anthropicClient.messages.create({
            model:      HAIKU_MODEL,
            max_tokens: 100,
            messages:   [{ role: 'user', content: prompt }],
        });

        const firstContent = _.head(response.content);
        if(firstContent?.type !== 'text') {
            // Stryker disable next-line StringLiteral: Error message text is not behavior
            throw new SummarizerResponseError('Unexpected response type from Haiku');
        }

        return _.trim(firstContent.text);
    }

    return {
        async summarizeMessages(messages: DiscordSearchResult[]): Promise<OverflowSummary[]> {
            if(_.isEmpty(messages)) {
                return [];
            }

            const semaphore = createSemaphore(maxConcurrent);

            // Process all messages in parallel with concurrency limiting
            const summaryPromises = _.map(messages, async (message): Promise<OverflowSummary> => {
                await semaphore.acquire();
                try {
                    const synopsis = await summarizeContent(message.content);
                    return {
                        id:        message.id,
                        timestamp: message.timestamp,
                        author:    message.author.username,
                        synopsis,
                    };
                } finally {
                    semaphore.release();
                }
            });

            return Promise.all(summaryPromises);
        },
    };
}
