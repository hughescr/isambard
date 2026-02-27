/**
 * Message Summarizer
 *
 * Generates brief synopses for Discord messages using Claude Haiku.
 * Used to summarize overflow messages when search results exceed the limit.
 *
 * Key design principle: Message IDs are maintained by our code, NOT passed through Haiku.
 * This prevents any possibility of ID hallucination or mangling.
 */

// eslint-disable-next-line lodash/import-scope -- Allow full lodash import for chaining only
import _ from 'lodash';
import chunk from 'lodash/chunk';
import head from 'lodash/head';
import isEmpty from 'lodash/isEmpty';
import last from 'lodash/last';
import map from 'lodash/map';
import replace from 'lodash/replace';
import sortBy from 'lodash/sortBy';
import pLimit from 'p-limit';
import type { DiscordSearchResult, OverflowSummary, BatchOverflowSummary } from './types';
import { generateText } from '@/agent';

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
     * Each message gets its own Haiku call.
     */
    summarizeMessages(messages: DiscordSearchResult[]): Promise<OverflowSummary[]>

    /**
     * Summarize messages in batches for efficiency.
     * Groups messages into chunks of batchSize, with one Haiku call per batch.
     *
     * @param messages Array of Discord search results to summarize
     * @param batchSize Number of messages per batch (default: 10)
     * @returns Array of batch summaries
     */
    summarizeMessageBatch(messages: DiscordSearchResult[], batchSize?: number): Promise<BatchOverflowSummary[]>
}

// Stryker disable next-line StringLiteral: Configuration prompt template
const SUMMARIZATION_PROMPT = `Summarize this Discord message in 1-2 sentences (~50 words max).
Focus on: key topics, questions asked, decisions made, action items.

Message:
{content}`;

// Stryker disable next-line StringLiteral: Configuration prompt template
const BATCH_SUMMARIZATION_PROMPT = `Summarize these Discord messages in 2-3 sentences (~75 words max).
Focus on: key topics discussed, questions asked, decisions made, action items.

Messages:
{messages}`;

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
/**
 * Summarize a single message using Haiku.
 * @param content The message content to summarize
 * @returns The synopsis text
 */
async function summarizeContent(content: string): Promise<string> {
    // Stryker disable next-line StringLiteral: Template placeholder for content substitution
    const prompt = replace(SUMMARIZATION_PROMPT, '{content}', content);
    return generateText(prompt);
}

/**
 * Format messages for batch prompt.
 */
function formatMessagesForBatch(messages: DiscordSearchResult[]): string {
    return map(messages, msg =>
        `[${msg.author.username}] ${msg.content}`
    ).join('\n');
}

/**
 * Summarize a batch of messages in a single Haiku call.
 */
async function summarizeBatch(messages: DiscordSearchResult[]): Promise<BatchOverflowSummary> {
    const formatted = formatMessagesForBatch(messages);
    // Stryker disable next-line StringLiteral: Template placeholder for content substitution
    const prompt = replace(BATCH_SUMMARIZATION_PROMPT, '{messages}', formatted);
    const synopsis = await generateText(prompt);

    const sorted = sortBy(messages, 'timestamp');
    return {
        startTimestamp: head(sorted)!.timestamp,
        endTimestamp:   last(sorted)!.timestamp,
        messageCount:   messages.length,
        authors:        _(messages).map('author.username').uniq().value() as string[],
        synopsis,
    };
}

export function createMessageSummarizer(options: SummarizerOptions): MessageSummarizer {
    const { maxConcurrent = 10 } = options;

    return {
        async summarizeMessages(messages: DiscordSearchResult[]): Promise<OverflowSummary[]> {
            // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant - map([]) returns [] so early return is redundant; prevents unnecessary pLimit setup
            if(isEmpty(messages)) {
                return [];
            }

            const limit = pLimit(maxConcurrent);

            // Process all messages in parallel with concurrency limiting
            const summaryPromises = map(messages, message =>
                limit(async (): Promise<OverflowSummary> => {
                    const synopsis = await summarizeContent(message.content);
                    return {
                        id:        message.id,
                        timestamp: message.timestamp,
                        author:    message.author.username,
                        synopsis,
                    };
                })
            );

            return Promise.all(summaryPromises);
        },

        async summarizeMessageBatch(messages: DiscordSearchResult[], batchSize = 10): Promise<BatchOverflowSummary[]> {
            // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant - chunk([], n) produces [] batches so early return is redundant; prevents unnecessary pLimit setup
            if(isEmpty(messages)) {
                return [];
            }

            const batches = chunk(messages, batchSize);
            const limit = pLimit(maxConcurrent);

            const batchPromises = map(batches, batch =>
                limit(() => summarizeBatch(batch))
            );

            return Promise.all(batchPromises);
        },
    };
}
