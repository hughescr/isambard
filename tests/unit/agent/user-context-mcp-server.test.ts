import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PersonHistoryCoordinator } from '../../../src/agent/history-providers';
import { createUserContextMCPServer } from '../../../src/agent/user-context-mcp-server';
import type { Contact, ContactId } from '../../../src/storage/contacts';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

const makeContact = (overrides: Partial<Omit<Contact, '_internal'>> = {}): Omit<Contact, '_internal'> => ({
    personId:    'alice-wonderland' as ContactId,
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

describe.concurrent('createUserContextMCPServer', () => {
    let mockCoordinator: { getPersonHistory: ReturnType<typeof mock> };

    beforeEach(() => {
        mockCoordinator = {
            getPersonHistory: mock(async (): Promise<{ history: string | undefined, person: Omit<Contact, '_internal'> | undefined }> => ({
                history: '--- Recent interactions with Alice Wonderland ---\n[email] [10:00] Hello\n--- End of recent history ---',
                person:  makeContact(),
            })),
        };
    });

    function asCoordinator(c: typeof mockCoordinator): PersonHistoryCoordinator {
        return c as unknown as PersonHistoryCoordinator;
    }

    function getTool(server: ReturnType<typeof createUserContextMCPServer>, name: string): RegisteredTool {
        const instance = server.instance as unknown as RegisteredToolInstance;
        return instance._registeredTools[name];
    }

    test('creates server with user-context name and 1.0.0 version', () => {
        const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
        expect(server.name).toBe('user-context');
        expect(server.type).toBe('sdk');
        expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
    });

    test('registers getPersonContext tool', () => {
        const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
        const tool = getTool(server, 'getPersonContext');
        expect(tool).toBeDefined();
        expect(tool.description).toContain('cross-platform interaction history');
    });

    describe('getPersonContext tool', () => {
        test('returns JSON with person and history when person found', async () => {
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });

            expect(result.isError).toBeFalsy();
            expect(result.content).toHaveLength(1);
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { person: Omit<Contact, '_internal'>, history: string };
            expect(parsed.person.displayName).toBe('Alice Wonderland');
            expect(parsed.person.personId as string).toBe('alice-wonderland');
            expect(parsed.history).toContain('Recent interactions');
        });

        test('person result does not include _internal field', async () => {
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as Record<string, unknown>;
            expect(parsed.person).not.toHaveProperty('_internal');
        });

        test('returns helpful message when person not found', async () => {
            mockCoordinator.getPersonHistory.mockImplementation(async (): Promise<{ history: string | undefined, person: undefined }> => ({
                history: undefined,
                person:  undefined,
            }));
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'unknown-person' });
            expect(result.isError).toBeFalsy();
            const text = textContent(result.content[0]);
            expect(text).toContain('unknown-person');
            expect(text).toContain('No contact found');
        });

        test('uses default 7-day time window when no timeRange provided', async () => {
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
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
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
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
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
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
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
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
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });
            expect(result.isError).toBe(true);
            const text = textContent(result.content[0]);
            expect(text).toContain('Database connection failed');
        });

        test('tool has readOnlyHint and idempotentHint annotations', () => {
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.annotations.idempotentHint).toBe(true);
        });

        test('handles person found but no history', async () => {
            mockCoordinator.getPersonHistory.mockImplementation(async (): Promise<{ history: undefined, person: Omit<Contact, '_internal'> }> => ({
                history: undefined,
                person:  makeContact(),
            }));
            const server = createUserContextMCPServer({ coordinator: asCoordinator(mockCoordinator) });
            const tool = getTool(server, 'getPersonContext');

            const result = await tool.handler({ identifier: 'alice' });
            expect(result.isError).toBeFalsy();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { person: Omit<Contact, '_internal'>, history: string | null };
            expect(parsed.person.displayName).toBe('Alice Wonderland');
            // undefined history is serialized as null (not absent) so the agent sees an explicit null
            expect(parsed.history).toBeNull();
        });
    });
});
