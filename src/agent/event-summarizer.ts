import { isEmpty } from 'lodash-es';
import pLimit from 'p-limit';
import { generateText } from './text-generator';
import type { MemoryToolItemData } from '@/storage';
import { formatShortRelativeTime } from '@/utils';

export interface EventBatchSummary {
    startTime: string    // ISO8601 of earliest event in batch
    endTime:   string    // ISO8601 of latest event in batch
    count:     number
    summary:   string    // Haiku-generated synopsis
}

// Type for the summarizer function (for DI)
export type SummarizeEventBatchesFn = typeof summarizeEventBatches;

// Stryker disable next-line ArithmeticOperator: Concurrency limit is a config constant
const CONCURRENCY_LIMIT = 4;
// Stryker disable next-line ArithmeticOperator: Content preview length is a config constant
const CONTENT_PREVIEW_LENGTH = 200;

export async function summarizeEventBatches(
    events: MemoryToolItemData[],
    batchSize: number,
    now: Date
): Promise<EventBatchSummary[]> {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Defensive empty array guard
    if(isEmpty(events)) {
        return [];
    }

    // Sort all events by updatedAt ascending, then split into batches
    const sortedEvents = events.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const batches = Array.from({ length: Math.ceil(sortedEvents.length / batchSize) }, (_, i) => sortedEvents.slice(i * batchSize, (i + 1) * batchSize));

    // Process batches in parallel with concurrency limit
    const limit = pLimit(CONCURRENCY_LIMIT);

    const summaryPromises = batches.map(batch =>
        limit(async (): Promise<EventBatchSummary> => {
            const startTime = batch.at(0)!.updatedAt;
            const endTime = batch.at(-1)!.updatedAt;

            // Format events for the prompt
            // Stryker disable StringLiteral: Cosmetic join separator for prompt formatting
            const formattedEvents = batch.map((event) => {
                const eventDate = new Date(event.updatedAt);
                const relativeAge = formatShortRelativeTime(eventDate, now);
                const preview = event.content.slice(0, CONTENT_PREVIEW_LENGTH);
                return `[${event.path}] (${relativeAge}): ${preview}`;
            }).join('\n');
            // Stryker restore StringLiteral

            // Generate summary
            const prompt = `Summarize these events in 2-3 sentences (~75 words max). Focus on: key activities, decisions, topics discussed.

Events:
${formattedEvents}`;

            const summary = await generateText(prompt);

            return {
                startTime,
                endTime,
                count: batch.length,
                summary,
            };
        })
    );

    return Promise.all(summaryPromises);
}
