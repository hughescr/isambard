import { describe, test, expect } from 'bun:test';
import { escapeHtml, renderPreviewPage } from '@/integrations/email/preview/render';
import type { WildDuckMessage } from '@/integrations/email/wildduck-client';

const TOKEN = 'T'.repeat(43);

function draft(overrides: Partial<WildDuckMessage> = {}): WildDuckMessage {
    return {
        id:        42,
        draft:     true,
        from:      { address: 'izzy@example.com', name: 'Izzy' },
        to:        [{ address: 'a@example.com' }, { address: 'b@example.com', name: 'Bee' }],
        cc:        [{ address: 'c@example.com' }],
        bcc:       [{ address: 'd@example.com' }],
        replyTo:   { address: 'reply@example.com' },
        subject:   'Hello',
        date:      '2026-09-27T10:00:00.000Z',
        messageId: '<m1@example.com>',
        text:      'Line one\nLine two',
        ...overrides,
    };
}

/** The value cell of a header row. */
function headerValue(page: string, name: string): string | undefined {
    return new RegExp(`<tr><th>${name}</th><td>(.*?)</td></tr>`, 'u').exec(page)?.[1];
}

describe('escapeHtml', () => {
    test('escapes every HTML-significant character', () => {
        expect(escapeHtml('<a href="x">Tom & Jerry\'s</a>')).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    });

    test('leaves other text alone', () => {
        expect(escapeHtml('plain text — ok')).toBe('plain text — ok');
    });
});

describe('renderPreviewPage', () => {
    test('is a complete HTML document titled with the subject', () => {
        const page = renderPreviewPage(draft(), TOKEN);

        expect(page.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
        expect(page).toContain('<meta charset="utf-8">');
        expect(page).toContain('<title>Draft preview: Hello</title>');
        expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
        expect(page).toContain('<style>body{font:15px/1.45 system-ui,sans-serif;');
        expect(page).toContain('@media (prefers-color-scheme:dark)');
        expect(page.endsWith('</html>\n')).toBe(true);
    });

    test('puts each header row on its own line', () => {
        expect(renderPreviewPage(draft(), TOKEN)).toContain('<table class="headers">\n<tr><th>From</th><td>Izzy &lt;izzy@example.com&gt;</td></tr>\n<tr><th>To</th>');
    });

    test('shows every header, in order', () => {
        const page = renderPreviewPage(draft(), TOKEN);

        expect(headerValue(page, 'From')).toBe('Izzy &lt;izzy@example.com&gt;');
        expect(headerValue(page, 'To')).toBe('a@example.com, Bee &lt;b@example.com&gt;');
        expect(headerValue(page, 'Cc')).toBe('c@example.com');
        expect(headerValue(page, 'Bcc')).toBe('d@example.com');
        expect(headerValue(page, 'Reply-To')).toBe('reply@example.com');
        expect(headerValue(page, 'Subject')).toBe('Hello');
        expect(headerValue(page, 'Date')).toBe('2026-09-27T10:00:00.000Z');
        expect(headerValue(page, 'Message-ID')).toBe('&lt;m1@example.com&gt;');
        expect(headerValue(page, 'Draft')).toBe('Drafts:42');
        const order = ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'Draft'].map(name => page.indexOf(`<tr><th>${name}</th>`));
        expect(order).toEqual(order.toSorted((a, b) => a - b));
    });

    test('shows (none) for every absent header', () => {
        const page = renderPreviewPage({ id: 7, draft: true }, TOKEN);

        for(const name of ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Subject', 'Date', 'Message-ID']) {
            expect(headerValue(page, name)).toBe('(none)');
        }
        expect(page).toContain('<title>Draft preview: (none)</title>');
    });

    test('shows (none) for empty recipient lists and a null date', () => {
        const page = renderPreviewPage(draft({ to: [], cc: [], bcc: [], date: null, subject: '' }), TOKEN);

        expect(headerValue(page, 'To')).toBe('(none)');
        expect(headerValue(page, 'Cc')).toBe('(none)');
        expect(headerValue(page, 'Bcc')).toBe('(none)');
        expect(headerValue(page, 'Date')).toBe('(none)');
        expect(headerValue(page, 'Subject')).toBe('(none)');
    });

    test('escapes hostile header, subject, body and filename values', () => {
        const hostile = '<script>alert("x")</script>';
        const page = renderPreviewPage(draft({
            from:        { address: 'x@example.com', name: hostile },
            subject:     hostile,
            text:        hostile,
            messageId:   hostile,
            attachments: [{ id: 'ATT00001', filename: hostile, contentType: hostile, sizeKb: 1 }],
        }), TOKEN);

        expect(page).not.toContain('<script>');
        expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    });

    test('shows the full text body in a pre block', () => {
        expect(renderPreviewPage(draft({ text: `${'x'.repeat(5000)}\n<b>` }), TOKEN)).toContain(`<pre>${'x'.repeat(5000)}\n&lt;b&gt;</pre>`);
    });

    test('says when there is no plain-text part', () => {
        const page = renderPreviewPage(draft({ text: undefined }), TOKEN);

        expect(page).toContain('<p class="none">(no plain-text part)</p>');
        expect(page).not.toContain('<pre>');
    });

    test('frames the HTML body from its own sandboxed URL, relative to the page', () => {
        const page = renderPreviewPage(draft({ html: ['<p>one</p>', '<p>two</p>'] }), TOKEN);

        expect(page).toContain(`<iframe sandbox src="${TOKEN}/body" title="HTML body"></iframe>`);
        expect(page).not.toContain('<p>one</p>');
    });

    test.each([
        ['absent', undefined],
        ['empty', []],
        ['empty parts', ['', '']],
        ['whitespace only', ['  ', '\n']],
    ])('has no HTML frame when the HTML body is %s', (_label, html) => {
        const page = renderPreviewPage(draft({ html }), TOKEN);

        expect(page).not.toContain('<iframe');
        expect(page).toContain('<p class="none">(no HTML part)</p>');
    });

    test('lists every attachment with a download link, its type and its size', () => {
        const page = renderPreviewPage(draft({
            attachments: [
                { id: 'ATT00001', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 13, size: 12_595 },
                { id: 'ATT00002', filename: 'photo.jpg', contentType: 'image/jpeg', sizeKb: 100 },
            ],
        }), TOKEN);

        expect(page).toContain('<h2>Attachments (2)</h2>');
        expect(page).toContain(`<tr><td><a href="${TOKEN}/a/ATT00001" download>report.pdf</a></td><td>application/pdf</td><td>12.3 KB</td></tr>`);
        expect(page).toContain(`<tr><td><a href="${TOKEN}/a/ATT00002" download>photo.jpg</a></td><td>image/jpeg</td><td>100.0 KB</td></tr>`);
        expect(page).toContain('<table class="attachments">\n<tr><td>');
        expect(page).toContain('12.3 KB</td></tr>\n<tr><td>');
        expect(page).toContain('100.0 KB</td></tr>\n</table>');
    });

    test('says when there are no attachments', () => {
        const page = renderPreviewPage(draft(), TOKEN);

        expect(page).toContain('<h2>Attachments (0)</h2>');
        expect(page).toContain('<p class="none">No attachments.</p>');
        expect(page).not.toContain('<table class="attachments">');
    });
});
