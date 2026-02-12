import { describe, expect, it, beforeEach } from 'bun:test';
import { padStart as _padStart, repeat as _repeat, every as _every } from 'lodash';
import type { MemoryToolItemData } from '../../../src/storage/memory-tool/types';
import { createMemoryPath } from '../../../src/storage/memory-tool/types';
import { mockGenerateText } from '../../setup';
import { summarizeEventBatches } from '../../../src/agent/event-summarizer';

describe('event-summarizer', () => {
    const now = new Date('2025-01-15T12:00:00Z');

    beforeEach(() => {
        mockGenerateText.mockClear();
        mockGenerateText.mockResolvedValue('Mock summary');
    });

    const createMockEvent = (path: string, updatedAt: string, content: string): MemoryToolItemData => ({
        path:        createMemoryPath(path),
        contentType: 'text/plain',
        content,
        tags:        new Set<string>(),
        updatedAt,
        metadata:    {},
        createdAt:   updatedAt,
    });

    describe.concurrent('empty and edge cases', () => {
        it('returns empty array for empty events', async () => {
            const result = await summarizeEventBatches([], 5, now);
            expect(result).toEqual([]);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        it('handles single event', async () => {
            const events = [
                createMockEvent('/events/e1', '2025-01-15T11:00:00Z', 'Single event content'),
            ];

            const result = await summarizeEventBatches(events, 5, now);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                startTime: '2025-01-15T11:00:00Z',
                endTime:   '2025-01-15T11:00:00Z',
                count:     1,
                summary:   'Mock summary',
            });
            expect(mockGenerateText).toHaveBeenCalledTimes(1);
        });

        it('handles generateText returning empty string', async () => {
            mockGenerateText.mockResolvedValue('');
            const events = [
                createMockEvent('/events/e1', '2025-01-15T11:00:00Z', 'Event content'),
            ];

            const result = await summarizeEventBatches(events, 5, now);

            expect(result).toHaveLength(1);
            expect(result[0].summary).toBe('');
        });
    });

    describe.concurrent('batching logic', () => {
        it('creates correct number of batches for evenly divisible events', async () => {
            const events = Array.from({ length: 10 }, (_, i) =>
                createMockEvent(`/events/e${i}`, `2025-01-15T${_padStart(`${11 + i}`, 2, '0')}:00:00Z`, `Event ${i}`)
            );

            const result = await summarizeEventBatches(events, 5, now);

            expect(result).toHaveLength(2);
            expect(mockGenerateText).toHaveBeenCalledTimes(2);
        });

        it('handles events not evenly divisible by batchSize', async () => {
            const events = Array.from({ length: 7 }, (_, i) =>
                createMockEvent(`/events/e${i}`, `2025-01-15T${_padStart(`${11 + i}`, 2, '0')}:00:00Z`, `Event ${i}`)
            );

            const result = await summarizeEventBatches(events, 3, now);

            expect(result).toHaveLength(3);
            expect(result[0].count).toBe(3);
            expect(result[1].count).toBe(3);
            expect(result[2].count).toBe(1);
            expect(mockGenerateText).toHaveBeenCalledTimes(3);
        });
    });

    describe.concurrent('batch properties', () => {
        it('each batch has correct startTime/endTime from sorted items', async () => {
            const events = [
                createMockEvent('/events/e1', '2025-01-15T11:30:00Z', 'Event 1'),
                createMockEvent('/events/e2', '2025-01-15T11:00:00Z', 'Event 2'),
                createMockEvent('/events/e3', '2025-01-15T11:45:00Z', 'Event 3'),
                createMockEvent('/events/e4', '2025-01-15T11:15:00Z', 'Event 4'),
                createMockEvent('/events/e5', '2025-01-15T12:00:00Z', 'Event 5'),
            ];

            const result = await summarizeEventBatches(events, 3, now);

            expect(result).toHaveLength(2);
            // First batch should have earliest 3 events (sorted)
            expect(result[0].startTime).toBe('2025-01-15T11:00:00Z');
            expect(result[0].endTime).toBe('2025-01-15T11:30:00Z');
            expect(result[0].count).toBe(3);
            // Second batch should have remaining 2 events (sorted)
            expect(result[1].startTime).toBe('2025-01-15T11:45:00Z');
            expect(result[1].endTime).toBe('2025-01-15T12:00:00Z');
            expect(result[1].count).toBe(2);
        });

        it('each batch has correct count', async () => {
            const events = Array.from({ length: 8 }, (_, i) =>
                createMockEvent(`/events/e${i}`, `2025-01-15T${_padStart(`${11 + i}`, 2, '0')}:00:00Z`, `Event ${i}`)
            );

            const result = await summarizeEventBatches(events, 3, now);

            expect(result).toHaveLength(3);
            expect(result[0].count).toBe(3);
            expect(result[1].count).toBe(3);
            expect(result[2].count).toBe(2);
        });
    });

    describe.concurrent('generateText integration', () => {
        it('calls generateText for each batch', async () => {
            const events = Array.from({ length: 6 }, (_, i) =>
                createMockEvent(`/events/e${i}`, `2025-01-15T${_padStart(`${11 + i}`, 2, '0')}:00:00Z`, `Event ${i}`)
            );

            await summarizeEventBatches(events, 3, now);

            expect(mockGenerateText).toHaveBeenCalledTimes(2);
        });

        it('passes formatted events in prompt to generateText', async () => {
            const events = [
                createMockEvent('/events/meeting', '2025-01-15T11:00:00Z', 'Discussed project roadmap and priorities for Q1'),
                createMockEvent('/events/decision', '2025-01-15T11:30:00Z', 'Decided to use TypeScript for the new service'),
            ];

            await summarizeEventBatches(events, 5, now);

            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const call = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(call).toBeDefined();
            expect(call).toContain('Summarize these events');
            expect(call).toContain('Events:');
            expect(call).toContain('/events/meeting');
            expect(call).toContain('1h ago');
            expect(call).toContain('Discussed project roadmap and priorities for Q1');
            expect(call).toContain('/events/decision');
            expect(call).toContain('30m ago');
            expect(call).toContain('Decided to use TypeScript for the new service');
        });

        it('truncates long content to 200 chars in prompt', async () => {
            const longContent = _repeat('A', 300);
            const events = [
                createMockEvent('/events/long', '2025-01-15T11:00:00Z', longContent),
            ];

            await summarizeEventBatches(events, 5, now);

            const call = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(call).toBeDefined();
            const contentInPrompt = call?.match(/1h ago\): (.+)/)?.[1];
            expect(contentInPrompt).toBeDefined();
            expect(contentInPrompt!.length).toBeLessThanOrEqual(200);
        });
    });

    describe('concurrency', () => {
        it('uses p-limit for concurrency control', async () => {
            // Create enough batches to test concurrency
            const events = Array.from({ length: 20 }, (_, i) =>
                createMockEvent(`/events/e${i}`, `2025-01-15T${_padStart(`${11 + Math.floor(i / 60)}`, 2, '0')}:${_padStart(`${i % 60}`, 2, '0')}:00Z`, `Event ${i}`)
            );

            mockGenerateText.mockImplementation(async () => {
                // Small delay to ensure batches are processed
                await new Promise(resolve => setTimeout(resolve, 10));
                return 'Mock summary';
            });

            const result = await summarizeEventBatches(events, 3, now);

            // Should create 7 batches (20 events / 3 = 6 full + 1 partial)
            expect(result).toHaveLength(7);
            expect(mockGenerateText).toHaveBeenCalledTimes(7);
            // All batches should have summaries
            expect(_every(result, { summary: 'Mock summary' })).toBe(true);
        });
    });

    describe('error handling', () => {
        it('propagates errors from generateText', async () => {
            const error = new Error('LLM service unavailable');
            mockGenerateText.mockRejectedValue(error);

            const events = [
                createMockEvent('/events/e1', '2025-01-15T11:00:00Z', 'Event content'),
            ];

            // eslint-disable-next-line @typescript-eslint/await-thenable -- bun test expect.rejects returns a thenable
            await expect(summarizeEventBatches(events, 5, now)).rejects.toThrow('LLM service unavailable');
        });
    });
});
