import { describe, test, expect } from 'bun:test';
import { createInterruptFlag } from '../../../../src/agent/session/interrupt-flag';

describe('createInterruptFlag', () => {
    test('starts with value false', () => {
        expect(createInterruptFlag().value).toBe(false);
    });

    test('returns a fresh, independently-mutable object on every call', () => {
        const first = createInterruptFlag();
        const second = createInterruptFlag();

        first.value = true;

        expect(first.value).toBe(true);
        expect(second.value).toBe(false);
    });
});
