import { describe, test, expect } from 'bun:test';
import {
    amendedDraftMeta,
    draftLockKey,
    hasDecisionMarker,
    mergeDraftMeta,
    newPreviewToken,
    previewTokenMatches,
    readDraftApprovalMeta
} from '@/integrations/email/draft-approval-meta';

describe('readDraftApprovalMeta', () => {
    test('reads every known key from a full metaData object', () => {
        expect(readDraftApprovalMeta({
            approvalCard: { channelId: 'ch', messageId: 'msg', edits: 2 },
            approval:     { actionId: 'act-1', at: '2026-09-27T00:00:00.000Z' },
            rejectedAt:   '2026-09-27T01:00:00.000Z',
            reason:       'Too blunt',
            supersededBy: 77,
            previewToken: 'tok',
            unrelated:    'kept elsewhere',
        })).toEqual({
            card:         { channelId: 'ch', messageId: 'msg', edits: 2 },
            approval:     { actionId: 'act-1', at: '2026-09-27T00:00:00.000Z' },
            rejectedAt:   '2026-09-27T01:00:00.000Z',
            reason:       'Too blunt',
            supersededBy: 77,
            previewToken: 'tok',
        });
    });

    test.each([
        ['undefined', undefined],
        ['null', null],
        ['a string', 'metaData'],
        ['an array', [1, 2]],
        ['an empty object', {}],
    ])('reads nothing from %s', (_label, metaData) => {
        expect(readDraftApprovalMeta(metaData)).toStrictEqual({});
    });

    test('drops each malformed key on its own, keeping the well-formed ones', () => {
        expect(readDraftApprovalMeta({
            approvalCard: { channelId: 'ch', messageId: 'msg', edits: -1 },
            approval:     { actionId: '', at: 'x' },
            rejectedAt:   5,
            reason:       ['r'],
            supersededBy: 1.5,
            previewToken: 9,
        })).toEqual({});
        expect(readDraftApprovalMeta({ approvalCard: { channelId: '', messageId: 'msg', edits: 0 } })).toEqual({});
        expect(readDraftApprovalMeta({ approvalCard: { channelId: 'ch', messageId: '', edits: 0 } })).toEqual({});
        expect(readDraftApprovalMeta({ approvalCard: { channelId: 'ch', messageId: 'msg', edits: 0.5 } })).toEqual({});
        expect(readDraftApprovalMeta({ approvalCard: { channelId: 'ch', messageId: 'msg', edits: 0 }, rejectedAt: 5 })).toEqual({
            card: { channelId: 'ch', messageId: 'msg', edits: 0 },
        });
    });
});

describe('mergeDraftMeta', () => {
    test('keeps unrelated keys and lets the patch win', () => {
        expect(mergeDraftMeta({ keep: 1, reason: 'old' }, { reason: 'new', rejectedAt: 'now' })).toEqual({ keep: 1, reason: 'new', rejectedAt: 'now' });
    });

    test('deletes a key whose patch value is undefined', () => {
        const merged = mergeDraftMeta({ keep: 1, approval: { actionId: 'a', at: 'b' } }, { approval: undefined });
        expect(merged).toEqual({ keep: 1 });
        expect(Object.hasOwn(merged, 'approval')).toBe(false);
    });

    test('treats a missing or non-object existing metaData as empty', () => {
        expect(mergeDraftMeta(undefined, { a: 1 })).toEqual({ a: 1 });
        expect(mergeDraftMeta('junk', { a: 1 })).toEqual({ a: 1 });
        expect(mergeDraftMeta([1], { a: 1 })).toEqual({ a: 1 });
        expect(mergeDraftMeta(null, { a: 1 })).toEqual({ a: 1 });
    });

    test('never mutates the existing object', () => {
        const existing = { a: 1, b: 2 };
        mergeDraftMeta(existing, { b: undefined });
        expect(existing).toEqual({ a: 1, b: 2 });
    });
});

describe('hasDecisionMarker', () => {
    test('is true for an approval marker, true for a rejection, and false otherwise', () => {
        expect(hasDecisionMarker({ approval: { actionId: 'a', at: 'b' } })).toBe(true);
        expect(hasDecisionMarker({ rejectedAt: 'now' })).toBe(true);
        expect(hasDecisionMarker({ card: { channelId: 'c', messageId: 'm', edits: 0 }, reason: 'r', supersededBy: 3 })).toBe(false);
    });
});

describe('amendedDraftMeta', () => {
    test('carries only the card link, with its edit count bumped', () => {
        expect(amendedDraftMeta({
            approvalCard: { channelId: 'ch', messageId: 'msg', edits: 2 },
            approval:     { actionId: 'a', at: 'b' },
            rejectedAt:   'then',
            reason:       'nope',
            supersededBy: 9,
            previewToken: 'old-token',
            other:        'x',
        })).toEqual({ approvalCard: { channelId: 'ch', messageId: 'msg', edits: 3 } });
    });

    test('is empty when the draft has no card link', () => {
        expect(amendedDraftMeta({ rejectedAt: 'then', reason: 'nope' })).toStrictEqual({});
        expect(amendedDraftMeta(undefined)).toStrictEqual({});
    });
});

describe('draftLockKey', () => {
    test('prefixes the uid so it can never collide with a card (snowflake) key', () => {
        expect(draftLockKey(42)).toBe('email-draft:42');
    });
});

describe('newPreviewToken', () => {
    test('is 43 base64url characters (32 random bytes)', () => {
        const token = newPreviewToken();
        expect(token).toMatch(/^[\w-]{43}$/u);
        expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    });

    test('is fresh on every call', () => {
        expect(newPreviewToken()).not.toBe(newPreviewToken());
    });
});

describe('previewTokenMatches', () => {
    const token = 'A'.repeat(43);

    test('matches an identical token', () => {
        expect(previewTokenMatches(token, `${'A'.repeat(42)}A`)).toBe(true);
    });

    test.each([
        ['a different token of the same length', `${'A'.repeat(42)}B`],
        ['a shorter token', 'A'.repeat(42)],
        ['a longer token', 'A'.repeat(44)],
    ])('rejects %s', (_label, candidate) => {
        expect(previewTokenMatches(token, candidate)).toBe(false);
    });

    test('rejects any candidate when the draft has no token', () => {
        expect(previewTokenMatches(undefined, token)).toBe(false);
        expect(previewTokenMatches(undefined, '')).toBe(false);
    });
});
