import { describe, test, expect } from 'bun:test';
import { computeRecovery } from '@/agent/session/recovery';
import type { JournalEntry } from '@/agent/session/types';

const AT = new Date(0);

describe('computeRecovery', () => {
    test('empty journal -> all empty/undefined/false', () => {
        const result = computeRecovery([]);

        expect(result).toEqual({
            lostTasks:            [],
            undelivered:          [],
            deliveredEnvelopeIds: [],
            lastSessionId:        undefined,
            lastOpenWasFallback:  false,
        });
    });

    test('a task_started with no later resolution is lost', () => {
        const entries: JournalEntry[] = [
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do the thing' },
        ];

        const result = computeRecovery(entries);

        expect(result.lostTasks).toEqual([{ taskId: 'task-1', description: 'do the thing' }]);
    });

    test('task_started followed by task_completed is not lost', () => {
        const entries: JournalEntry[] = [
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do the thing' },
            { type: 'task_completed', at: AT, taskId: 'task-1' },
        ];

        expect(computeRecovery(entries).lostTasks).toEqual([]);
    });

    test('task_started followed by task_lost is not (again) reported lost', () => {
        const entries: JournalEntry[] = [
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do the thing' },
            { type: 'task_lost', at: AT, taskId: 'task-1' },
        ];

        expect(computeRecovery(entries).lostTasks).toEqual([]);
    });

    test('a discord envelope with turn_completed and no response_delivered is undelivered, carrying the response text', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind: 'discord', responseText: 'hello there' },
        ];

        const result = computeRecovery(entries);

        expect(result.undelivered).toEqual([
            { envelopeId: 'env-1', envelopeKind: 'discord', channelId: undefined, responseText: 'hello there' },
        ]);
    });

    test('an undelivered envelope carries the channelId recorded on its envelope_submitted entry', () => {
        const entries: JournalEntry[] = [
            {
                type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord', channelId: 'chan-1',
            },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind: 'discord', responseText: 'hello there' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([
            { envelopeId: 'env-1', envelopeKind: 'discord', channelId: 'chan-1', responseText: 'hello there' },
        ]);
    });

    test('a catchup envelope with turn_completed and no response_delivered is undelivered', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'catchup' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind: 'catchup', responseText: 'summary' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([
            { envelopeId: 'env-1', envelopeKind: 'catchup', channelId: undefined, responseText: 'summary' },
        ]);
    });

    test('a delivered envelope is not undelivered, and is present in deliveredEnvelopeIds', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind: 'discord', responseText: 'hello there' },
            {
                type: 'response_delivered', at: AT, envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-1'],
            },
        ];

        const result = computeRecovery(entries);

        expect(result.undelivered).toEqual([]);
        expect(result.deliveredEnvelopeIds).toEqual(['env-1']);
    });

    test('response_delivered ids are deduped', () => {
        const entries: JournalEntry[] = [
            {
                type: 'response_delivered', at: AT, envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-1'],
            },
            {
                type: 'response_delivered', at: AT, envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-2'],
            },
        ];

        expect(computeRecovery(entries).deliveredEnvelopeIds).toEqual(['env-1']);
    });

    test('an envelope with no turn_completed is not undelivered — the turn never finished', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([]);
    });

    test.each(['notification', 'perch', 'boot'] as const)('a %s envelope with turn_completed is never undelivered', (kind) => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind, responseText: 'text' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([]);
    });

    test('lastSessionId and lastOpenWasFallback come from the latest session_opened entry', () => {
        const entries: JournalEntry[] = [
            {
                type: 'session_opened', at: AT, role: 'conversation', sessionId: 'session-old', resumed: false,
            },
            {
                type: 'session_opened', at: AT, role: 'conversation', sessionId: 'session-new', resumed: false, fallback: true,
            },
        ];

        const result = computeRecovery(entries);

        expect(result.lastSessionId).toBe('session-new');
        expect(result.lastOpenWasFallback).toBe(true);
    });

    test('lastOpenWasFallback defaults to false when the latest session_opened has no fallback field', () => {
        const entries: JournalEntry[] = [
            {
                type: 'session_opened', at: AT, role: 'conversation', sessionId: 'session-1', resumed: true,
            },
        ];

        expect(computeRecovery(entries).lastOpenWasFallback).toBe(false);
    });
});
