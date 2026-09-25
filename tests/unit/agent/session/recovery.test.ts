import { describe, test, expect } from 'bun:test';
import { computeRecovery, lastKnownAt, taskLaunchEntries } from '@/agent/session/recovery';
import type { JournalEntry } from '@/agent/session/types';

const AT = new Date(0);

describe('computeRecovery', () => {
    test('empty journal -> all empty/undefined', () => {
        const result = computeRecovery([]);

        expect(result).toEqual({
            lostTasks:            [],
            undelivered:          [],
            deliveredEnvelopeIds: [],
            lastSessionId:        undefined,
        });
    });

    test('a task_started with no later resolution is lost', () => {
        const entries: JournalEntry[] = [
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do the thing' },
        ];

        const result = computeRecovery(entries);

        expect(result.lostTasks).toEqual([{ taskId: 'task-1', description: 'do the thing' }]);
    });

    test.each(['completed', 'failed', 'stopped'] as const)('task_started followed by task_finished (%s) is not lost', (outcome) => {
        const entries: JournalEntry[] = [
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do the thing' },
            { type: 'task_finished', at: AT, taskId: 'task-1', outcome },
        ];

        expect(computeRecovery(entries).lostTasks).toEqual([]);
    });

    test('a task_launched row for a started task does not resolve it', () => {
        const entries: JournalEntry[] = [
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do the thing' },
            { type: 'task_launched', at: AT, taskId: 'task-1', toolUseId: 'tu-1', toolName: 'Agent', envelopeId: 'env-1', kind: 'discord' },
        ];

        expect(computeRecovery(entries).lostTasks).toEqual([{ taskId: 'task-1', description: 'do the thing' }]);
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

    test('a task envelope (R2 adopted wake turn) with turn_completed and no response_delivered is undelivered', () => {
        const entries: JournalEntry[] = [
            {
                type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'task', channelId: 'chan-1',
            },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind: 'task', responseText: 'background work is done' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([
            { envelopeId: 'env-1', envelopeKind: 'task', channelId: 'chan-1', responseText: 'background work is done' },
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

    test('a pre-change response_delivered row without disposition seeds the delivery guard', () => {
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

    test.each(['discord', 'catchup', 'task'] as const)('a %s envelope whose turn_completed carries no responseText is not undelivered (#130)', (kind) => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind, channelId: 'chan-1' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([]);
    });

    test('only the envelope whose turn produced a reply is undelivered when a reply-less one sits beside it', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-silent', kind: 'discord', channelId: 'chan-1' },
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-reply', kind: 'discord', channelId: 'chan-2' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-silent', kind: 'discord' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-reply', kind: 'discord', responseText: 'hello' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([
            { envelopeId: 'env-reply', envelopeKind: 'discord', channelId: 'chan-2', responseText: 'hello' },
        ]);
    });

    test('an empty-string responseText still counts as a reply and is listed undelivered', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord' },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind: 'discord', responseText: '' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([
            { envelopeId: 'env-1', envelopeKind: 'discord', channelId: undefined, responseText: '' },
        ]);
    });

    test.each(['notification', 'perch', 'boot'] as const)('a %s envelope with turn_completed is never undelivered', (kind) => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind },
            { type: 'turn_completed', at: AT, envelopeId: 'env-1', kind, responseText: 'text' },
        ];

        expect(computeRecovery(entries).undelivered).toEqual([]);
    });

    test('lastSessionId comes from the latest session_opened entry', () => {
        const entries: JournalEntry[] = [
            {
                type: 'session_opened', at: AT, role: 'conversation', sessionId: 'session-old', outcome: 'fresh', cause: 'boot',
            },
            {
                type: 'session_opened', at: AT, role: 'conversation', sessionId: 'session-new', outcome: 'resume_fallback', cause: 'crash_reopen',
            },
        ];

        const result = computeRecovery(entries);

        expect(result.lastSessionId).toBe('session-new');
    });
});

describe('lastKnownAt', () => {
    test('undefined over an empty journal', () => {
        expect(lastKnownAt([])).toBeUndefined();
    });

    test('undefined when the journal has neither turn_completed nor turn_failed entries', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord' },
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do a thing' },
        ];

        expect(lastKnownAt(entries)).toBeUndefined();
    });

    test('the at of a single turn_completed entry', () => {
        const at = new Date(1000);
        const entries: JournalEntry[] = [
            { type: 'turn_completed', at, envelopeId: 'env-1', kind: 'discord', responseText: 'hi' },
        ];

        expect(lastKnownAt(entries)).toEqual(at);
    });

    test('the max at across turn_completed and turn_failed entries, regardless of journal order', () => {
        const earlier = new Date(1000);
        const middle = new Date(2000);
        const latest = new Date(3000);
        const entries: JournalEntry[] = [
            { type: 'turn_completed', at: middle, envelopeId: 'env-2', kind: 'discord', responseText: 'mid' },
            { type: 'turn_failed', at: latest, envelopeId: 'env-3', kind: 'discord', error: 'boom' },
            { type: 'turn_completed', at: earlier, envelopeId: 'env-1', kind: 'discord', responseText: 'early' },
        ];

        expect(lastKnownAt(entries)).toEqual(latest);
    });

    test('envelope_submitted and session_opened entries do not count toward the max, even when later than every turn entry', () => {
        const turnAt = new Date(1000);
        const laterSubmission = new Date(5000);
        const entries: JournalEntry[] = [
            { type: 'turn_completed', at: turnAt, envelopeId: 'env-1', kind: 'discord', responseText: 'hi' },
            { type: 'envelope_submitted', at: laterSubmission, envelopeId: 'env-2', kind: 'discord' },
            {
                type: 'session_opened', at: laterSubmission, role: 'conversation', sessionId: 'session-1', outcome: 'fresh', cause: 'boot',
            },
        ];

        expect(lastKnownAt(entries)).toEqual(turnAt);
    });

    test('a tie on the exact same at keeps the first qualifying entry, not the last', () => {
        const firstAt = new Date(1000);
        const secondAt = new Date(1000);
        const entries: JournalEntry[] = [
            { type: 'turn_completed', at: firstAt, envelopeId: 'env-1', kind: 'discord', responseText: 'first' },
            { type: 'turn_failed', at: secondAt, envelopeId: 'env-2', kind: 'discord', error: 'boom' },
        ];

        expect(lastKnownAt(entries)).toBe(firstAt);
    });

    test('an at exactly 1ms later than the current latest still replaces it', () => {
        const earlier = new Date(1000);
        const oneMsLater = new Date(1001);
        const entries: JournalEntry[] = [
            { type: 'turn_completed', at: earlier, envelopeId: 'env-1', kind: 'discord', responseText: 'first' },
            { type: 'turn_failed', at: oneMsLater, envelopeId: 'env-2', kind: 'discord', error: 'boom' },
        ];

        expect(lastKnownAt(entries)).toBe(oneMsLater);
    });
});

describe('taskLaunchEntries', () => {
    test('empty over an empty journal', () => {
        expect(taskLaunchEntries([])).toEqual([]);
    });

    test('filters out every non-task_launched entry', () => {
        const entries: JournalEntry[] = [
            { type: 'envelope_submitted', at: AT, envelopeId: 'env-1', kind: 'discord' },
            { type: 'task_started', at: AT, taskId: 'task-1', description: 'do a thing' },
        ];

        expect(taskLaunchEntries(entries)).toEqual([]);
    });

    test('returns task_launched entries in their original order, with optional fields intact', () => {
        const first: JournalEntry = {
            type: 'task_launched', at: AT, taskId: 'task-1', toolUseId: 'tool-1', toolName: 'Agent', envelopeId: 'env-1', kind: 'discord', channelId: 'chan-1', authorId: 'user-1',
        };
        const second: JournalEntry = {
            type: 'task_launched', at: AT, taskId: 'task-2', toolUseId: 'tool-2', toolName: 'Workflow', envelopeId: 'env-2', kind: 'discord',
        };
        const entries: JournalEntry[] = [
            first,
            {
                type: 'session_opened', at: AT, role: 'conversation', sessionId: 'sess-1', outcome: 'fresh', cause: 'boot',
            },
            second,
        ];

        expect(taskLaunchEntries(entries)).toEqual([first, second]);
    });
});
