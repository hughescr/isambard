import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import type { ImapConnectionConfig, ImapConnection as ImapConnectionType } from '@/integrations/email/imap-connection';
import { ImapConnectionError } from '@/integrations/email/errors';

// -----------------------------------------------------------------------
// Mock imapflow — must be set up before importing the module under test.
// We use separate mock() functions for each method and a plain class for
// ImapFlow so `new ImapFlow()` works correctly (Bun's mock() wrapper does
// not support constructor `new` calls reliably).
// -----------------------------------------------------------------------
const mockConnect         = mock<() => Promise<void>>(() => Promise.resolve());
const mockLogout          = mock<() => Promise<void>>(() => Promise.resolve());
const mockMailboxOpen     = mock<() => Promise<unknown>>(() => Promise.resolve({ path: 'INBOX' }));
const mockSearch          = mock<() => Promise<unknown>>(() => Promise.resolve([]));
const mockFetchOne        = mock<() => Promise<unknown>>(() => Promise.resolve(false));
const mockFetchAll        = mock<() => Promise<unknown>>(() => Promise.resolve([]));
const mockMessageMove     = mock<() => Promise<unknown>>(() => Promise.resolve({}));
const mockMessageFlagsAdd    = mock<() => Promise<unknown>>(() => Promise.resolve(true));
const mockMessageFlagsRemove = mock<() => Promise<unknown>>(() => Promise.resolve(true));
const mockList            = mock<() => Promise<unknown>>(() => Promise.resolve([]));
const mockIdle            = mock<() => Promise<void>>(() => Promise.resolve());
const mockStatus          = mock<() => Promise<unknown>>(() => Promise.resolve({ messages: 10, unseen: 3 }));
const mockAppend          = mock<() => Promise<unknown>>(() => Promise.resolve({ uid: 42 }));

type MockFn = (...args: unknown[]) => unknown;

/** Plain class whose instance methods delegate to the shared mocks above. */
class MockImapFlow {
    usable = false;
    connect()                           { return mockConnect(); }
    logout()                            { return mockLogout(); }
    mailboxOpen(...args: unknown[])     { return (mockMailboxOpen as MockFn)(...args); }
    search(...args: unknown[])          { return (mockSearch as MockFn)(...args); }
    fetchOne(...args: unknown[])        { return (mockFetchOne as MockFn)(...args); }
    fetchAll(...args: unknown[])        { return (mockFetchAll as MockFn)(...args); }
    messageMove(...args: unknown[])     { return (mockMessageMove as MockFn)(...args); }
    messageFlagsAdd(...args: unknown[])    { return (mockMessageFlagsAdd as MockFn)(...args); }
    messageFlagsRemove(...args: unknown[]) { return (mockMessageFlagsRemove as MockFn)(...args); }
    list(...args: unknown[])            { return (mockList as MockFn)(...args); }
    idle(...args: unknown[])            { return (mockIdle as MockFn)(...args); }
    status(...args: unknown[])          { return (mockStatus as MockFn)(...args); }
    append(...args: unknown[])          { return (mockAppend as MockFn)(...args); }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('imapflow', () => ({ ImapFlow: MockImapFlow }));

// Import after mocking
const { ImapConnection } = await import('@/integrations/email/imap-connection') as {
    ImapConnection: new (config: ImapConnectionConfig) => ImapConnectionType
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
const DEFAULT_CONFIG: ImapConnectionConfig = {
    host:             'imap.example.com',
    port:             993,
    user:             'user@example.com',
    password:         'secret',
    maxBodySizeBytes: 50_000,
};

// Minimal raw MIME source for a plain-text email (used for parseHeaders)
const PLAIN_SOURCE = Buffer.from([
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'CC: Carol <carol@example.com>',
    'Subject: Hello',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'Message-ID: <abc123@example.com>',
    'In-Reply-To: <prev@example.com>',
    'Authentication-Results: spf=pass',
    'X-Rspamd-Report: report text',
    'X-Rspamd-Score: 2.5',
    '',
    'Hello, world!',
].join('\r\n'));

// Raw MIME source for an HTML-only email (headers only — body is fetched via bodyParts)
const HTML_SOURCE = Buffer.from([
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Content-Type: text/html; charset=utf-8',
    'Subject: HTML Email',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'Message-ID: <html123@example.com>',
    '',
    '<html><body><p>Hello from HTML</p></body></html>',
].join('\r\n'));

const PLAIN_BODY_CONTENT = 'Hello, world!';
const HTML_BODY_CONTENT  = '<html><body><p>Hello from HTML</p></body></html>';

/**
 * Make a bodyParts fetch result — the second fetchOne call that returns the body part.
 */
function makeBodyPartFetchResult(partNumber: string, content: string) {
    return {
        uid:       42,
        bodyParts: new Map([[partNumber, Buffer.from(content)]]),
    };
}

function makePlainFetchResult(uid = 42) {
    return {
        uid,
        source:   PLAIN_SOURCE,
        envelope: {
            date:      new Date('2024-01-01T12:00:00.000Z'),
            subject:   'Hello',
            messageId: '<abc123@example.com>',
            inReplyTo: '<prev@example.com>',
            from:      [{ name: 'Alice', address: 'alice@example.com' }],
            to:        [{ name: 'Bob',   address: 'bob@example.com'   }],
            cc:        [{ name: 'Carol', address: 'carol@example.com' }],
        },
        bodyStructure: {
            type:       'text/plain',
            part:       '1',
            childNodes: [],
        },
    };
}

function makeHtmlFetchResult(uid = 99) {
    return {
        uid,
        source:   HTML_SOURCE,
        envelope: {
            date:      new Date('2024-01-01T12:00:00.000Z'),
            subject:   'HTML Email',
            messageId: '<html123@example.com>',
            from:      [{ name: 'Alice', address: 'alice@example.com' }],
            to:        [{ name: 'Bob',   address: 'bob@example.com'   }],
            cc:        [],
        },
        bodyStructure: {
            type:       'text/html',
            part:       '1',
            childNodes: [],
        },
    };
}

/**
 * Set up mockFetchOne to return metadata result first, then body part result.
 */
function setupFetchOnePair(metadataResult: unknown, partNumber: string, bodyContent: string) {
    mockFetchOne
        .mockImplementationOnce(() => Promise.resolve(metadataResult))
        .mockImplementationOnce(() => Promise.resolve(
            makeBodyPartFetchResult(partNumber, bodyContent)
        ));
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('ImapConnection', () => {
    let connection: ImapConnectionType;

    beforeEach(() => {
        // Reset each method mock (do NOT reset MockImapFlow constructor — it
        // holds the implementation that assigns these mocks onto `this`)
        mockConnect.mockReset();
        mockLogout.mockReset();
        mockMailboxOpen.mockReset();
        mockSearch.mockReset();
        mockFetchOne.mockReset();
        mockFetchAll.mockReset();
        mockMessageMove.mockReset();
        mockMessageFlagsAdd.mockReset();
        mockMessageFlagsRemove.mockReset();
        mockList.mockReset();
        mockIdle.mockReset();
        mockStatus.mockReset();
        mockAppend.mockReset();

        // Default successful implementations
        mockConnect.mockImplementation(() => Promise.resolve());
        mockLogout.mockImplementation(() => Promise.resolve());
        mockMailboxOpen.mockImplementation(() => Promise.resolve({ path: 'INBOX' }));
        mockSearch.mockImplementation(() => Promise.resolve([]));
        mockFetchOne.mockImplementation(() => Promise.resolve(false));
        mockFetchAll.mockImplementation(() => Promise.resolve([]));
        mockMessageMove.mockImplementation(() => Promise.resolve({}));
        mockMessageFlagsAdd.mockImplementation(() => Promise.resolve(true));
        mockMessageFlagsRemove.mockImplementation(() => Promise.resolve(true));
        mockList.mockImplementation(() => Promise.resolve([]));
        mockIdle.mockImplementation(() => Promise.resolve());
        mockStatus.mockImplementation(() => Promise.resolve({ messages: 10, unseen: 3 }));
        mockAppend.mockImplementation(() => Promise.resolve({ uid: 42 }));

        connection = new ImapConnection(DEFAULT_CONFIG);
    });

    // -------------------------------------------------------------------
    // connected getter
    // -------------------------------------------------------------------
    describe('connected getter', () => {
        test('returns false before connecting', () => {
            expect(connection.connected).toBe(false);
        });

        test('returns true after connect()', async () => {
            await connection.connect();

            expect(connection.connected).toBe(true);
        });

        test('returns false after disconnect()', async () => {
            await connection.connect();
            await connection.disconnect();

            expect(connection.connected).toBe(false);
        });
    });

    // -------------------------------------------------------------------
    // connect / disconnect lifecycle
    // -------------------------------------------------------------------
    describe('connect()', () => {
        test('calls ImapFlow.connect()', async () => {
            await connection.connect();

            expect(mockConnect).toHaveBeenCalledTimes(1);
        });

        test('wraps connect error in ImapConnectionError', async () => {
            mockConnect.mockImplementation(() => Promise.reject(new Error('network down')));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.connect()).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('ImapConnectionError message includes original error message', async () => {
            mockConnect.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.connect()).rejects.toThrow('ECONNREFUSED');
        });
    });

    describe('disconnect()', () => {
        test('calls ImapFlow.logout() when connected', async () => {
            await connection.connect();
            await connection.disconnect();

            expect(mockLogout).toHaveBeenCalledTimes(1);
        });

        test('does not call logout() when not connected', async () => {
            await connection.disconnect();

            expect(mockLogout).not.toHaveBeenCalled();
        });

        test('wraps logout error in ImapConnectionError', async () => {
            mockLogout.mockImplementation(() => Promise.reject(new Error('logout failed')));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.disconnect()).rejects.toBeInstanceOf(ImapConnectionError);
        });
    });

    // -------------------------------------------------------------------
    // fetchMessage
    // -------------------------------------------------------------------
    describe('fetchMessage()', () => {
        test('opens the specified folder and fetches by UID', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            await connection.fetchMessage('INBOX', 42);

            expect(mockMailboxOpen).toHaveBeenCalledWith('INBOX');
            expect(mockFetchOne).toHaveBeenCalledWith(
                '42',
                expect.objectContaining({ source: true, envelope: true, bodyStructure: true }),
                expect.objectContaining({ uid: true })
            );
        });

        test('fetches specific body part (second fetchOne call uses bodyParts)', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            await connection.fetchMessage('INBOX', 42);

            // Second call should request bodyParts
            expect(mockFetchOne).toHaveBeenCalledTimes(2);
            expect(mockFetchOne).toHaveBeenNthCalledWith(2,
                '42',
                expect.objectContaining({ bodyParts: ['1'] }),
                expect.objectContaining({ uid: true })
            );
        });

        test('parses uid from fetch result', async () => {
            setupFetchOnePair(makePlainFetchResult(42), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.uid).toBe(42);
        });

        test('parses from address', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.from).toEqual({ name: 'Alice', address: 'alice@example.com' });
        });

        test('parses to addresses', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.to).toEqual([{ name: 'Bob', address: 'bob@example.com' }]);
        });

        test('parses cc addresses', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.cc).toEqual([{ name: 'Carol', address: 'carol@example.com' }]);
        });

        test('parses subject', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.subject).toBe('Hello');
        });

        test('parses date', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.date).toEqual(new Date('2024-01-01T12:00:00.000Z'));
        });

        test('extracts plain-text body from body part (no MIME boundary noise)', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toContain('Hello, world!');
        });

        test('extracts headers from source', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.headers.messageId).toBe('<abc123@example.com>');
            expect(result.headers.inReplyTo).toBe('<prev@example.com>');
            expect(result.headers.authenticationResults).toMatch(/spf=pass/);
            expect(result.headers.xRspamdReport).toBe('report text');
            expect(result.headers.xRspamdScore).toBe('2.5');
        });

        test('converts HTML-only body to plain text', async () => {
            setupFetchOnePair(makeHtmlFetchResult(), '1', HTML_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 99);

            expect(result.bodyText).toContain('Hello from HTML');
        });

        test('truncates body at maxBodySizeBytes', async () => {
            const bigContent   = _.repeat('x', 200_000);
            const bigSource    = Buffer.from([
                'From: Alice <alice@example.com>',
                'To: Bob <bob@example.com>',
                'Subject: Big',
                'Date: Mon, 01 Jan 2024 12:00:00 +0000',
                'Message-ID: <big@example.com>',
                '',
                bigContent,
            ].join('\r\n'));
            const smallConfig: ImapConnectionConfig = { ...DEFAULT_CONFIG, maxBodySizeBytes: 100 };
            const smallConn = new ImapConnection(smallConfig);
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:      1,
                    source:   bigSource,
                    envelope: {
                        date:      new Date(),
                        subject:   'Big',
                        messageId: '<big@example.com>',
                        from:      [{ name: 'Alice', address: 'alice@example.com' }],
                        to:        [{ name: 'Bob', address: 'bob@example.com' }],
                        cc:        [],
                    },
                    bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       1,
                    bodyParts: new Map([['1', Buffer.from(bigContent)]]),
                }));
            await smallConn.connect();

            const result = await smallConn.fetchMessage('INBOX', 1);

            expect(result.bodyText.length).toBeLessThanOrEqual(100);
        });

        test('hasAttachments is false for plain-text email', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.hasAttachments).toBe(false);
        });

        test('hasAttachments is true when bodyStructure has attachment part', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain',      part: '1', childNodes: [] },
                        { type: 'application/pdf', part: '2', disposition: 'attachment', childNodes: [] },
                    ],
                },
            };
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.hasAttachments).toBe(true);
        });

        test('throws ImapConnectionError when fetchOne returns false', async () => {
            mockFetchOne.mockImplementation(() => Promise.resolve(false));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('INBOX', 999)).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('wraps fetchOne error in ImapConnectionError', async () => {
            mockFetchOne.mockImplementation(() => Promise.reject(new Error('UID not found')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('INBOX', 42)).rejects.toBeInstanceOf(ImapConnectionError);
        });

        // -------------------------------------------------------------------
        // BODYSTRUCTURE / findTextPart tests via fetchMessage
        // -------------------------------------------------------------------
        test('simple text/plain message: fetches part 1 body', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', 'Simple plain body');
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('Simple plain body');
        });

        test('multipart/alternative (text/plain + text/html): selects text/plain part', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/alternative',
                    childNodes: [
                        { type: 'text/plain', part: '1', childNodes: [] },
                        { type: 'text/html',  part: '2', childNodes: [] },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from('Plain text part')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            // Should have fetched part '1' (text/plain), not '2' (text/html)
            expect(mockFetchOne).toHaveBeenNthCalledWith(2,
                '42',
                expect.objectContaining({ bodyParts: ['1'] }),
                expect.anything()
            );
            expect(result.bodyText).toBe('Plain text part');
        });

        test('HTML-only message: falls back to text/html with html-to-text conversion', async () => {
            setupFetchOnePair(makeHtmlFetchResult(), '1', '<p>HTML only</p>');
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 99);

            expect(result.bodyText).toContain('HTML only');
            // Should not contain HTML tags
            expect(result.bodyText).not.toContain('<p>');
        });

        test('multipart/mixed with attachment: finds text/plain inside mixed', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain',      part: '1', childNodes: [] },
                        { type: 'application/pdf', part: '2', disposition: 'attachment', childNodes: [] },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from('Text from mixed')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('Text from mixed');
        });

        test('no text parts in bodyStructure: returns empty string', async () => {
            const pdfData = Buffer.from('pdf-content');
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        {
                            type:                  'application/pdf',
                            part:                  '1',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'report.pdf' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            // Two fetchOne calls: envelope/structure + attachment part fetch
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', pdfData]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('');
            // Two fetchOne calls: envelope fetch + attachment fetch (no text body fetch)
            expect(mockFetchOne).toHaveBeenCalledTimes(2);
            expect(result.attachments).toHaveLength(1);
        });

        test('absent bodyStructure: returns empty string', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: undefined,
            };
            mockFetchOne.mockImplementationOnce(() => Promise.resolve(fetchResult));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('');
            expect(mockFetchOne).toHaveBeenCalledTimes(1);
        });

        test('bodyPart fetchOne returns false: returns empty string body', async () => {
            // First call: metadata; second call: false (bodyPart not found)
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(makePlainFetchResult()))
                .mockImplementationOnce(() => Promise.resolve(false));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('');
        });

        test('bodyPart fetchOne returns result with no bodyParts map: returns empty string', async () => {
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(makePlainFetchResult()))
                .mockImplementationOnce(() => Promise.resolve({ uid: 42 }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('');
        });

        test('bodyPart map missing requested key: returns empty string', async () => {
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(makePlainFetchResult()))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', Buffer.from('wrong part')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('');
        });

        test('nested multipart/alternative inside multipart/mixed: finds text/plain', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        {
                            type:       'multipart/alternative',
                            childNodes: [
                                { type: 'text/plain', part: '1.1', childNodes: [] },
                                { type: 'text/html',  part: '1.2', childNodes: [] },
                            ],
                        },
                        { type: 'application/pdf', part: '2', disposition: 'attachment', childNodes: [] },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1.1', Buffer.from('Nested plain text')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(mockFetchOne).toHaveBeenNthCalledWith(2,
                '42',
                expect.objectContaining({ bodyParts: ['1.1'] }),
                expect.anything()
            );
            expect(result.bodyText).toBe('Nested plain text');
        });

        test('HTML fallback used when no text/plain in multipart/alternative', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/alternative',
                    childNodes: [
                        { type: 'application/rtf', part: '1', childNodes: [] },
                        { type: 'text/html',        part: '2', childNodes: [] },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', Buffer.from('<p>HTML fallback</p>')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(mockFetchOne).toHaveBeenNthCalledWith(2,
                '42',
                expect.objectContaining({ bodyParts: ['2'] }),
                expect.anything()
            );
            expect(result.bodyText).toContain('HTML fallback');
        });

        test('bodyStructure with no part field falls back to part 1', async () => {
            // bodyStructure without explicit part number → defaults to '1'
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'text/plain',
                    // no part field
                    childNodes: [],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from('Fallback part 1')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(mockFetchOne).toHaveBeenNthCalledWith(2,
                '42',
                expect.objectContaining({ bodyParts: ['1'] }),
                expect.anything()
            );
            expect(result.bodyText).toBe('Fallback part 1');
        });

        test('multipart/alternative with HTML before plain: still selects text/plain (order-independent preference)', async () => {
            // HTML is listed FIRST in childNodes; plain is listed SECOND.
            // findTextPart must still prefer text/plain over text/html regardless of order.
            // This kills ConditionalExpression and BlockStatement mutants on the if(!found.isHtml) guard.
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/alternative',
                    childNodes: [
                        { type: 'text/html',  part: '1', childNodes: [] },
                        { type: 'text/plain', part: '2', childNodes: [] },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', Buffer.from('Plain preferred over HTML')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            // Must select part '2' (text/plain), not part '1' (text/html)
            expect(mockFetchOne).toHaveBeenNthCalledWith(2,
                '42',
                expect.objectContaining({ bodyParts: ['2'] }),
                expect.anything()
            );
            expect(result.bodyText).toBe('Plain preferred over HTML');
        });

        test('text/plain body with HTML-entity content is not decoded (isHtml=false for text/plain)', async () => {
            // Body contains '&amp;' — if isHtml were incorrectly true, html-to-text would decode it to '&'.
            // If isHtml is correctly false, the raw content '&amp;' is preserved as-is.
            setupFetchOnePair(makePlainFetchResult(), '1', 'Hello &amp; world');
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            // Plain text is not processed by html-to-text — '&amp;' must remain verbatim
            expect(result.bodyText).toBe('Hello &amp; world');
        });
    });

    // -------------------------------------------------------------------
    // fetchNewMessages
    // -------------------------------------------------------------------
    describe('fetchNewMessages()', () => {
        test('opens the folder and searches for UIDs greater than sinceUid', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([]));
            await connection.connect();

            await connection.fetchNewMessages('INBOX', 100);

            expect(mockMailboxOpen).toHaveBeenCalledWith('INBOX');
            // Should search with uid range > 100
            expect(mockSearch).toHaveBeenCalledWith(
                expect.objectContaining({ uid: '101:*' }),
                expect.objectContaining({ uid: true })
            );
        });

        test('returns empty array when no new messages', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([]));
            await connection.connect();

            const result = await connection.fetchNewMessages('INBOX', 100);

            expect(result).toEqual([]);
            // fetchAll must not be called when uids is empty (short-circuit)
            expect(mockFetchAll).not.toHaveBeenCalled();
        });

        test('returns empty array when search returns false', async () => {
            mockSearch.mockImplementation(() => Promise.resolve(false));
            await connection.connect();

            const result = await connection.fetchNewMessages('INBOX', 100);

            expect(result).toEqual([]);
            // fetchAll must not be called when uids is falsy (short-circuit)
            expect(mockFetchAll).not.toHaveBeenCalled();
        });

        test('fetches each found UID and returns EmailMetadata array', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([101, 102]));
            mockFetchAll.mockImplementation(() => Promise.resolve([
                makePlainFetchResult(101),
                makePlainFetchResult(102),
            ]));
            // fetchOne called twice: body part for uid 101, body part for uid 102
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       101,
                    bodyParts: new Map([['1', Buffer.from('Body 101')]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       102,
                    bodyParts: new Map([['1', Buffer.from('Body 102')]]),
                }));
            await connection.connect();

            const result = await connection.fetchNewMessages('INBOX', 100);

            expect(result).toHaveLength(2);
            expect(result[0].uid).toBe(101);
            expect(result[1].uid).toBe(102);
        });

        test('wraps error in ImapConnectionError', async () => {
            mockSearch.mockImplementation(() => Promise.reject(new Error('search failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchNewMessages('INBOX', 100)).rejects.toBeInstanceOf(ImapConnectionError);
        });
    });

    // -------------------------------------------------------------------
    // listUnread
    // -------------------------------------------------------------------
    describe('listUnread()', () => {
        test('opens the folder and searches for unseen messages', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([]));
            await connection.connect();

            await connection.listUnread('CleanInbox');

            expect(mockMailboxOpen).toHaveBeenCalledWith('CleanInbox');
            expect(mockSearch).toHaveBeenCalledWith(
                expect.objectContaining({ seen: false }),
                expect.objectContaining({ uid: true })
            );
        });

        test('returns empty array when no unread messages', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([]));
            await connection.connect();

            const result = await connection.listUnread('INBOX');

            expect(result).toEqual([]);
            // fetchAll must not be called when uids is empty (short-circuit)
            expect(mockFetchAll).not.toHaveBeenCalled();
        });

        test('returns summaries with uid, from, subject, date', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([42]));
            mockFetchAll.mockImplementation(() => Promise.resolve([makePlainFetchResult(42)]));
            await connection.connect();

            const result = await connection.listUnread('INBOX');

            expect(result).toHaveLength(1);
            expect(result[0].uid).toBe(42);
            expect(result[0].from).toEqual({ name: 'Alice', address: 'alice@example.com' });
            expect(result[0].subject).toBe('Hello');
            expect(result[0].date).toEqual(new Date('2024-01-01T12:00:00.000Z'));
        });

        test('wraps error in ImapConnectionError', async () => {
            mockSearch.mockImplementation(() => Promise.reject(new Error('search failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.listUnread('INBOX')).rejects.toBeInstanceOf(ImapConnectionError);
        });
    });

    // -------------------------------------------------------------------
    // moveMessage
    // -------------------------------------------------------------------
    describe('moveMessage()', () => {
        test('opens fromFolder and calls messageMove with uid', async () => {
            await connection.connect();

            await connection.moveMessage(42, 'INBOX', 'Archive');

            expect(mockMailboxOpen).toHaveBeenCalledWith('INBOX');
            expect(mockMessageMove).toHaveBeenCalledWith(
                42,
                'Archive',
                expect.objectContaining({ uid: true })
            );
        });

        test('wraps error in ImapConnectionError', async () => {
            mockMessageMove.mockImplementation(() => Promise.reject(new Error('move failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.moveMessage(42, 'INBOX', 'Archive')).rejects.toBeInstanceOf(ImapConnectionError);
        });
    });

    // -------------------------------------------------------------------
    // setFlag
    // -------------------------------------------------------------------
    describe('setFlag()', () => {
        test('opens folder and calls messageFlagsAdd with uid and flag array', async () => {
            await connection.connect();

            await connection.setFlag(42, 'INBOX', '\\Seen');

            expect(mockMailboxOpen).toHaveBeenCalledWith('INBOX');
            expect(mockMessageFlagsAdd).toHaveBeenCalledWith(
                42,
                ['\\Seen'],
                expect.objectContaining({ uid: true })
            );
        });

        test('wraps error in ImapConnectionError', async () => {
            mockMessageFlagsAdd.mockImplementation(() => Promise.reject(new Error('flag failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.setFlag(42, 'INBOX', '\\Seen')).rejects.toBeInstanceOf(ImapConnectionError);
        });
    });

    // -------------------------------------------------------------------
    // clearFlag
    // -------------------------------------------------------------------
    describe('clearFlag()', () => {
        test('opens folder and calls messageFlagsRemove with uid and flag array', async () => {
            await connection.connect();

            await connection.clearFlag(42, 'Drafts', '\\DiscordNotifyFailed');

            expect(mockMailboxOpen).toHaveBeenCalledWith('Drafts');
            expect(mockMessageFlagsRemove).toHaveBeenCalledWith(
                42,
                ['\\DiscordNotifyFailed'],
                expect.objectContaining({ uid: true })
            );
        });

        test('wraps error in ImapConnectionError', async () => {
            mockMessageFlagsRemove.mockImplementation(() => Promise.reject(new Error('flag remove failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.clearFlag(42, 'Drafts', '\\DiscordNotifyFailed')).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('re-throws ImapConnectionError without wrapping', async () => {
            const original = new ImapConnectionError('already wrapped');
            mockMessageFlagsRemove.mockImplementation(() => Promise.reject(original));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.clearFlag(42, 'Drafts', '\\TestFlag')).rejects.toBe(original);
        });
    });

    // -------------------------------------------------------------------
    // ensureFolders
    // -------------------------------------------------------------------
    describe('ensureFolders()', () => {
        // Standard "happy path" fixture with specialUse flags — WildDuck uses 'Sent Mail' for Sent
        const allFolders = [
            { path: 'INBOX',     specialUse: '\\Inbox'   },
            { path: 'CleanInbox'                          },  // custom, no flag
            { path: 'Drafts',    specialUse: '\\Drafts'  },
            { path: 'Quarantine'                          },  // custom, no flag
            { path: 'Review'                              },  // custom, no flag
            { path: 'Junk',      specialUse: '\\Junk'    },
            { path: 'Trash',     specialUse: '\\Trash'   },
            { path: 'Archive',   specialUse: '\\Archive' },
            { path: 'Sent Mail', specialUse: '\\Sent'    },  // WildDuck uses 'Sent Mail'
        ];

        test('calls list() to get available mailboxes', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            await connection.connect();

            await connection.ensureFolders();

            expect(mockList).toHaveBeenCalledTimes(1);
        });

        test('resolves when all expected folders are present', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).resolves.toBeUndefined();
        });

        test('resolves when Sent folder is matched via \\Sent specialUse flag to Sent Mail path', async () => {
            // WildDuck has 'Sent Mail' as the path but \\Sent specialUse flag maps it to EmailFolder.Sent
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            await connection.connect();

            // Should not throw — specialUse flag resolves 'Sent' -> 'Sent Mail'
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).resolves.toBeUndefined();
        });

        test('resolves when Sent has no specialUse flag but FOLDER_FALLBACK_PATHS path exists', async () => {
            // No \\Sent flag on any folder — fallback to 'Sent Mail' from FOLDER_FALLBACK_PATHS
            const noFlagFolders = [
                { path: 'INBOX',     specialUse: '\\Inbox'   },
                { path: 'CleanInbox'                          },
                { path: 'Drafts',    specialUse: '\\Drafts'  },
                { path: 'Quarantine'                          },
                { path: 'Review'                              },
                { path: 'Junk',      specialUse: '\\Junk'    },
                { path: 'Trash',     specialUse: '\\Trash'   },
                { path: 'Archive',   specialUse: '\\Archive' },
                { path: 'Sent Mail'                           },  // present but no specialUse flag
            ];
            mockList.mockImplementation(() => Promise.resolve(noFlagFolders));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).resolves.toBeUndefined();
        });

        test('throws when neither flag-matched nor fallback-path Sent folder exists', async () => {
            // Neither '\\Sent'-flagged folder nor 'Sent Mail' fallback path exists
            const noSentFolders = [
                { path: 'INBOX',     specialUse: '\\Inbox'   },
                { path: 'CleanInbox'                          },
                { path: 'Drafts',    specialUse: '\\Drafts'  },
                { path: 'Quarantine'                          },
                { path: 'Review'                              },
                { path: 'Junk',      specialUse: '\\Junk'    },
                { path: 'Trash',     specialUse: '\\Trash'   },
                { path: 'Archive',   specialUse: '\\Archive' },
                // No 'Sent Mail' path, no \\Sent flag
            ];
            mockList.mockImplementation(() => Promise.resolve(noSentFolders));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toThrow('Sent Mail');
        });

        test('custom folders (CleanInbox, Quarantine, Review) always use hardcoded names', async () => {
            // Custom folders are never resolved via flags — they must exist by exact name
            const missingCustomFolders = [
                { path: 'INBOX',     specialUse: '\\Inbox'   },
                { path: 'Drafts',    specialUse: '\\Drafts'  },
                { path: 'Junk',      specialUse: '\\Junk'    },
                { path: 'Trash',     specialUse: '\\Trash'   },
                { path: 'Archive',   specialUse: '\\Archive' },
                { path: 'Sent Mail', specialUse: '\\Sent'    },
                // Missing CleanInbox, Quarantine, Review
            ];
            mockList.mockImplementation(() => Promise.resolve(missingCustomFolders));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('throws ImapConnectionError when a folder is missing', async () => {
            mockList.mockImplementation(() => Promise.resolve([
                { path: 'INBOX', specialUse: '\\Inbox' },
                { path: 'Junk',  specialUse: '\\Junk'  },
                // Missing CleanInbox, Quarantine, Review, Archive
            ]));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('error message names the missing folder', async () => {
            mockList.mockImplementation(() => Promise.resolve([
                { path: 'INBOX',     specialUse: '\\Inbox'   },
                { path: 'CleanInbox'                          },
                { path: 'Drafts',    specialUse: '\\Drafts'  },
                { path: 'Review'                              },
                { path: 'Junk',      specialUse: '\\Junk'    },
                { path: 'Trash',     specialUse: '\\Trash'   },
                { path: 'Archive',   specialUse: '\\Archive' },
                { path: 'Sent Mail', specialUse: '\\Sent'    },
                // Missing Quarantine
            ]));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toThrow('Quarantine');
        });

        test('wraps list error in ImapConnectionError', async () => {
            mockList.mockImplementation(() => Promise.reject(new Error('list failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('re-throws ImapConnectionError from inner throw unchanged', async () => {
            mockList.mockImplementation(() => Promise.resolve([
                { path: 'INBOX', specialUse: '\\Inbox' },
                // Missing all other required folders
            ]));
            await connection.connect();

            // The inner throw (Required IMAP folder missing) is an ImapConnectionError — it should
            // propagate with its original message rather than being re-wrapped in "ensureFolders failed"
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toThrow('Required IMAP folder missing');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.not.toThrow('ensureFolders failed');
        });

        test('error message includes ensureFolders context for external errors', async () => {
            mockList.mockImplementation(() => Promise.reject(new Error('connection reset')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.ensureFolders()).rejects.toThrow('ensureFolders failed');
        });

        // -------------------------------------------------------------------
        // resolveFolder() integration — methods use resolved paths after ensureFolders()
        // -------------------------------------------------------------------

        test('fetchMessage uses resolved path after ensureFolders() — Sent -> Sent Mail', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();
            await connection.ensureFolders();

            await connection.fetchMessage('Sent Mail', 42);

            expect(mockMailboxOpen).toHaveBeenCalledWith('Sent Mail');
        });

        test('moveMessage uses resolved toFolder path after ensureFolders() — Sent -> Sent Mail', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            mockMessageMove.mockImplementation(() => Promise.resolve({}));
            await connection.connect();
            await connection.ensureFolders();

            await connection.moveMessage(42, 'INBOX', 'Sent Mail');

            expect(mockMessageMove).toHaveBeenCalledWith(42, 'Sent Mail', expect.objectContaining({ uid: true }));
        });

        test('appendMessage uses resolved path for both mailboxOpen and append after ensureFolders()', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            mockAppend.mockImplementation(() => Promise.resolve({ uid: 99 }));
            await connection.connect();
            await connection.ensureFolders();

            await connection.appendMessage('Sent Mail', Buffer.from('raw message'));

            expect(mockMailboxOpen).toHaveBeenCalledWith('Sent Mail');
            expect(mockAppend).toHaveBeenCalledWith('Sent Mail', expect.any(Buffer));
        });

        test('getMailboxCounts uses resolved path after ensureFolders() — Sent -> Sent Mail', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            mockStatus.mockImplementation(() => Promise.resolve({ messages: 5, unseen: 1 }));
            await connection.connect();
            await connection.ensureFolders();

            await connection.getMailboxCounts('Sent Mail');

            expect(mockStatus).toHaveBeenCalledWith('Sent Mail', expect.objectContaining({ messages: true, unseen: true }));
        });

        test('idle uses resolved path after ensureFolders() — Sent -> Sent Mail', async () => {
            mockList.mockImplementation(() => Promise.resolve(allFolders));
            mockIdle.mockImplementation(() => Promise.resolve());
            await connection.connect();
            await connection.ensureFolders();

            await connection.idle('Sent Mail');

            expect(mockMailboxOpen).toHaveBeenCalledWith('Sent Mail');
        });

        test('before ensureFolders(), resolveFolder returns the original folder path unchanged', async () => {
            // Without calling ensureFolders(), _resolvedPaths is empty — resolveFolder falls back to identity
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            await connection.fetchMessage('Sent Mail', 42);

            // Before ensureFolders() is called, 'Sent Mail' is passed through as-is
            expect(mockMailboxOpen).toHaveBeenCalledWith('Sent Mail');
        });

        // -------------------------------------------------------------------
        // Non-identity folder mapping — server path differs from EmailFolder
        // -------------------------------------------------------------------

        // Gmail-style fixture where the Sent folder has a vendor-prefixed server path
        const gmailFolders = [
            { path: 'INBOX',                  specialUse: '\\Inbox'   },
            { path: 'CleanInbox'                                       },  // custom, no flag
            { path: 'Drafts',                 specialUse: '\\Drafts'  },
            { path: 'Quarantine'                                       },  // custom, no flag
            { path: 'Review'                                           },  // custom, no flag
            { path: 'Junk',                   specialUse: '\\Junk'    },
            { path: 'Trash',                  specialUse: '\\Trash'   },
            { path: 'Archive',                specialUse: '\\Archive' },
            { path: '[Gmail]/Sent Mail',      specialUse: '\\Sent'    },  // Gmail uses a vendor-prefixed path
        ];

        test('fetchMessage uses actual server path after ensureFolders() — [Gmail]/Sent Mail non-identity mapping', async () => {
            // The logical folder name is 'Sent Mail' (EmailFolder.Sent) but the server path is '[Gmail]/Sent Mail'.
            // ensureFolders() must store the server path; resolveFolder() must translate the logical name.
            mockList.mockImplementation(() => Promise.resolve(gmailFolders));
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();
            await connection.ensureFolders();

            await connection.fetchMessage('Sent Mail', 42);

            // The IMAP call must use the server's actual path, NOT the logical 'Sent Mail'
            expect(mockMailboxOpen).toHaveBeenCalledWith('[Gmail]/Sent Mail');
        });

        test('moveMessage uses actual server path for toFolder after ensureFolders() — [Gmail]/Sent Mail non-identity mapping', async () => {
            mockList.mockImplementation(() => Promise.resolve(gmailFolders));
            mockMessageMove.mockImplementation(() => Promise.resolve({}));
            await connection.connect();
            await connection.ensureFolders();

            await connection.moveMessage(42, 'INBOX', 'Sent Mail');

            // The destination path passed to IMAP must be the server path, not the logical name
            expect(mockMessageMove).toHaveBeenCalledWith(42, '[Gmail]/Sent Mail', expect.objectContaining({ uid: true }));
        });

        test('appendMessage uses actual server path after ensureFolders() — [Gmail]/Sent Mail non-identity mapping', async () => {
            mockList.mockImplementation(() => Promise.resolve(gmailFolders));
            mockAppend.mockImplementation(() => Promise.resolve({ uid: 99 }));
            await connection.connect();
            await connection.ensureFolders();

            await connection.appendMessage('Sent Mail', Buffer.from('raw message'));

            expect(mockMailboxOpen).toHaveBeenCalledWith('[Gmail]/Sent Mail');
            expect(mockAppend).toHaveBeenCalledWith('[Gmail]/Sent Mail', expect.any(Buffer));
        });
    });

    // -------------------------------------------------------------------
    // parseHeaders edge cases (tested via fetchMessage)
    // -------------------------------------------------------------------
    describe('parseHeaders edge cases', () => {
        test('handles source with no blank line (uses entire buffer as header section)', async () => {
            // Source with no CRLF CRLF separator — entire buffer treated as headers
            const noBlankSource = Buffer.from(
                'Message-ID: <no-blank@example.com>\r\nFrom: Alice <alice@example.com>'
            );
            const fetchResult = {
                uid:      1,
                source:   noBlankSource,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'No blank',
                    messageId: undefined,
                    from:      [{ address: 'alice@example.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       1,
                    bodyParts: new Map([['1', Buffer.from('')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 1);

            // messageId comes from parsed header since envelope.messageId is undefined
            expect(result.messageId).toBe('<no-blank@example.com>');
        });

        test('ignores malformed header lines with no colon', async () => {
            const malformedSource = Buffer.from([
                'this line has no colon',
                'Message-ID: <good@example.com>',
                '',
                'body',
            ].join('\r\n'));
            const fetchResult = {
                uid:      2,
                source:   malformedSource,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'Test',
                    messageId: undefined,
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       2,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 2);

            expect(result.messageId).toBe('<good@example.com>');
        });

        test('ignores header lines where colon is at position 0 (empty name)', async () => {
            // colonIdx <= 0 means skip the line
            const emptyNameSource = Buffer.from([
                ': value-with-no-name',
                'Message-ID: <valid@example.com>',
                '',
                'body',
            ].join('\r\n'));
            const fetchResult = {
                uid:      3,
                source:   emptyNameSource,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'Test',
                    messageId: undefined,
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       3,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 3);

            expect(result.messageId).toBe('<valid@example.com>');
        });

        test('ignores unknown header names (only keeps tracked headers)', async () => {
            const withUnknownSource = Buffer.from([
                'X-Unknown-Header: should-be-ignored',
                'Message-ID: <tracked@example.com>',
                '',
                'body',
            ].join('\r\n'));
            const fetchResult = {
                uid:      4,
                source:   withUnknownSource,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'Test',
                    messageId: undefined,
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       4,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 4);

            expect(result.messageId).toBe('<tracked@example.com>');
            expect(result.headers).not.toHaveProperty('x-unknown-header');
        });

        test('only keeps first occurrence of a header (ignores duplicates)', async () => {
            const dupHeaderSource = Buffer.from([
                'Message-ID: <first@example.com>',
                'Message-ID: <second@example.com>',
                '',
                'body',
            ].join('\r\n'));
            const fetchResult = {
                uid:      5,
                source:   dupHeaderSource,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'Test',
                    messageId: undefined,
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       5,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 5);

            expect(result.messageId).toBe('<first@example.com>');
        });

        test('unfolds continuation headers (CRLF + whitespace)', async () => {
            const foldedSource = Buffer.from([
                'Subject: This is a very long subject\r\n that was folded',
                'Message-ID: <folded@example.com>',
                '',
                'body',
            ].join('\r\n'));
            const fetchResult = {
                uid:      6,
                source:   foldedSource,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   undefined,
                    messageId: undefined,
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       6,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 6);

            // Subject should have unfolded continuation
            expect(result.subject).toContain('This is a very long subject');
        });
    });

    // -------------------------------------------------------------------
    // extractBody edge cases (tested via fetchMessage)
    // -------------------------------------------------------------------
    describe('extractBody edge cases', () => {
        test('returns empty string body when bodyStructure is undefined', async () => {
            mockFetchOne.mockImplementationOnce(() => Promise.resolve({
                uid:      10,
                source:   Buffer.from('From: Alice <alice@example.com>'),
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'No body',
                    messageId: '<x@x.com>',
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: undefined,
            }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 10);

            expect(result.bodyText).toBe('');
        });

        test('converts html body when bodyStructure type is text/html', async () => {
            setupFetchOnePair(makeHtmlFetchResult(99), '1', HTML_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 99);

            // Should be plain text (html-to-text converted)
            expect(result.bodyText).not.toContain('<html>');
            expect(result.bodyText).not.toContain('<body>');
            expect(result.bodyText).toContain('Hello from HTML');
        });

        test('does not convert plain text body when bodyStructure type is text/plain', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.bodyText).toBe('Hello, world!');
        });

        test('truncates body exactly at maxBodySizeBytes boundary', async () => {
            const exactContent = _.repeat('a', 50);
            const smallConfig: ImapConnectionConfig = { ...DEFAULT_CONFIG, maxBodySizeBytes: 50 };
            const smallConn = new ImapConnection(smallConfig);
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:      11,
                    source:   Buffer.from(['From: x', '', exactContent].join('\r\n')),
                    envelope: {
                        date:      new Date(),
                        subject:   'Exact',
                        messageId: '<x@x.com>',
                        from:      [{ address: 'a@b.com' }],
                        to:        [],
                        cc:        [],
                    },
                    bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       11,
                    bodyParts: new Map([['1', Buffer.from(exactContent)]]),
                }));
            await smallConn.connect();

            const result = await smallConn.fetchMessage('INBOX', 11);

            // Exactly 50 bytes — should NOT be truncated (> check, not >=)
            expect(Buffer.byteLength(result.bodyText, 'utf8')).toBe(50);
        });

        test('truncates body when it exceeds maxBodySizeBytes by one byte', async () => {
            const overContent = _.repeat('a', 51);
            const smallConfig: ImapConnectionConfig = { ...DEFAULT_CONFIG, maxBodySizeBytes: 50 };
            const smallConn = new ImapConnection(smallConfig);
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:      12,
                    source:   Buffer.from(['From: x', '', overContent].join('\r\n')),
                    envelope: {
                        date:      new Date(),
                        subject:   'Over',
                        messageId: '<x@x.com>',
                        from:      [{ address: 'a@b.com' }],
                        to:        [],
                        cc:        [],
                    },
                    bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       12,
                    bodyParts: new Map([['1', Buffer.from(overContent)]]),
                }));
            await smallConn.connect();

            const result = await smallConn.fetchMessage('INBOX', 12);

            expect(Buffer.byteLength(result.bodyText, 'utf8')).toBe(50);
        });

        test('truncates multi-byte UTF-8 at a safe byte boundary', async () => {
            // '€' is 3 bytes (e2 82 ac), 'a' is 1 byte.
            // Body: 'aa€a' = 1+1+3+1 = 6 bytes.
            // With maxBodySizeBytes=4: end=4 lands on the 2nd byte of '€' (a continuation byte).
            // The safe boundary walk-back must return 'aa' (2 bytes), not a partial '€'.
            const euroSign    = '€';
            const bodyContent = `aa${euroSign}a`;
            const smallConfig: ImapConnectionConfig = { ...DEFAULT_CONFIG, maxBodySizeBytes: 4 };
            const smallConn = new ImapConnection(smallConfig);
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:      13,
                    source:   Buffer.from(['From: x', '', bodyContent].join('\r\n')),
                    envelope: {
                        date:      new Date(),
                        subject:   'UTF8',
                        messageId: '<x@x.com>',
                        from:      [{ address: 'a@b.com' }],
                        to:        [],
                        cc:        [],
                    },
                    bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       13,
                    bodyParts: new Map([['1', Buffer.from(bodyContent)]]),
                }));
            await smallConn.connect();

            const result = await smallConn.fetchMessage('INBOX', 13);

            // Result must be valid UTF-8 (no replacement characters) and not exceed maxBytes
            expect(Buffer.byteLength(result.bodyText, 'utf8')).toBeLessThanOrEqual(4);
            // The only safe truncation point is after the first two 'a' bytes (2 bytes)
            expect(result.bodyText).toBe('aa');
        });
    });

    // -------------------------------------------------------------------
    // hasAttachmentParts edge cases (tested via fetchMessage)
    // -------------------------------------------------------------------
    describe('hasAttachmentParts edge cases', () => {
        test('returns false when bodyStructure is undefined', async () => {
            mockFetchOne.mockImplementationOnce(() => Promise.resolve({
                uid:      20,
                source:   PLAIN_SOURCE,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'Test',
                    messageId: '<x@x.com>',
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: undefined,
            }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 20);

            expect(result.hasAttachments).toBe(false);
        });

        test('detects attachment in nested childNodes (recursive check)', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        {
                            type:       'multipart/alternative',
                            childNodes: [
                                { type: 'text/plain',      part: '1.1', childNodes: [] },
                                { type: 'application/pdf', part: '1.2', disposition: 'attachment', childNodes: [] },
                            ],
                        },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1.1', Buffer.from('nested body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.hasAttachments).toBe(true);
        });

        test('returns false when childNodes is absent and disposition is not attachment', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:        'text/plain',
                    part:        '1',
                    disposition: 'inline',
                    // No childNodes property
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from('inline body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.hasAttachments).toBe(false);
        });

        test('detects attachment when root bodyStructure disposition is attachment', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:        'application/pdf',
                    part:        '1',
                    disposition: 'Attachment', // case-insensitive check
                    childNodes:  [],
                },
            };
            // No text part — only one fetchOne call
            mockFetchOne.mockImplementationOnce(() => Promise.resolve(fetchResult));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.hasAttachments).toBe(true);
        });
    });

    // -------------------------------------------------------------------
    // fetchAttachments / findAttachmentParts (tested via fetchMessage)
    // -------------------------------------------------------------------
    describe('fetchAttachments (via fetchMessage)', () => {
        test('returns empty attachments array for plain-text email', async () => {
            setupFetchOnePair(makePlainFetchResult(), '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toEqual([]);
        });

        test('returns empty attachments array when bodyStructure is undefined', async () => {
            mockFetchOne.mockImplementationOnce(() => Promise.resolve({
                uid:      20,
                source:   PLAIN_SOURCE,
                envelope: {
                    date:      new Date('2024-01-01'),
                    subject:   'Test',
                    messageId: '<x@x.com>',
                    from:      [{ address: 'a@b.com' }],
                    to:        [],
                    cc:        [],
                },
                bodyStructure: undefined,
            }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 20);

            expect(result.attachments).toEqual([]);
        });

        test('fetches a single attachment from multipart/mixed message', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain',      part: '1', childNodes: [] },
                        {
                            type:                  'application/pdf',
                            part:                  '2',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'report.pdf' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            const pdfData = Buffer.from('fake-pdf-data');
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', pdfData]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(1);
            expect(result.attachments[0]?.filename).toBe('report.pdf');
            expect(result.attachments[0]?.contentType).toBe('application/pdf');
            expect(result.attachments[0]?.data).toEqual(pdfData);
        });

        test('fetches multiple attachments from multipart/mixed message', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain', part: '1', childNodes: [] },
                        {
                            type:                  'application/pdf',
                            part:                  '2',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'report.pdf' },
                            childNodes:            [],
                        },
                        {
                            type:                  'image/jpeg',
                            part:                  '3',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'photo.jpg' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            const pdfData  = Buffer.from('pdf-bytes');
            const jpegData = Buffer.from('jpeg-bytes');
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', pdfData]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['3', jpegData]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(2);
            expect(result.attachments[0]?.filename).toBe('report.pdf');
            expect(result.attachments[0]?.contentType).toBe('application/pdf');
            expect(result.attachments[1]?.filename).toBe('photo.jpg');
            expect(result.attachments[1]?.contentType).toBe('image/jpeg');
        });

        test('uses fallback filename "attachment" when dispositionParameters has no filename', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain',      part: '1', childNodes: [] },
                        {
                            type:        'application/octet-stream',
                            part:        '2',
                            disposition: 'attachment',
                            // No dispositionParameters
                            childNodes:  [],
                        },
                    ],
                },
            };
            const data = Buffer.from('raw-data');
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', data]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(1);
            expect(result.attachments[0]?.filename).toBe('attachment');
        });

        test('finds attachment using name parameter when filename is absent', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain', part: '1', childNodes: [] },
                        {
                            type:                  'application/pdf',
                            part:                  '2',
                            disposition:           'attachment',
                            dispositionParameters: { name: 'named.pdf' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            const pdfData = Buffer.from('pdf-data');
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', pdfData]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(1);
            expect(result.attachments[0]?.filename).toBe('named.pdf');
        });

        test('skips attachment when fetchOne returns false for that part', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain', part: '1', childNodes: [] },
                        {
                            type:                  'application/pdf',
                            part:                  '2',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'report.pdf' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve(false)); // Attachment fetch returns false
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            // Attachment is skipped (no part data)
            expect(result.attachments).toHaveLength(0);
        });

        test('skips attachment when bodyParts map does not contain the part', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain', part: '1', childNodes: [] },
                        {
                            type:                  'application/pdf',
                            part:                  '2',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'report.pdf' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map(), // Empty — part '2' missing
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(0);
        });

        test('finds attachment in nested multipart structure', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:       'multipart/mixed',
                    childNodes: [
                        {
                            type:       'multipart/alternative',
                            childNodes: [
                                { type: 'text/plain', part: '1.1', childNodes: [] },
                                { type: 'text/html',  part: '1.2', childNodes: [] },
                            ],
                        },
                        {
                            type:                  'application/pdf',
                            part:                  '2',
                            disposition:           'attachment',
                            dispositionParameters: { filename: 'nested.pdf' },
                            childNodes:            [],
                        },
                    ],
                },
            };
            const pdfData = Buffer.from('nested-pdf');
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1.1', Buffer.from(PLAIN_BODY_CONTENT)]]),
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['2', pdfData]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(1);
            expect(result.attachments[0]?.filename).toBe('nested.pdf');
            expect(result.attachments[0]?.data).toEqual(pdfData);
        });

        test('uses part "1" as fallback when bodyStructure.part is absent for attachment', async () => {
            const fetchResult = {
                ...makePlainFetchResult(),
                bodyStructure: {
                    type:                  'application/pdf',
                    // No part field
                    disposition:           'attachment',
                    dispositionParameters: { filename: 'nopart.pdf' },
                    childNodes:            [],
                },
            };
            const pdfData = Buffer.from('nopart-pdf');
            // Only one fetchOne call for a single-part attachment with no text part
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve(fetchResult))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       42,
                    bodyParts: new Map([['1', pdfData]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.attachments).toHaveLength(1);
            expect(result.attachments[0]?.filename).toBe('nopart.pdf');
            expect(result.attachments[0]?.data).toEqual(pdfData);
        });
    });

    // -------------------------------------------------------------------
    // mapAddresses edge cases (tested via fetchMessage/listUnread)
    // -------------------------------------------------------------------
    describe('mapAddresses edge cases', () => {
        test('returns empty array when addrs is undefined', async () => {
            const fetchResult = makePlainFetchResult();
            fetchResult.envelope.cc = undefined as unknown as typeof fetchResult.envelope.cc;
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.cc).toEqual([]);
        });

        test('returns address without name when name is absent', async () => {
            const fetchResult = makePlainFetchResult();
            (fetchResult.envelope as { to: unknown }).to = [{ address: 'noname@example.com' }];
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.to).toEqual([{ address: 'noname@example.com' }]);
            expect(result.to[0]).not.toHaveProperty('name');
        });

        test('returns empty string for address when address field is undefined', async () => {
            const fetchResult = makePlainFetchResult();
            (fetchResult.envelope as { to: unknown }).to = [{ name: 'No Address' }];
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.to).toEqual([{ name: 'No Address', address: '' }]);
        });
    });

    // -------------------------------------------------------------------
    // toEmailMetadata fallback logic (tested via fetchMessage)
    // -------------------------------------------------------------------
    describe('toEmailMetadata fallback logic', () => {
        test('falls back to header message-id when envelope.messageId is falsy', async () => {
            const fetchResult = makePlainFetchResult();
            fetchResult.envelope.messageId = undefined as unknown as string;
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            // messageId from parsed header
            expect(result.messageId).toBe('<abc123@example.com>');
        });

        test('returns empty string messageId when both envelope and header are missing', async () => {
            const noMsgIdSource = Buffer.from([
                'From: Alice <alice@example.com>',
                '',
                'body',
            ].join('\r\n'));
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:      30,
                    source:   noMsgIdSource,
                    envelope: {
                        date:      new Date('2024-01-01'),
                        subject:   'No ID',
                        messageId: undefined,
                        from:      [{ address: 'a@b.com' }],
                        to:        [],
                        cc:        [],
                    },
                    bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       30,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 30);

            expect(result.messageId).toBe('');
        });

        test('falls back to header subject when envelope.subject is falsy', async () => {
            const fetchResult = makePlainFetchResult();
            fetchResult.envelope.subject = undefined as unknown as string;
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.subject).toBe('Hello');
        });

        test('falls back to Date(headers.date) when envelope.date is falsy', async () => {
            const fetchResult = makePlainFetchResult();
            fetchResult.envelope.date = undefined as unknown as Date;
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.date).toEqual(new Date('Mon, 01 Jan 2024 12:00:00 +0000'));
        });

        test('returns empty address for from when from array is empty', async () => {
            const fetchResult = makePlainFetchResult();
            fetchResult.envelope.from = [];
            setupFetchOnePair(fetchResult, '1', PLAIN_BODY_CONTENT);
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 42);

            expect(result.from).toEqual({ address: '' });
        });

        test('uses Date(0) for date when envelope.date is falsy and header date is missing', async () => {
            const noDateSource = Buffer.from([
                'From: Alice <alice@example.com>',
                '',
                'body',
            ].join('\r\n'));
            mockFetchOne
                .mockImplementationOnce(() => Promise.resolve({
                    uid:      31,
                    source:   noDateSource,
                    envelope: {
                        date:      undefined,
                        subject:   'No date',
                        messageId: '<x@x.com>',
                        from:      [{ address: 'a@b.com' }],
                        to:        [],
                        cc:        [],
                    },
                    bodyStructure: { type: 'text/plain', part: '1', childNodes: [] },
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    uid:       31,
                    bodyParts: new Map([['1', Buffer.from('body')]]),
                }));
            await connection.connect();

            const result = await connection.fetchMessage('INBOX', 31);

            // new Date(undefined) is Invalid Date, new Date(0) is epoch
            // The fallback is `new Date(headers.date ?? 0)` which is `new Date(0)` when header date missing
            expect(result.date).toEqual(new Date(0));
        });
    });

    // -------------------------------------------------------------------
    // Error message content and re-throw tests
    // -------------------------------------------------------------------
    describe('error message content and re-throw behavior', () => {
        test('fetchMessage: "not found" error message includes uid and folder', async () => {
            mockFetchOne.mockImplementation(() => Promise.resolve(false));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('MyFolder', 777)).rejects.toThrow('777');
        });

        test('fetchMessage: "not found" error message includes folder name', async () => {
            mockFetchOne.mockImplementation(() => Promise.resolve(false));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('MyFolder', 777)).rejects.toThrow('MyFolder');
        });

        test('fetchMessage: wrap error message includes folder and uid context', async () => {
            mockFetchOne.mockImplementation(() => Promise.reject(new Error('conn reset')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('MyFolder', 777)).rejects.toThrow('MyFolder');
        });

        test('fetchMessage: re-throws ImapConnectionError from inner throw without double-wrapping', async () => {
            mockFetchOne.mockImplementation(() => Promise.resolve(false));
            await connection.connect();

            // When !msg throws ImapConnectionError, it must be re-thrown as-is — not wrapped in "fetchMessage failed"
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('INBOX', 999)).rejects.toThrow('not found in INBOX');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchMessage('INBOX', 999)).rejects.not.toThrow('fetchMessage failed');
        });

        test('fetchNewMessages: re-throws ImapConnectionError without double-wrapping', async () => {
            // Simulate an ImapConnectionError thrown inside the try block
            // by making mailboxOpen throw one
            mockMailboxOpen.mockImplementation(() => Promise.reject(
                new ImapConnectionError('inner-imap-unique-token')
            ));
            await connection.connect();

            // Should re-throw with original message, not wrapped in "fetchNewMessages failed"
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchNewMessages('INBOX', 0)).rejects.toThrow('inner-imap-unique-token');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchNewMessages('INBOX', 0)).rejects.not.toThrow('fetchNewMessages failed');
        });

        test('fetchNewMessages: wrap error message includes folder and sinceUid context', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(new Error('oops')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.fetchNewMessages('MyFolder', 55)).rejects.toThrow('fetchNewMessages failed');
        });

        test('listUnread: re-throws ImapConnectionError without double-wrapping', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(
                new ImapConnectionError('inner-listunread-unique-token')
            ));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.listUnread('INBOX')).rejects.toThrow('inner-listunread-unique-token');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.listUnread('INBOX')).rejects.not.toThrow('listUnread failed');
        });

        test('listUnread: wrap error message includes folder context', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(new Error('oops')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.listUnread('SpecialFolder')).rejects.toThrow('listUnread failed');
        });

        test('moveMessage: re-throws ImapConnectionError without double-wrapping', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(
                new ImapConnectionError('inner-movemessage-unique-token')
            ));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.moveMessage(42, 'INBOX', 'Archive')).rejects.toThrow('inner-movemessage-unique-token');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.moveMessage(42, 'INBOX', 'Archive')).rejects.not.toThrow('moveMessage failed');
        });

        test('moveMessage: wrap error message includes uid, from, and to context', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(new Error('oops')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.moveMessage(99, 'FromBox', 'ToBox')).rejects.toThrow('moveMessage failed');
        });

        test('setFlag: re-throws ImapConnectionError without double-wrapping', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(
                new ImapConnectionError('inner-setflag-unique-token')
            ));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.setFlag(42, 'INBOX', '\\Seen')).rejects.toThrow('inner-setflag-unique-token');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.setFlag(42, 'INBOX', '\\Seen')).rejects.not.toThrow('setFlag failed');
        });

        test('setFlag: wrap error message includes uid, folder, and flag context', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.reject(new Error('oops')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.setFlag(77, 'FlagFolder', '\\Flagged')).rejects.toThrow('setFlag failed');
        });

        test('listUnread: returns default date (epoch) when message has no date', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([42]));
            mockFetchAll.mockImplementation(() => Promise.resolve([{
                uid:      42,
                envelope: {
                    from:    [{ name: 'Alice', address: 'alice@example.com' }],
                    subject: 'Test',
                    date:    undefined,
                },
            }]));
            await connection.connect();

            const result = await connection.listUnread('INBOX');

            expect(result[0].date).toEqual(new Date(0));
        });

        test('listUnread: returns empty string subject when message has no subject', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([42]));
            mockFetchAll.mockImplementation(() => Promise.resolve([{
                uid:      42,
                envelope: {
                    from:    [{ name: 'Alice', address: 'alice@example.com' }],
                    subject: undefined,
                    date:    new Date('2024-01-01'),
                },
            }]));
            await connection.connect();

            const result = await connection.listUnread('INBOX');

            expect(result[0].subject).toBe('');
        });

        test('listUnread: returns default address when message has no from', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([42]));
            mockFetchAll.mockImplementation(() => Promise.resolve([{
                uid:      42,
                envelope: {
                    from:    undefined,
                    subject: 'Test',
                    date:    new Date('2024-01-01'),
                },
            }]));
            await connection.connect();

            const result = await connection.listUnread('INBOX');

            expect(result[0].from).toEqual({ address: '' });
        });
    });

    // -------------------------------------------------------------------
    // serialize queue
    // -------------------------------------------------------------------
    describe('serialize queue', () => {
        test('serializes concurrent operations — second call waits for first', async () => {
            const order: string[] = [];
            let firstResolve!: () => void;

            // First mailboxOpen blocks until we resolve it
            mockMailboxOpen
                .mockImplementationOnce(() => new Promise<unknown>((resolve) => {
                    order.push('first-start');
                    firstResolve = () => {
                        order.push('first-done');
                        resolve({ path: 'INBOX' });
                    };
                }))
                .mockImplementationOnce(() => {
                    order.push('second-start');
                    return Promise.resolve({ path: 'INBOX' });
                });

            mockFetchAll.mockImplementation(() => Promise.resolve([]));
            mockSearch.mockImplementation(() => Promise.resolve([]));
            await connection.connect();

            // Start two concurrent operations
            const p1 = connection.listUnread('INBOX');
            const p2 = connection.listUnread('INBOX');

            // Let p1's mailboxOpen call get submitted
            await Promise.resolve();
            await Promise.resolve();

            // At this point first-start should be in order, second should not have started
            expect(order).toContain('first-start');
            expect(order).not.toContain('second-start');

            // Unblock first
            firstResolve();
            await p1;

            // Now second should run
            await p2;

            expect(order).toEqual(['first-start', 'first-done', 'second-start']);
        });

        test('queue recovers after failed operation — subsequent calls still execute', async () => {
            let callCount = 0;
            mockMailboxOpen.mockImplementation(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('transient failure'));
                }
                return Promise.resolve({ path: 'INBOX' });
            });
            mockSearch.mockImplementation(() => Promise.resolve([]));
            await connection.connect();

            // First call fails
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.listUnread('INBOX')).rejects.toBeInstanceOf(ImapConnectionError);

            // Second call should still succeed (queue advanced past the failure)
            const result = await connection.listUnread('INBOX');

            expect(result).toEqual([]);
            expect(callCount).toBe(2);
        });
    });

    // -------------------------------------------------------------------
    // idle() and cancelIdle()
    // -------------------------------------------------------------------
    describe('idle() and cancelIdle()', () => {
        test('idle() opens folder and calls client.idle()', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.resolve({ path: 'INBOX' }));
            mockIdle.mockImplementation(() => Promise.resolve());
            await connection.connect();

            await connection.idle('INBOX');

            expect(mockMailboxOpen).toHaveBeenCalledWith('INBOX');
            expect(mockIdle).toHaveBeenCalledTimes(1);
        });

        test('cancelIdle() resolves the idle() promise early', async () => {
            let idleResolve!: () => void;
            mockMailboxOpen.mockImplementation(() => Promise.resolve({ path: 'INBOX' }));
            mockIdle.mockImplementation(() => new Promise<void>((resolve) => {
                idleResolve = resolve;
            }));
            await connection.connect();

            // Start idle but don't let client.idle() resolve naturally
            const idlePromise = connection.idle('INBOX');

            // Give the serializer time to enter the idle body
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Cancel IDLE — should cause idle() to resolve early
            connection.cancelIdle();

            // idle() should now resolve
            await idlePromise;

            // Clean up: resolve the lingering imapflow idle promise too
            idleResolve();
        });

        test('cancelIdle() is a no-op when no IDLE in progress', () => {
            // Should not throw
            const doCancel = (): void => {
                connection.cancelIdle();
            };
            expect(doCancel).not.toThrow();
        });

        test('idle() clears _idleAbort after completion', async () => {
            mockMailboxOpen.mockImplementation(() => Promise.resolve({ path: 'INBOX' }));
            mockIdle.mockImplementation(() => Promise.resolve());
            await connection.connect();

            // After idle() completes naturally, cancelIdle() should be a no-op
            await connection.idle('INBOX');

            // Should not throw — _idleAbort was cleared
            const doCancel = (): void => {
                connection.cancelIdle();
            };
            expect(doCancel).not.toThrow();
        });

        test('idle() goes through the serialize queue', async () => {
            const order: string[] = [];
            let blockResolve!: () => void;

            // Block the first operation (connect runs in queue too, so make a blocking listUnread)
            mockMailboxOpen
                .mockImplementationOnce(() => {
                    order.push('listUnread-start');
                    return new Promise<unknown>((resolve) => {
                        blockResolve = () => {
                            order.push('listUnread-done');
                            resolve({ path: 'INBOX' });
                        };
                    });
                })
                .mockImplementationOnce(() => {
                    order.push('idle-start');
                    return Promise.resolve({ path: 'INBOX' });
                });
            mockSearch.mockImplementation(() => Promise.resolve([]));
            mockIdle.mockImplementation(() => Promise.resolve());
            await connection.connect();

            const p1 = connection.listUnread('INBOX');
            const p2 = connection.idle('INBOX');

            await Promise.resolve();
            await Promise.resolve();

            expect(order).toContain('listUnread-start');
            expect(order).not.toContain('idle-start');

            blockResolve();
            await p1;
            await p2;

            expect(order).toEqual(['listUnread-start', 'listUnread-done', 'idle-start']);
        });

        test('serialize() calls cancelIdle() before executing new operations — IDLE resolves without external trigger', async () => {
            // This test verifies that calling serialize() cancels an in-progress IDLE
            // via the _idleAbort mechanism. Without cancelIdle() in serialize(), the
            // idle promise would block the queue indefinitely and listPromise would hang.
            const order: string[] = [];

            mockMailboxOpen.mockImplementation(() => Promise.resolve({ path: 'INBOX' }));
            // idle() blocks forever unless cancelIdle() is called — no external resolve
            mockIdle.mockImplementation(() => new Promise<void>((resolve) => {
                order.push('idle-started');
                // This promise never resolves on its own — only cancelIdle() can unblock it
                // via the _idleAbort mechanism in connection.idle()
                void resolve; // suppress unused warning; intentionally never called here
            }));
            mockSearch.mockImplementation(() => {
                order.push('listUnread-ran');
                return Promise.resolve([]);
            });
            await connection.connect();

            // Start idle in background — holds the queue with a never-resolving promise
            const idlePromise = connection.idle('INBOX');

            // Give serializer time to enter the idle body and set _idleAbort
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(order).toContain('idle-started');

            // Enqueue listUnread — if serialize() calls cancelIdle(), the idle promise
            // resolves via _idleAbort and listUnread can run.
            // Without the fix, listPromise would hang indefinitely.
            const listPromise = connection.listUnread('INBOX');

            // Flush microtasks so cancelIdle() is called and _idleAbort fires
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            await idlePromise;
            await listPromise;

            expect(order).toContain('listUnread-ran');
            expect(order.indexOf('idle-started')).toBeLessThan(order.indexOf('listUnread-ran'));
        });
    });

    // -------------------------------------------------------------------
    // getMailboxCounts
    // -------------------------------------------------------------------
    describe('getMailboxCounts()', () => {
        test('calls client.status() with messages and unseen true, returns both counts', async () => {
            mockStatus.mockImplementation(() => Promise.resolve({ messages: 20, unseen: 5 }));
            await connection.connect();

            const result = await connection.getMailboxCounts('CleanInbox');

            expect(mockStatus).toHaveBeenCalledWith('CleanInbox', { messages: true, unseen: true });
            expect(result).toEqual({ total: 20, unread: 5 });
        });

        test('returns { total: 0, unread: 0 } when status fields are undefined', async () => {
            mockStatus.mockImplementation(() => Promise.resolve({}));
            await connection.connect();

            const result = await connection.getMailboxCounts('CleanInbox');

            expect(result).toEqual({ total: 0, unread: 0 });
        });

        test('returns 0 for total when messages field is undefined', async () => {
            mockStatus.mockImplementation(() => Promise.resolve({ unseen: 3 }));
            await connection.connect();

            const result = await connection.getMailboxCounts('CleanInbox');

            expect(result.total).toBe(0);
            expect(result.unread).toBe(3);
        });

        test('returns 0 for unread when unseen field is undefined', async () => {
            mockStatus.mockImplementation(() => Promise.resolve({ messages: 7 }));
            await connection.connect();

            const result = await connection.getMailboxCounts('CleanInbox');

            expect(result.total).toBe(7);
            expect(result.unread).toBe(0);
        });

        test('wraps non-ImapConnectionError as ImapConnectionError', async () => {
            mockStatus.mockImplementation(() => Promise.reject(new Error('STATUS failed')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.getMailboxCounts('CleanInbox')).rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('error message includes folder context', async () => {
            mockStatus.mockImplementation(() => Promise.reject(new Error('oops')));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.getMailboxCounts('MyFolder')).rejects.toThrow('getMailboxCounts failed (folder=MyFolder)');
        });

        test('re-throws ImapConnectionError without wrapping', async () => {
            mockStatus.mockImplementation(() => Promise.reject(
                new ImapConnectionError('inner-getmailboxcounts-unique-token')
            ));
            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.getMailboxCounts('CleanInbox')).rejects.toThrow('inner-getmailboxcounts-unique-token');
            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.getMailboxCounts('CleanInbox')).rejects.not.toThrow('getMailboxCounts failed');
        });

        test('goes through serialize queue — waits for prior operation', async () => {
            const order: string[] = [];
            let blockResolve!: () => void;

            mockMailboxOpen
                .mockImplementationOnce(() => {
                    order.push('listUnread-start');
                    return new Promise<unknown>((resolve) => {
                        blockResolve = () => {
                            order.push('listUnread-done');
                            resolve({ path: 'CleanInbox' });
                        };
                    });
                });
            mockSearch.mockImplementation(() => Promise.resolve([]));
            mockStatus.mockImplementation(() => {
                order.push('status-start');
                return Promise.resolve({ messages: 8, unseen: 2 });
            });
            await connection.connect();

            const p1 = connection.listUnread('CleanInbox');
            const p2 = connection.getMailboxCounts('CleanInbox');

            await Promise.resolve();
            await Promise.resolve();

            expect(order).toContain('listUnread-start');
            expect(order).not.toContain('status-start');

            blockResolve();
            await p1;
            await p2;

            expect(order).toEqual(['listUnread-start', 'listUnread-done', 'status-start']);
        });
    });

    // -------------------------------------------------------------------
    // appendMessage
    // -------------------------------------------------------------------
    describe('appendMessage', () => {
        test('should open mailbox and call append with folder and buffer', async () => {
            mockAppend.mockImplementation(() => Promise.resolve({ uid: 77 }));

            await connection.connect();
            const rawMsg = Buffer.from('raw-message');
            const uid    = await connection.appendMessage('Drafts', rawMsg);

            expect(mockMailboxOpen).toHaveBeenCalledWith('Drafts');
            expect(mockAppend).toHaveBeenCalledWith('Drafts', rawMsg);
            expect(uid).toBe(77);
        });

        test('should throw ImapConnectionError when append result has no uid (UIDPLUS required)', async () => {
            mockAppend.mockImplementation(() => Promise.resolve({}));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.appendMessage('Drafts', Buffer.from('msg')))
                .rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('should throw ImapConnectionError with UIDPLUS message when uid is absent', async () => {
            mockAppend.mockImplementation(() => Promise.resolve({}));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.appendMessage('Drafts', Buffer.from('msg')))
                .rejects.toThrow('UIDPLUS');
        });

        test('should throw ImapConnectionError on failure', async () => {
            mockAppend.mockImplementation(() => Promise.reject(new Error('APPEND failed')));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.appendMessage('Drafts', Buffer.from('msg')))
                .rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('should re-throw ImapConnectionError without wrapping', async () => {
            const original = new ImapConnectionError('already wrapped');
            mockAppend.mockImplementation(() => Promise.reject(original));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.appendMessage('Drafts', Buffer.from('msg')))
                .rejects.toBe(original);
        });
    });

    // -------------------------------------------------------------------
    // searchByFlag
    // -------------------------------------------------------------------
    describe('searchByFlag', () => {
        test('should open mailbox and search by keyword', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([10, 20, 30]));

            await connection.connect();
            const uids = await connection.searchByFlag('Drafts', '\\SendRejectedByAdmin');

            expect(mockMailboxOpen).toHaveBeenCalledWith('Drafts');
            expect(mockSearch).toHaveBeenCalledWith({ keyword: '\\SendRejectedByAdmin' }, { uid: true });
            expect(uids).toEqual([10, 20, 30]);
        });

        test('should return empty array when search returns no results', async () => {
            mockSearch.mockImplementation(() => Promise.resolve([]));

            await connection.connect();
            const uids = await connection.searchByFlag('Drafts', '\\TestFlag');

            expect(uids).toEqual([]);
        });

        test('should return empty array when search returns null/undefined', async () => {
            mockSearch.mockImplementation(() => Promise.resolve(null));

            await connection.connect();
            const uids = await connection.searchByFlag('Drafts', '\\TestFlag');

            expect(uids).toEqual([]);
        });

        test('should throw ImapConnectionError on failure', async () => {
            mockSearch.mockImplementation(() => Promise.reject(new Error('SEARCH failed')));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.searchByFlag('Drafts', '\\Flag'))
                .rejects.toBeInstanceOf(ImapConnectionError);
        });

        test('should re-throw ImapConnectionError without wrapping', async () => {
            const original = new ImapConnectionError('already wrapped');
            mockSearch.mockImplementation(() => Promise.reject(original));

            await connection.connect();

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(connection.searchByFlag('Drafts', '\\Flag'))
                .rejects.toBe(original);
        });
    });
});
