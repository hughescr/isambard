import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PersonHistoryCoordinator, type PersonHistoryCoverage, type PersonHistoryResult } from '../../../src/agent/history-providers';
import { createPersonContextMCPServer } from '../../../src/agent/person-context-mcp-server';
import type { HealthState, ServiceName } from '../../../src/services/types';
import type { Contact, ContactBackend, PersonId } from '../../../src/storage/contacts';
import { mockLogger, textContent } from '../../setup';

const COVERAGE: PersonHistoryCoverage = {
    queried:       ['email', 'bsky'],
    unavailable:   ['bsky'],
    partial:       [],
    notConfigured: [],
    notApplicable: ['discord'],
    truncated:     true,
    failures:      [{ platform: 'bsky', source: 'author-feed', category: 'transient' }],
};

/** A health registry stub reporting the given state per service (online when unlisted). */
function healthRegistry(states: Partial<Record<ServiceName, HealthState>>) {
    return { getState: mock((service: ServiceName): HealthState => states[service] ?? 'online') };
}

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

const makeContact = (overrides: Partial<Omit<Contact, '_internal'>> = {}): Omit<Contact, '_internal'> => ({
    personId:    'alice-wonderland' as PersonId,
    displayName: 'Alice Wonderland',
    identifiers: [
        { platform: 'email', value: 'alice@example.com' },
        { platform: 'bsky',  value: 'alice.bsky.social' },
    ],
    notes:     'Test contact',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    ...overrides,
});

describe.concurrent('createPersonContextMCPServer', () => {
    let mockCoordinator: { getPersonHistory: ReturnType<typeof mock> };

    beforeEach(() => {
        mockCoordinator = {
            getPersonHistory: mock(async (): Promise<PersonHistoryResult> => ({
                kind:     'observed',
                history:  '--- Recent interactions with Alice Wonderland ---\n[email] [10:00] Hello\n--- End of recent history ---',
                person:   makeContact(),
                coverage: COVERAGE,
            })),
        };
    });

    function asCoordinator(c: typeof mockCoordinator): PersonHistoryCoordinator {
        return c as unknown as PersonHistoryCoordinator;
    }

    function getTool(server: ReturnType<typeof createPersonContextMCPServer>, name: string): RegisteredTool {
        const instance = server.instance as unknown as RegisteredToolInstance;
        return instance._registeredTools[name];
    }

    test('keeps the model-visible wire name user-context and 1.0.0 version', () => {
        const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
        expect(server.name).toBe('user-context');
        expect(server.type).toBe('sdk');
        expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
    });

    test('registers getPersonContext tool', () => {
        const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
        const tool = getTool(server, 'getPersonContext');
        expect(tool).toBeDefined();
        expect(tool.description).toContain('cross-platform interaction history');
    });

    test('accepts a one-character person identifier', () => {
        const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
        const tool = getTool(server, 'getPersonContext');
        const schema = tool.inputSchema.shape.identifier as { safeParse: (value: unknown) => { success: boolean } };
        expect(schema.safeParse('x').success).toBe(true);
    });

    describe('getPersonContext tool', () => {
        test('returns JSON with person and history when person found', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });

            expect(result.isError).toBeFalsy();
            expect(result.content).toHaveLength(1);
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { person: Omit<Contact, '_internal'>, history: string, coverage: PersonHistoryCoverage };
            expect(parsed.person.displayName).toBe('Alice Wonderland');
            expect(parsed.person.personId as string).toBe('alice-wonderland');
            expect(parsed.history).toBe('--- Recent interactions with Alice Wonderland ---\n[email] [10:00] Hello\n--- End of recent history ---');
            expect(parsed.coverage).toEqual(COVERAGE);
            expect(Object.keys(parsed)).toEqual(['person', 'history', 'coverage']);
        });

        test('passes no unavailable platforms when no health registry is wired', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });

            await getTool(server, 'getPersonContext').handler({ identifier: 'alice' });

            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { unavailablePlatforms: unknown }];
            expect(callArgs[1].unavailablePlatforms).toEqual({});
        });

        test('passes health-derived unavailable platforms by category and omits online ones', async () => {
            const registry = healthRegistry({ discord: 'online', email: 'disabled', bsky: 'offline' });
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator), healthRegistry: registry });

            await getTool(server, 'getPersonContext').handler({ identifier: 'alice' });

            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { unavailablePlatforms: unknown }];
            expect(callArgs[1].unavailablePlatforms).toEqual({ email: 'permanent_not_configured', bsky: 'offline_retryable_later' });
            expect(registry.getState.mock.calls.map(call => call[0])).toEqual(['discord', 'email', 'bsky']);
        });

        test('treats starting and recovering services as retryable later', async () => {
            const registry = healthRegistry({ discord: 'starting', bsky: 'recovering' });
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator), healthRegistry: registry });

            await getTool(server, 'getPersonContext').handler({ identifier: 'alice' });

            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { unavailablePlatforms: unknown }];
            expect(callArgs[1].unavailablePlatforms).toEqual({ discord: 'offline_retryable_later', bsky: 'offline_retryable_later' });
        });

        test('keeps the history trailer and reports truncation through a real coordinator', async () => {
            const contact = { ...makeContact(), _internal: { bskyDid: 'did:plc:alice' } };
            const entries = Array.from({ length: 20 }, (_, i) => ({
                platform:  'email' as const,
                timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(),
                summary:   `${String(i)}${'z'.repeat(1000)}`,
                direction: 'inbound' as const,
            }));
            const coordinator = new PersonHistoryCoordinator({
                contactBackend: { fuzzyLookup: async () => [contact] } as unknown as ContactBackend,
                providers:      [{ platform: 'email', fetchHistory: async () => ({ platform: 'email', entries, coverage: 'complete', truncated: false, failures: [] }) }],
            });
            const server = createPersonContextMCPServer({ coordinator });

            const result = await getTool(server, 'getPersonContext').handler({ identifier: 'alice' });

            const parsed = JSON.parse(textContent(result.content[0])) as { history: string, coverage: PersonHistoryCoverage };
            expect(parsed.history.endsWith('\n--- End of recent history ---')).toBe(true);
            expect(parsed.history.length).toBeLessThanOrEqual(12_000);
            expect(parsed.coverage.truncated).toBe(true);
            expect(parsed.coverage.queried).toEqual(['email']);
            expect(parsed.coverage.notConfigured).toEqual(['discord', 'bsky']);
        });

        test('describes the coverage block in the tool description', () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const { description } = getTool(server, 'getPersonContext');
            expect(description).toContain('plus a coverage block');
            expect(description).toContain('truncated means the search was bounded, so some entries were or may have been left out.');
            expect(description).toContain('A null history means no entries were observed, not that none exist: it shows no interactions only on queried platforms that are not unavailable or partial, and only when truncated is false; notConfigured and notApplicable platforms were never searched.');
            expect(description).not.toContain('A null history only means no interactions');
        });

        test('person result does not include _internal field', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as Record<string, unknown>;
            expect(parsed.person).not.toHaveProperty('_internal');
        });

        test('returns helpful message when person not found', async () => {
            mockCoordinator.getPersonHistory.mockImplementation(async (): Promise<PersonHistoryResult> => ({ kind: 'contact_not_found' }));
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'unknown-person' });
            expect(result.isError).toBeFalsy();
            const text = textContent(result.content[0]);
            expect(text).toContain('unknown-person');
            expect(text).toContain('No contact found');
        });

        test('uses default 7-day time window when no timeRange provided', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            await tool.handler({ identifier: 'alice' });

            expect(mockCoordinator.getPersonHistory).toHaveBeenCalledTimes(1);
            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { timeWindowMinutes: number, maxMessagesPerPlatform: number, maxTotalEntries: number, startTime?: Date, endTime?: Date }];
            expect(callArgs[0]).toBe('alice');
            // Default is 7 days = 7 * 24 * 60 = 10080 minutes (used as fallback when no explicit dates)
            expect(callArgs[1].timeWindowMinutes).toBe(7 * 24 * 60);
            expect(callArgs[1].maxMessagesPerPlatform).toBe(20);
            expect(callArgs[1].maxTotalEntries).toBe(50);
            // No explicit dates provided — coordinator uses timeWindowMinutes as fallback
            expect(callArgs[1].startTime).toBeUndefined();
            expect(callArgs[1].endTime).toBeUndefined();
        });

        test('passes absolute startTime and endTime when timeRange with both provided', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const startTime = new Date('2025-01-01T00:00:00.000Z');
            const endTime   = new Date('2025-01-02T00:00:00.000Z');
            await tool.handler({ identifier: 'alice', timeRange: { startTime: startTime.toISOString(), endTime: endTime.toISOString() } });

            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { startTime?: Date, endTime?: Date }];
            // Absolute dates are passed directly so the coordinator uses the exact window
            expect(callArgs[1].startTime).toBeInstanceOf(Date);
            expect(callArgs[1].endTime).toBeInstanceOf(Date);
            expect(callArgs[1].startTime!.toISOString()).toBe('2025-01-01T00:00:00.000Z');
            expect(callArgs[1].endTime!.toISOString()).toBe('2025-01-02T00:00:00.000Z');
        });

        test('passes absolute startTime and undefined endTime when only startTime provided', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const startTime = new Date('2025-01-01T00:00:00.000Z');
            await tool.handler({ identifier: 'alice', timeRange: { startTime: startTime.toISOString() } });

            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { startTime?: Date, endTime?: Date }];
            // startTime is passed through; endTime is undefined so coordinator defaults to now
            expect(callArgs[1].startTime).toBeInstanceOf(Date);
            expect(callArgs[1].startTime!.toISOString()).toBe('2025-01-01T00:00:00.000Z');
            expect(callArgs[1].endTime).toBeUndefined();
        });

        test('passes undefined startTime and absolute endTime when only endTime provided', async () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const endTime = new Date('2025-06-01T12:00:00.000Z');
            await tool.handler({ identifier: 'alice', timeRange: { endTime: endTime.toISOString() } });

            const callArgs = mockCoordinator.getPersonHistory.mock.calls[0] as [string, { startTime?: Date, endTime?: Date }];
            // endTime is passed through; startTime is undefined so coordinator uses timeWindowMinutes fallback
            expect(callArgs[1].startTime).toBeUndefined();
            expect(callArgs[1].endTime).toBeInstanceOf(Date);
            expect(callArgs[1].endTime!.toISOString()).toBe('2025-06-01T12:00:00.000Z');
        });

        test('returns error result when coordinator throws', async () => {
            mockCoordinator.getPersonHistory.mockImplementation(async (): Promise<never> => {
                throw new Error('Database connection failed');
            });
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });
            expect(result.isError).toBe(true);
            const text = textContent(result.content[0]);
            expect(text).toContain('Database connection failed');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { tool: 'getPersonContext', error: 'Database connection failed' }, 'MCP tool error');
        });

        test('tool has readOnlyHint and idempotentHint annotations', () => {
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.annotations.idempotentHint).toBe(true);
        });

        test('handles person found but no history', async () => {
            mockCoordinator.getPersonHistory.mockImplementation(async (): Promise<PersonHistoryResult> => ({
                kind:     'observed',
                history:  undefined,
                person:   makeContact(),
                coverage: COVERAGE,
            }));
            const server = createPersonContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });
            expect(result.isError).toBeFalsy();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { person: Omit<Contact, '_internal'>, history: string | null, coverage: PersonHistoryCoverage };
            expect(parsed.person.displayName).toBe('Alice Wonderland');
            // undefined history is serialized as null (not absent) so the agent sees an explicit null,
            // and coverage says whether that null means "nothing there" or "could not look"
            expect(parsed.history).toBeNull();
            expect(parsed.coverage).toEqual(COVERAGE);
        });
    });
});
