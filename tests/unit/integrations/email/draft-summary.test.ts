import { describe, test, expect } from 'bun:test';
import { buildDraftSummary, DRAFT_SNIPPET_MAX_CODE_POINTS, formatAttachmentSize } from '@/integrations/email/draft-summary';

describe('buildDraftSummary', () => {
    test('carries From, To, Cc, Bcc and Subject exactly as stored', () => {
        const summary = buildDraftSummary({
            id:      7,
            from:    { address: 'izzy@example.com', name: 'Izzy' },
            to:      [{ address: 'a@example.com' }, { address: 'b@example.com', name: 'B' }],
            cc:      [{ address: 'c@example.com' }],
            bcc:     [{ address: 'd@example.com' }],
            subject: 'Hello',
            text:    'Body',
        });

        expect(summary).toEqual({
            from:        { address: 'izzy@example.com', name: 'Izzy' },
            to:          [{ address: 'a@example.com' }, { address: 'b@example.com', name: 'B' }],
            cc:          [{ address: 'c@example.com' }],
            bcc:         [{ address: 'd@example.com' }],
            subject:     'Hello',
            snippet:     'Body',
            attachments: [],
        });
    });

    test('defaults missing recipients to empty lists, the subject to empty, and leaves From absent', () => {
        const summary = buildDraftSummary({ id: 7 });

        expect(summary).toStrictEqual({ from: undefined, to: [], cc: [], bcc: [], subject: '', snippet: '', attachments: [] });
    });

    test('prefers the text body over the HTML body', () => {
        expect(buildDraftSummary({ id: 1, text: 'plain', html: ['<p>html</p>'] }).snippet).toBe('plain');
    });

    test('converts the joined HTML parts to text when there is no text body', () => {
        expect(buildDraftSummary({ id: 1, html: ['<p>Hello <b>there</b></p>', '<p>second part</p>'] }).snippet).toBe('Hello there second part');
    });

    test('joins inline HTML parts with a line break, never gluing words together', () => {
        expect(buildDraftSummary({ id: 1, html: ['Hello', 'there'] }).snippet).toBe('Hello there');
    });

    test('collapses every run of whitespace to one space and trims the ends', () => {
        expect(buildDraftSummary({ id: 1, text: '  Hi\n\n\tthere   you \r\n' }).snippet).toBe('Hi there you');
    });

    test('keeps a body of exactly the limit whole', () => {
        const body = 'a'.repeat(DRAFT_SNIPPET_MAX_CODE_POINTS);
        expect(buildDraftSummary({ id: 1, text: body }).snippet).toBe(body);
        expect(DRAFT_SNIPPET_MAX_CODE_POINTS).toBe(400);
    });

    test('cuts a longer body to the limit in code points, ending with an ellipsis', () => {
        const snippet = buildDraftSummary({ id: 1, text: '😀'.repeat(401) }).snippet;
        expect([...snippet]).toHaveLength(400);
        expect(snippet).toBe(`${'😀'.repeat(399)}…`);
    });

    test('lists attachments with their decoded size, falling back to sizeKb × 1024', () => {
        const summary = buildDraftSummary({
            id:          1,
            attachments: [
                { id: 'ATT00001', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 13, size: 12_345 },
                { id: 'ATT00002', filename: 'photo.jpg', contentType: 'image/jpeg', sizeKb: 2 },
            ],
        });

        expect(summary.attachments).toEqual([
            { filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: 12_345 },
            { filename: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 2048 },
        ]);
    });
});

describe('formatAttachmentSize', () => {
    test.each([
        [0, '0 B'],
        [1023, '1023 B'],
        [1024, '1.0 KB'],
        [12_595, '12.3 KB'],
        [1024 * 1024 - 1, '1024.0 KB'],
        [1024 * 1024, '1.0 MB'],
        [5.5 * 1024 * 1024, '5.5 MB'],
        [1024 * 1024 * 1024, '1.0 GB'],
        [1024 * 1024 * 1024 * 1024, '1024.0 GB'],
    ])('formats %d bytes as %s', (bytes, expected) => {
        expect(formatAttachmentSize(bytes)).toBe(expected);
    });
});
