import { describe, test, expect } from 'bun:test';
import { map as _map } from 'lodash';
import { SegmentManager } from '@/storage/message-cache/segment-manager';
import type { MessageId, CachedSegmentData } from '@/storage/message-cache/types';
import type { ChannelId } from '@/integrations/discord/types';

describe.concurrent('SegmentManager', () => {
    const channelId = '123456789' as ChannelId;

    const createSegment = (
        start: string,
        end: string,
        messages: { id: string, content: string, authorId: string, timestamp: string }[] = []
    ): CachedSegmentData => ({
        channelId,
        startSnowflake: start as MessageId,
        endSnowflake:   end as MessageId,
        messages:       _map(messages, m => ({
            id:        m.id as MessageId,
            content:   m.content,
            authorId:  m.authorId,
            timestamp: m.timestamp,
        })),
        fetchedAt: '2024-01-15T10:30:00.000Z',
    });

    describe('findGaps', () => {
        test('should return full range as gap when no cached segments exist', () => {
            const gaps = SegmentManager.findGaps(
                [],
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(1);
            expect(gaps[0].start).toBe('100' as MessageId);
            expect(gaps[0].end).toBe('200' as MessageId);
        });

        test('should return empty array when range is fully covered by single segment', () => {
            const segments = [createSegment('50', '250')];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(0);
        });

        test.each([
            {
                name:     'gap before cached segment',
                segments: [createSegment('150', '250')],
                expected: [{ start: '100' as MessageId, end: '149' as MessageId }],
            },
            {
                name:     'gap after cached segment',
                segments: [createSegment('50', '120')],
                expected: [{ start: '121' as MessageId, end: '200' as MessageId }],
            },
        ])('should find $name', ({ segments, expected }) => {
            const gaps = SegmentManager.findGaps(
                [...segments],
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(expected.length);
            expect(gaps[0].start).toBe(expected[0].start);
            expect(gaps[0].end).toBe(expected[0].end);
        });

        test('should find gaps before and after cached segment', () => {
            const segments = [createSegment('130', '170')];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(2);
            expect(gaps[0].start).toBe('100' as MessageId);
            expect(gaps[0].end).toBe('129' as MessageId);
            expect(gaps[1].start).toBe('171' as MessageId);
            expect(gaps[1].end).toBe('200' as MessageId);
        });

        test('should find gap between two cached segments', () => {
            const segments = [
                createSegment('100', '120'),
                createSegment('150', '200'),
            ];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(1);
            expect(gaps[0].start).toBe('121' as MessageId);
            expect(gaps[0].end).toBe('149' as MessageId);
        });

        test('should handle adjacent segments with no gap', () => {
            const segments = [
                createSegment('100', '149'),
                createSegment('150', '200'),
            ];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(0);
        });

        test('should handle overlapping segments', () => {
            const segments = [
                createSegment('100', '160'),
                createSegment('140', '200'),
            ];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(0);
        });

        test('should handle segments outside requested range', () => {
            const segments = [
                createSegment('10', '50'),
                createSegment('250', '300'),
            ];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(1);
            expect(gaps[0].start).toBe('100' as MessageId);
            expect(gaps[0].end).toBe('200' as MessageId);
        });

        test('should use BigInt arithmetic for large snowflake IDs', () => {
            const segments = [createSegment('1234567890123456790', '1234567890123456900')];

            const gaps = SegmentManager.findGaps(
                segments,
                '1234567890123456700' as MessageId,
                '1234567890123457000' as MessageId
            );

            expect(gaps).toHaveLength(2);
            expect(gaps[0].start).toBe('1234567890123456700' as MessageId);
            expect(gaps[0].end).toBe('1234567890123456789' as MessageId);
            expect(gaps[1].start).toBe('1234567890123456901' as MessageId);
            expect(gaps[1].end).toBe('1234567890123457000' as MessageId);
        });

        test('should handle unsorted segments', () => {
            const segments = [
                createSegment('150', '200'),
                createSegment('100', '120'),
            ];

            const gaps = SegmentManager.findGaps(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(1);
            expect(gaps[0].start).toBe('121' as MessageId);
            expect(gaps[0].end).toBe('149' as MessageId);
        });

        test.each([
            {
                name:     'equal start times (sort stability)',
                segments: [createSegment('100', '150'), createSegment('100', '200')],
                start:    '50' as MessageId,
                end:      '250' as MessageId,
                expected: 2,
            },
            {
                name:     'gap ending at boundary',
                segments: [createSegment('200', '300')],
                start:    '199' as MessageId,
                end:      '300' as MessageId,
                expected: 1,
            },
            {
                name:     'current position equals end boundary',
                segments: [createSegment('100', '199')],
                start:    '100' as MessageId,
                end:      '200' as MessageId,
                expected: 1,
            },
        ])('should handle $name', ({ segments, start, end, expected }) => {
            const gaps = SegmentManager.findGaps([...segments], start, end);
            expect(gaps).toHaveLength(expected);
        });
    });

    describe('findOverlappingSegments', () => {
        test('should return empty array when no segments overlap', () => {
            const segments = [
                createSegment('10', '50'),
                createSegment('250', '300'),
            ];

            const overlapping = SegmentManager.findOverlappingSegments(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(overlapping).toHaveLength(0);
        });

        test('should find segment that fully contains requested range', () => {
            const segments = [createSegment('50', '250')];

            const overlapping = SegmentManager.findOverlappingSegments(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(overlapping).toHaveLength(1);
            expect(overlapping[0].startSnowflake).toBe('50' as MessageId);
        });

        test.each([
            { name: 'at start', segStart: '50', segEnd: '150', expectedStart: '50' as MessageId },
            { name: 'at end', segStart: '150', segEnd: '250', expectedStart: '150' as MessageId },
            { name: 'fully contained', segStart: '130', segEnd: '170', expectedStart: '130' as MessageId },
        ])('should find segment that overlaps $name', ({ segStart, segEnd, expectedStart }) => {
            const segments = [createSegment(segStart, segEnd)];

            const overlapping = SegmentManager.findOverlappingSegments(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(overlapping).toHaveLength(1);
            expect(overlapping[0].startSnowflake).toBe(expectedStart);
        });

        test('should find multiple overlapping segments', () => {
            const segments = [
                createSegment('50', '120'),
                createSegment('180', '250'),
            ];

            const overlapping = SegmentManager.findOverlappingSegments(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(overlapping).toHaveLength(2);
        });

        test.each([
            {
                name:     'NOT include adjacent segments',
                segments: [createSegment('50', '99'), createSegment('201', '250')],
                expected: 0,
            },
            {
                name:     'include segment touching boundary',
                segments: [createSegment('50', '100'), createSegment('200', '250')],
                expected: 2,
            },
            {
                name:     'include when segEnd equals startBigInt',
                segments: [createSegment('50', '100')],
                expected: 1,
            },
            {
                name:     'include when segStart equals endBigInt',
                segments: [createSegment('200', '250')],
                expected: 1,
            },
        ])('should $name', ({ segments, expected }) => {
            const overlapping = SegmentManager.findOverlappingSegments(
                [...segments],
                '100' as MessageId,
                '200' as MessageId
            );
            expect(overlapping).toHaveLength(expected);
        });
    });

    describe('mergeMessages', () => {
        test('should return empty array for empty segments', () => {
            const messages = SegmentManager.mergeMessages(
                [],
                '100' as MessageId,
                '200' as MessageId
            );

            expect(messages).toHaveLength(0);
        });

        test('should filter messages within requested range', () => {
            const segments = [createSegment('50', '250', [
                { id: '80', content: 'Before', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '120', content: 'Within 1', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                { id: '180', content: 'Within 2', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
                { id: '220', content: 'After', authorId: 'a', timestamp: '2024-01-15T10:30:00.000Z' },
            ])];

            const messages = SegmentManager.mergeMessages(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(messages).toHaveLength(2);
            expect(messages[0].id).toBe('120' as MessageId);
            expect(messages[1].id).toBe('180' as MessageId);
        });

        test('should include messages at range boundaries', () => {
            const segments = [createSegment('100', '200', [
                { id: '100', content: 'At start', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '150', content: 'Middle', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                { id: '200', content: 'At end', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
            ])];

            const messages = SegmentManager.mergeMessages(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(messages).toHaveLength(3);
        });

        test('should deduplicate messages by ID', () => {
            const segments = [
                createSegment('100', '150', [
                    { id: '120', content: 'First copy', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                    { id: '140', content: 'Unique 1', authorId: 'a', timestamp: '2024-01-15T10:05:00.000Z' },
                ]),
                createSegment('140', '200', [
                    { id: '140', content: 'Unique 1 again', authorId: 'a', timestamp: '2024-01-15T10:05:00.000Z' },
                    { id: '160', content: 'Unique 2', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                ]),
            ];

            const messages = SegmentManager.mergeMessages(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(messages).toHaveLength(3);
            const ids = _map(messages, 'id');
            expect(ids).toContain('120' as MessageId);
            expect(ids).toContain('140' as MessageId);
            expect(ids).toContain('160' as MessageId);
        });

        test('should sort messages by ID ascending (including large snowflake IDs)', () => {
            const segments = [createSegment('100', '200', [
                { id: '180', content: 'Third', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
                { id: '120', content: 'First', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '150', content: 'Second', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
            ])];

            const messages = SegmentManager.mergeMessages(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(messages).toHaveLength(3);
            expect(messages[0].id).toBe('120' as MessageId);
            expect(messages[1].id).toBe('150' as MessageId);
            expect(messages[2].id).toBe('180' as MessageId);
        });

        test('should deduplicate and maintain stable sort for identical IDs', () => {
            const segments = [createSegment('100', '200', [
                { id: '150', content: 'Message A', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '160', content: 'Message B', authorId: 'a', timestamp: '2024-01-15T10:05:00.000Z' },
                { id: '150', content: 'Duplicate of A', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
            ])];

            const messages = SegmentManager.mergeMessages(
                segments,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(messages).toHaveLength(2);
            expect(messages[0].id).toBe('150' as MessageId);
            expect(messages[1].id).toBe('160' as MessageId);
        });
    });

    describe('sort and merge edge cases', () => {
        test('should handle unsorted segments and overlapping boundaries', () => {
            const segments = [
                createSegment('200', '300'),
                createSegment('100', '149'),
                createSegment('149', '200'),
            ];

            const gaps = SegmentManager.findGaps(
                segments,
                '50' as MessageId,
                '400' as MessageId
            );

            expect(gaps).toHaveLength(2);
            expect(gaps[0].start).toBe('50' as MessageId);
            expect(gaps[0].end).toBe('99' as MessageId);
            expect(gaps[1].start).toBe('301' as MessageId);
        });
    });
});
