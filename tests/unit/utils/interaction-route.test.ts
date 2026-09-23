import { describe, test, expect } from 'bun:test';
import {
    QUESTION_PREFIX,
    CONTACT_PREFIXES,
    ALLOWLIST_BUTTON_PREFIXES,
    ALLOWLIST_MODAL_PREFIXES,
    EMAIL_REVIEW_PREFIXES,
    EMAIL_SEND_BUTTON_PREFIXES,
    EMAIL_SEND_MODAL_PREFIXES,
    EMAIL_ALLOWLIST_SELECT_PREFIX,
    BSKY_BUTTON_PREFIXES,
    BSKY_MODAL_PREFIXES
} from '@/config/interaction-routes';
import { encodeCustomId, parseCustomId, customIdSchema } from '@/utils/interaction-route';

/**
 * Every registered route prefix across every closed vocabulary in `@/config/interaction-routes`
 * — the full grammar `encodeCustomId`/`parseCustomId` must round-trip, per issue #89's acceptance
 * criterion. A new vocabulary or prefix added there is covered here automatically since this list
 * is built from the same exported constants `bot.ts` registers routes from.
 */
const ALL_REGISTERED_PREFIXES: readonly string[] = [
    QUESTION_PREFIX,
    ...CONTACT_PREFIXES,
    ...ALLOWLIST_BUTTON_PREFIXES,
    ...ALLOWLIST_MODAL_PREFIXES,
    ...EMAIL_REVIEW_PREFIXES,
    ...EMAIL_SEND_BUTTON_PREFIXES,
    ...EMAIL_SEND_MODAL_PREFIXES,
    EMAIL_ALLOWLIST_SELECT_PREFIX,
    ...BSKY_BUTTON_PREFIXES,
    ...BSKY_MODAL_PREFIXES,
];

describe('encodeCustomId / parseCustomId round-trip', () => {
    test('encodes and parses a prefix+id with no value', () => {
        const customId = encodeCustomId({ prefix: 'contact-approve', id: 'abc-123' });
        expect(String(customId)).toBe('contact-approve:abc-123');
        expect(parseCustomId(customId)).toEqual({ prefix: 'contact-approve', id: 'abc-123' });
    });

    test('encodes and parses a prefix+id+value', () => {
        const customId = encodeCustomId({ prefix: 'email-trash', id: '42', value: 'Review' });
        expect(String(customId)).toBe('email-trash:42:Review');
        expect(parseCustomId(customId)).toEqual({ prefix: 'email-trash', id: '42', value: 'Review' });
    });

    test('round-trips a folder value containing a space unchanged', () => {
        const customId = encodeCustomId({ prefix: 'email-allow', id: '7', value: 'Sent Mail' });
        expect(String(customId)).toBe('email-allow:7:Sent Mail');
        expect(parseCustomId(customId)).toEqual({ prefix: 'email-allow', id: '7', value: 'Sent Mail' });
    });

    test('round-trips every registered bsky button prefix', () => {
        for(const prefix of ['bsky-send-approve', 'bsky-send-approveallowlist', 'bsky-send-reject', 'bsky-dm-approve', 'bsky-dm-approveallowlist', 'bsky-dm-reject']) {
            const customId = encodeCustomId({ prefix, id: 'uuid-1' });
            expect(parseCustomId(customId)).toEqual({ prefix, id: 'uuid-1' });
        }
    });

    test('round-trips every registered route prefix from every closed vocabulary, id-only', () => {
        for(const prefix of ALL_REGISTERED_PREFIXES) {
            const customId = encodeCustomId({ prefix, id: 'route-id' });
            expect(parseCustomId(customId)).toEqual({ prefix, id: 'route-id' });
        }
    });

    test('round-trips every registered route prefix from every closed vocabulary, id-plus-value', () => {
        for(const prefix of ALL_REGISTERED_PREFIXES) {
            const customId = encodeCustomId({ prefix, id: 'route-id', value: 'route-value' });
            expect(parseCustomId(customId)).toEqual({ prefix, id: 'route-id', value: 'route-value' });
        }
    });
});

describe('parseCustomId — undefined for malformed input', () => {
    test('returns undefined when there is no colon at all', () => {
        expect(parseCustomId('no-colon-here')).toBeUndefined();
    });

    test('returns undefined for an empty string', () => {
        expect(parseCustomId('')).toBeUndefined();
    });

    test('returns undefined when the prefix segment is empty', () => {
        expect(parseCustomId(':id')).toBeUndefined();
    });

    test("returns undefined for 'prefix:' (empty id, no second colon)", () => {
        expect(parseCustomId('prefix:')).toBeUndefined();
    });

    test("returns undefined for 'prefix::value' (empty id, second colon immediately)", () => {
        expect(parseCustomId('prefix::value')).toBeUndefined();
    });
});

describe('parseCustomId — value handling', () => {
    test('leaves value undefined when there is no second colon', () => {
        expect(parseCustomId('prefix:id')).toEqual({ prefix: 'prefix', id: 'id' });
    });

    test('preserves embedded colons in value without re-splitting (question free-text case)', () => {
        expect(parseCustomId('question:q1:10:30 AM')).toEqual({ prefix: 'question', id: 'q1', value: '10:30 AM' });
    });

    test("parses a trailing colon as an empty-string value ('prefix:id:')", () => {
        expect(parseCustomId('prefix:id:')).toEqual({ prefix: 'prefix', id: 'id', value: '' });
    });

    test('does not trim leading/trailing whitespace in id', () => {
        expect(parseCustomId('prefix: id ')).toEqual({ prefix: 'prefix', id: ' id ' });
    });

    test('does not trim leading/trailing whitespace in value', () => {
        expect(parseCustomId('prefix:id: value ')).toEqual({ prefix: 'prefix', id: 'id', value: ' value ' });
    });
});

describe('encodeCustomId — value:"" round-trips to an explicit empty value', () => {
    test('a trailing colon with value "" parses back to value: ""', () => {
        const customId = encodeCustomId({ prefix: 'prefix', id: 'id', value: '' });
        expect(String(customId)).toBe('prefix:id:');
        expect(parseCustomId(customId)).toEqual({ prefix: 'prefix', id: 'id', value: '' });
    });
});

describe('encodeCustomId — rejects ambiguous or empty segments', () => {
    test('throws when prefix is empty', () => {
        expect(() => encodeCustomId({ prefix: '', id: 'id' })).toThrow("must be non-empty and contain no ':'");
    });

    test('throws when id is empty', () => {
        expect(() => encodeCustomId({ prefix: 'prefix', id: '' })).toThrow("must be non-empty and contain no ':'");
    });

    test('throws when prefix contains a colon', () => {
        expect(() => encodeCustomId({ prefix: 'pre:fix', id: 'id' })).toThrow("must be non-empty and contain no ':'");
    });

    test('throws when id contains a colon (would be misread as an id/value split)', () => {
        expect(() => encodeCustomId({ prefix: 'email-allow', id: '42:Review' })).toThrow("must be non-empty and contain no ':'");
    });

    test('does not throw when only value contains a colon', () => {
        expect(() => encodeCustomId({ prefix: 'question', id: 'q1', value: '10:30' })).not.toThrow();
    });
});

describe('customIdSchema', () => {
    test('accepts a non-empty string', () => {
        expect(customIdSchema.safeParse('prefix:id').success).toBe(true);
    });

    test('accepts a 1-character string (the minimum length boundary)', () => {
        expect(customIdSchema.safeParse('x').success).toBe(true);
    });

    test('rejects an empty string', () => {
        const result = customIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });
});
