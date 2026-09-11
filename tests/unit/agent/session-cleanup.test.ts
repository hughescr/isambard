/**
 * Tests for session cleanup utility
 *
 * Extracts session IDs from SDK stream events.
 */
import { describe, test, expect } from 'bun:test';
import { extractSessionId } from '../../../src/agent/session-cleanup';
import type { SystemEvent } from '../../../src/agent/types';

describe('extractSessionId', () => {
    test('should extract session_id from system init event', () => {
        const event: SystemEvent = {
            type:       'system',
            subtype:    'init',
            session_id: 'test-session-123',
        };

        const result = extractSessionId(event);

        expect(result).toBe('test-session-123');
    });

    test.each([
        ['non-system events', { type: 'assistant', message: {} }],
        ['system events without init subtype', { type: 'system', subtype: 'status', session_id: 'should-not-extract' }],
        ['system init events without session_id', { type: 'system', subtype: 'init' }],
        ['null input', null],
        ['undefined input', undefined],
        ['array input', ['not', 'an', 'object']],
    ])('should return undefined for %s', (_description, event) => {
        const result = extractSessionId(event);
        expect(result).toBeUndefined();
    });

    test('should return null for null session_id', () => {
        const event = { type: 'system', subtype: 'init', session_id: null as unknown as string };
        const result = extractSessionId(event);
        expect(result).toBeNull();
    });

    test('should return empty string for empty session_id', () => {
        const event = { type: 'system', subtype: 'init', session_id: '' };
        const result = extractSessionId(event);
        expect(result).toBe('');
    });

    test.each([
        ['system event missing subtype field', { type: 'system', session_id: 'should-not-extract' }],
        ['type is not system but subtype is init', { type: 'user', subtype: 'init', session_id: 'should-not-extract' }],
        ['type is system but subtype is not init', { type: 'system', subtype: 'message', session_id: 'should-not-extract' }],
    ])('should return undefined when %s', (_description, event) => {
        const result = extractSessionId(event);
        expect(result).toBeUndefined();
    });

    test('should return session_id only when both type is system AND subtype is init', () => {
        const event: SystemEvent = {
            type:       'system',
            subtype:    'init',
            session_id: 'valid-session-id',
        };

        const result = extractSessionId(event);

        expect(result).toBe('valid-session-id');
    });
});
