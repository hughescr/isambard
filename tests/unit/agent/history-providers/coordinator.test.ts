import { describe, test, expect, afterEach, jest, mock } from 'bun:test';
import { PersonHistoryCoordinator, type PersonHistoryCoordinatorOptions } from '../../../../src/agent/history-providers/coordinator';
import type { HistoryEntry, HistoryFetchParams, HistoryFetchResult, KnownPlatform, PersonHistoryResult, PlatformHistoryProvider } from '../../../../src/agent/history-providers/types';
import type { Contact, PersonId, PlatformType } from '../../../../src/storage/contacts';
import { mockLogger } from '../../../setup';

// ── Helpers ────────────────────────────────────────────────────────────────────

const makeContact = (overrides: Partial<Contact> = {}): Contact => ({
    personId:    'craig-hughes' as PersonId,
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

const makeResult = (platform: KnownPlatform, overrides: Partial<HistoryFetchResult> = {}): HistoryFetchResult => ({
    platform,
    entries:   [],
    coverage:  'complete',
    truncated: false,
    failures:  [],
    ...overrides,
});

/** Build an ISO timestamp in UTC for "today" at a given hour/minute. */
function todayUtc(hour: number, minute: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute)).toISOString();
}

/** Narrow a coordinator result to the observed branch, failing the test otherwise. */
function observed(result: PersonHistoryResult): Extract<PersonHistoryResult, { kind: 'observed' }> {
    if(result.kind !== 'observed') {
        throw new Error(`expected an observed result, got ${result.kind}`);
    }
    return result;
}

const HEADER = '--- Recent interactions with Craig Hughes ---';
const FOOTER = '--- End of recent history ---';

// ── Mock types ─────────────────────────────────────────────────────────────────

interface MockContactBackend {
    fuzzyLookup:       ReturnType<typeof mock>
    resolveIdentifier: ReturnType<typeof mock>
    getContact:        ReturnType<typeof mock>
}

function makeOptions(
    overrides: {
        backend?:   MockContactBackend
        providers?: PlatformHistoryProvider[]
    } = {}
): PersonHistoryCoordinatorOptions {
    return {
        contactBackend: (overrides.backend ?? makeMockBackend()) as unknown as PersonHistoryCoordinatorOptions['contactBackend'],
        providers:      overrides.providers ?? [],
    };
}

function makeMockBackend(contact: Contact = makeContact()): MockContactBackend {
    return {
        fuzzyLookup:       mock(async (): Promise<Contact[]> => [contact]),
        resolveIdentifier: mock(async (): Promise<Contact[]> => [contact]),
        getContact:        mock(async (): Promise<Contact | undefined> => contact),
    };
}

function makeProvider(platform: KnownPlatform, entries: HistoryEntry[] = []): PlatformHistoryProvider {
    return {
        platform,
        fetchHistory: mock(async (): Promise<HistoryFetchResult> => makeResult(platform, { entries })),
    };
}

function capturingProvider(platform: KnownPlatform, captured: HistoryFetchParams[]): PlatformHistoryProvider {
    return {
        platform,
        fetchHistory: mock(async (params: HistoryFetchParams): Promise<HistoryFetchResult> => {
            captured.push(params);
            return makeResult(platform);
        }),
    };
}

function failingProvider(platform: KnownPlatform, message = 'Provider error'): PlatformHistoryProvider {
    return {
        platform,
        fetchHistory: mock(async (): Promise<HistoryFetchResult> => {
            throw new Error(message);
        }),
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.concurrent('PersonHistoryCoordinator', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    // ── getPersonHistory ───────────────────────────────────────────────────────

    describe('getPersonHistory', () => {
        test('returns contact_not_found when no contact found', async () => {
            const backend   = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => []);
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend }));
            const result = await coord.getPersonHistory('unknown person');

            expect(result).toEqual({ kind: 'contact_not_found' });
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
            const contact1 = makeContact({ personId: 'craig-hughes' as PersonId, displayName: 'Craig Hughes' });
            const contact2 = makeContact({ personId: 'craig-other'  as PersonId, displayName: 'Craig Other' });
            const backend  = makeMockBackend();
            backend.fuzzyLookup.mockImplementation(async (): Promise<Contact[]> => [contact1, contact2]);

            const coord  = new PersonHistoryCoordinator(makeOptions({ backend }));
            const { person } = observed(await coord.getPersonHistory('craig'));

            expect(person.personId as string).toBe('craig-hughes');
            expect(person.displayName).toBe('Craig Hughes');
        });

        test('strips _internal from returned person', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions());
            const { person } = observed(await coord.getPersonHistory('craig'));

            expect(person.displayName).toBe('Craig Hughes');
            expect(person).not.toHaveProperty('_internal');
        });

        test('reports every known platform as not configured when no providers are registered', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.history).toBeUndefined();
            expect(result.coverage).toEqual({
                queried:       [],
                unavailable:   [],
                partial:       [],
                notConfigured: ['discord', 'email', 'bsky'],
                notApplicable: [],
                truncated:     false,
                failures:      [],
            });
        });

        test('lists only the unregistered platforms as not configured', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord')] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.coverage.notConfigured).toEqual(['email', 'bsky']);
            expect(result.coverage.queried).toEqual(['discord']);
        });

        test('reports a complete empty search as queried with undefined history and nothing unavailable', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('email')] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.history).toBeUndefined();
            expect(result.coverage).toEqual({
                queried:       ['email'],
                unavailable:   [],
                partial:       [],
                notConfigured: ['discord', 'bsky'],
                notApplicable: [],
                truncated:     false,
                failures:      [],
            });
        });

        test('reports a registered platform the contact has no identifier on as not applicable without calling it', async () => {
            const emailProvider = makeProvider('email');
            const contact = makeContact({ identifiers: [{ platform: 'discord', value: 'craig' }] });
            const coord   = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [makeProvider('discord'), emailProvider] }));
            const result  = observed(await coord.getPersonHistory('craig'));

            expect(emailProvider.fetchHistory).not.toHaveBeenCalled();
            expect(result.coverage.notApplicable).toEqual(['email']);
            expect(result.coverage.queried).toEqual(['discord']);
            expect(result.coverage.unavailable).toEqual([]);
        });

        test('returns formatted history when providers return entries', async () => {
            const entries = [
                makeEntry({ timestamp: '2025-01-01T10:30:00.000Z', summary: 'craig: Hello' }),
                makeEntry({ timestamp: '2025-01-01T10:31:00.000Z', summary: 'Izzy: Hi there' }),
            ];
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history).toBe(`${HEADER}\n[discord] [2025-01-01] Izzy: Hi there\n[discord] [2025-01-01] craig: Hello\n${FOOTER}`);
        });

        test('formats today timestamps as HH:MM and past timestamps as date', async () => {
            // Use single-digit hour/minute to exercise the padStart('0') zero-padding
            const todayEntry = makeEntry({ timestamp: todayUtc(9, 5), summary: 'today msg' });
            const pastEntry  = makeEntry({ timestamp: '2025-01-01T10:30:00.000Z', summary: 'past msg' });
            const coord      = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [todayEntry, pastEntry])] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history).toContain('today msg');
            expect(history).toContain('past msg');
            // Today's entry should use HH:MM format with zero-padded single-digit values
            expect(history).toContain('[09:05]');
            // Past entry should use YYYY-MM-DD format
            expect(history).toContain('[2025-01-01]');
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
            const { history } = observed(await coord.getPersonHistory('craig'));

            for(const [index, date] of dates.entries()) {
                expect(history).toContain(`[${date.toISOString().slice(0, 10)}] date-case-${index}`);
            }
            expect(history).not.toContain('[09:05]');
        });

        test('separates every formatted interaction with a newline', async () => {
            const entries = [makeEntry({ summary: 'first' }), makeEntry({ summary: 'second' })];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const { history } = observed(await coord.getPersonHistory('craig'));
            expect(history).toMatch(/first\n\[discord\].*second/);
        });

        test('entries are sorted descending by timestamp', async () => {
            const earlierEntry = makeEntry({ timestamp: '2025-01-01T08:00:00.000Z', summary: 'earlier message' });
            const laterEntry   = makeEntry({ timestamp: '2025-01-01T10:00:00.000Z', summary: 'later message' });

            // Provide entries in ascending order — coordinator should flip them
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [earlierEntry, laterEntry])] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history!.indexOf('later message')).toBeLessThan(history!.indexOf('earlier message'));
        });

        test('merges entries from multiple providers and sorts them', async () => {
            const discordEntry = makeEntry({ platform: 'discord', timestamp: '2025-01-01T10:00:00.000Z', summary: 'discord msg' });
            const emailEntry   = makeEntry({ platform: 'email',   timestamp: '2025-01-01T09:00:00.000Z', summary: 'email msg' });
            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email',   value: 'craig@example.com' },
                ],
            });

            const coord = new PersonHistoryCoordinator(makeOptions({
                backend:   makeMockBackend(contact),
                providers: [makeProvider('discord', [discordEntry]), makeProvider('email', [emailEntry])],
            }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history).toBe(`${HEADER}\n[discord] [2025-01-01] discord msg\n[email] [2025-01-01] email msg\n${FOOTER}`);
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
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [firstProvider, secondProvider] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history!.indexOf('first provider')).toBeLessThan(history!.indexOf('second provider'));
        });

        test('includes [bsky] platform label in formatted output for bsky entries', async () => {
            const bskyEntry = makeEntry({ platform: 'bsky', timestamp: '2025-01-01T09:00:00.000Z', summary: 'bsky msg' });
            const contact   = makeContact({ identifiers: [{ platform: 'bsky', value: 'craig.bsky.social' }] });
            const coord     = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [makeProvider('bsky', [bskyEntry])] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history).toContain('[bsky] [2025-01-01] bsky msg');
        });

        test('caps results at maxTotalEntries and reports the cut as truncated', async () => {
            const entries: HistoryEntry[] = Array.from({ length: 20 }, (_, i) => makeEntry({
                timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(),
                summary:   `msg-${i}`,
            }));
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const result = observed(await coord.getPersonHistory('craig', { maxTotalEntries: 5 }));

            // Should only contain 5 entries: the 5 most recent
            expect(result.history?.match(/msg-\d+/g)).toEqual(['msg-19', 'msg-18', 'msg-17', 'msg-16', 'msg-15']);
            expect(result.history?.endsWith(FOOTER)).toBe(true);
            expect(result.coverage.truncated).toBe(true);
        });

        test('is not truncated when the entry count exactly equals maxTotalEntries', async () => {
            const entries = [makeEntry({ summary: 'one' }), makeEntry({ summary: 'two' })];
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const result = observed(await coord.getPersonHistory('craig', { maxTotalEntries: 2 }));

            expect(result.history?.match(/one|two/g)).toEqual(['one', 'two']);
            expect(result.coverage.truncated).toBe(false);
        });

        test('drops whole entries at maxCharacters, keeping the footer and marking truncated', async () => {
            const entries = [
                makeEntry({ summary: 'x'.repeat(5000) }),
                makeEntry({ timestamp: '2025-01-01T09:00:00.000Z', summary: 'short msg' }),
            ];
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const result = observed(await coord.getPersonHistory('craig', { maxCharacters: 200 }));

            // The newest entry does not fit, so nothing older is shown either: entries stay contiguous.
            expect(result.history).toBe(`${HEADER}\n${FOOTER}`);
            expect(result.coverage.truncated).toBe(true);
        });

        test('keeps an entry line that exactly fills maxCharacters', async () => {
            const line  = '[discord] [2025-01-01] exact fit';
            const full  = `${HEADER}\n${line}\n${FOOTER}`;
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [makeEntry({ summary: 'exact fit' })])] }));

            const exact = observed(await coord.getPersonHistory('craig', { maxCharacters: full.length }));
            expect(exact.history).toBe(full);
            expect(exact.coverage.truncated).toBe(false);

            const short = observed(await coord.getPersonHistory('craig', { maxCharacters: full.length - 1 }));
            expect(short.history).toBe(`${HEADER}\n${FOOTER}`);
            expect(short.coverage.truncated).toBe(true);
        });

        test('keeps the most recent lines that fit and drops the older rest', async () => {
            const entries = [
                makeEntry({ timestamp: '2025-01-01T10:00:00.000Z', summary: 'newest' }),
                makeEntry({ timestamp: '2025-01-01T09:00:00.000Z', summary: 'middle' }),
                makeEntry({ timestamp: '2025-01-01T08:00:00.000Z', summary: 'oldest' }),
            ];
            const twoLines = `${HEADER}\n[discord] [2025-01-01] newest\n[discord] [2025-01-01] middle\n${FOOTER}`;
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const result = observed(await coord.getPersonHistory('craig', { maxCharacters: twoLines.length }));

            expect(result.history).toBe(twoLines);
            expect(result.coverage.truncated).toBe(true);
        });

        test('keeps the header and footer even when maxCharacters is smaller than the frame', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [makeEntry()])] }));
            const result = observed(await coord.getPersonHistory('craig', { maxCharacters: 10 }));

            expect(result.history).toBe(`${HEADER}\n${FOOTER}`);
            expect(result.coverage.truncated).toBe(true);
        });

        test('does not truncate when output is shorter than maxCharacters', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [makeEntry({ summary: 'short' })])] }));
            const result = observed(await coord.getPersonHistory('craig', { maxCharacters: 10_000 }));

            expect(result.history).toBe(`${HEADER}\n[discord] [2025-01-01] short\n${FOOTER}`);
            expect(result.coverage.truncated).toBe(false);
        });

        test('does not truncate provider history when maxCharacters is NaN', async () => {
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [makeEntry({ summary: 'complete' })])] }));
            const result = observed(await coord.getPersonHistory('craig', { maxCharacters: Number.NaN }));

            expect(result.history).toBe(`${HEADER}\n[discord] [2025-01-01] complete\n${FOOTER}`);
            expect(result.coverage.truncated).toBe(false);
        });

        test('propagates a provider-reported truncation into coverage.truncated', async () => {
            const provider: PlatformHistoryProvider = {
                platform:     'email',
                fetchHistory: mock(async (): Promise<HistoryFetchResult> => makeResult('email', { entries: [makeEntry({ platform: 'email' })], truncated: true })),
            };
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.coverage.truncated).toBe(true);
        });

        test('reports truncation when only one identifier of one platform was truncated', async () => {
            const emailProvider: PlatformHistoryProvider = {
                platform:     'email',
                fetchHistory: mock(async (params: HistoryFetchParams): Promise<HistoryFetchResult> =>
                    makeResult('email', { truncated: params.identifier === 'craig@work.com' })),
            };
            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email',   value: 'craig@work.com' },
                    { platform: 'email',   value: 'craig@personal.com' },
                ],
            });
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [makeProvider('discord'), emailProvider] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.history).toBeUndefined();
            expect(result.coverage.truncated).toBe(true);
        });

        test('continues when one provider rejects and logs the platform with the error', async () => {
            const workingEntry = makeEntry({ platform: 'email', timestamp: '2025-01-01T10:00:00.000Z', summary: 'email works' });
            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email',   value: 'craig@example.com' },
                ],
            });

            mockLogger.warn.mockClear();
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [failingProvider('discord'), makeProvider('email', [workingEntry])] }));
            const result = observed(await coord.getPersonHistory('craig'));

            // Even though discord failed, email results still appear
            expect(result.history).toContain('email works');
            expect(result.coverage).toEqual({
                queried:       ['discord', 'email'],
                unavailable:   ['discord'],
                partial:       [],
                notConfigured: ['bsky'],
                notApplicable: [],
                truncated:     false,
                failures:      [{ platform: 'discord', source: 'provider', category: 'transient' }],
            });
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { err: expect.objectContaining({ message: 'Provider error' }), platform: 'discord' },
                'PersonHistoryCoordinator: provider query failed'
            );
        });

        test('reports every platform unavailable with undefined history when all providers fail', async () => {
            const contact = makeContact({
                identifiers: [
                    { platform: 'discord', value: 'craig' },
                    { platform: 'email',   value: 'craig@example.com' },
                ],
            });
            const unavailableEmail: PlatformHistoryProvider = {
                platform:     'email',
                fetchHistory: mock(async (): Promise<HistoryFetchResult> => makeResult('email', {
                    coverage: 'unavailable',
                    failures: [{ source: 'wildduck-search', category: 'transient', error: new Error('down') }],
                })),
            };
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [failingProvider('discord'), unavailableEmail] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.history).toBeUndefined();
            expect(result.coverage.unavailable).toEqual(['discord', 'email']);
            expect(result.coverage.queried).toEqual(['discord', 'email']);
            // Raw provider errors never reach the coverage block
            expect(result.coverage.failures).toEqual([
                { platform: 'discord', source: 'provider',        category: 'transient' },
                { platform: 'email',   source: 'wildduck-search', category: 'transient' },
            ]);
        });

        test('reports a provider-reported partial result as partial, not unavailable', async () => {
            const provider: PlatformHistoryProvider = {
                platform:     'discord',
                fetchHistory: mock(async (): Promise<HistoryFetchResult> => makeResult('discord', {
                    entries:  [makeEntry({ summary: 'seen' })],
                    coverage: 'partial',
                    failures: [{ source: 'channel:2', category: 'transient' }],
                })),
            };
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [provider] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.history).toContain('seen');
            expect(result.coverage.partial).toEqual(['discord']);
            expect(result.coverage.unavailable).toEqual([]);
        });

        test('marks a platform partial when one of its identifiers succeeds and another fails', async () => {
            const provider: PlatformHistoryProvider = {
                platform:     'email',
                fetchHistory: mock(async (params: HistoryFetchParams): Promise<HistoryFetchResult> => {
                    if(params.identifier === 'craig@work.com') {
                        throw new Error('work mailbox down');
                    }
                    return makeResult('email', { entries: [makeEntry({ platform: 'email', summary: 'personal mail' })] });
                }),
            };
            const contact = makeContact({
                identifiers: [
                    { platform: 'email', value: 'craig@work.com' },
                    { platform: 'email', value: 'craig@personal.com' },
                ],
            });
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [provider] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.history).toContain('personal mail');
            expect(result.coverage.partial).toEqual(['email']);
            expect(result.coverage.unavailable).toEqual([]);
            expect(result.coverage.failures).toEqual([{ platform: 'email', source: 'provider', category: 'transient' }]);
        });

        test('marks a platform unavailable only when every one of its identifiers failed', async () => {
            const contact = makeContact({
                identifiers: [
                    { platform: 'email', value: 'craig@work.com' },
                    { platform: 'email', value: 'craig@personal.com' },
                ],
            });
            const coord  = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [failingProvider('email')] }));
            const result = observed(await coord.getPersonHistory('craig'));

            expect(result.coverage.unavailable).toEqual(['email']);
            expect(result.coverage.partial).toEqual([]);
            expect(result.coverage.failures).toHaveLength(2);
        });

        test('skips a platform that service health reports down and reports it unavailable but not queried', async () => {
            const discordProvider = makeProvider('discord');
            const emailProvider   = makeProvider('email');
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [discordProvider, emailProvider] }));
            const result = observed(await coord.getPersonHistory('craig', { unavailablePlatforms: { discord: 'offline_retryable_later' } }));

            expect(discordProvider.fetchHistory).not.toHaveBeenCalled();
            expect(emailProvider.fetchHistory).toHaveBeenCalledTimes(1);
            expect(result.coverage).toEqual({
                queried:       ['email'],
                unavailable:   ['discord'],
                partial:       [],
                notConfigured: ['bsky'],
                notApplicable: [],
                truncated:     false,
                failures:      [{ platform: 'discord', source: 'service-health', category: 'offline_retryable_later' }],
            });
        });

        test('reports a health-down platform the contact has no identifier on as not applicable', async () => {
            const contact = makeContact({ identifiers: [{ platform: 'email', value: 'craig@example.com' }] });
            const coord   = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [makeProvider('discord')] }));
            const result  = observed(await coord.getPersonHistory('craig', { unavailablePlatforms: { discord: 'permanent_not_configured' } }));

            expect(result.coverage.notApplicable).toEqual(['discord']);
            expect(result.coverage.unavailable).toEqual([]);
            expect(result.coverage.failures).toEqual([]);
        });

        test('passes startTime and endTime to providers based on timeWindowMinutes', async () => {
            const captured: HistoryFetchParams[] = [];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig', { timeWindowMinutes: 60 });

            const [params] = captured;
            expect(params.startTime).toBeInstanceOf(Date);
            expect(params.endTime).toBeInstanceOf(Date);

            const windowMs = params.endTime!.getTime() - params.startTime!.getTime();
            expect(windowMs).toBe(60 * 60 * 1000);
        });

        test('uses explicit startTime and endTime options when provided, ignoring timeWindowMinutes', async () => {
            const captured: HistoryFetchParams[] = [];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [capturingProvider('discord', captured)] }));
            // Pass a wildly different timeWindowMinutes to confirm it is ignored when explicit dates are provided
            await coord.getPersonHistory('craig', {
                startTime:         new Date('2025-01-01T00:00:00.000Z'),
                endTime:           new Date('2025-01-02T00:00:00.000Z'),
                timeWindowMinutes: 9999,
            });

            expect(captured[0]?.startTime?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
            expect(captured[0]?.endTime?.toISOString()).toBe('2025-01-02T00:00:00.000Z');
        });

        test('uses explicit endTime with timeWindowMinutes fallback when only endTime provided', async () => {
            const captured: HistoryFetchParams[] = [];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig', { endTime: new Date('2025-06-01T12:00:00.000Z'), timeWindowMinutes: 60 });

            // endTime is used as-is; startTime is computed from endTime - 60 minutes
            expect(captured[0]?.endTime?.toISOString()).toBe('2025-06-01T12:00:00.000Z');
            expect(captured[0]?.startTime?.toISOString()).toBe('2025-06-01T11:00:00.000Z');
        });

        test('passes maxMessages to providers', async () => {
            const captured: HistoryFetchParams[] = [];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig', { maxMessagesPerPlatform: 25 });

            expect(captured[0]?.maxMessages).toBe(25);
        });

        test('queries all matching identifiers for a platform', async () => {
            const captured: HistoryFetchParams[] = [];
            const contact = makeContact({
                identifiers: [
                    { platform: 'email', value: 'craig@work.com' },
                    { platform: 'email', value: 'craig@personal.com' },
                ],
            });
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [capturingProvider('email', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured.map(params => params.identifier)).toEqual(['craig@work.com', 'craig@personal.com']);
        });

        test('passes a discord scope with the discordUserId when _internal has one', async () => {
            const captured: HistoryFetchParams[] = [];
            const contact = makeContact({ identifiers: [{ platform: 'discord', value: 'craig' }] });
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured[0]?.scope).toEqual({ platform: 'discord', discordUserId: '123456789' });
        });

        test('passes no discord scope when _internal has no discordUserId', async () => {
            const captured: HistoryFetchParams[] = [];
            const contact = makeContact({ identifiers: [{ platform: 'discord', value: 'craig' }], _internal: { bskyDid: 'did:plc:abc123' } });
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured[0]).not.toHaveProperty('scope');
        });

        test('passes a bsky direct-conversation scope when _internal has a bskyDid', async () => {
            const captured: HistoryFetchParams[] = [];
            const contact = makeContact({ identifiers: [{ platform: 'bsky', value: 'craig.bsky.social' }] });
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [capturingProvider('bsky', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured[0]?.scope).toEqual({ platform: 'bsky', kind: 'direct-conversation', participantDid: 'did:plc:abc123' });
        });

        test('passes a bsky author-feed scope when the contact has no _internal', async () => {
            const captured: HistoryFetchParams[] = [];
            const contact = makeContact({ identifiers: [{ platform: 'bsky', value: 'craig.bsky.social' }], _internal: undefined });
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [capturingProvider('bsky', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured[0]?.scope).toEqual({ platform: 'bsky', kind: 'author-feed' });
        });

        test('passes no scope to the email provider even when _internal carries other platform IDs', async () => {
            const captured: HistoryFetchParams[] = [];
            const contact = makeContact({ identifiers: [{ platform: 'email', value: 'craig@example.com' }] });
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [capturingProvider('email', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured[0]).toEqual({
                identifier:  'craig@example.com',
                maxMessages: 10,
                startTime:   expect.any(Date),
                endTime:     expect.any(Date),
            });
        });

        test('rejects a registered provider whose platform has no history scope case', async () => {
            const contact = makeContact({ identifiers: [{ platform: 'rss' as unknown as PlatformType, value: 'feed' }] });
            const provider = makeProvider('rss' as unknown as KnownPlatform);
            const coord = new PersonHistoryCoordinator(makeOptions({ backend: makeMockBackend(contact), providers: [provider] }));

            await expect(coord.getPersonHistory('craig')).rejects.toThrow('Unexpected history platform: rss');
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
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [unknownPlatformEntry])] }));

            await expect(coord.getPersonHistory('craig')).rejects.toThrow('Unexpected platform: rss');
        });
    });

    // ── default option constants ────────────────────────────────────────────────

    describe('default option constants', () => {
        // Each default in types.ts drives observable coordinator behaviour when the
        // caller passes no option (or omits that option). These tests pin the defaults
        // through the public API rather than importing the constants directly.

        test('uses the default maxMessagesPerPlatform of 10 when omitted', async () => {
            const captured: HistoryFetchParams[] = [];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig');

            expect(captured[0]?.maxMessages).toBe(10);
        });

        test('caps results at the default maxTotalEntries of 30 when omitted', async () => {
            const entries: HistoryEntry[] = Array.from({ length: 40 }, (_, i) => makeEntry({
                timestamp: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
                summary:   `default-cap-${i}`,
            }));
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history?.match(/default-cap-\d+/g)).toHaveLength(30);
        });

        test('uses the default time window of 120 minutes when timeWindowMinutes is omitted', async () => {
            const captured: HistoryFetchParams[] = [];
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [capturingProvider('discord', captured)] }));
            await coord.getPersonHistory('craig', { endTime: new Date('2025-06-01T12:00:00.000Z') });

            expect(captured[0]?.endTime?.toISOString()).toBe('2025-06-01T12:00:00.000Z');
            expect(captured[0]?.startTime?.toISOString()).toBe('2025-06-01T10:00:00.000Z');
        });

        test('keeps whole lines within the default maxCharacters of 12_000 when omitted', async () => {
            const line = (i: number): string => `[discord] [2025-01-01] ${String(i)}${'y'.repeat(4000)}`;
            const entries: HistoryEntry[] = Array.from({ length: 5 }, (_, i) => makeEntry({
                timestamp: new Date(Date.UTC(2025, 0, 1, 4 - i)).toISOString(),
                summary:   `${String(i)}${'y'.repeat(4000)}`,
            }));
            const coord  = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', entries)] }));
            const result = observed(await coord.getPersonHistory('craig'));

            // Two ~4025-char lines fit in 12_000 alongside the frame; a third would not.
            expect(result.history).toBe(`${HEADER}\n${line(0)}\n${line(1)}\n${FOOTER}`);
            expect(result.coverage.truncated).toBe(true);
        });
    });

    describe('getPersonHistory formatting regressions', () => {
        test('formats a previous UTC date as a date at the midnight boundary', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));
            const entry = makeEntry({ timestamp: '2025-01-01T23:59:00.000Z', summary: 'previous day' });
            const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [entry])] }));
            const { history } = observed(await coord.getPersonHistory('craig'));

            expect(history).toContain('[2025-01-01] previous day');
        });

        test('formats today timestamps in UTC even when the process timezone differs', async () => {
            const previousTimezone = process.env.TZ;
            process.env.TZ = 'Asia/Kathmandu';
            try {
                const entry = makeEntry({ timestamp: todayUtc(12, 34), summary: 'UTC timestamp' });
                const coord = new PersonHistoryCoordinator(makeOptions({ providers: [makeProvider('discord', [entry])] }));
                const { history } = observed(await coord.getPersonHistory('craig'));

                expect(history).toContain('[12:34] UTC timestamp');
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
    });
});
