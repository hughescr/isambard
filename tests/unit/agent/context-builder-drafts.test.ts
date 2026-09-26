import { describe, expect, mock, test } from 'bun:test';
import { buildAdminRejectedSubsection, formatMemoryPreview } from '@/agent/context-builder';
import { createMemoryPath } from '@/storage/memory-tool/types';

function makeWildDuck(getMessage: (mailbox: string, uid: number) => Promise<{ id: number, subject?: string, to?: { address: string }[], metaData?: Record<string, unknown> } | null>) {
    return {
        getMessage,
        getMailboxCounts: async () => ({ total: 0, unseen: 0 }),
        listMessages:     async () => [],
        searchByKeyword:  async () => [],
    };
}

describe('draft context subsections', () => {
    test('formats memory previews at the exact 100-character boundary', () => {
        const path = createMemoryPath('/events/preview');
        const now = new Date('2026-09-12T01:00:00Z');
        const updatedAt = '2026-09-12T00:00:00Z';
        const exactly100 = 'a'.repeat(100);
        expect(formatMemoryPreview(path, exactly100, undefined, updatedAt, now).endsWith(`: ${exactly100}`)).toBe(true);
        expect(formatMemoryPreview(path, `${exactly100}b`, undefined, updatedAt, now).endsWith(`: ${exactly100}...`)).toBe(true);
    });

    test('uses the Drafts mailbox and omits empty subsections', async () => {
        const getMessage = mock(async (_mailbox: string, _uid: number) => null);
        const wildDuck = makeWildDuck(getMessage);
        expect(await buildAdminRejectedSubsection([], wildDuck)).toBeUndefined();
        expect(await buildAdminRejectedSubsection([17], wildDuck)).toBeUndefined();
        expect(getMessage.mock.calls).toEqual([['Drafts', 17]]);
    });

    test('fetches independent rejected drafts with bounded concurrency and renders UID order', async () => {
        const uids = Array.from({ length: 12 }, (_, index) => index + 1);
        let active = 0;
        let peak = 0;
        const wdc = makeWildDuck(async (_mailbox, uid) => {
            active++;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active--;
            return {
                id:       uid, subject:  `subject-${uid}`, to:       [{ address: `user${uid}@example.com` }],
                metaData: { rejectedAt: '2026-09-12T00:00:00Z', reason: `reason-${uid}` },
            };
        });

        const text = await buildAdminRejectedSubsection(uids, wdc);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(8);
        expect(text?.split('\n').slice(1)).toEqual(uids.map(uid => `- To: user${uid}@example.com, Subject: "subject-${uid}" — Reason: reason-${uid}`));
    });

    test('skips drafts without a usable reason or recipient', async () => {
        const messages = new Map<number, { id: number, subject: string, to?: { address: string }[], metaData: Record<string, unknown> }>([
            [1, { id: 1, subject: 'valid', to: [{ address: 'one@example.com' }], metaData: { rejectedAt: 'now', reason: 'denied' } }],
            [2, { id: 2, subject: 'no reason', to: [{ address: 'two@example.com' }], metaData: { rejectedAt: 'now' } }],
            [3, { id: 3, subject: 'no recipient', to: [], metaData: { rejectedAt: 'now', reason: 'denied' } }],
            [4, { id: 4, subject: 'numeric reason', to: [{ address: 'four@example.com' }], metaData: { rejectedAt: 'now', reason: 42 } }],
        ]);
        const text = await buildAdminRejectedSubsection([1, 2, 3, 4], makeWildDuck(async (_mailbox, uid) => messages.get(uid) ?? null));
        expect(text).toContain('one@example.com');
        expect(text).not.toContain('two@example.com');
        expect(text).not.toContain('no recipient');
        expect(text).not.toContain('four@example.com');
    });

    test('keeps a missing subject empty without losing the rejection reason', async () => {
        const text = await buildAdminRejectedSubsection([7], makeWildDuck(async () => ({
            id: 7, to: [{ address: 'recipient@example.com' }], metaData: { rejectedAt: 'now', reason: 'admin declined' },
        })));

        expect(text).toContain('To: recipient@example.com, Subject: "" — Reason: admin declined');
    });
});

describe('draft fetch concurrency and escalation count', () => {
    test('starts the configured eight rejected-draft fetches before any completes', async () => {
        const uids = Array.from({ length: 8 }, (_, index) => index + 1);
        const releases: (() => void)[] = [];
        const getMessage = mock((_mailbox: string, uid: number) => new Promise<{
            id:       number
            subject:  string
            to:       { address: string }[]
            metaData: Record<string, unknown>
        }>((resolve) => {
            releases.push(() => resolve({
                id:       uid,
                subject:  `subject-${uid}`,
                to:       [{ address: `user${uid}@example.com` }],
                metaData: { rejectedAt: 'now', reason: 'denied' },
            }));
        }));

        const resultPromise = buildAdminRejectedSubsection(uids, makeWildDuck(getMessage));
        await Promise.resolve();
        await Promise.resolve();

        expect(getMessage).toHaveBeenCalledTimes(8);
        for(const release of releases) {
            release();
        }
        expect(await resultPromise).toContain('Messages You Attempted to Send');
    });
});
