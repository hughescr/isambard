import _ from 'lodash';
import pLimit from 'p-limit';
import type { MemoryToolItemData } from '../storage/memory-tool/types';
import { generateText } from './text-generator';
import { formatShortRelativeTime } from '../utils/time';

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
    if(_.isEmpty(events)) {
        return [];
    }

    // Sort all events by updatedAt ascending, then split into batches
    const sortedEvents = _.sortBy(events, 'updatedAt');
    const batches = _.chunk(sortedEvents, batchSize);

    // Process batches in parallel with concurrency limit
    const limit = pLimit(CONCURRENCY_LIMIT);

    const summaryPromises = _.map(batches, batch =>
        limit(async (): Promise<EventBatchSummary> => {
            const startTime = _.head(batch)!.updatedAt;
            const endTime = _.last(batch)!.updatedAt;

            // Format events for the prompt
            // Stryker disable StringLiteral: Cosmetic join separator for prompt formatting
            const formattedEvents = _.map(batch, (event) => {
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
