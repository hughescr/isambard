import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { PersonHistoryCoordinator, type PersonHistoryCoordinatorOptions } from '../../../../src/agent/history-providers/coordinator';
import type { HistoryEntry, HistoryFetchParams, KnownPlatform, PlatformHistoryProvider } from '../../../../src/agent/history-providers/types';
import type { Contact, ContactId } from '../../../../src/storage/contacts';
import { mockLogger } from '../../../setup';

// ── Helpers ────────────────────────────────────────────────────────────────────

const makeContact = (overrides: Partial<Contact> = {}): Contact => ({
    personId:    'craig-hughes' as ContactId,
    displayName: 'Craig Hughes',
    identifiers: [
        { platform: 'email',   value: 'craig@example.com' },
        { platform: 'discord', value: 'craig' },
        { platform: 'bsky',    value: 'craig.bsky.social' },
    ],
    _internal: { discordUserId: '123456789', bskyDid: 'did:plc:abc123' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    ...overrides,
});

const makeEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
    platform:  'discord',
    timestamp: '2025-01-01T10:30:00.000Z',
    summary:   'craig: Hello there',
    direction: 'inbound',
    ...overrides,
});

/** Build an ISO timestamp in UTC for "today" at a given hour/minute. */
function todayUtc(hour: number, minute: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute)).toISOString();
}

// ── Mock types ─────────────────────────────────────────────────────────────────

interface MockContactBackend {
    fuzzyLookup:       ReturnType<typeof mock>
    resolveIdentifier: ReturnType<typeof mock>
    getContact:        ReturnType<typeof mock>
}

interface MockSearchService {
    getRecentMessages: ReturnType<typeof mock>
    searchMessages:    ReturnType<typeof mock>
    getMessageById:    ReturnType<typeof mock>
    getMessagesById:   ReturnType<typeof mock>
}

function makeOptions(
    overrides: {
        backend?:   MockContactBackend
        providers?: PlatformHistoryProvider[]
        search?:    MockSearchService
    } = {}
): PersonHistoryCoordinatorOptions {
    return {
        contactBackend:       (overrides.backend  ?? makeMockBackend())  as unknown as PersonHistoryCoordinatorOptions['contactBackend'],
        providers:            overrides.providers ?? [],
        messageSearchService: overrides.search   ?? makeMockSearch(),
    };
}

function makeMockBackend(): MockContactBackend {
    return {
        fuzzyLookup:       mock(async (): Promise<Contact[]> => [makeContact()]),
        resolveIdentifier: mock(async (): Promise<Contact[]> => [makeContact()]),
        getContact:        mock(async (): Promise<Contact | undefined> => makeContact()),
    };
}

function makeMockSearch(): MockSearchService {
    return {
        getRecentMessages: mock(async (): Promise<{ messages: unknown[] }> => ({ messages: [] })),
        searchMessages:    mock(async () => ({ messages: [], metadata: { totalFound: 0, timeRange: { start: '', end: '' } } })),
        getMessageById:    mock(async () => null),
        getMessagesById:   mock(async () => []),
    };
}

function makeProvider(platform: KnownPlatform, entries: HistoryEntry[] = []): PlatformHistoryProvider {
    return {
        platform,
        fetchHistory: mock(async (): Promise<HistoryEntry[]> => entries),
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.concurrent('PersonHistoryCoordinator', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    // ── getPersonHistory ───────────────────────────────────────────────────────

    describe('getPersonHistory', () => {
        test('returns undefined when no contact found', async () => {
            const backend   = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => []);
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend }));
            const result = await coord.getPersonHistory('unknown person');

            expect(result.history).toBeUndefined();
            expect(result.person).toBeUndefined();
        });

        test('rejects a sparse contact result from the backend', async () => {
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [undefined] as unknown as Contact[]);
            const coord = new PersonHistoryCoordinator(makeOptions({ backend }));

            await expect(coord.getPersonHistory('craig')).rejects.toThrow(
                'contacts[0] undefined after contacts.length === 0 guard'
            );
            await expect(coord.getPersonHistory('craig')).rejects.toMatchObject({
                context: { location: 'getPersonHistory' },
            });
        });

        test('returns first fuzzy match as person', async () => {
            const contact1 = makeContact({ personId: 'craig-hughes' as ContactId, displayName: 'Craig Hughes' });
            const contact2 = makeContact({ personId: 'craig-other'  as ContactId, displayName: 'Craig Other' });
            const backend  = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact1, contact2]);

            const coord  = new PersonHistoryCoordinator(makeOptions({ backend }));
            const result = await coord.getPersonHistory('craig');

            expect(result.person?.personId as string).toBe('craig-hughes');
            expect(result.person?.displayName).toBe('Craig Hughes');
        });

        test('strips _internal from returned person', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions());
            const result = await coord.getPersonHistory('craig');

            expect(result.person).toBeDefined();
            expect((result.person as unknown as { _internal?: unknown })._internal).toBeUndefined();
        });

        test('returns undefined history when no providers are registered', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [] }));
            const result = await coord.getPersonHistory('craig');

            expect(result.history).toBeUndefined();
            expect(result.person).toBeDefined();
        });

        test('returns formatted history when providers return entries', async () => {
            const entries = [
                makeEntry({ timestamp: '2025-01-01T10:30:00.000Z', summary: 'craig: Hello' }),
                makeEntry({ timestamp: '2025-01-01T10:31:00.000Z', summary: 'Izzy: Hi there' }),
            ];
            const provider = makeProvider('discord', entries);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig');

            expect(result.history).toContain('Craig Hughes');
            expect(result.history).toContain('craig: Hello');
            expect(result.history).toContain('Izzy: Hi there');
            expect(result.history).toContain('--- Recent interactions with Craig Hughes ---');
            expect(result.history).toContain('--- End of recent history ---');
        });

        test('formats today timestamps as HH:MM and past timestamps as date', async () => {
            // Use single-digit hour/minute to exercise the padStart('0') zero-padding
            const todayEntry = makeEntry({ timestamp: todayUtc(9, 5), summary: 'today msg' });
            const pastEntry  = makeEntry({ timestamp: '2025-01-01T10:30:00.000Z', summary: 'past msg' });
            const provider   = makeProvider('discord', [todayEntry, pastEntry]);
            const coord      = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result     = await coord.getPersonHistory('craig');

            expect(result.history).toContain('today msg');
            expect(result.history).toContain('past msg');
            // Today's entry should use HH:MM format with zero-padded single-digit values
            expect(result.history).toContain('[09:05]');
            // Past entry should use YYYY-MM-DD format
            expect(result.history).toContain('[2025-01-01]');
        });

        test('formats a different year, month, or day as a date even when the other fields match today', async () => {
            const now = new Date();
            const dates = [
                new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(), 9, 5)),
                new Date(Date.UTC(now.getUTCFullYear(), (now.getUTCMonth() + 6) % 12, now.getUTCDate(), 9, 5)),
                new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() === 1 ? 2 : 1, 9, 5)),
            ];
            const entries = dates.map((date, index) => makeEntry({ timestamp: date.toISOString(), summary: `date-case-${index}` }));
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const { history } = await coord.getPersonHistory('craig');

            for(const [index, date] of dates.entries()) {
                expect(history).toContain(`[${date.toISOString().slice(0, 10)}] date-case-${index}`);
            }
            expect(history).not.toContain('[09:05]');
        });

        test('separates every formatted interaction with a newline', async () => {
            const entries = [makeEntry({ summary: 'first' }), makeEntry({ summary: 'second' })];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const { history } = await coord.getPersonHistory('craig');
            expect(history).toMatch(/first\n\[discord\].*second/);
        });

        test('entries are sorted descending by timestamp', async () => {
            const earlierEntry = makeEntry({ timestamp: '2025-01-01T08:00:00.000Z', summary: 'earlier message' });
            const laterEntry   = makeEntry({ timestamp: '2025-01-01T10:00:00.000Z', summary: 'later message' });

            // Provide entries in ascending order — coordinator should flip them
            const provider = makeProvider('discord', [earlierEntry, laterEntry]);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig');

            expect(result.history).toBeDefined();
            const laterPos   = result.history!.indexOf('later message');
            const earlierPos = result.history!.indexOf('earlier message');
            expect(laterPos).toBeLessThan(earlierPos);
        });

        test('merges entries from multiple providers and sorts them', async () => {
            const discordEntry = makeEntry({ platform: 'discord', timestamp: '2025-01-01T10:00:00.000Z', summary: 'discord msg' });
            const emailEntry   = makeEntry({ platform: 'email',   timestamp: '2025-01-01T09:00:00.000Z', summary: 'email msg' });

            const discordProvider = makeProvider('discord', [discordEntry]);
            const emailProvider   = makeProvider('email',   [emailEntry]);

            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email',   value: 'craig@example.com' },
                ],
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord  = new PersonHistoryCoordinator(makeOptions({ backend, providers: [discordProvider, emailProvider] }));
            const result = await coord.getPersonHistory('craig');

            expect(result.history).toContain('discord msg');
            expect(result.history).toContain('email msg');
            // Each entry line must carry the platform label so readers know which channel each message came from
            expect(result.history).toContain('[discord]');
            expect(result.history).toContain('[email]');

            // discord msg is later, should appear first
            const discordPos = result.history!.indexOf('discord msg');
            const emailPos   = result.history!.indexOf('email msg');
            expect(discordPos).toBeLessThan(emailPos);
        });

        test('preserves provider registration order for entries with equal timestamps', async () => {
            const timestamp = '2025-01-01T10:00:00.000Z';
            const firstProvider = makeProvider('discord', [makeEntry({ timestamp, summary: 'first provider' })]);
            const secondProvider = makeProvider('email', [makeEntry({ platform: 'email', timestamp, summary: 'second provider' })]);
            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email', value: 'craig@example.com' },
                ],
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);
            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [firstProvider, secondProvider] }));
            const result = await coord.getPersonHistory('craig');

            expect(result.history!.indexOf('first provider')).toBeLessThan(result.history!.indexOf('second provider'));
        });

        test('includes [bsky] platform label in formatted output for bsky entries', async () => {
            const bskyEntry   = makeEntry({ platform: 'bsky', timestamp: '2025-01-01T09:00:00.000Z', summary: 'bsky msg' });
            const bskyProvider = makeProvider('bsky', [bskyEntry]);

            const contact = makeContact({
                identifiers: [{ platform: 'bsky', value: 'craig.bsky.social' }],
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord  = new PersonHistoryCoordinator(makeOptions({ backend, providers: [bskyProvider] }));
            const result = await coord.getPersonHistory('craig');

            expect(result.history).toContain('bsky msg');
            expect(result.history).toContain('[bsky]');
        });

        test('caps results at maxTotalEntries', async () => {
            const entries: HistoryEntry[] = Array.from({ length: 20 }, (_, i) => makeEntry({
                timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(),
                summary:   `msg-${i}`,
            }));
            const provider = makeProvider('discord', entries);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig', { maxTotalEntries: 5 });

            // Should only contain 5 entries: the 5 most recent
            const matches = result.history?.match(/msg-\d+/g) ?? [];
            expect(matches).toHaveLength(5);
        });

        test('caps output at maxCharacters when formatted string is longer', async () => {
            const longSummary = 'x'.repeat(5000);
            const entries = [
                makeEntry({ summary: longSummary }),
                makeEntry({ timestamp: '2025-01-01T09:00:00.000Z', summary: 'short msg' }),
            ];
            const provider = makeProvider('discord', entries);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig', { maxCharacters: 200 });

            expect(result.history).toBeDefined();
            expect(result.history!).toHaveLength(200);
        });

        test('does not truncate when output is shorter than maxCharacters', async () => {
            const entries  = [makeEntry({ summary: 'short' })];
            const provider = makeProvider('discord', entries);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig', { maxCharacters: 10_000 });

            expect(result.history).toBeDefined();
            // Full output should be well under 10_000 and contain the complete footer
            expect(result.history).toContain('--- End of recent history ---');
            expect(result.history!.length).toBeLessThan(10_000);
        });

        test('does not truncate provider history when maxCharacters is NaN', async () => {
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [makeEntry({ summary: 'complete' })])] }));
            const result = await coord.getPersonHistory('craig', { maxCharacters: Number.NaN });
            expect(result.history).toContain('complete');
            expect(result.history).toContain('--- End of recent history ---');
        });

        test('continues when one provider fails (error isolation)', async () => {
            const failingProvider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async () => { throw new Error('Provider error'); }),
            };
            const workingEntry    = makeEntry({ platform: 'email', timestamp: '2025-01-01T10:00:00.000Z', summary: 'email works' });
            const workingProvider = makeProvider('email', [workingEntry]);

            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email',   value: 'craig@example.com' },
                ],
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            mockLogger.warn.mockClear();
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend, providers: [failingProvider, workingProvider] }));
            const result = await coord.getPersonHistory('craig');

            // Even though discord failed, email results still appear
            expect(result.history).toContain('email works');
            // Logger should have been called with the error
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { err: expect.objectContaining({ message: 'Provider error' }) },
                'PersonHistoryCoordinator: provider query failed'
            );
        });

        test('returns undefined history when all providers fail', async () => {
            const failingProvider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async () => { throw new Error('Provider error'); }),
            };
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [failingProvider] }));
            const result = await coord.getPersonHistory('craig');

            expect(result.history).toBeUndefined();
            expect(result.person).toBeDefined();
        });

        test('passes startTime and endTime to providers based on timeWindowMinutes', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            await coord.getPersonHistory('craig', { timeWindowMinutes: 60 });

            expect(capturedParams).toBeDefined();
            expect(capturedParams!.startTime).toBeInstanceOf(Date);
            expect(capturedParams!.endTime).toBeInstanceOf(Date);

            const windowMs = capturedParams!.endTime!.getTime() - capturedParams!.startTime!.getTime();
            // Should be approximately 60 minutes (allow 5s tolerance for test execution time)
            expect(windowMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
            expect(windowMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
        });

        test('uses explicit startTime and endTime options when provided, ignoring timeWindowMinutes', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const explicitStart = new Date('2025-01-01T00:00:00.000Z');
            const explicitEnd   = new Date('2025-01-02T00:00:00.000Z');

            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            // Pass a wildly different timeWindowMinutes to confirm it is ignored when explicit dates are provided
            await coord.getPersonHistory('craig', { startTime: explicitStart, endTime: explicitEnd, timeWindowMinutes: 9999 });

            expect(capturedParams).toBeDefined();
            expect(capturedParams!.startTime?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
            expect(capturedParams!.endTime?.toISOString()).toBe('2025-01-02T00:00:00.000Z');
        });

        test('uses explicit endTime with timeWindowMinutes fallback when only endTime provided', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const explicitEnd = new Date('2025-06-01T12:00:00.000Z');

            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            await coord.getPersonHistory('craig', { endTime: explicitEnd, timeWindowMinutes: 60 });

            expect(capturedParams).toBeDefined();
            // endTime is used as-is
            expect(capturedParams!.endTime?.toISOString()).toBe('2025-06-01T12:00:00.000Z');
            // startTime is computed from endTime - 60 minutes
            expect(capturedParams!.startTime?.toISOString()).toBe('2025-06-01T11:00:00.000Z');
        });

        test('passes maxMessages to providers', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            await coord.getPersonHistory('craig', { maxMessagesPerPlatform: 25 });

            expect(capturedParams?.maxMessages).toBe(25);
        });

        test('queries all matching identifiers for a platform', async () => {
            const fetchCalls: string[] = [];
            const provider: PlatformHistoryProvider = {
                platform:     'email',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    fetchCalls.push(params.identifier);
                    return [];
                }),
            };

            const contact = makeContact({
                identifiers: [
                    { platform: 'email', value: 'craig@work.com' },
                    { platform: 'email', value: 'craig@personal.com' },
                ],
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(fetchCalls).toContain('craig@work.com');
            expect(fetchCalls).toContain('craig@personal.com');
        });

        test('passes discordUserId metadata to discord provider when _internal has discordUserId', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const contact = makeContact({
                identifiers: [{ platform: 'discord', value: 'craig' }],
                _internal:   { discordUserId: '123456789', bskyDid: 'did:plc:abc123' },
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(capturedParams?.metadata?.discordUserId).toBe('123456789');
        });

        test('passes bskyDid metadata to bsky provider when _internal has bskyDid', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'bsky',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const contact = makeContact({
                identifiers: [{ platform: 'bsky', value: 'craig.bsky.social' }],
                _internal:   { discordUserId: '123456789', bskyDid: 'did:plc:abc123' },
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(capturedParams?.metadata?.bskyDid).toBe('did:plc:abc123');
        });

        test('does not pass metadata when contact has no _internal', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const contact = makeContact({
                identifiers: [{ platform: 'discord', value: 'craig' }],
                _internal:   undefined,
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(capturedParams?.metadata).toBeUndefined();
            expect(capturedParams).not.toHaveProperty('metadata');
        });

        test('does not pass discordUserId metadata to non-discord provider', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'bsky',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const contact = makeContact({
                identifiers: [{ platform: 'bsky', value: 'craig.bsky.social' }],
                _internal:   { discordUserId: '123456789' },
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(capturedParams?.metadata?.discordUserId).toBeUndefined();
        });

        test('does not pass bskyDid metadata to non-bsky provider', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const contact = makeContact({
                identifiers: [{ platform: 'discord', value: 'craig' }],
                _internal:   { bskyDid: 'did:plc:abc123' },
            });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(capturedParams?.metadata?.bskyDid).toBeUndefined();
        });

        test('skips provider when contact has no matching identifiers for that platform', async () => {
            const fetchHistory = mock(async (): Promise<HistoryEntry[]> => []);
            const provider: PlatformHistoryProvider = {
                platform: 'bsky',
                fetchHistory,
            };

            // Contact has no bsky identifiers
            const contact = makeContact({ identifiers: [{ platform: 'email', value: 'craig@example.com' }] });
            const backend = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact]);

            const coord = new PersonHistoryCoordinator(makeOptions({ backend, providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(fetchHistory).not.toHaveBeenCalled();
        });

        test('uses resolveIdentifier when platformHint is provided', async () => {
            const backend = makeMockBackend();
            const coord   = new PersonHistoryCoordinator(makeOptions({ backend }));
            await coord.getPersonHistory('craig', { platformHint: 'discord' });

            expect(backend.resolveIdentifier).toHaveBeenCalledTimes(1);
            expect(backend.fuzzyLookup).not.toHaveBeenCalled();
        });

        test('passes platform and identifier to resolveIdentifier', async () => {
            const backend = makeMockBackend();
            const coord   = new PersonHistoryCoordinator(makeOptions({ backend }));
            await coord.getPersonHistory('Craig@Example.COM', { platformHint: 'discord' });

            expect(backend.resolveIdentifier).toHaveBeenCalledWith('discord', 'Craig@Example.COM');
        });

        test('falls back to fuzzyLookup when resolveIdentifier returns empty with platformHint', async () => {
            const backend = makeMockBackend();
            backend.resolveIdentifier.mockImplementation(async (): Promise<Contact[]> => []);
            const coord = new PersonHistoryCoordinator(makeOptions({ backend }));
            await coord.getPersonHistory('craig', { platformHint: 'discord' });

            expect(backend.resolveIdentifier).toHaveBeenCalledTimes(1);
            expect(backend.fuzzyLookup).toHaveBeenCalledTimes(1);
            expect(backend.fuzzyLookup).toHaveBeenCalledWith('craig');
        });

        test('uses fuzzyLookup when no platformHint is provided', async () => {
            const backend = makeMockBackend();
            const coord   = new PersonHistoryCoordinator(makeOptions({ backend }));
            await coord.getPersonHistory('craig');

            expect(backend.fuzzyLookup).toHaveBeenCalledTimes(1);
            expect(backend.resolveIdentifier).not.toHaveBeenCalled();
        });

        test('formatHistoryEntries assertNever throws for unknown platform at runtime', async () => {
            // This test documents the exhaustiveness contract: adding a new KnownPlatform
            // without updating platformLabel's switch will produce a runtime throw.
            // We cast through `unknown` to simulate a provider returning an unrecognised platform.
            const unknownPlatformEntry: HistoryEntry = {
                platform:  'rss' as unknown as KnownPlatform,
                timestamp: '2025-01-01T10:00:00.000Z',
                summary:   'feed item',
                direction: 'inbound',
            };
            const provider = makeProvider('discord', [unknownPlatformEntry]);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));

            await expect(coord.getPersonHistory('craig')).rejects.toThrow('Unexpected platform: rss');
        });
    });

    // ── default option constants ────────────────────────────────────────────────

    describe('default option constants', () => {
        // Each default in types.ts drives observable coordinator behaviour when the
        // caller passes no option (or omits that option). These tests pin the defaults
        // through the public API rather than importing the constants directly.

        test('uses the default maxMessagesPerPlatform of 10 when omitted', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            await coord.getPersonHistory('craig');

            expect(capturedParams?.maxMessages).toBe(10);
        });

        test('caps results at the default maxTotalEntries of 30 when omitted', async () => {
            const entries: HistoryEntry[] = Array.from({ length: 40 }, (_, i) => makeEntry({
                timestamp: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
                summary:   `default-cap-${i}`,
            }));
            const provider = makeProvider('discord', entries);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig');

            const matches = result.history?.match(/default-cap-\d+/g) ?? [];
            expect(matches).toHaveLength(30);
        });

        test('uses the default time window of 120 minutes when timeWindowMinutes is omitted', async () => {
            let capturedParams: HistoryFetchParams | undefined;
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (params): Promise<HistoryEntry[]> => {
                    capturedParams = params;
                    return [];
                }),
            };

            const explicitEnd = new Date('2025-06-01T12:00:00.000Z');
            const coord       = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            await coord.getPersonHistory('craig', { endTime: explicitEnd });

            expect(capturedParams?.endTime?.toISOString()).toBe('2025-06-01T12:00:00.000Z');
            expect(capturedParams?.startTime?.toISOString()).toBe('2025-06-01T10:00:00.000Z');
        });

        test('truncates at the default maxCharacters of 12_000 when omitted', async () => {
            const entries: HistoryEntry[] = Array.from({ length: 5 }, (_, i) => makeEntry({
                timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(),
                summary:   'y'.repeat(5000),
            }));
            const provider = makeProvider('discord', entries);
            const coord    = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result   = await coord.getPersonHistory('craig');

            expect(result.history).toHaveLength(12_000);
        });
    });

    // ── getChannelLocalHistory ──────────────────────────────────────────────────

    describe('getChannelLocalHistory', () => {
        let mockSearch: MockSearchService;

        beforeEach(() => {
            mockSearch = makeMockSearch();
        });

        test('returns undefined when no messages found', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({ messages: [] }));
            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toBeUndefined();
        });

        test('returns formatted history when messages are found', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: 'Hello world', timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toBeDefined();
            expect(result).toContain('Craig: Hello world');
            expect(result).toContain('[discord]');
            expect(result).toContain('--- Recent interactions with channel ---');
        });

        test('keeps messages without IDs when exclusion is omitted', async () => {
            mockSearch.getRecentMessages.mockImplementation(async () => ({ messages: [
                { content: 'message without an ID', timestamp: '2025-01-01T10:00:00.000Z' },
            ] }));
            const coord = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            expect(await coord.getChannelLocalHistory('ch-123')).toContain('message without an ID');
        });

        test('excludes the specified messageId', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: 'keep this',    timestamp: '2025-01-01T10:00:00.000Z' },
                    { id: 'msg2', author: { displayName: 'Craig' }, content: 'exclude this', timestamp: '2025-01-01T10:01:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123', 'msg2');

            expect(result).toContain('keep this');
            expect(result).not.toContain('exclude this');
        });

        test('returns undefined after excluding all messages', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: 'only message', timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123', 'msg1');

            expect(result).toBeUndefined();
        });

        test('passes maxMessagesPerPlatform to getRecentMessages', async () => {
            let capturedLimit: number | undefined;
            mockSearch.getRecentMessages.mockImplementation(async (_channelId: string, limit?: number): Promise<{ messages: unknown[] }> => {
                capturedLimit = limit;
                return { messages: [] };
            });

            const coord = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            await coord.getChannelLocalHistory('ch-123', undefined, { maxMessagesPerPlatform: 15 });

            expect(capturedLimit).toBe(15);
        });

        test('uses the default per-platform limit when no limit is supplied', async () => {
            let capturedLimit: number | undefined;
            mockSearch.getRecentMessages.mockImplementation(async (_channelId: string, limit?: number): Promise<{ messages: unknown[] }> => {
                capturedLimit = limit;
                return { messages: [] };
            });

            const coord = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            await coord.getChannelLocalHistory('ch-123');

            expect(capturedLimit).toBe(10);
        });

        test('truncates channel history at the default maxCharacters when omitted', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: Array.from({ length: 5 }, (_, _index) => ({ id: 'message', author: { displayName: 'Craig' }, content: 'x'.repeat(5000), timestamp: '2025-01-01T10:00:00.000Z' })),
            }));

            const coord = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toHaveLength(12_000);
        });

        test('uses the epoch timestamp when a raw message omits its timestamp', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: 'timeless' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toContain('[1970-01-01] Craig: timeless');
        });

        test('prefers a display name over a username when both are available', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig Display', username: 'craiguser' }, content: 'hello', timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toContain('Craig Display: hello');
            expect(result).not.toContain('craiguser: hello');
        });

        test('caps output at maxCharacters when formatted string is longer', async () => {
            const longContent = 'x'.repeat(5000);
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: longContent, timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123', undefined, { maxCharacters: 300 });

            expect(result).toBeDefined();
            expect(result!).toHaveLength(300);
        });

        test('does not truncate when output is shorter than maxCharacters', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: 'short', timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123', undefined, { maxCharacters: 10_000 });

            expect(result).toBeDefined();
            expect(result).toContain('--- End of recent history ---');
            expect(result!.length).toBeLessThan(10_000);
        });

        test('does not truncate channel history when maxCharacters is NaN', async () => {
            mockSearch.getRecentMessages.mockImplementation(async () => ({ messages: [
                { id: 'message', content: 'complete', timestamp: '2025-01-01T10:00:00.000Z' },
            ] }));
            const coord = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123', undefined, { maxCharacters: Number.NaN });
            expect(result).toContain('complete');
            expect(result).toContain('--- End of recent history ---');
        });

        test('messages are sorted descending by timestamp', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, content: 'earlier message', timestamp: '2025-01-01T09:00:00.000Z' },
                    { id: 'msg2', author: { displayName: 'Craig' }, content: 'later message',   timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toBeDefined();
            const laterPos   = result!.indexOf('later message');
            const earlierPos = result!.indexOf('earlier message');
            expect(laterPos).toBeLessThan(earlierPos);
        });

        test('uses username fallback when displayName is absent', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { username: 'craiguser' }, content: 'hello', timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toContain('craiguser: hello');
        });

        test('uses unknown fallback when author has no displayName or username', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: {}, content: 'hello', timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            expect(result).toContain('unknown: hello');
        });

        test('formats a previous UTC date as a date at the midnight boundary', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));
            const entry = makeEntry({ timestamp: '2025-01-01T23:59:00.000Z', summary: 'previous day' });
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [entry])] }));
            const result = await coord.getPersonHistory('craig');

            expect(result.history).toContain('[2025-01-01] previous day');
        });

        test('formats today timestamps in UTC even when the process timezone differs', async () => {
            const previousTimezone = process.env.TZ;
            process.env.TZ = 'Asia/Kathmandu';
            try {
                const entry = makeEntry({ timestamp: todayUtc(12, 34), summary: 'UTC timestamp' });
                const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [entry])] }));
                const result = await coord.getPersonHistory('craig');

                expect(result.history).toContain('[12:34] UTC timestamp');
            } finally {
                if(previousTimezone === undefined) {
                    delete process.env.TZ;
                } else {
                    // eslint-disable-next-line require-atomic-updates -- Restore the timezone captured before this isolated test's await.
                    process.env.TZ = previousTimezone;
                }
            }
        });

        test('formats an invalid symbol platform in the assertNever diagnostic', async () => {
            const invalidEntry = makeEntry({ platform: Symbol('invalid platform') as unknown as KnownPlatform });
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [invalidEntry])] }));

            await expect(coord.getPersonHistory('craig')).rejects.toThrow('Unexpected platform: Symbol(invalid platform)');
        });

        test('uses empty string fallback when content is absent', async () => {
            mockSearch.getRecentMessages.mockImplementation(async (): Promise<{ messages: unknown[] }> => ({
                messages: [
                    { id: 'msg1', author: { displayName: 'Craig' }, timestamp: '2025-01-01T10:00:00.000Z' },
                ],
            }));

            const coord  = new PersonHistoryCoordinator(makeOptions({ search: mockSearch }));
            const result = await coord.getChannelLocalHistory('ch-123');

            // Summary should be "Craig: " with an empty content part (not some fallback text like "Stryker was here!")
            expect(result).toContain('[discord] [2025-01-01] Craig: \n');
        });
    });
});
