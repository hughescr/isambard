import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import { attachmentContentDisposition, createDraftPreviewHandler, type DraftPreviewHandlerDeps } from '@/integrations/email/preview/handler';
import { renderPreviewPage } from '@/integrations/email/preview/render';
import type { AttachmentStream, WildDuckMessage } from '@/integrations/email/wildduck-client';

const TOKEN = 'A'.repeat(43);
const OTHER_TOKEN = `${'A'.repeat(42)}B`;
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const TTL_MS = 60 * 60 * 1000;
const PAGE_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; frame-src \'self\'; img-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'';
const BODY_CSP = 'sandbox; default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; frame-ancestors \'self\'';

function stored(overrides: Partial<WildDuckMessage> = {}, meta: Record<string, unknown> = {}): WildDuckMessage {
    return {
        id:          42,
        draft:       true,
        subject:     'Hello',
        to:          [{ address: 'a@example.com' }],
        date:        new Date(NOW - 1000).toISOString(),
        text:        'Body',
        html:        ['<p>Hi</p>', '<p>there</p>'],
        attachments: [{ id: 'ATT00001', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 1 }],
        metaData:    { previewToken: TOKEN, ...meta },
        ...overrides,
    };
}

interface Harness {
    handle:     (request: Request) => Promise<Response>
    getMessage: ReturnType<typeof mock<(folder: string, uid: number, signal?: AbortSignal) => Promise<WildDuckMessage | null>>>
    openStream: ReturnType<typeof mock<(folder: string, uid: number, id: string, signal?: AbortSignal) => Promise<AttachmentStream | null>>>
}

function harness(draft: WildDuckMessage | null = stored(), overrides: Partial<DraftPreviewHandlerDeps> = {}): Harness {
    const getMessage = mock(async (_folder: string, _uid: number, _signal?: AbortSignal): Promise<WildDuckMessage | null> => draft);
    const openStream = mock(async (_folder: string, _uid: number, _id: string, _signal?: AbortSignal): Promise<AttachmentStream | null> => ({ body: new Response('PDFBYTES').body, contentLength: 8 }));
    const handle = createDraftPreviewHandler({
        wildDuckClient: { getMessage, openAttachmentStream: openStream },
        ttlMs:          TTL_MS,
        mountPath:      '/',
        now:            () => NOW,
        ...overrides,
    });
    return { handle, getMessage, openStream };
}

function get(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://127.0.0.1:8791${path}`, { headers });
}

/** The headers every preview response carries, as the response has them. */
function commonHeadersOf(response: Response): Record<string, string | null> {
    return {
        'cache-control':          response.headers.get('cache-control'),
        'referrer-policy':        response.headers.get('referrer-policy'),
        'x-content-type-options': response.headers.get('x-content-type-options'),
        'x-frame-options':        response.headers.get('x-frame-options'),
    };
}

const COMMON_HEADERS = {
    'cache-control':          'no-store',
    'referrer-policy':        'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options':        'SAMEORIGIN',
};

interface TextSummary {
    status:      number
    contentType: string | null
    text:        string
    common:      Record<string, string | null>
}

async function summarise(response: Response): Promise<TextSummary> {
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type'), text, common: commonHeadersOf(response) };
}

function plain(status: number, text: string): TextSummary {
    return { status, contentType: 'text/plain; charset=utf-8', text, common: COMMON_HEADERS };
}

async function statusOf(pending: Promise<Response>): Promise<number> {
    const response = await pending;
    return response.status;
}

async function textOf(pending: Promise<Response>): Promise<string> {
    const response = await pending;
    return response.text();
}

async function headerOf(pending: Promise<Response>, name: string): Promise<string | null> {
    const response = await pending;
    return response.headers.get(name);
}

describe('createDraftPreviewHandler', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
    });

    describe('method and access checks', () => {
        test.each(['POST', 'HEAD', 'PUT', 'DELETE'])('refuses %s with 405', async (method) => {
            const h = harness();

            const response = await h.handle(new Request(`http://127.0.0.1:8791/d/42/${TOKEN}`, { method }));

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
            expect(commonHeadersOf(response)).toEqual(COMMON_HEADERS);
            expect(h.getMessage).not.toHaveBeenCalled();
        });

        test('405 carries its explanation', async () => {
            const response = await harness().handle(new Request(`http://127.0.0.1:8791/d/42/${TOKEN}`, { method: 'POST' }));

            expect(await summarise(response)).toEqual(plain(405, 'Method not allowed.'));
        });

        test.each([
            ['no login header', {}],
            ['a login not on the list', { 'Tailscale-User-Login': 'mallory@example.com' }],
        ])('refuses %s with 403 when a login allowlist is set', async (_label, headers) => {
            const h = harness(stored(), { allowedLogins: ['craig@example.com'] });

            expect(await summarise(await h.handle(get(`/d/42/${TOKEN}`, headers)))).toEqual(plain(403, 'Forbidden.'));
            expect(h.getMessage).not.toHaveBeenCalled();
        });

        test('admits an allowlisted login in any case', async () => {
            const h = harness(stored(), { allowedLogins: ['craig@example.com'] });

            expect(await statusOf(h.handle(get(`/d/42/${TOKEN}`, { 'Tailscale-User-Login': 'Craig@Example.com' })))).toBe(200);
        });

        test('needs no login header without an allowlist', async () => {
            expect(await statusOf(harness().handle(get(`/d/42/${TOKEN}`)))).toBe(200);
        });
    });

    describe('paths', () => {
        test.each([
            '/',
            '/d/42',
            `/d/abc/${TOKEN}`,
            `/d/42/${TOKEN.slice(1)}`,
            `/d/42/${TOKEN}A`,
            `/d/42/${TOKEN.slice(1)}=`,
            `/d/42/${TOKEN}/`,
            `/d/42/${TOKEN}/x`,
            `/d/42/${TOKEN}/bodyx`,
            `/d/12345678901/${TOKEN}`,
            `/d/42/${TOKEN}/a/att00001`,
            `/d/42/${TOKEN}/a/ATT`,
            `/d/42/${TOKEN}/a/ATT1234567`,
            `/x/d/42/${TOKEN}`,
        ])('refuses %s with 404 without reading WildDuck', async (path) => {
            const h = harness();

            expect(await summarise(await h.handle(get(path)))).toEqual(plain(404, 'Not found.'));
            expect(h.getMessage).not.toHaveBeenCalled();
        });

        test('reads the draft by its uid with the request\'s signal', async () => {
            const h = harness();
            const request = get(`/d/42/${TOKEN}`);

            await h.handle(request);

            expect(h.getMessage.mock.calls).toEqual([['Drafts', 42, request.signal]]);
        });

        test('accepts a ten-digit uid and the base64url alphabet', async () => {
            const token = `${'a'.repeat(20)}-_09${'Z'.repeat(19)}`;
            const h = harness(stored({ id: 1_234_567_890 }, { previewToken: token }));

            expect(await statusOf(h.handle(get(`/d/1234567890/${token}`)))).toBe(200);
            expect(h.getMessage.mock.calls[0][1]).toBe(1_234_567_890);
        });

        describe('under a mount path', () => {
            test.each([
                ['the page', `/d/42/${TOKEN}`, 'text/html; charset=utf-8'],
                ['the body', `/d/42/${TOKEN}/body`, 'text/html; charset=utf-8'],
                ['an attachment', `/d/42/${TOKEN}/a/ATT00001`, 'application/pdf'],
            ])('serves %s whether or not the proxy stripped the mount', async (_label, path, contentType) => {
                const h = harness(stored(), { mountPath: '/izzy-preview' });

                const responses = await Promise.all([path, `/izzy-preview${path}`].map(async requested => h.handle(get(requested))));

                expect(responses.map(response => [response.status, response.headers.get('content-type')])).toEqual([[200, contentType], [200, contentType]]);
            });

            test('resolves the page\'s relative body and attachment links under the mount', async () => {
                const h = harness(stored(), { mountPath: '/izzy-preview' });
                const pageUrl = `https://mac.tailnet.ts.net/izzy-preview/d/42/${TOKEN}`;
                const response = await h.handle(get(`/d/42/${TOKEN}`));
                const page = await response.text();
                const links = [...page.matchAll(/(?:src|href)="([^"]+)"/gu)].map(([, link]) => new URL(link, pageUrl).pathname);

                expect(links).toEqual([`/izzy-preview/d/42/${TOKEN}/body`, `/izzy-preview/d/42/${TOKEN}/a/ATT00001`]);
                expect(await Promise.all(links.map(async link => statusOf(h.handle(get(link)))))).toEqual([200, 200]);
            });

            test.each([
                '/izzy-preview',
                '/izzy-preview/',
                `/izzy-previewd/42/${TOKEN}`,
                `/izzy-preview/izzy-preview/d/42/${TOKEN}`,
                `/other/d/42/${TOKEN}`,
            ])('refuses %s with 404', async (path) => {
                const h = harness(stored(), { mountPath: '/izzy-preview' });

                expect(await summarise(await h.handle(get(path)))).toEqual(plain(404, 'Not found.'));
                expect(h.getMessage).not.toHaveBeenCalled();
            });
        });
    });

    describe('draft checks', () => {
        test('answers 502 when WildDuck fails, logging the uid but never the token', async () => {
            const h = harness();
            h.getMessage.mockImplementation(async () => {
                throw new Error('WildDuck down');
            });

            expect(await summarise(await h.handle(get(`/d/42/${TOKEN}`)))).toEqual(plain(502, 'Could not read the draft from the mail server.'));
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: 42, status: 502, error: 'WildDuck down', msg: 'Draft preview could not read the draft' });
            expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(TOKEN);
        });

        test('logs a non-Error failure as a string', async () => {
            const h = harness();
            h.getMessage.mockImplementation(async () => {
                throw 'socket closed';
            });

            expect(await statusOf(h.handle(get(`/d/42/${TOKEN}`)))).toBe(502);
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: 42, status: 502, error: 'socket closed', msg: 'Draft preview could not read the draft' });
        });

        test.each([
            ['missing', null],
            ['no longer a draft', stored({ draft: false })],
            ['of unknown draft state', stored({ draft: undefined })],
            ['superseded', stored({}, { supersededBy: 55 })],
            ['without a token', stored({}, { previewToken: undefined })],
        ])('answers a draft that is %s with the same 404 as a wrong token', async (_label, draft) => {
            const refused = await summarise(await harness(draft).handle(get(`/d/42/${TOKEN}`)));
            const mismatch = await summarise(await harness().handle(get(`/d/42/${OTHER_TOKEN}`)));

            expect(refused).toEqual(plain(404, 'Not found.'));
            expect(mismatch).toEqual(refused);
        });

        test.each([
            ['an approval marker', { approval: { actionId: 'act-1', at: '2026-09-27T11:00:00.000Z' } }],
            ['a rejection', { rejectedAt: '2026-09-27T11:00:00.000Z' }],
        ])('answers 410 for a draft with %s', async (_label, meta) => {
            expect(await summarise(await harness(stored({}, meta)).handle(get(`/d/42/${TOKEN}`)))).toEqual(plain(410, 'This draft has been approved or rejected.'));
        });

        test('reports a decision ahead of expiry', async () => {
            const h = harness(stored({ date: new Date(NOW - TTL_MS - 1).toISOString() }, { rejectedAt: 'then' }));

            expect(await textOf(h.handle(get(`/d/42/${TOKEN}`)))).toBe('This draft has been approved or rejected.');
        });

        test('works up to the TTL after the draft\'s date', async () => {
            expect(await statusOf(harness(stored({ date: new Date(NOW - TTL_MS).toISOString() })).handle(get(`/d/42/${TOKEN}`)))).toBe(200);
        });

        test.each([
            ['a millisecond past the TTL', stored({ date: new Date(NOW - TTL_MS - 1).toISOString() })],
            ['with no date', stored({ date: undefined })],
            ['with a null date', stored({ date: null })],
            ['with an unreadable date', stored({ date: 'not a date' })],
        ])('answers 410 for a link %s', async (_label, draft) => {
            expect(await summarise(await harness(draft).handle(get(`/d/42/${TOKEN}`)))).toEqual(plain(410, 'Preview link expired.'));
        });

        test('logs each answered request with its uid and status only', async () => {
            await harness().handle(get(`/d/42/${TOKEN}`));
            await harness(null).handle(get(`/d/42/${TOKEN}`));

            expect(mockLogger.info.mock.calls).toEqual([
                [{ uid: 42, status: 200, msg: 'Draft preview request' }],
                [{ uid: 42, status: 404, msg: 'Draft preview request' }],
            ]);
        });
    });

    describe('the page', () => {
        test('renders the draft as an HTML page under the page CSP', async () => {
            const draft = stored();
            const response = await harness(draft).handle(get(`/d/42/${TOKEN}`));

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
            expect(response.headers.get('content-security-policy')).toBe(PAGE_CSP);
            expect(commonHeadersOf(response)).toEqual(COMMON_HEADERS);
            expect(await response.text()).toBe(renderPreviewPage(draft, TOKEN));
        });
    });

    describe('/body', () => {
        test('serves the joined HTML parts under a sandboxing CSP', async () => {
            const response = await harness().handle(get(`/d/42/${TOKEN}/body`));

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
            expect(response.headers.get('content-security-policy')).toBe(BODY_CSP);
            expect(commonHeadersOf(response)).toEqual(COMMON_HEADERS);
            expect(await response.text()).toBe('<p>Hi</p>\n<p>there</p>');
        });

        test.each([
            ['absent', undefined],
            ['empty', ['']],
            ['whitespace only', ['  ', '\n']],
        ])('is 404 when the HTML body is %s', async (_label, html) => {
            expect(await summarise(await harness(stored({ html })).handle(get(`/d/42/${TOKEN}/body`)))).toEqual(plain(404, 'Not found.'));
        });

        test('is checked like the page', async () => {
            expect(await statusOf(harness(stored({}, { rejectedAt: 'then' })).handle(get(`/d/42/${TOKEN}/body`)))).toBe(410);
            expect(await statusOf(harness().handle(get(`/d/42/${OTHER_TOKEN}/body`)))).toBe(404);
        });
    });

    describe('/a/:id', () => {
        test('streams the attachment as a download with its declared type and length', async () => {
            const h = harness();
            const request = get(`/d/42/${TOKEN}/a/ATT00001`);

            const response = await h.handle(request);

            expect(response.status).toBe(200);
            expect(h.openStream.mock.calls).toEqual([['Drafts', 42, 'ATT00001', request.signal]]);
            expect(response.headers.get('content-type')).toBe('application/pdf');
            expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf');
            expect(response.headers.get('content-security-policy')).toBe('sandbox');
            expect(response.headers.get('content-length')).toBe('8');
            expect(commonHeadersOf(response)).toEqual(COMMON_HEADERS);
            expect(await response.text()).toBe('PDFBYTES');
        });

        test('omits the length when WildDuck gave none', async () => {
            const h = harness();
            h.openStream.mockImplementation(async () => ({ body: new Response('xyz').body }));

            const response = await h.handle(get(`/d/42/${TOKEN}/a/ATT00001`));

            expect(response.headers.has('content-length')).toBe(false);
            expect(await response.text()).toBe('xyz');
        });

        test.each([
            ['empty', ''],
            ['not a MIME type', 'text/html\r\nX-Evil: 1'],
            ['missing a subtype', 'application'],
            ['with trailing junk', 'application/pdf; x'],
            ['with leading junk', 'x; application/pdf'],
        ])('falls back to application/octet-stream for a declared type that is %s', async (_label, contentType) => {
            const h = harness(stored({ attachments: [{ id: 'ATT00001', filename: 'f', contentType, sizeKb: 1 }] }));

            expect(await headerOf(h.handle(get(`/d/42/${TOKEN}/a/ATT00001`)), 'content-type')).toBe('application/octet-stream');
        });

        test('keeps a declared type with a vendor subtype', async () => {
            const h = harness(stored({ attachments: [{ id: 'ATT00001', filename: 'f', contentType: 'application/vnd.ms-excel+xml', sizeKb: 1 }] }));

            expect(await headerOf(h.handle(get(`/d/42/${TOKEN}/a/ATT00001`)), 'content-type')).toBe('application/vnd.ms-excel+xml');
        });

        test.each([
            ['not in the draft', stored()],
            ['asked of a draft with no attachments', stored({ attachments: undefined })],
        ])('is 404 for an attachment %s, without opening a stream', async (_label, draft) => {
            const h = harness(draft);

            expect(await summarise(await h.handle(get(`/d/42/${TOKEN}/a/ATT00009`)))).toEqual(plain(404, 'Not found.'));
            expect(h.openStream).not.toHaveBeenCalled();
        });

        test('is 404 when WildDuck no longer has the attachment', async () => {
            const h = harness();
            h.openStream.mockImplementation(async () => null);

            expect(await summarise(await h.handle(get(`/d/42/${TOKEN}/a/ATT00001`)))).toEqual(plain(404, 'Not found.'));
        });

        test('is 502 when WildDuck fails to open the attachment', async () => {
            const h = harness();
            h.openStream.mockImplementation(async () => {
                throw new Error('stream failed');
            });

            expect(await summarise(await h.handle(get(`/d/42/${TOKEN}/a/ATT00001`)))).toEqual(plain(502, 'Could not read the draft from the mail server.'));
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: 42, status: 502, error: 'stream failed', msg: 'Draft preview could not read the attachment' });
        });

        test('is checked like the page', async () => {
            const h = harness(stored({}, { approval: { actionId: 'a', at: 'b' } }));

            expect(await statusOf(h.handle(get(`/d/42/${TOKEN}/a/ATT00001`)))).toBe(410);
            expect(h.openStream).not.toHaveBeenCalled();
        });
    });
});

describe('attachmentContentDisposition', () => {
    test('gives an ASCII name and an RFC 5987 UTF-8 name', () => {
        expect(attachmentContentDisposition('résumé 2026.pdf')).toBe('attachment; filename="r_sum_ 2026.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%202026.pdf');
    });

    test('replaces other control characters in the ASCII name, and percent-encodes them in the UTF-8 name', () => {
        expect(attachmentContentDisposition('a\tb\u007F.txt')).toBe('attachment; filename="a_b_.txt"; filename*=UTF-8\'\'a%09b%7F.txt');
    });

    test('strips CR, LF, quotes and backslashes', () => {
        expect(attachmentContentDisposition('a"b\r\nc\\d.txt')).toBe('attachment; filename="abcd.txt"; filename*=UTF-8\'\'abcd.txt');
    });

    test('percent-encodes the characters encodeURIComponent leaves alone but RFC 5987 does not allow', () => {
        expect(attachmentContentDisposition('it\'s (1)*.txt')).toBe('attachment; filename="it\'s (1)*.txt"; filename*=UTF-8\'\'it%27s%20%281%29%2A.txt');
    });

    test('names a nameless attachment "attachment"', () => {
        expect(attachmentContentDisposition('')).toBe('attachment; filename="attachment"; filename*=UTF-8\'\'attachment');
        expect(attachmentContentDisposition('"\r\n')).toBe('attachment; filename="attachment"; filename*=UTF-8\'\'attachment');
    });
});
