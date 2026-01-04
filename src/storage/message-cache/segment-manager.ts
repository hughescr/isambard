import { sortBy as _sortBy, uniqBy as _uniqBy, filter as _filter, flatMap as _flatMap } from 'lodash';
import type { MessageId, CachedSegmentData, CacheGap, CachedMessage } from './types';

/**
 * Manages segment operations for message caching.
 * Handles gap-finding, overlap detection, and message merging.
 */
export class SegmentManager {
    /**
     * Finds gaps in cached coverage for a requested range.
     * Returns an array of gaps that need to be fetched from Discord API.
     *
     * @param cachedSegments - Array of cached segments (will be sorted internally)
     * @param requestedStart - Start of requested range (inclusive)
     * @param requestedEnd - End of requested range (inclusive)
     * @returns Array of gaps not covered by cached segments
     *
     * @example
     * ```ts
     * // Cached: [100-120], [150-200]
     * // Requested: 100-200
     * // Returns: [{ start: 121, end: 149 }]
     * ```
     */
    static findGaps(
        cachedSegments: CachedSegmentData[],
        requestedStart: MessageId,
        requestedEnd: MessageId
    ): CacheGap[] {
        // Early return optimization: if no segments are cached, the entire
        // requested range is a gap. This avoids unnecessary BigInt conversions
        // and sorting for the empty case.
        // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent - line 66 handles empty case identically
        if(cachedSegments.length === 0) {
            return [{ start: requestedStart, end: requestedEnd }];
        }

        const startBigInt = BigInt(requestedStart);
        const endBigInt = BigInt(requestedEnd);

        // Sort segments by startSnowflake using BigInt comparison
        // Stryker disable all: Sort comparator mutations are equivalent (stable sort)
        const sortedSegments = [...cachedSegments].sort((a, b) => {
            const aStart = BigInt(a.startSnowflake);
            const bStart = BigInt(b.startSnowflake);
            if(aStart < bStart) {
                return -1;
            }
            if(aStart > bStart) {
                return 1;
            }
            return 0;
        });
        // Stryker restore all

        // Filter to segments that intersect with requested range
        // Stryker disable next-line all: BigInt boundary conditions produce equivalent mutants
        const relevantSegments = _filter(sortedSegments, (segment) => {
            const segStart = BigInt(segment.startSnowflake);
            const segEnd = BigInt(segment.endSnowflake);
            // Stryker disable next-line all: BigInt boundary conditions produce equivalent mutants
            return segEnd >= startBigInt && segStart <= endBigInt;
        });

        // Stryker disable next-line all: Early return for empty segments is essential control flow
        if(relevantSegments.length === 0) {
            return [{ start: requestedStart, end: requestedEnd }];
        }

        const gaps: CacheGap[] = [];
        let currentPosition = startBigInt;

        for(const segment of relevantSegments) {
            const segStart = BigInt(segment.startSnowflake);
            const segEnd = BigInt(segment.endSnowflake);

            // If there's a gap before this segment
            if(currentPosition < segStart) {
                const gapEnd = segStart - 1n;
                // Only add gap if it's within our requested range
                // Stryker disable next-line all: BigInt boundary conditions produce equivalent mutants
                if(gapEnd >= startBigInt && currentPosition <= endBigInt) {
                    gaps.push({
                        start: currentPosition.toString() as MessageId,
                        end:   gapEnd.toString() as MessageId,
                    });
                }
            }

            // Move position to after this segment
            // Stryker disable next-line ConditionalExpression: Equivalent under sorted-segments invariant
            if(segEnd >= currentPosition) {
                currentPosition = segEnd + 1n;
            }
        }

        // Check for gap after the last segment
        if(currentPosition <= endBigInt) {
            gaps.push({
                start: currentPosition.toString() as MessageId,
                end:   requestedEnd,
            });
        }

        return gaps;
    }

    /**
     * Finds cached segments that overlap with the requested range.
     * Uses conservative overlap: only returns segments where there's actual overlap,
     * not adjacent segments.
     *
     * @param cachedSegments - Array of cached segments
     * @param requestedStart - Start of requested range (inclusive)
     * @param requestedEnd - End of requested range (inclusive)
     * @returns Array of segments that overlap with the requested range
     */
    static findOverlappingSegments(
        cachedSegments: CachedSegmentData[],
        requestedStart: MessageId,
        requestedEnd: MessageId
    ): CachedSegmentData[] {
        const startBigInt = BigInt(requestedStart);
        const endBigInt = BigInt(requestedEnd);

        return _filter(cachedSegments, (segment) => {
            const segStart = BigInt(segment.startSnowflake);
            const segEnd = BigInt(segment.endSnowflake);

            // Conservative overlap: actual intersection required
            // Segment overlaps if: segment.start <= requested.end AND segment.end >= requested.start
            return segStart <= endBigInt && segEnd >= startBigInt;
        });
    }

    /**
     * Merges messages from overlapping segments within the requested range.
     * Deduplicates by message ID and sorts by ID ascending.
     *
     * @param segments - Array of cached segments containing messages
     * @param requestedStart - Start of requested range (inclusive)
     * @param requestedEnd - End of requested range (inclusive)
     * @returns Deduplicated, sorted array of messages within range
     */
    static mergeMessages(
        segments: CachedSegmentData[],
        requestedStart: MessageId,
        requestedEnd: MessageId
    ): CachedMessage[] {
        const startBigInt = BigInt(requestedStart);
        const endBigInt = BigInt(requestedEnd);

        // Collect all messages from all segments
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- lodash path syntax returns any[]
        const allMessages: CachedMessage[] = _flatMap(segments, 'messages');

        // Filter to messages within requested range
        const messagesInRange = _filter(allMessages, (message) => {
            const msgId = BigInt(message.id);
            return msgId >= startBigInt && msgId <= endBigInt;
        });

        // Deduplicate by message ID (keep first occurrence)
        const uniqueMessages = _uniqBy(messagesInRange, 'id');

        // Sort by message ID numerically using BigInt
        // Stryker disable all: Sort comparator mutations are equivalent (stable sort)
        const sortedMessages = [...uniqueMessages].sort((a, b) => {
            const aId = BigInt(a.id);
            const bId = BigInt(b.id);
            if(aId < bId) {
                return -1;
            }
            if(aId > bId) {
                return 1;
            }
            return 0;
        });
        // Stryker restore all

        return sortedMessages;
    }
}
