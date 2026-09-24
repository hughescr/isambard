import { describe, test, expect } from 'bun:test';
import { ApprovalCardEditGate, approvalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('ApprovalCardEditGate', () => {
    test('pendingEdit is undefined for a card nobody holds', () => {
        const gate = new ApprovalCardEditGate();

        expect(gate.pendingEdit('card-msg')).toBeUndefined();
    });

    test('pendingEdit stays pending while the card is held and settles once the hold is released', async () => {
        const gate = new ApprovalCardEditGate();
        const release = gate.hold('card-msg');

        const pending = gate.pendingEdit('card-msg');
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('pending');

        release();
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('fulfilled');
    });

    test('a hold on one card leaves another card unheld', () => {
        const gate = new ApprovalCardEditGate();
        const release = gate.hold('card-a');

        expect(gate.pendingEdit('card-b')).toBeUndefined();
        release();
    });

    test('with two holds on a card, releasing the second keeps pendingEdit waiting for the first', async () => {
        const gate = new ApprovalCardEditGate();
        const releaseFirst = gate.hold('card-msg');
        const releaseSecond = gate.hold('card-msg');

        releaseSecond();
        const pending = gate.pendingEdit('card-msg');
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('pending');

        releaseFirst();
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('fulfilled');
    });

    test('with two holds on a card, releasing the first keeps pendingEdit waiting for the second', async () => {
        const gate = new ApprovalCardEditGate();
        const releaseFirst = gate.hold('card-msg');
        const releaseSecond = gate.hold('card-msg');

        releaseFirst();
        const pending = gate.pendingEdit('card-msg');
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('pending');

        releaseSecond();
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('fulfilled');
    });

    test('a card whose every hold is released is forgotten', () => {
        const gate = new ApprovalCardEditGate();
        const releaseFirst = gate.hold('card-msg');
        const releaseSecond = gate.hold('card-msg');
        releaseFirst();
        releaseSecond();

        expect(gate.pendingEdit('card-msg')).toBeUndefined();
    });

    test('the shared gate is an ApprovalCardEditGate', () => {
        expect(approvalCardEditGate).toBeInstanceOf(ApprovalCardEditGate);
    });
});
