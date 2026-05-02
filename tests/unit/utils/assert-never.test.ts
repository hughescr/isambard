import { describe, test, expect } from 'bun:test';
import { InvariantViolationError } from '../../../src/errors';
import { assertNever } from '../../../src/utils/assert-never';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('assertNever', () => {
    test('throws with default message including the unexpected value', () => {
        // Cast through unknown to simulate a runtime value that bypasses the type system
        expect(() => assertNever('rss' as unknown as never)).toThrow('Unexpected value: rss');
    });

    test('default message uses String() for numeric values', () => {
        expect(() => assertNever(42 as unknown as never)).toThrow('Unexpected value: 42');
    });

    test('default message uses String() for object values', () => {
        expect(() => assertNever({ kind: 'unknown' } as unknown as never)).toThrow('Unexpected value: [object Object]');
    });

    test('throws with custom message when provided', () => {
        expect(() => assertNever('rss' as unknown as never, 'Unexpected platform: rss')).toThrow('Unexpected platform: rss');
    });

    test('thrown error is an InvariantViolationError', () => {
        expect(() => assertNever('bad' as unknown as never)).toThrow(InvariantViolationError);
    });

    test('thrown InvariantViolationError message contains the unexpected value', () => {
        let caughtError: unknown;
        try {
            assertNever('myPlatform' as unknown as never);
        } catch (err) {
            caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(InvariantViolationError);
        expect((caughtError as Error).message).toContain('myPlatform');
    });
});
