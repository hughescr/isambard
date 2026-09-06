import { describe, test, expect } from 'bun:test';
import { createIngressGate } from '@/integrations/discord/ingress-gate';

interface FakeMessage {
    id: string
}

function makeMessage(id: string): FakeMessage {
    return { id };
}

describe('createIngressGate', () => {
    test('starts in the buffering state', () => {
        const gate = createIngressGate<FakeMessage>({ onDrain: () => undefined });
        expect(gate.state()).toBe('buffering');
    });

    test('admit() while buffering pushes the message and returns buffered', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });

        const result = gate.admit(makeMessage('1'));

        expect(result).toBe('buffered');
        expect(drained).toEqual([]);
    });

    test('admit() while open returns pass without buffering', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });
        gate.open(new Set());

        const result = gate.admit(makeMessage('1'));

        expect(result).toBe('pass');
        expect(drained).toEqual([]);
    });

    test('admit() while stopped returns dropped', () => {
        const gate = createIngressGate<FakeMessage>({ onDrain: () => undefined });
        gate.stop();

        const result = gate.admit(makeMessage('1'));

        expect(result).toBe('dropped');
        expect(gate.state()).toBe('stopped');
    });

    test('open() drains buffered messages in arrival order', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });

        gate.admit(makeMessage('1'));
        gate.admit(makeMessage('2'));
        gate.admit(makeMessage('3'));

        gate.open(new Set());

        expect(drained.map(m => m.id)).toEqual(['1', '2', '3']);
        expect(gate.state()).toBe('open');
    });

    test('open() drains buffered messages minus the replayed ids', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });

        gate.admit(makeMessage('1'));
        gate.admit(makeMessage('2'));
        gate.admit(makeMessage('3'));

        gate.open(new Set(['2']));

        expect(drained.map(m => m.id)).toEqual(['1', '3']);
    });

    test('open() is idempotent — a second call does not re-drain', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });

        gate.admit(makeMessage('1'));
        gate.open(new Set());
        expect(drained.map(m => m.id)).toEqual(['1']);

        // A message admitted after open() is passed straight through, not buffered/re-drained
        gate.admit(makeMessage('2'));
        gate.open(new Set());

        expect(drained.map(m => m.id)).toEqual(['1']);
    });

    test('stop() discards buffered messages without draining them', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });

        gate.admit(makeMessage('1'));
        gate.stop();

        expect(drained).toEqual([]);
        expect(gate.state()).toBe('stopped');
    });

    test('stop() from open transitions to stopped and subsequent admit() drops', () => {
        const gate = createIngressGate<FakeMessage>({ onDrain: () => undefined });
        gate.open(new Set());
        gate.stop();

        expect(gate.admit(makeMessage('1'))).toBe('dropped');
    });

    test('open() after stop() does not transition back to open', () => {
        const drained: FakeMessage[] = [];
        const gate = createIngressGate<FakeMessage>({ onDrain: message => drained.push(message) });

        gate.admit(makeMessage('1'));
        gate.stop();
        gate.open(new Set());

        expect(gate.state()).toBe('stopped');
        expect(drained).toEqual([]);
    });
});
