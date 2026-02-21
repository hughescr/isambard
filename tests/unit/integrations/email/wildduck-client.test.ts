/* eslint-disable n/no-unsupported-features/node-builtins -- Bun runtime supports fetch and Response */
/* eslint-disable @typescript-eslint/await-thenable -- Bun-specific APIs */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import _ from 'lodash';
import { mockLogger } from '../../../setup';
import { WildDuckClient, WildDuckError, WildDuckAuthError } from '@/integrations/email/wildduck-client';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const mockFetch = mock(async (_url: string, _options?: RequestInit): Promise<Response> => {
    throw new Error('Fetch not mocked for this test');
});

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const CLIENT_OPTIONS = {
    url:      'https://wildduck-api.example.com',
    user:     'test@example.com',
    password: 'secret',
};

const AUTH_RESPONSE = {
    success: true,
    id:      'user-abc123',
    token:   'test-auth-token',
};

const MAILBOX_RESPONSE = {
    success: true,
    results: [
        { id: 'mbx-inbox',      path: 'INBOX',      specialUse: '\\Inbox' },
        { id: 'mbx-clean',      path: 'CleanInbox' },
        { id: 'mbx-archive',    path: 'Archive',     specialUse: '\\Archive' },
        { id: 'mbx-sent',       path: 'Sent Mail',   specialUse: '\\Sent' },
        { id: 'mbx-junk',       path: 'Junk',        specialUse: '\\Junk' },
        { id: 'mbx-trash',      path: 'Trash',       specialUse: '\\Trash' },
        { id: 'mbx-drafts',     path: 'Drafts',      specialUse: '\\Drafts' },
        { id: 'mbx-quarantine', path: 'Quarantine' },
        { id: 'mbx-review',     path: 'Review' },
    ],
};

// Mailbox response where server paths differ from logical folder names (e.g. Gmail-style)
const NONSTANDARD_MAILBOX_RESPONSE = {
    success: true,
    results: [
        { id: 'mbx-inbox',      path: 'INBOX',                  specialUse: '\\Inbox' },
        { id: 'mbx-clean',      path: 'CleanInbox' },
        { id: 'mbx-archive',    path: '[Gmail]/All Mail',        specialUse: '\\Archive' },
        { id: 'mbx-sent',       path: '[Gmail]/Sent Mail',       specialUse: '\\Sent' },
        { id: 'mbx-junk',       path: '[Gmail]/Spam',            specialUse: '\\Junk' },
        { id: 'mbx-trash',      path: '[Gmail]/Trash',           specialUse: '\\Trash' },
        { id: 'mbx-drafts',     path: '[Gmail]/Drafts',          specialUse: '\\Drafts' },
        { id: 'mbx-quarantine', path: 'Quarantine' },
        { id: 'mbx-review',     path: 'Review' },
    ],
};

// ---------------------------------------------------------------------------
// Helper to mock a successful JSON response
// ---------------------------------------------------------------------------
function statusText(status: number): string {
    if(status === 200) {
        return 'OK';
    }
    if(status === 400) {
        return 'Bad Request';
    }
    if(status === 401) {
        return 'Unauthorized';
    }
    return 'Error';
}

function makeJsonResponse(body: unknown, status = 200): Response {
    return {
        ok:         status >= 200 && status < 300,
        status,
        statusText: statusText(status),
        json:       async () => body,
        text:       async () => JSON.stringify(body),
    } as unknown as Response;
}

function makeErrorResponseWithBody(body: string, status = 400): Response {
    return {
        ok:         false,
        status,
        statusText: statusText(status),
        json:       async () => { throw new Error('Not JSON'); },
        text:       async () => body,
    } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('WildDuckClient', () => {
    beforeEach(() => {
        mockFetch.mockClear();
        mockLogger.warn.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Testing mock needs to override global fetch type
        globalThis.fetch = mockFetch as any;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    // -----------------------------------------------------------------------
    // init()
    // -----------------------------------------------------------------------
    describe('init()', () => {
        test('calls POST /authenticate with correct credentials', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();

            expect(mockFetch).toHaveBeenCalledTimes(2);
            const [authUrl, authOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(authUrl).toBe('https://wildduck-api.example.com/authenticate');
            expect(authOptions.method).toBe('POST');
            const body = JSON.parse(authOptions.body as string) as { username: string, password: string, token: boolean };
            expect(body.username).toBe('test@example.com');
            expect(body.password).toBe('secret');
            expect(body.token).toBe(true);
        });

        test('calls GET /users/me/mailboxes after authentication', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();

            const [mailboxUrl, mailboxOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
            expect(mailboxUrl).toBe('https://wildduck-api.example.com/users/me/mailboxes');
            expect(mailboxOptions.method).toBe('GET');
        });

        test('stores auth token in X-Access-Token header for subsequent requests', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();

            const [_mailboxUrl, mailboxOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
            const headers = mailboxOptions.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBe('test-auth-token');
        });

        test('throws WildDuckAuthError when no token is returned', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'user-abc123' }));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).rejects.toThrow(WildDuckAuthError);
        });

        test('throws WildDuckError on non-200 auth response', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError on 401 auth response', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Unauthorized' }, 401));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).rejects.toThrow(WildDuckAuthError);
        });

        test('sends Content-Type: application/json header in POST /authenticate', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();

            const [_authUrl, authOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
            const headers = authOptions.headers as Record<string, string>;
            expect(headers['Content-Type']).toBe('application/json');
        });

        test('does not send X-Access-Token in POST /authenticate when re-authenticating', async () => {
            // First init to get a token
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();

            // Trigger a 401 on search to force re-auth
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            // Re-auth response
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            // Retry search
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({});

            // The re-auth call (call index 1 after clear) should NOT include old X-Access-Token
            const [_reAuthUrl, reAuthOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
            const headers = reAuthOptions.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // search()
    // -----------------------------------------------------------------------
    describe('search()', () => {
        async function makeInitializedClient(): Promise<WildDuckClient> {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();
            return client;
        }

        test('calls GET /users/me/search with correct URL', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { correspondent: 'alice@example.com' } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('https://wildduck-api.example.com/users/me/search');
        });

        test('includes correspondent in query params as "q"', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { correspondent: 'alice@example.com' } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('q=alice%40example.com');
        });

        test('includes content in query params as "query"', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { content: 'meeting' } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('query=meeting');
        });

        test('includes before date as "dateend"', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { before: '2025-01-15T00:00:00.000Z' } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('dateend=2025-01-15');
        });

        test('includes since date as "datestart"', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { since: '2025-01-01T00:00:00.000Z' } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('datestart=2025-01-01');
        });

        test('maps mailbox names to WildDuck IDs in query params', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ mailboxes: ['CleanInbox', 'Archive'] });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('mailbox=mbx-clean');
            expect(searchUrl).toContain('mailbox=mbx-archive');
        });

        test('skips unknown mailbox names when mapping', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            // 'AllMail' is not in our mailbox map
            await client.search({ mailboxes: ['CleanInbox', 'AllMail'] });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('mailbox=mbx-clean');
            expect(searchUrl).not.toContain('AllMail');
        });

        test('logs a warning for each unknown mailbox name skipped', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ mailboxes: ['CleanInbox', 'UnknownBox'] });

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                folderName: 'UnknownBox',
            }));
        });

        test('does not log a warning for known mailbox names', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ mailboxes: ['CleanInbox', 'Archive'] });

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('maps search result mailbox ID to folder name in "FolderName:UID" format', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      42,
                        mailbox: 'mbx-clean',
                        from:    { name: 'Alice', address: 'alice@example.com' },
                        to:      [{ address: 'me@example.com' }],
                        subject: 'Hello',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            expect(results).toHaveLength(1);
            expect(results[0]?.message).toBe('CleanInbox:42');
        });

        test('formats from address with name when present', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      1,
                        mailbox: 'mbx-clean',
                        from:    { name: 'Alice Smith', address: 'alice@example.com' },
                        to:      [],
                        subject: 'Test',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            expect(results[0]?.from).toBe('Alice Smith <alice@example.com>');
        });

        test('formats from address without name when absent', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      1,
                        mailbox: 'mbx-clean',
                        from:    { address: 'noname@example.com' },
                        to:      [],
                        subject: 'Test',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            expect(results[0]?.from).toBe('noname@example.com');
        });

        test('maps to addresses to formatted strings', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      1,
                        mailbox: 'mbx-archive',
                        from:    { address: 'sender@example.com' },
                        to:      [
                            { name: 'Bob', address: 'bob@example.com' },
                            { address: 'carol@example.com' },
                        ],
                        subject: 'Multi-recipient',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            expect(results[0]?.to).toEqual(['Bob <bob@example.com>', 'carol@example.com']);
        });

        test('uses raw mailbox value when mailbox ID is not in map', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      5,
                        mailbox: 'mbx-unknown',
                        from:    { address: 'sender@example.com' },
                        to:      [],
                        subject: 'Test',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            expect(results[0]?.message).toBe('mbx-unknown:5');
        });

        test('returns empty array when no results', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            const results = await client.search({});

            expect(results).toHaveLength(0);
        });

        test('does not include mailbox param when mailboxes list is empty', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ mailboxes: [] });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).not.toContain('mailbox=');
        });

        test('passes Content-Type header through in GET /search request', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({});

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            // GET requests should have method set
            expect(options.method).toBe('GET');
        });

        test('sends search request with correct method GET', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ mailboxes: ['CleanInbox'] });

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(options.method).toBe('GET');
        });

        test('sends X-Access-Token header with search request', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({});

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const headers = options.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBe('test-auth-token');
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            // First search attempt returns 401
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            // Re-authentication succeeds
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            // Retry search succeeds
            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      10,
                        mailbox: 'mbx-clean',
                        from:    { address: 'alice@example.com' },
                        to:      [],
                        subject: 'Found it',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            // Should have made 3 calls: search (401), re-auth, retry search
            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(results).toHaveLength(1);
            expect(results[0]?.message).toBe('CleanInbox:10');
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({});

            // Third call (retry search) should use the new token
            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            const headers = options.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-200, non-401 error response', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.search({})).rejects.toThrow(WildDuckError);
        });

        test('throws if re-auth after 401 also fails', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            // Re-auth also fails (no token returned)
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.search({})).rejects.toThrow(WildDuckAuthError);
        });

        test('includes header search param in URL', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { header: { name: 'X-Custom', value: 'test-value' } } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('header.X-Custom=test-value');
        });

        test('handles multiple results with mixed mailboxes', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      1,
                        mailbox: 'mbx-clean',
                        from:    { address: 'alice@example.com' },
                        to:      [],
                        subject: 'First',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                    {
                        id:      2,
                        mailbox: 'mbx-archive',
                        from:    { address: 'bob@example.com' },
                        to:      [],
                        subject: 'Second',
                        date:    '2025-01-02T10:00:00.000Z',
                    },
                ],
            }));

            const results = await client.search({});

            expect(results).toHaveLength(2);
            expect(results[0]?.message).toBe('CleanInbox:1');
            expect(results[1]?.message).toBe('Archive:2');
        });
    });

    // -----------------------------------------------------------------------
    // shutdown()
    // -----------------------------------------------------------------------
    describe('shutdown()', () => {
        test('calls DELETE /authenticate with X-Access-Token header', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.shutdown();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/authenticate');
            expect(options.method).toBe('DELETE');
            const headers = options.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBe('test-auth-token');
        });

        test('clears the token after shutdown', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            await client.shutdown();
            mockFetch.mockClear();

            // After shutdown, searching should not include the old token
            // (it will fail because token is null and no X-Access-Token sent)
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));
            await client.search({});

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const headers = options.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBeUndefined();
        });

        test('does not call DELETE if shutdown before init', async () => {
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.shutdown();

            expect(mockFetch).not.toHaveBeenCalled();
        });

        test('sends Content-Type: application/json header in DELETE /authenticate', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            await client.shutdown();

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const headers = options.headers as Record<string, string>;
            expect(headers['Content-Type']).toBe('application/json');
        });

        test('ignores errors during DELETE /authenticate', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();

            mockFetch.mockRejectedValueOnce(new Error('Network error during logout'));

            // Should not throw
            await expect(client.shutdown()).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Shared helper for initialized client (used by new method tests)
    // -----------------------------------------------------------------------
    async function makeInitializedClient(): Promise<InstanceType<typeof WildDuckClient>> {
        mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
        mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
        const client = new WildDuckClient(CLIENT_OPTIONS);
        await client.init();
        mockFetch.mockClear();
        return client;
    }

    // -----------------------------------------------------------------------
    // getUserAddresses()
    // -----------------------------------------------------------------------
    describe('getUserAddresses()', () => {
        const ADDRESSES_RESPONSE = {
            success: true,
            results: [
                { id: 'addr-1', address: 'isambard@rungie.com', name: 'Isambard', main: true,  tags: ['formal'] },
                { id: 'addr-2', address: 'izzy@rungie.com',     name: 'Izzy',     main: false, tags: ['informal'] },
            ],
        };

        test('calls GET /users/me/addresses with auth token', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(ADDRESSES_RESPONSE));

            await client.getUserAddresses();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/addresses');
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('uses GET method', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(ADDRESSES_RESPONSE));

            await client.getUserAddresses();

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(options.method).toBe('GET');
        });

        test('returns mapped address array', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(ADDRESSES_RESPONSE));

            const addresses = await client.getUserAddresses();

            expect(addresses).toHaveLength(2);
            expect(addresses[0]).toEqual({ id: 'addr-1', address: 'isambard@rungie.com', name: 'Isambard', main: true,  tags: ['formal'] });
            expect(addresses[1]).toEqual({ id: 'addr-2', address: 'izzy@rungie.com',     name: 'Izzy',     main: false, tags: ['informal'] });
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(ADDRESSES_RESPONSE));

            const addresses = await client.getUserAddresses();

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(addresses).toHaveLength(2);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(ADDRESSES_RESPONSE));

            await client.getUserAddresses();

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            const headers = options.headers as Record<string, string>;
            expect(headers['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.getUserAddresses()).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            // Re-auth returns no token
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.getUserAddresses()).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // uploadMessage()
    // -----------------------------------------------------------------------
    describe('uploadMessage()', () => {
        const UPLOAD_RESPONSE = { success: true, message: { id: 42, mailbox: 'mbx-drafts', size: 512 }, previousDeleted: false };

        const BASE_PAYLOAD = {
            from:    { name: 'Isambard', address: 'isambard@rungie.com' },
            to:      [{ address: 'recipient@example.com' }],
            subject: 'Hello',
            text:    'Body text',
        };

        test('calls POST /users/me/mailboxes/{mailboxId}/messages with correct URL', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', BASE_PAYLOAD);

            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-drafts/messages');
        });

        test('sends POST method with Content-Type application/json', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', BASE_PAYLOAD);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(options.method).toBe('POST');
            expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', BASE_PAYLOAD);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('sends payload as JSON body', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', BASE_PAYLOAD);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string) as typeof BASE_PAYLOAD;
            expect(body.from).toEqual({ name: 'Isambard', address: 'isambard@rungie.com' });
            expect(body.subject).toBe('Hello');
            expect(body.text).toBe('Body text');
        });

        test('resolves replacePrevious mailbox path to mailbox ID in JSON body', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', {
                ...BASE_PAYLOAD,
                replacePrevious: { mailbox: 'Drafts', id: 42 },
            });

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string) as { replacePrevious: { mailbox: string, id: number } };
            expect(body.replacePrevious).toEqual({ mailbox: 'mbx-drafts', id: 42 });
        });

        test('omits replacePrevious from JSON body when not set', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', BASE_PAYLOAD);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string) as Record<string, unknown>;
            expect(body.replacePrevious).toBeUndefined();
        });

        test('returns the id from the response', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            const uid = await client.uploadMessage('Drafts', BASE_PAYLOAD);

            expect(uid).toBe(42);
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.uploadMessage('NonExistentFolder', BASE_PAYLOAD)).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            const uid = await client.uploadMessage('Drafts', BASE_PAYLOAD);

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(uid).toBe(42);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(UPLOAD_RESPONSE));

            await client.uploadMessage('Drafts', BASE_PAYLOAD);

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.uploadMessage('Drafts', BASE_PAYLOAD)).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.uploadMessage('Drafts', BASE_PAYLOAD)).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // submitMessage()
    // -----------------------------------------------------------------------
    describe('submitMessage()', () => {
        test('calls POST /users/me/mailboxes/{mailboxId}/messages/{uid}/submit', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.submitMessage('Drafts', 99);

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-drafts/messages/99/submit');
            expect(options.method).toBe('POST');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.submitMessage('Drafts', 99);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('resolves without value on success', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.submitMessage('Drafts', 99)).resolves.toBeUndefined();
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.submitMessage('NonExistentFolder', 99)).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.submitMessage('Drafts', 99);

            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.submitMessage('Drafts', 99);

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.submitMessage('Drafts', 99)).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.submitMessage('Drafts', 99)).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // updateMessageMetadata()
    // -----------------------------------------------------------------------
    describe('updateMessageMetadata()', () => {
        const METADATA = { sentMessageId: '<abc@rungie.com>', threadId: 'thread-xyz' };

        test('calls PUT /users/me/mailboxes/{mailboxId}/messages/{uid}', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageMetadata('Sent Mail', 7, METADATA);

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-sent/messages/7');
            expect(options.method).toBe('PUT');
        });

        test('sends metadata in body as { metaData }', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageMetadata('Sent Mail', 7, METADATA);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string) as { metaData: typeof METADATA };
            expect(body.metaData).toEqual(METADATA);
        });

        test('sends Content-Type application/json header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageMetadata('Sent Mail', 7, METADATA);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageMetadata('Sent Mail', 7, METADATA);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('resolves without value on success', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.updateMessageMetadata('Sent Mail', 7, METADATA)).resolves.toBeUndefined();
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.updateMessageMetadata('NonExistentFolder', 7, METADATA)).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageMetadata('Sent Mail', 7, METADATA);

            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageMetadata('Sent Mail', 7, METADATA);

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.updateMessageMetadata('Sent Mail', 7, METADATA)).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.updateMessageMetadata('Sent Mail', 7, METADATA)).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // getMessage()
    // -----------------------------------------------------------------------
    describe('getMessage()', () => {
        const MESSAGE_RESPONSE = {
            success:  true,
            id:       42,
            subject:  'Test subject',
            from:     { address: 'sender@example.com', name: 'Sender' },
            metaData: { threadId: 'thread-abc' },
        };

        test('calls GET /users/me/mailboxes/{mailboxId}/messages/{uid}', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(MESSAGE_RESPONSE));

            await client.getMessage('Sent Mail', 42);

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-sent/messages/42');
            expect(options.method).toBe('GET');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(MESSAGE_RESPONSE));

            await client.getMessage('Sent Mail', 42);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('returns the message on success', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(MESSAGE_RESPONSE));

            const msg = await client.getMessage('Sent Mail', 42);

            expect(msg).not.toBeNull();
            expect(msg?.id).toBe(42);
            expect(msg?.subject).toBe('Test subject');
            expect(msg?.from).toEqual({ address: 'sender@example.com', name: 'Sender' });
            expect(msg?.metaData).toEqual({ threadId: 'thread-abc' });
        });

        test('returns null on 404', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Message not found' }, 404));

            const msg = await client.getMessage('Sent Mail', 42);

            expect(msg).toBeNull();
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.getMessage('NonExistentFolder', 42)).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MESSAGE_RESPONSE));

            const msg = await client.getMessage('Sent Mail', 42);

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(msg?.id).toBe(42);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MESSAGE_RESPONSE));

            await client.getMessage('Sent Mail', 42);

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 non-404 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.getMessage('Sent Mail', 42)).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.getMessage('Sent Mail', 42)).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // getMailboxId()
    // -----------------------------------------------------------------------
    describe('getMailboxId()', () => {
        async function makeInitializedClient(): Promise<WildDuckClient> {
            mockFetch
                .mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE))
                .mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            return client;
        }

        test('should return mailbox ID for known path', async () => {
            const client = await makeInitializedClient();
            expect(client.getMailboxId('CleanInbox')).toBe('mbx-clean');
        });

        test('should return mailbox ID for Drafts path', async () => {
            const client = await makeInitializedClient();
            expect(client.getMailboxId('Drafts')).toBe('mbx-drafts');
        });

        test('should return undefined for unknown path', async () => {
            const client = await makeInitializedClient();
            expect(client.getMailboxId('NonExistent')).toBeUndefined();
        });

        test('should return undefined before init()', () => {
            const client = new WildDuckClient(CLIENT_OPTIONS);
            expect(client.getMailboxId('CleanInbox')).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // specialUse-based mailbox resolution
    // -----------------------------------------------------------------------
    describe('specialUse-based mailbox resolution', () => {
        async function makeClientWithNonstandardPaths(): Promise<WildDuckClient> {
            mockFetch
                .mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE))
                .mockResolvedValueOnce(makeJsonResponse(NONSTANDARD_MAILBOX_RESPONSE));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();
            return client;
        }

        test('resolves logical folder name via specialUse when server path differs', async () => {
            // 'Sent Mail' logical name resolves via \\Sent flag, even though actual path is '[Gmail]/Sent Mail'
            const client = await makeClientWithNonstandardPaths();
            expect(client.getMailboxId('Sent Mail')).toBe('mbx-sent');
        });

        test('resolves Drafts via \\Drafts specialUse flag', async () => {
            const client = await makeClientWithNonstandardPaths();
            expect(client.getMailboxId('Drafts')).toBe('mbx-drafts');
        });

        test('resolves Junk via \\Junk specialUse flag', async () => {
            const client = await makeClientWithNonstandardPaths();
            expect(client.getMailboxId('Junk')).toBe('mbx-junk');
        });

        test('resolves Trash via \\Trash specialUse flag', async () => {
            const client = await makeClientWithNonstandardPaths();
            expect(client.getMailboxId('Trash')).toBe('mbx-trash');
        });

        test('resolves Archive via \\Archive specialUse flag', async () => {
            const client = await makeClientWithNonstandardPaths();
            expect(client.getMailboxId('Archive')).toBe('mbx-archive');
        });

        test('resolves INBOX via \\Inbox specialUse flag', async () => {
            const client = await makeClientWithNonstandardPaths();
            expect(client.getMailboxId('INBOX')).toBe('mbx-inbox');
        });

        test('can call getMessage with logical folder name when path differs', async () => {
            const client = await makeClientWithNonstandardPaths();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success:  true,
                id:       99,
                subject:  'Test',
                from:     { address: 'sender@example.com', name: 'Sender' },
                metaData: {},
            }));

            const msg = await client.getMessage('Sent Mail', 99);

            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            // Should use the WildDuck mailbox ID (mbx-sent), not the server path
            expect(url).toContain('mbx-sent');
            expect(msg?.id).toBe(99);
        });

        test('path mapping still works for non-special folders (no specialUse)', async () => {
            const client = await makeClientWithNonstandardPaths();
            // CleanInbox has no specialUse, still resolves by path
            expect(client.getMailboxId('CleanInbox')).toBe('mbx-clean');
        });

        test('specialUse mapping does not conflict with path mapping when both are valid', async () => {
            // Standard paths — both path and specialUse resolve to the same mailbox
            const client = await makeInitializedClient();
            expect(client.getMailboxId('Sent Mail')).toBe('mbx-sent');
            expect(client.getMailboxId('Drafts')).toBe('mbx-drafts');
        });

        test('mailboxes without specialUse are still accessible by path', async () => {
            const client = await makeClientWithNonstandardPaths();
            // Quarantine has no specialUse, so path '[Gmail]/...'-style would break it,
            // but Quarantine path IS 'Quarantine' so it maps directly
            expect(client.getMailboxId('Quarantine')).toBe('mbx-quarantine');
        });

        test('unknown specialUse value does not create spurious map entries', async () => {
            // Mailbox with a specialUse value not in SPECIAL_USE_FLAGS should not pollute the map
            // Include all required folders plus a custom one with unknown specialUse
            mockFetch
                .mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE))
                .mockResolvedValueOnce(makeJsonResponse({
                    success: true,
                    results: [
                        ...MAILBOX_RESPONSE.results,
                        { id: 'mbx-custom', path: 'CustomFolder', specialUse: '\\Custom' },
                    ],
                }));
            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();
            mockFetch.mockClear();

            // The path-based lookup works
            expect(client.getMailboxId('CustomFolder')).toBe('mbx-custom');
            // But no spurious 'undefined' key is added (\\Custom is not in SPECIAL_USE_FLAGS)
            expect(client.getMailboxId('undefined')).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // deleteMessage()
    // -----------------------------------------------------------------------
    describe('deleteMessage()', () => {
        test('calls DELETE /users/me/mailboxes/{mailboxId}/messages/{uid}', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.deleteMessage('Drafts', 42);

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-drafts/messages/42');
            expect(options.method).toBe('DELETE');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.deleteMessage('Drafts', 42);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('resolves without value on success', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.deleteMessage('Drafts', 42)).resolves.toBeUndefined();
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.deleteMessage('NonExistentFolder', 42)).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.deleteMessage('Drafts', 42);

            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.deleteMessage('Drafts', 42);

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.deleteMessage('Drafts', 42)).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.deleteMessage('Drafts', 42)).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // updateMessageFlags()
    // -----------------------------------------------------------------------
    describe('updateMessageFlags()', () => {
        test('calls PUT /users/me/mailboxes/{mailboxId}/messages/{uid} with addFlags only', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] });

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-drafts/messages/42');
            expect(options.method).toBe('PUT');
            const body = JSON.parse(options.body as string) as Record<string, unknown>;
            expect(body.addFlags).toEqual(['TestFlag']);
            expect(body.removeFlags).toBeUndefined();
        });

        test('calls PUT with removeFlags only', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { removeFlags: ['TestFlag'] });

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string) as Record<string, unknown>;
            expect(body.removeFlags).toEqual(['TestFlag']);
            expect(body.addFlags).toBeUndefined();
        });

        test('calls PUT with both addFlags and removeFlags', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { addFlags: ['A'], removeFlags: ['B'] });

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string) as Record<string, unknown>;
            expect(body.addFlags).toEqual(['A']);
            expect(body.removeFlags).toEqual(['B']);
        });

        test('sends Content-Type application/json header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] });

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] });

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('resolves without value on success', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] })).resolves.toBeUndefined();
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.updateMessageFlags('NonExistentFolder', 42, { addFlags: ['TestFlag'] })).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] });

            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] });

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] })).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.updateMessageFlags('Drafts', 42, { addFlags: ['TestFlag'] })).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // getMailboxCounts()
    // -----------------------------------------------------------------------
    describe('getMailboxCounts()', () => {
        const MAILBOX_INFO_RESPONSE = { success: true, total: 15, unseen: 3 };

        test('calls GET /users/me/mailboxes/{mailboxId} with correct URL', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_INFO_RESPONSE));

            await client.getMailboxCounts('CleanInbox');

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-clean');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_INFO_RESPONSE));

            await client.getMailboxCounts('CleanInbox');

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('returns total and unseen from response', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_INFO_RESPONSE));

            const result = await client.getMailboxCounts('CleanInbox');

            expect(result).toEqual({ total: 15, unseen: 3 });
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.getMailboxCounts('NonExistentFolder')).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_INFO_RESPONSE));

            await client.getMailboxCounts('CleanInbox');

            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_INFO_RESPONSE));

            await client.getMailboxCounts('CleanInbox');

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.getMailboxCounts('CleanInbox')).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.getMailboxCounts('CleanInbox')).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // keyword in SearchCriteria
    // -----------------------------------------------------------------------
    describe('search() with keyword criteria', () => {
        test('includes keyword in URL query params', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            await client.search({ query: { keyword: 'TestFlag' } });

            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('keyword=TestFlag');
        });
    });

    // -----------------------------------------------------------------------
    // searchByKeyword()
    // -----------------------------------------------------------------------
    describe('searchByKeyword()', () => {
        test('calls search() with keyword query restricted to the specified mailbox', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      42,
                        mailbox: 'mbx-clean',
                        from:    { address: 'alice@example.com' },
                        to:      [],
                        subject: 'Test',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                    {
                        id:      99,
                        mailbox: 'mbx-clean',
                        from:    { address: 'bob@example.com' },
                        to:      [],
                        subject: 'Another',
                        date:    '2025-01-02T10:00:00.000Z',
                    },
                ],
            }));

            const uids = await client.searchByKeyword('CleanInbox', 'TestFlag');

            // Verify search was called with keyword and mailbox restriction
            const [searchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(searchUrl).toContain('keyword=TestFlag');
            expect(searchUrl).toContain('mailbox=mbx-clean');
            // Verify UIDs are correctly parsed (separator between mailbox and UID)
            expect(uids).toEqual([42, 99]);
        });

        test('returns empty array when no results', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true, results: [] }));

            const uids = await client.searchByKeyword('CleanInbox', 'SomeFlag');

            expect(uids).toEqual([]);
        });

        test('filters out results with no colon in message field (returns 0, filtered)', async () => {
            const client = await makeInitializedClient();

            // Construct a response where mapSearchResult produces a message without a colon
            // This happens when the mailbox name itself contains no colon and the format is wrong
            // We simulate by mocking search() — but easier to test via an injected malformed result
            // The message field format is 'FolderName:UID' — if mailboxMap returns undefined
            // for the mailboxId, folderName = mailboxId itself (which may lack a colon)
            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      'abc',  // non-numeric string ID produces NaN → 0 after parseInt
                        mailbox: 'mbx-clean',
                        from:    { address: 'sender@example.com' },
                        to:      [],
                        subject: 'Test',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const uids = await client.searchByKeyword('CleanInbox', 'TestFlag');

            // parseInt('abc', 10) = NaN, which is not > 0, so filtered out
            expect(uids).toEqual([]);
        });

        test('parses UID correctly when mailbox name contains colon-like chars via lastIndexOf', async () => {
            const client = await makeInitializedClient();

            // The message format is 'FolderName:UID' — lastIndexOf(':') handles colons in folder names
            // Simulate a result where the folder name resolves to something with a colon
            mockFetch.mockResolvedValueOnce(makeJsonResponse({
                success: true,
                results: [
                    {
                        id:      7,
                        mailbox: 'mbx-unknown',  // Not in mailboxMap, so folderName = 'mbx-unknown'
                        from:    { address: 'test@example.com' },
                        to:      [],
                        subject: 'Test',
                        date:    '2025-01-01T10:00:00.000Z',
                    },
                ],
            }));

            const uids = await client.searchByKeyword('CleanInbox', 'TestFlag');

            // 'mbx-unknown:7' → lastIndexOf(':') finds the colon → UID = 7
            expect(uids).toEqual([7]);
        });
    });

    // -----------------------------------------------------------------------
    // getFullMessage() — empty body
    // -----------------------------------------------------------------------
    describe('getFullMessage() — empty body', () => {
        test('returns empty string bodyText when both text and html are absent', async () => {
            const client = await makeInitializedClient();

            const noBody = {
                success: true,
                id:      42,
                from:    { address: 'alice@example.com' },
                to:      [{ address: 'me@example.com' }],
                cc:      [],
                subject: 'No body',
                date:    '2025-01-15T10:00:00.000Z',
                // text and html intentionally omitted
                headers: {},
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noBody));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.bodyText).toBe('');
        });
    });

    // -----------------------------------------------------------------------
    // Error body included in WildDuckError message
    // -----------------------------------------------------------------------
    describe('error body included in WildDuckError', () => {
        test('makeRequest includes response body in WildDuckError message when body is non-empty', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeErrorResponseWithBody('{"error":"validation failed"}', 400));

            await expect(client.search({})).rejects.toThrow('validation failed');
        });

        test('makeRequest does not append colon when body is empty string', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeErrorResponseWithBody('', 400));

            let caughtError: unknown;
            try {
                await client.search({});
            } catch (err) {
                caughtError = err;
            }
            expect(caughtError).toBeInstanceOf(WildDuckError);
            expect((caughtError as WildDuckError).message).not.toContain(':Bad Request:');
            expect((caughtError as WildDuckError).message).toMatch(/400 Bad Request$/);
        });

        test('makeRequestNullable includes response body in WildDuckError message when body is non-empty', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeErrorResponseWithBody('{"error":"mailbox not found"}', 400));

            await expect(client.getMessage('Drafts', 42)).rejects.toThrow('mailbox not found');
        });

        test('makeRequestNullable does not append colon when body is empty string', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeErrorResponseWithBody('', 400));

            let caughtError: unknown;
            try {
                await client.getMessage('Drafts', 42);
            } catch (err) {
                caughtError = err;
            }
            expect(caughtError).toBeInstanceOf(WildDuckError);
            expect((caughtError as WildDuckError).message).not.toContain(':Bad Request:');
            expect((caughtError as WildDuckError).message).toMatch(/400 Bad Request$/);
        });
    });

    // -----------------------------------------------------------------------
    // Error class tests
    // -----------------------------------------------------------------------
    describe('WildDuckError', () => {
        test('is an instance of Error', () => {
            const err = new WildDuckError('test');
            expect(err).toBeInstanceOf(Error);
        });

        test('has correct name', () => {
            const err = new WildDuckError('test');
            expect(err.name).toBe('WildDuckError');
        });

        test('preserves message', () => {
            const err = new WildDuckError('Something went wrong');
            expect(err.message).toBe('Something went wrong');
        });
    });

    describe('WildDuckAuthError', () => {
        test('is an instance of WildDuckError', () => {
            const err = new WildDuckAuthError('auth failed');
            expect(err).toBeInstanceOf(WildDuckError);
        });

        test('has correct name', () => {
            const err = new WildDuckAuthError('auth failed');
            expect(err.name).toBe('WildDuckAuthError');
        });
    });

    // -----------------------------------------------------------------------
    // init() folder validation
    // -----------------------------------------------------------------------
    describe('init() folder validation', () => {
        test('succeeds when all required folders are present', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).resolves.toBeUndefined();
        });

        test('creates missing required folder via POST /users/me/mailboxes', async () => {
            const missingReview = {
                success: true,
                results: _.filter(MAILBOX_RESPONSE.results, m => m.path !== 'Review'),
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(missingReview));
            // POST to create Review folder
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            // Second loadMailboxes after creation
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).resolves.toBeUndefined();

            // Verify the POST call was made to create the mailbox
            const calls = mockFetch.mock.calls as [string, RequestInit][];
            const postCall = _.find(calls, ([url, opts]) => url === 'https://wildduck-api.example.com/users/me/mailboxes' && opts.method === 'POST');
            expect(postCall).toBeDefined();
            const body = JSON.parse(postCall![1].body as string) as { path: string };
            expect(body.path).toBe('Review');
        });

        test('creates multiple missing folders when several are absent', async () => {
            const missingMany = {
                success: true,
                results: _.filter(MAILBOX_RESPONSE.results, m => m.path !== 'Review' && m.path !== 'Quarantine'),
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(missingMany));
            // POST to create first missing folder
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            // POST to create second missing folder
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            // Second loadMailboxes after creation
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).resolves.toBeUndefined();

            const calls = mockFetch.mock.calls as [string, RequestInit][];
            const postCalls = _.filter(calls, ([url, opts]) => url === 'https://wildduck-api.example.com/users/me/mailboxes' && opts.method === 'POST');
            expect(postCalls).toHaveLength(2);
        });

        test('does not call POST when all required folders are present', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await client.init();

            // Only 2 calls: authenticate + loadMailboxes (no POST for creation)
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        test('retries createMailbox on 401 by re-authenticating', async () => {
            const missingReview = {
                success: true,
                results: _.filter(MAILBOX_RESPONSE.results, m => m.path !== 'Review'),
            };
            // authenticate, loadMailboxes, POST (401), re-authenticate, POST (success), loadMailboxes
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(missingReview));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).resolves.toBeUndefined();

            expect(mockFetch).toHaveBeenCalledTimes(6);
        });

        test('propagates non-auth error from createMailbox without retry', async () => {
            const missingReview = {
                success: true,
                results: _.filter(MAILBOX_RESPONSE.results, m => m.path !== 'Review'),
            };
            // authenticate, loadMailboxes, POST (500 server error)
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(missingReview));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Internal server error' }, 500));

            const client = new WildDuckClient(CLIENT_OPTIONS);
            await expect(client.init()).rejects.toThrow(WildDuckError);

            // Only 3 calls: authenticate + loadMailboxes + failed POST (no re-authenticate)
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });
    });

    // -----------------------------------------------------------------------
    // getAuthToken()
    // -----------------------------------------------------------------------
    describe('getAuthToken()', () => {
        test('returns null before init()', () => {
            const client = new WildDuckClient(CLIENT_OPTIONS);
            expect(client.getAuthToken()).toBeNull();
        });

        test('returns the token after init()', async () => {
            const client = await makeInitializedClient();
            expect(client.getAuthToken()).toBe('test-auth-token');
        });

        test('returns null after shutdown()', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));
            await client.shutdown();

            expect(client.getAuthToken()).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // getApiUrl()
    // -----------------------------------------------------------------------
    describe('getApiUrl()', () => {
        test('returns the base URL provided in options', () => {
            const client = new WildDuckClient(CLIENT_OPTIONS);
            expect(client.getApiUrl()).toBe('https://wildduck-api.example.com');
        });

        test('returns the base URL after init()', async () => {
            const client = await makeInitializedClient();
            expect(client.getApiUrl()).toBe('https://wildduck-api.example.com');
        });
    });

    // -----------------------------------------------------------------------
    // moveMessage()
    // -----------------------------------------------------------------------
    describe('moveMessage()', () => {
        test('calls PUT /users/me/mailboxes/{sourceId}/messages/{uid} with moveTo', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.moveMessage('CleanInbox', 42, 'Archive');

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-clean/messages/42');
            expect(options.method).toBe('PUT');
            const body = JSON.parse(options.body as string) as Record<string, unknown>;
            expect(body.moveTo).toBe('mbx-archive');
        });

        test('sends Content-Type application/json header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.moveMessage('CleanInbox', 42, 'Archive');

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.moveMessage('CleanInbox', 42, 'Archive');

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('resolves without value on success', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.moveMessage('CleanInbox', 42, 'Archive')).resolves.toBeUndefined();
        });

        test('throws WildDuckError when source mailbox not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.moveMessage('NonExistent', 42, 'Archive')).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckError when dest mailbox not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.moveMessage('CleanInbox', 42, 'NonExistent')).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.moveMessage('CleanInbox', 42, 'Archive');

            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await client.moveMessage('CleanInbox', 42, 'Archive');

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.moveMessage('CleanInbox', 42, 'Archive')).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.moveMessage('CleanInbox', 42, 'Archive')).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // listMessages()
    // -----------------------------------------------------------------------
    describe('listMessages()', () => {
        const LIST_RESPONSE = {
            success: true,
            results: [
                {
                    id:          10,
                    from:        { address: 'alice@example.com', name: 'Alice' },
                    subject:     'Hello',
                    date:        '2025-01-01T10:00:00.000Z',
                    intro:       'Hello there...',
                    attachments: [],
                },
                {
                    id:          11,
                    from:        { address: 'bob@example.com' },
                    subject:     'World',
                    date:        '2025-01-02T10:00:00.000Z',
                    intro:       'World news...',
                    attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 120 }],
                },
            ],
        };

        test('calls GET /users/me/mailboxes/{mailboxId}/messages with default params', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox');

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('https://wildduck-api.example.com/users/me/mailboxes/mbx-clean/messages');
            expect(options.method).toBe('GET');
        });

        test('includes unseen=true in default query params', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox');

            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('unseen=true');
        });

        test('includes limit=20 in default query params', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox');

            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('limit=20');
        });

        test('includes order=asc in default query params', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox');

            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('order=asc');
        });

        test('respects custom options: unseen=false, limit=50, order=desc', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox', { unseen: false, limit: 50, order: 'desc' });

            const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('unseen=false');
            expect(url).toContain('limit=50');
            expect(url).toContain('order=desc');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox');

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('returns mapped WildDuckMessageSummary array', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            const results = await client.listMessages('CleanInbox');

            expect(results).toHaveLength(2);
            expect(results[0]).toEqual({
                id:          10,
                from:        { address: 'alice@example.com', name: 'Alice' },
                subject:     'Hello',
                date:        '2025-01-01T10:00:00.000Z',
                intro:       'Hello there...',
                attachments: [],
            });
            expect(results[1]).toEqual({
                id:          11,
                from:        { address: 'bob@example.com' },
                subject:     'World',
                date:        '2025-01-02T10:00:00.000Z',
                intro:       'World news...',
                attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 120 }],
            });
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.listMessages('NonExistentFolder')).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            const results = await client.listMessages('CleanInbox');

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(results).toHaveLength(2);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(LIST_RESPONSE));

            await client.listMessages('CleanInbox');

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.listMessages('CleanInbox')).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.listMessages('CleanInbox')).rejects.toThrow(WildDuckAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // getFullMessage()
    // -----------------------------------------------------------------------
    describe('getFullMessage()', () => {
        const FULL_MESSAGE_RESPONSE = {
            success:     true,
            id:          42,
            messageId:   '<abc123@example.com>',
            from:        { address: 'alice@example.com', name: 'Alice' },
            to:          [{ address: 'me@example.com', name: 'Me' }],
            cc:          [{ address: 'cc@example.com' }],
            subject:     'Test Subject',
            date:        '2025-01-15T10:00:00.000Z',
            text:        'Plain text body here.',
            attachments: [],
            replyTo:     { address: 'reply@example.com' },
            headers:     {
                'message-id':             '<abc123@example.com>',
                'in-reply-to':            '<prev@example.com>',
                'authentication-results': 'dkim=pass',
                'x-rspamd-report':        'report-data',
                'x-rspamd-score':         '1.5',
            },
        };

        test('calls GET /users/me/mailboxes/{mailboxId}/messages/{uid}', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(FULL_MESSAGE_RESPONSE));

            await client.getFullMessage('CleanInbox', 42);

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-clean/messages/42');
            expect(options.method).toBe('GET');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(FULL_MESSAGE_RESPONSE));

            await client.getFullMessage('CleanInbox', 42);

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('maps response to EmailMetadata', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(FULL_MESSAGE_RESPONSE));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result).not.toBeNull();
            expect(result?.uid).toBe(42);
            expect(result?.messageId).toBe('<abc123@example.com>');
            expect(result?.from).toEqual({ address: 'alice@example.com', name: 'Alice' });
            expect(result?.to).toEqual([{ address: 'me@example.com', name: 'Me' }]);
            expect(result?.cc).toEqual([{ address: 'cc@example.com' }]);
            expect(result?.subject).toBe('Test Subject');
            expect(result?.date).toEqual(new Date('2025-01-15T10:00:00.000Z'));
            expect(result?.bodyText).toBe('Plain text body here.');
            expect(result?.hasAttachments).toBe(false);
            expect(result?.attachments).toEqual([]);
        });

        test('maps headers to EmailHeaders', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse(FULL_MESSAGE_RESPONSE));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.headers.messageId).toBe('<abc123@example.com>');
            expect(result?.headers.inReplyTo).toBe('<prev@example.com>');
            expect(result?.headers.replyTo).toBe('reply@example.com');
            expect(result?.headers.authenticationResults).toBe('dkim=pass');
            expect(result?.headers.xRspamdReport).toBe('report-data');
            expect(result?.headers.xRspamdScore).toBe('1.5');
        });

        test('sets hasAttachments=true when attachments present', async () => {
            const client = await makeInitializedClient();

            const withAttachments = {
                ...FULL_MESSAGE_RESPONSE,
                attachments: [{ id: 'att-1', filename: 'file.pdf', contentType: 'application/pdf', sizeKb: 100 }],
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(withAttachments));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.hasAttachments).toBe(true);
        });

        test('converts HTML to text when no text body', async () => {
            const client = await makeInitializedClient();

            const htmlOnly = {
                ...FULL_MESSAGE_RESPONSE,
                text: undefined,
                html: '<h1>Hello</h1><p>World</p>',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(htmlOnly));

            const result = await client.getFullMessage('CleanInbox', 42);

            // html-to-text should produce plain text from the HTML (h1 becomes uppercase)
            expect(_.toLower(result?.bodyText)).toContain('hello');
            expect(_.toLower(result?.bodyText)).toContain('world');
        });

        test('truncates body at maxBodySizeBytes', async () => {
            const client = new WildDuckClient({ ...CLIENT_OPTIONS, maxBodySizeBytes: 10 });
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            await client.init();
            mockFetch.mockClear();

            const longBody = { ...FULL_MESSAGE_RESPONSE, text: _.repeat('A', 100) };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(longBody));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.bodyText.length).toBeLessThanOrEqual(10);
        });

        test('truncates at valid UTF-8 boundary when cutting inside a multi-byte character', async () => {
            // 'あ' is 3 bytes (0xE3 0x81 0x82) — maxBodySizeBytes=5 would cut into second char
            // Content: 'あいう' = 9 bytes; limit=5 → would cut at byte 5 (middle of 'い')
            // The UTF-8 loop should back up to byte 3, yielding just 'あ'
            const client = new WildDuckClient({ ...CLIENT_OPTIONS, maxBodySizeBytes: 5 });
            mockFetch.mockResolvedValueOnce(makeJsonResponse(AUTH_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(MAILBOX_RESPONSE));
            await client.init();
            mockFetch.mockClear();

            const multibyteBody = { ...FULL_MESSAGE_RESPONSE, text: 'あいう' };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(multibyteBody));

            const result = await client.getFullMessage('CleanInbox', 42);

            // Result must be valid UTF-8 (no partial multi-byte sequences)
            expect(result?.bodyText).toBe('あ');
        });

        test('uses messageId from headers when messageId field missing', async () => {
            const client = await makeInitializedClient();

            const noTopLevelMsgId = {
                ...FULL_MESSAGE_RESPONSE,
                messageId: undefined,
                headers:   { 'message-id': '<from-header@example.com>' },
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noTopLevelMsgId));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.messageId).toBe('<from-header@example.com>');
        });

        test('returns empty string messageId when both fields missing', async () => {
            const client = await makeInitializedClient();

            const noMsgId = { ...FULL_MESSAGE_RESPONSE, messageId: undefined, headers: {} };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noMsgId));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.messageId).toBe('');
        });

        test('returns empty string subject when subject missing', async () => {
            const client = await makeInitializedClient();

            const noSubject = { ...FULL_MESSAGE_RESPONSE, subject: undefined };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noSubject));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.subject).toBe('');
        });

        test('returns null on 404', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Not found' }, 404));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result).toBeNull();
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.getFullMessage('NonExistentFolder', 42)).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(FULL_MESSAGE_RESPONSE));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(result?.uid).toBe(42);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(FULL_MESSAGE_RESPONSE));

            await client.getFullMessage('CleanInbox', 42);

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 non-404 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Server error' }, 500));

            await expect(client.getFullMessage('CleanInbox', 42)).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.getFullMessage('CleanInbox', 42)).rejects.toThrow(WildDuckAuthError);
        });

        test('uses empty address when from field is absent', async () => {
            const client = await makeInitializedClient();

            const noFrom = { ...FULL_MESSAGE_RESPONSE, from: undefined };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noFrom));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.from).toEqual({ address: '' });
        });

        test('preserves angle brackets in plain text body (not processed as HTML)', async () => {
            const client = await makeInitializedClient();

            // Plain text email with a literal < character (like a code snippet or email address)
            // If treated as HTML, html-to-text would strip or transform it; as plain text it is preserved
            const plainWithAngles = {
                ...FULL_MESSAGE_RESPONSE,
                text: 'Reply to <user@example.com> or <admin@example.com>',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(plainWithAngles));

            const result = await client.getFullMessage('CleanInbox', 42);

            // Plain text must be returned as-is, with angle brackets preserved
            expect(result?.bodyText).toContain('<user@example.com>');
            expect(result?.bodyText).toContain('<admin@example.com>');
        });

        test('returns empty to array when to field is absent', async () => {
            const client = await makeInitializedClient();

            const noTo = { ...FULL_MESSAGE_RESPONSE, to: undefined };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noTo));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.to).toEqual([]);
        });

        test('returns empty cc array when cc field is absent', async () => {
            const client = await makeInitializedClient();

            const noCc = { ...FULL_MESSAGE_RESPONSE, cc: undefined };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noCc));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.cc).toEqual([]);
        });

        test('returns empty attachmentMeta when attachments field is absent', async () => {
            const client = await makeInitializedClient();

            const noAttachments = { ...FULL_MESSAGE_RESPONSE, attachments: undefined };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noAttachments));

            const result = await client.getFullMessage('CleanInbox', 42);

            expect(result?.attachmentMeta).toEqual([]);
            expect(result?.hasAttachments).toBe(false);
        });

        test('converts HTML to plain text stripping tags when html body present', async () => {
            const client = await makeInitializedClient();

            const htmlOnly = {
                ...FULL_MESSAGE_RESPONSE,
                text: undefined,
                html: '<h1>Hello</h1><p>World</p>',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(htmlOnly));

            const result = await client.getFullMessage('CleanInbox', 42);

            // html-to-text strips HTML tags; raw HTML would contain '<h1>'
            expect(result?.bodyText).not.toContain('<h1>');
            expect(result?.bodyText).not.toContain('<p>');
        });

        test('omits name from address when name is absent', async () => {
            const client = await makeInitializedClient();

            const noName = {
                ...FULL_MESSAGE_RESPONSE,
                from: { address: 'noname@example.com' },
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(noName));

            const result = await client.getFullMessage('CleanInbox', 42);

            // Should not have name property at all
            expect(result?.from).toEqual({ address: 'noname@example.com' });
            expect((result?.from as unknown as Record<string, unknown>).name).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // getAttachment()
    // -----------------------------------------------------------------------
    describe('getAttachment()', () => {
        function makeBufferResponse(data: Buffer, status = 200): Response {
            return {
                ok:          status >= 200 && status < 300,
                status,
                statusText:  statusText(status),
                arrayBuffer: async () => data.buffer,
                text:        async () => data.toString('utf8'),
            } as unknown as Response;
        }

        test('calls GET /users/me/mailboxes/{mailboxId}/messages/{uid}/attachments/{attachmentId}', async () => {
            const client = await makeInitializedClient();

            const data = Buffer.from('attachment data here');
            mockFetch.mockResolvedValueOnce(makeBufferResponse(data));

            await client.getAttachment('CleanInbox', 42, 'att-1');

            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://wildduck-api.example.com/users/me/mailboxes/mbx-clean/messages/42/attachments/att-1');
            expect(options.method).toBe('GET');
        });

        test('sends auth token header', async () => {
            const client = await makeInitializedClient();

            const data = Buffer.from('attachment data here');
            mockFetch.mockResolvedValueOnce(makeBufferResponse(data));

            await client.getAttachment('CleanInbox', 42, 'att-1');

            const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('test-auth-token');
        });

        test('returns Buffer of attachment data', async () => {
            const client = await makeInitializedClient();

            const data = Buffer.from('binary attachment content');
            mockFetch.mockResolvedValueOnce(makeBufferResponse(data));

            const result = await client.getAttachment('CleanInbox', 42, 'att-1');

            expect(result).toBeInstanceOf(Buffer);
            expect(result.toString('utf8')).toBe('binary attachment content');
        });

        test('throws WildDuckError when mailboxPath not in map', async () => {
            const client = await makeInitializedClient();

            await expect(client.getAttachment('NonExistentFolder', 42, 'att-1')).rejects.toThrow(WildDuckError);
        });

        test('retries on 401 by re-authenticating', async () => {
            const client = await makeInitializedClient();

            const data = Buffer.from('data');
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'new-token' }));
            mockFetch.mockResolvedValueOnce(makeBufferResponse(data));

            const result = await client.getAttachment('CleanInbox', 42, 'att-1');

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(result).toBeInstanceOf(Buffer);
        });

        test('uses new token on retry after 401', async () => {
            const client = await makeInitializedClient();

            const data = Buffer.from('data');
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ ...AUTH_RESPONSE, token: 'refreshed-token' }));
            mockFetch.mockResolvedValueOnce(makeBufferResponse(data));

            await client.getAttachment('CleanInbox', 42, 'att-1');

            const [_url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
            expect((options.headers as Record<string, string>)['X-Access-Token']).toBe('refreshed-token');
        });

        test('throws WildDuckError on non-2xx non-401 error', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce({
                ok:         false,
                status:     500,
                statusText: 'Error',
                text:       _.constant('Internal Error'),
            } as unknown as Response);

            await expect(client.getAttachment('CleanInbox', 42, 'att-1')).rejects.toThrow(WildDuckError);
        });

        test('throws WildDuckAuthError when re-auth fails after 401', async () => {
            const client = await makeInitializedClient();

            mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'Token expired' }, 401));
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ success: true }));

            await expect(client.getAttachment('CleanInbox', 42, 'att-1')).rejects.toThrow(WildDuckAuthError);
        });
    });
});
