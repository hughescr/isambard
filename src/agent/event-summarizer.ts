import pLimit from 'p-limit';
import { generateText } from './text-generator';
import type { MemoryToolItemData } from '@/storage';
import { formatShortRelativeTime } from '@/utils';

interface EventBatchSummary {
    startTime: string    // ISO8601 of earliest event in batch
    endTime:   string    // ISO8601 of latest event in batch
    count:     number
    summary:   string    // Haiku-generated synopsis
}

// Type for the summarizer function (for DI)
export type SummarizeEventBatchesFn = typeof summarizeEventBatches;

const CONCURRENCY_LIMIT = 4;
const CONTENT_PREVIEW_LENGTH = 200;

export async function summarizeEventBatches(
    events: MemoryToolItemData[],
    batchSize: number,
    now: Date
): Promise<EventBatchSummary[]> {
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
            const formattedEvents = batch.map((event) => {
                const eventDate = new Date(event.updatedAt);
                const relativeAge = formatShortRelativeTime(eventDate, now);
                // Stryker disable next-line llm: slice and substring agree for a string with non-negative bounds.
                const preview = event.content.slice(0, CONTENT_PREVIEW_LENGTH);
                return `[${event.path}] (${relativeAge}): ${preview}`;
            }).join('\n');

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
