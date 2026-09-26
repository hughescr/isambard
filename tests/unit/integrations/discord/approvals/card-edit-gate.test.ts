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

    test('acquire holds an unheld card at once', async () => {
        const gate = new ApprovalCardEditGate();

        const release = await gate.acquire('card-msg');
        const pending = gate.pendingEdit('card-msg');
        await flush();
        expect(pending === undefined ? 'none' : Bun.peek.status(pending)).toBe('pending');

        release();
        expect(gate.pendingEdit('card-msg')).toBeUndefined();
    });

    test('acquire waits for every hold on the card before holding it', async () => {
        const gate = new ApprovalCardEditGate();
        const releaseFirst = gate.hold('card-msg');
        const releaseSecond = gate.hold('card-msg');

        const acquiring = gate.acquire('card-msg');
        releaseFirst();
        await flush();
        expect(Bun.peek.status(acquiring)).toBe('pending');

        releaseSecond();
        const release = await acquiring;
        expect(gate.pendingEdit('card-msg')).toBeDefined();
        release();
        expect(gate.pendingEdit('card-msg')).toBeUndefined();
    });

    test('two acquires of one card take turns: the second holds only once the first releases', async () => {
        const gate = new ApprovalCardEditGate();
        const releaseHold = gate.hold('card-msg');
        const order: string[] = [];
        const first = gate.acquire('card-msg').then((release) => {
            order.push('first');
            return release;
        });
        const second = gate.acquire('card-msg').then((release) => {
            order.push('second');
            return release;
        });

        releaseHold();
        const releaseFirst = await first;
        await flush();
        await flush();
        expect(order).toEqual(['first']);
        expect(Bun.peek.status(second)).toBe('pending');

        releaseFirst();
        const releaseSecond = await second;
        expect(order).toEqual(['first', 'second']);
        releaseSecond();
        expect(gate.pendingEdit('card-msg')).toBeUndefined();
    });

    test('the shared gate is an ApprovalCardEditGate', () => {
        expect(approvalCardEditGate).toBeInstanceOf(ApprovalCardEditGate);
    });
});
