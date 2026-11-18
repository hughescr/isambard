import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    amendedDraftMeta,
    draftLockKey,
    hasDecisionMarker,
    htmlDigest,
    htmlMarker,
    mergeDraftMeta,
    newPreviewToken,
    previewTokenMatches,
    readDraftApprovalMeta,
    readDraftHtmlPart,
    readDraftSendMeta
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

    test('keeps a card link whose channel and message ids are a single character', () => {
        expect(readDraftApprovalMeta({ approvalCard: { channelId: 'c', messageId: 'm', edits: 0 } })).toEqual({
            card: { channelId: 'c', messageId: 'm', edits: 0 },
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

describe('readDraftSendMeta', () => {
    const APPROVAL = { actionId: 'act-1', at: '2026-09-27T00:00:00.000Z' };

    test('reads a well-formed approval marker, with no rejection and no amend', () => {
        expect(readDraftSendMeta({ approval: APPROVAL, approvalCard: { channelId: 'ch', messageId: 'msg', edits: 0 }, previewToken: 'tok' })).toStrictEqual({
            approval:   APPROVAL,
            rejected:   false,
            superseded: false,
        });
    });

    test.each([
        ['a timestamp', '2026-09-27T01:00:00.000Z'],
        ['null', null],
        ['an empty string', ''],
        ['undefined', undefined],
        ['a number', 5],
    ])('counts a rejectedAt key holding %s as a rejection', (_label, rejectedAt) => {
        expect(readDraftSendMeta({ approval: APPROVAL, rejectedAt })).toStrictEqual({ approval: APPROVAL, rejected: true, superseded: false });
    });

    test.each([
        ['a uid', 55],
        ['null', null],
        ['undefined', undefined],
        ['a string', 'x'],
        ['a fraction', 1.5],
    ])('counts a supersededBy key holding %s as an amend', (_label, supersededBy) => {
        expect(readDraftSendMeta({ approval: APPROVAL, supersededBy })).toStrictEqual({ approval: APPROVAL, rejected: false, superseded: true });
    });

    test.each([
        ['an empty action id', { actionId: '', at: 'x' }],
        ['no timestamp', { actionId: 'act-1' }],
        ['a numeric action id', { actionId: 1, at: 'x' }],
        ['null', null],
    ])('reads no approval marker from one with %s', (_label, approval) => {
        expect(readDraftSendMeta({ approval })).toStrictEqual({ approval: undefined, rejected: false, superseded: false });
    });

    test.each([
        ['undefined', undefined],
        ['null', null],
        ['a string', 'metaData'],
        ['an array', [1, 2]],
    ])('reads nothing from %s', (_label, metaData) => {
        expect(readDraftSendMeta(metaData)).toStrictEqual({ approval: undefined, rejected: false, superseded: false });
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

describe('the HTML part marker (htmlSha256)', () => {
    const HTML = '<p style="margin:0 0 1em">Hi <strong>there</strong></p>\n<p style="margin:0 0 1em">two</p>';
    const DIGEST = createHash('sha256').update(HTML, 'utf8').digest('hex');

    test('htmlDigest is the hex SHA-256 of the exact UTF-8 string', () => {
        expect(htmlDigest(HTML)).toBe(DIGEST);
        expect(htmlDigest('é')).toBe(createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
    });

    test('htmlMarker is the digest under htmlSha256, or nothing without HTML', () => {
        expect(htmlMarker(HTML)).toStrictEqual({ htmlSha256: DIGEST });
        expect(htmlMarker(undefined)).toStrictEqual({});
    });

    test('readDraftApprovalMeta reads a well-formed digest and drops a malformed one', () => {
        expect(readDraftApprovalMeta({ htmlSha256: DIGEST })).toEqual({ htmlSha256: DIGEST });
        for(const malformed of [DIGEST.toUpperCase(), `${DIGEST}0`, DIGEST.slice(1), `x${DIGEST}`, `${DIGEST}x`, 'g'.repeat(64), 5]) {
            expect(readDraftApprovalMeta({ htmlSha256: malformed })).toEqual({});
        }
    });

    test('a draft with no marker has no HTML part, whatever its html (WildDuck synthesises one for every plain-text message)', () => {
        expect(readDraftHtmlPart({ previewToken: 't' }, ['<p>synthesised</p>'])).toEqual({ state: 'none' });
        expect(readDraftHtmlPart(undefined, undefined)).toEqual({ state: 'none' });
    });

    test('a marker matching the stored HTML is a verified HTML part, carrying that HTML', () => {
        expect(readDraftHtmlPart({ htmlSha256: DIGEST }, [HTML])).toEqual({ state: 'verified', html: HTML });
    });

    test('the stored parts are joined with a newline, and CRLF line breaks (as the MIME encoding stores them) count as LF', () => {
        const [first, second] = HTML.split('\n');
        expect(readDraftHtmlPart({ htmlSha256: DIGEST }, [first, second])).toEqual({ state: 'verified', html: HTML });
        expect(readDraftHtmlPart({ htmlSha256: DIGEST }, [HTML.replaceAll('\n', '\r\n')])).toEqual({ state: 'verified', html: HTML });
    });

    test.each([
        ['different HTML', ['<p>other</p>']],
        ['trimmed differently', [` ${HTML}`]],
        ['no HTML at all', undefined],
        ['HTML that is not a list of strings', [5]],
        ['an empty HTML part matching a digest of nothing', []],
    ])('a marker that does not verify against %s is unverified', (_label, html) => {
        const digest = html?.length === 0 ? htmlDigest('') : DIGEST;
        expect(readDraftHtmlPart({ htmlSha256: digest }, html)).toEqual({ state: 'unverified' });
    });

    test('a malformed marker is unverified, never ignored', () => {
        expect(readDraftHtmlPart({ htmlSha256: DIGEST.toUpperCase() }, [HTML])).toEqual({ state: 'unverified' });
        expect(readDraftHtmlPart({ htmlSha256: null }, [HTML])).toEqual({ state: 'unverified' });
    });

    test('an amend never carries the marker over from the old metaData', () => {
        expect(amendedDraftMeta({ approvalCard: { channelId: 'ch', messageId: 'msg', edits: 0 }, htmlSha256: DIGEST })).toStrictEqual({ approvalCard: { channelId: 'ch', messageId: 'msg', edits: 1 } });
    });

    test('a metaData merge keeps the marker', () => {
        expect(mergeDraftMeta({ htmlSha256: DIGEST, previewToken: 't' }, { rejectedAt: 'now' })).toEqual({ htmlSha256: DIGEST, previewToken: 't', rejectedAt: 'now' });
    });
});
