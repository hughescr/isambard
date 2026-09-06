/**
 * Tests for the P10 boot sequence: everything the conductor's own `open()` (recovery, task_lost,
 * boot-envelope injection via the SessionStart hook) does NOT already cover — delivering
 * undelivered responses once, replaying received-but-unhandled messages, opening the ingress
 * gate, and submitting the catch-up envelope.
 *
 * @module tests/unit/agent/session/boot-sequence
 */
import { describe, it, expect, mock } from 'bun:test';
import { FakeJournal } from '../../../helpers/fake-journal';
import { runBootSequence } from '@/agent/session/boot-sequence';
import type { UndeliveredEnvelope } from '@/agent/session/recovery';

function undeliveredEnvelope(overrides: Partial<UndeliveredEnvelope> = {}): UndeliveredEnvelope {
    return { envelopeId: 'env-1', envelopeKind: 'discord', ...overrides };
}

interface ReplayedItem {
    id: string
}

describe('runBootSequence', () => {
    it('delivers every undelivered envelope exactly once', async () => {
        const journal = new FakeJournal();
        const delivered: string[] = [];
        const deliver = mock(async (item: UndeliveredEnvelope) => {
            delivered.push(item.envelopeId);
        });

        await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [undeliveredEnvelope({ envelopeId: 'env-1' }), undeliveredEnvelope({ envelopeId: 'env-2' })] },
            deliver,
            replayUnhandled: async () => [],
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: () => undefined },
            journal,
        });

        expect(deliver).toHaveBeenCalledTimes(2);
        expect(delivered).toEqual(['env-1', 'env-2']);
    });

    it('calling deliver a second time for an id the caller\'s guard already delivered does not send again (guard is the caller\'s responsibility)', async () => {
        const journal = new FakeJournal();
        const sent = new Set<string>();
        const deliver = mock(async (item: UndeliveredEnvelope) => {
            if(sent.has(item.envelopeId)) {
                return;
            }
            sent.add(item.envelopeId);
        });

        // Deliberately duplicated envelopeId, as if two crash-recovery windows both saw it —
        // the exactly-once guarantee is the injected `deliver`'s guard (Conductor.deliver), not
        // this module's own dedupe; this test proves runBootSequence calls it once per list entry
        // and trusts the guard rather than re-implementing dedupe here.
        await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [undeliveredEnvelope({ envelopeId: 'env-1' }), undeliveredEnvelope({ envelopeId: 'env-1' })] },
            deliver,
            replayUnhandled: async () => [],
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: () => undefined },
            journal,
        });

        expect(deliver).toHaveBeenCalledTimes(2);
        expect(sent.size).toBe(1);
    });

    it('orders deliver -> replay submit -> journal flush -> gate open -> catch-up submit', async () => {
        const journal = new FakeJournal();
        const callLog: string[] = [];
        const replayed: ReplayedItem[] = [{ id: 'msg-1' }, { id: 'msg-2' }];

        journal.flush = mock(async () => {
            callLog.push('journal:flush');
        });

        await runBootSequence<ReplayedItem>({
            recovery: { undelivered: [undeliveredEnvelope()] },
            deliver:  async () => {
                callLog.push('deliver');
            },
            replayUnhandled: async () => replayed,
            submitReplay:    async () => {
                callLog.push('replay:submit');
            },
            submitCatchUp: async () => {
                callLog.push('catchup:submit');
            },
            unreadCount: () => 1,
            ingressGate: {
                open: () => {
                    callLog.push('gate:open');
                },
            },
            journal,
        });

        expect(callLog).toEqual(['deliver', 'replay:submit', 'journal:flush', 'gate:open', 'catchup:submit']);
    });

    it('submits one replay envelope carrying every replayed message when non-empty', async () => {
        const journal = new FakeJournal();
        const replayed: ReplayedItem[] = [{ id: 'msg-1' }, { id: 'msg-2' }];
        const submitReplay = mock(async () => undefined);

        const result = await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => replayed,
            submitReplay,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: () => undefined },
            journal,
        });

        expect(submitReplay).toHaveBeenCalledTimes(1);
        expect(submitReplay).toHaveBeenCalledWith(replayed);
        expect(result.replayedCount).toBe(2);
    });

    it('opens the ingress gate with the replayed ids even when nothing was replayed', async () => {
        const journal = new FakeJournal();
        const submitReplay = mock(async () => undefined);
        const openSpy = mock((_ids: ReadonlySet<string>) => undefined);

        const result = await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => [],
            submitReplay,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: openSpy },
            journal,
        });

        expect(submitReplay).not.toHaveBeenCalled();
        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(openSpy).toHaveBeenCalledWith(new Set());
        expect(result.replayedCount).toBe(0);
    });

    it('opens the gate with exactly the replayed message ids', async () => {
        const journal = new FakeJournal();
        const replayed: ReplayedItem[] = [{ id: 'msg-1' }, { id: 'msg-2' }];
        const openSpy = mock((_ids: ReadonlySet<string>) => undefined);

        await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => replayed,
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: openSpy },
            journal,
        });

        expect(openSpy).toHaveBeenCalledWith(new Set(['msg-1', 'msg-2']));
    });

    it('submits the catch-up envelope and reports catchUpSubmitted when unreadCount() > 0', async () => {
        const journal = new FakeJournal();
        const submitCatchUp = mock(async () => undefined);

        const result = await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => [],
            submitReplay:    async () => undefined,
            submitCatchUp,
            unreadCount:     () => 3,
            ingressGate:     { open: () => undefined },
            journal,
        });

        expect(submitCatchUp).toHaveBeenCalledTimes(1);
        expect(result.catchUpSubmitted).toBe(true);
    });

    it('skips the catch-up envelope when unreadCount() is zero', async () => {
        const journal = new FakeJournal();
        const submitCatchUp = mock(async () => undefined);

        const result = await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => [],
            submitReplay:    async () => undefined,
            submitCatchUp,
            unreadCount:     () => 0,
            ingressGate:     { open: () => undefined },
            journal,
        });

        expect(submitCatchUp).not.toHaveBeenCalled();
        expect(result.catchUpSubmitted).toBe(false);
    });

    // ---------------------------------------------------------------------------
    // P10 fix: any rejection before the gate would open must not leave it stuck in
    // 'buffering' forever — the gate always opens (in a `finally`), and the error still
    // propagates to the caller (`runConductorInboxInit`'s own try/catch logs it).
    // ---------------------------------------------------------------------------

    it('opens the ingress gate with an empty set (not stuck buffering) when deliver() rejects, and still rethrows', async () => {
        const journal = new FakeJournal();
        const openSpy = mock((_ids: ReadonlySet<string>) => undefined);
        const boom = new Error('deliver boom');

        await expect(runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [undeliveredEnvelope()] },
            deliver:         async () => { throw boom; },
            replayUnhandled: async () => [],
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: openSpy },
            journal,
        })).rejects.toThrow(boom);

        expect(openSpy).toHaveBeenCalledWith(new Set());
    });

    it('opens the ingress gate with an empty set when replayUnhandled() rejects, and still rethrows', async () => {
        const journal = new FakeJournal();
        const openSpy = mock((_ids: ReadonlySet<string>) => undefined);
        const boom = new Error('replayUnhandled boom');

        await expect(runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => { throw boom; },
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: openSpy },
            journal,
        })).rejects.toThrow(boom);

        expect(openSpy).toHaveBeenCalledWith(new Set());
    });

    it('opens the ingress gate with an empty set (not the replayed ids) when submitReplay() rejects, since those messages were never actually resubmitted', async () => {
        const journal = new FakeJournal();
        const openSpy = mock((_ids: ReadonlySet<string>) => undefined);
        const boom = new Error('submitReplay boom');
        const replayed: ReplayedItem[] = [{ id: 'msg-1' }];

        await expect(runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => replayed,
            submitReplay:    async () => { throw boom; },
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: openSpy },
            journal,
        })).rejects.toThrow(boom);

        expect(openSpy).toHaveBeenCalledWith(new Set());
    });

    it('opens the ingress gate with the replayed ids when journal.flush() rejects after a successful replay submission, and still rethrows', async () => {
        const journal = new FakeJournal();
        journal.flush = mock(async () => {
            throw new Error('flush boom');
        });
        const openSpy = mock((_ids: ReadonlySet<string>) => undefined);
        const replayed: ReplayedItem[] = [{ id: 'msg-1' }];

        await expect(runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => replayed,
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: openSpy },
            journal,
        })).rejects.toThrow('flush boom');

        expect(openSpy).toHaveBeenCalledWith(new Set(['msg-1']));
    });

    it('does not submit the catch-up envelope when an earlier step rejected', async () => {
        const journal = new FakeJournal();
        const submitCatchUp = mock(async () => undefined);

        await expect(runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => { throw new Error('boom'); },
            submitReplay:    async () => undefined,
            submitCatchUp,
            unreadCount:     () => 5,
            ingressGate:     { open: () => undefined },
            journal,
        })).rejects.toThrow('boom');

        expect(submitCatchUp).not.toHaveBeenCalled();
    });

    it('flushes the journal exactly once per boot sequence', async () => {
        const journal = new FakeJournal();

        await runBootSequence<ReplayedItem>({
            recovery:        { undelivered: [] },
            deliver:         async () => undefined,
            replayUnhandled: async () => [],
            submitReplay:    async () => undefined,
            submitCatchUp:   async () => undefined,
            unreadCount:     () => 0,
            ingressGate:     { open: () => undefined },
            journal,
        });

        expect(journal.flushCount).toBe(1);
    });
});
