/**
 * Message Summarizer
 *
 * Generates batch synopses for Discord overflow messages using Claude Haiku.
 * Groups messages into batches so one call summarizes each batch.
 */
import { chain, isEmpty } from 'lodash-es';
import pLimit from 'p-limit';
import type { DiscordSearchResult, BatchOverflowSummary } from './types';
import { generateText } from '@/agent';

/**
 * Options for creating a message summarizer.
 */
interface SummarizerOptions {
    /** Maximum concurrent Haiku requests (default: 10) */
    maxConcurrent?: number
}

/**
 * Interface for the message summarizer.
 */
export interface MessageSummarizer {
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

const BATCH_SUMMARIZATION_PROMPT = `Summarize these Discord messages in 2-3 sentences (~75 words max).
Focus on: key topics discussed, questions asked, decisions made, action items.

Messages:
{messages}`;

/**
 * Creates a message summarizer that uses Claude Haiku to generate synopses.
 *
 * The summarizer processes batches in parallel with configurable concurrency.
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
 * const summaries = await summarizer.summarizeMessageBatch(overflowMessages);
 * // Returns: [{ startTimestamp, endTimestamp, messageCount, authors, synopsis }, ...]
 * ```
 */
/**
 * Format messages for batch prompt.
 */
function formatMessagesForBatch(messages: DiscordSearchResult[]): string {
    return messages.map(msg =>
        `[${msg.author.username}] ${msg.content}`).join('\n');
}

/**
 * Summarize a batch of messages in a single Haiku call.
 */
async function summarizeBatch(messages: DiscordSearchResult[]): Promise<BatchOverflowSummary> {
    const formatted = formatMessagesForBatch(messages);
    const prompt = BATCH_SUMMARIZATION_PROMPT.replace('{messages}', formatted);
    const synopsis = await generateText(prompt);

    const sorted = messages.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
        // Stryker disable next-line llm: for supported positive integer batch sizes, the batch is nonempty and its ISO timestamp is nonempty, so the optional access and fallback are unreachable
        startTimestamp: sorted.at(0)!.timestamp,
        endTimestamp:   sorted.at(-1)!.timestamp,
        messageCount:   messages.length,
        authors:        chain(messages).map('author.username').uniq().value() as string[],
        synopsis,
    };
}

export function createMessageSummarizer(options: SummarizerOptions): MessageSummarizer {
    const { maxConcurrent = 10 } = options;

    return {
        async summarizeMessageBatch(messages: DiscordSearchResult[], batchSize = 10): Promise<BatchOverflowSummary[]> {
            if(isEmpty(messages)) {
                return [];
            }

            const batches = Array.from({ length: Math.ceil(messages.length / batchSize) }, (_, i) => messages.slice(i * batchSize, (i + 1) * batchSize));
            const limit = pLimit(maxConcurrent);

            const batchPromises = batches.map(batch =>
                limit(() => summarizeBatch(batch)));

            return Promise.all(batchPromises);
        },
    };
}
