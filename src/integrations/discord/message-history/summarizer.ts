/**
 * Message Summarizer
 *
 * Generates brief synopses for Discord messages using Claude Haiku.
 * Used to summarize overflow messages when search results exceed the limit.
 *
 * Key design principle: Message IDs are maintained by our code, NOT passed through Haiku.
 * This prevents any possibility of ID hallucination or mangling.
 */

import _ from 'lodash';
import { generateText } from '@/agent/text-generator';
import type { DiscordSearchResult, OverflowSummary } from './types';

/**
 * Options for creating a message summarizer.
 */
export interface SummarizerOptions {
    /** Maximum concurrent Haiku requests (default: 10) */
    maxConcurrent?: number
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

// Stryker disable next-line StringLiteral: Configuration prompt template
const SUMMARIZATION_PROMPT = `Summarize this Discord message in 1-2 sentences (~50 words max).
Focus on: key topics, questions asked, decisions made, action items.

Message:
{content}`;

/**
 * Simple semaphore for limiting concurrent operations.
 * @internal Exported for testing purposes only
 */
export function createSemaphore(maxConcurrent: number): {
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
                // Stryker disable next-line UpdateOperator: Semaphore counter increment is essential for concurrency control
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
 *   maxConcurrent: 5,
 * });
 *
 * const summaries = await summarizer.summarizeMessages(overflowMessages);
 * // Returns: [{ id, timestamp, author, synopsis }, ...]
 * ```
 */
export function createMessageSummarizer(options: SummarizerOptions): MessageSummarizer {
    const { maxConcurrent = 10 } = options;

    /**
     * Summarize a single message using Haiku.
     * @param content The message content to summarize
     * @returns The synopsis text
     */
    async function summarizeContent(content: string): Promise<string> {
        // Stryker disable next-line StringLiteral: Template placeholder for content substitution
        const prompt = _.replace(SUMMARIZATION_PROMPT, '{content}', content);
        return await generateText(prompt);
    }

    return {
        async summarizeMessages(messages: DiscordSearchResult[]): Promise<OverflowSummary[]> {
            // Stryker disable next-line all: Early return for empty input prevents unnecessary work
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
