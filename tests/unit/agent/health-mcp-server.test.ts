import { describe, test, expect } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHealthMCPServer } from '../../../src/agent/health-mcp-server';
import { makeHealthEntry, makeHealthRegistry } from '../../helpers/fake-health-registry';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

function getTool(server: ReturnType<typeof createHealthMCPServer>, name: string): RegisteredTool {
    const instance = server.instance as unknown as RegisteredToolInstance;
    return instance._registeredTools[name];
}

describe('createHealthMCPServer', () => {
    test('creates a server named health', () => {
        const server = createHealthMCPServer({ healthRegistry: makeHealthRegistry() });
        expect(server.name).toBe('health');
        expect(server.type).toBe('sdk');
    });

    test('creates a server at version 1.0.0', () => {
        const server = createHealthMCPServer({ healthRegistry: makeHealthRegistry() });
        expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
    });

    test('registers a getServiceHealth tool with the documented description', () => {
        const server = createHealthMCPServer({ healthRegistry: makeHealthRegistry() });
        const tool = getTool(server, 'getServiceHealth');
        expect(tool).toBeDefined();
        expect(tool.description).toBe('Get the current health status of every integrated service (Discord, email, Bluesky, CalDAV, DynamoDB, etc). Returns per-service state, epoch, and last error, plus a human-readable summary when there is anything to report. Answers even during an outage.');
    });

    describe('getServiceHealth tool', () => {
        test('returns state/epoch/lastError per service from getAll()', async () => {
            const discordEntry = makeHealthEntry({ state: 'online', epoch: 4 });
            const emailEntry   = makeHealthEntry({ state: 'offline', epoch: 1, lastError: { code: 'AUTH', message: 'bad creds' } });
            const registry     = makeHealthRegistry({ entries: { discord: discordEntry, email: emailEntry } });
            const server       = createHealthMCPServer({ healthRegistry: registry });
            const tool         = getTool(server, 'getServiceHealth');

            const result = await tool.handler({});

            expect(result.isError).toBeFalsy();
            const parsed = JSON.parse(textContent(result.content[0])) as { services: Record<string, { state: string, epoch: number, failureCount: number, lastError?: { code: string, message: string } }> };
            expect(parsed.services.discord).toEqual({ state: 'online', epoch: 4, failureCount: 0 });
            expect(parsed.services.email).toEqual({ state: 'offline', epoch: 1, failureCount: 0, lastError: { code: 'AUTH', message: 'bad creds' } });
        });

        test('includes summary text when buildStatusSummary() is defined', async () => {
            const registry = makeHealthRegistry({ summary: 'email offline for 3m' });
            const server   = createHealthMCPServer({ healthRegistry: registry });
            const tool     = getTool(server, 'getServiceHealth');

            const result = await tool.handler({});

            const parsed = JSON.parse(textContent(result.content[0])) as { summary?: string };
            expect(parsed.summary).toBe('email offline for 3m');
        });

        test('omits summary key when buildStatusSummary() is undefined', async () => {
            const registry = makeHealthRegistry();
            const server   = createHealthMCPServer({ healthRegistry: registry });
            const tool     = getTool(server, 'getServiceHealth');

            const result = await tool.handler({});

            const parsed = JSON.parse(textContent(result.content[0])) as Record<string, unknown>;
            expect(parsed).not.toHaveProperty('summary');
        });

        test('is reachable and answers normally while a service is offline', async () => {
            const registry = makeHealthRegistry({ entries: { discord: makeHealthEntry({ state: 'offline' }) } });
            const server   = createHealthMCPServer({ healthRegistry: registry });
            const tool     = getTool(server, 'getServiceHealth');

            const result = await tool.handler({});

            expect(result.isError).toBeFalsy();
            const parsed = JSON.parse(textContent(result.content[0])) as { services: Record<string, { state: string }> };
            expect(parsed.services.discord.state).toBe('offline');
        });

        test('is reachable and answers normally when every registered service is offline or disabled', async () => {
            const registry = makeHealthRegistry({
                entries: {
                    discord:                    makeHealthEntry({ state: 'offline' }),
                    'discord-channel-registry': makeHealthEntry({ state: 'disabled' }),
                    email:                      makeHealthEntry({ state: 'offline' }),
                    bluesky:                    makeHealthEntry({ state: 'disabled' }),
                    caldav:                     makeHealthEntry({ state: 'offline' }),
                    dynamodb:                   makeHealthEntry({ state: 'disabled' }),
                },
            });
            const server = createHealthMCPServer({ healthRegistry: registry });
            const tool   = getTool(server, 'getServiceHealth');

            const result = await tool.handler({});

            expect(result.isError).toBeFalsy();
            const parsed = JSON.parse(textContent(result.content[0])) as { services: Record<string, { state: string }> };
            expect(parsed.services.discord.state).toBe('offline');
            expect(parsed.services.bluesky.state).toBe('disabled');
            expect(parsed.services.dynamodb.state).toBe('disabled');
        });

        test('has readOnlyHint true and destructiveHint false, with no health guard blocking it', () => {
            const server = createHealthMCPServer({ healthRegistry: makeHealthRegistry() });
            const tool   = getTool(server, 'getServiceHealth');

            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.annotations.destructiveHint).toBe(false);
            expect(tool.annotations.idempotentHint).toBe(true);
            expect(tool.annotations.openWorldHint).toBe(false);
        });
    });
});
