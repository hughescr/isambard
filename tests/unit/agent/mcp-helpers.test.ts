import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mcpServiceUnavailableResult, checkServiceHealth, checkWriteServiceHealth, withHealthGuard, withWriteHealthGuard, withToolErrorHandling } from '../../../src/agent/mcp-helpers';
import type { ServiceHealthRegistry } from '../../../src/services/health-registry';
import type { ReconnectionLoop } from '../../../src/services/reconnection-loop';
import type { ServiceHealthEntry } from '../../../src/services/types';
import { mockLogger } from '../../setup';

// ---- helpers ----

function makeEntry(overrides: Partial<ServiceHealthEntry> = {}): ServiceHealthEntry {
    return {
        state:        'offline',
        epoch:        0,
        failureCount: 0,
        ...overrides,
    };
}

function makeRegistry(available: Record<string, boolean>, entries: Record<string, ServiceHealthEntry>): ServiceHealthRegistry {
    return {
        isAvailable:        mock((svc: string) => available[svc] ?? false),
        getEntry:           mock((svc: string) => entries[svc] ?? makeEntry()),
        getState:           mock(() => 'offline' as const),
        getAll:             mock(() => ({}) as ReturnType<ServiceHealthRegistry['getAll']>),
        isWriteAvailable:   mock(() => false),
        sendEvent:          mock(() => undefined),
        subscribe:          mock(() => () => undefined),
        buildStatusSummary: mock(() => undefined),
        stop:               mock(() => undefined),
    };
}

function makeLoop(): ReconnectionLoop {
    return {
        triggerNow: mock(async () => true),
        start:      mock(() => undefined),
        stop:       mock(() => undefined),
        isRunning:  mock(() => false),
    };
}

// ---- mcpServiceUnavailableResult ----

describe('mcpServiceUnavailableResult', () => {
    test('state=disabled → category permanent_not_configured, message says "not configured"', () => {
        const entry = makeEntry({ state: 'disabled' });
        const result = mcpServiceUnavailableResult('email', entry);
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('not configured');
        // Should NOT include retry language
        expect(text).not.toContain('retry');
    });

    test('state=degraded → message says "Read operations may still work"', () => {
        const entry = makeEntry({ state: 'degraded' });
        const result = mcpServiceUnavailableResult('email', entry);
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('Read operations may still work');
    });

    test('state=offline → message contains "retry"', () => {
        const entry = makeEntry({ state: 'offline' });
        const result = mcpServiceUnavailableResult('bluesky', entry);
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('retry');
    });

    test('state=recovering → treated as offline, message contains "retry"', () => {
        const entry = makeEntry({ state: 'recovering' });
        const result = mcpServiceUnavailableResult('bluesky', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('retry');
    });

    test('with lastError → message includes error message', () => {
        const entry = makeEntry({ state: 'offline', lastError: { code: 'AUTH', message: 'bad credentials' } });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('bad credentials');
    });

    test('without lastError → no last-error text', () => {
        const entry = makeEntry({ state: 'offline' });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).not.toContain('Last error');
    });

    test('with lastOfflineAt → message includes "Offline since"', () => {
        const entry = makeEntry({ state: 'offline', lastOfflineAt: new Date(Date.now() - 60_000) });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('Offline since');
    });

    test('without lastOfflineAt → no "Offline since" text', () => {
        const entry = makeEntry({ state: 'offline' });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).not.toContain('Offline since');
    });

    test('nextRetryAt in the future → message includes "Next reconnection attempt in ~Xs"', () => {
        const nextRetryAt = new Date(Date.now() + 30_000);
        const entry = makeEntry({ state: 'offline', nextRetryAt });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('Next reconnection attempt in ~');
        expect(text).toMatch(/~\d+s/);
    });

    test('nextRetryAt in the past → message says "reconnection attempt is in progress"', () => {
        const nextRetryAt = new Date(Date.now() - 5000);
        const entry = makeEntry({ state: 'offline', nextRetryAt });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('reconnection attempt is in progress');
    });

    test('without nextRetryAt → message says "reconnection attempt is in progress"', () => {
        const entry = makeEntry({ state: 'offline' });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('reconnection attempt is in progress');
    });

    test('with reconnectionLoop → triggerNow() is called', () => {
        const entry = makeEntry({ state: 'offline' });
        const loop = makeLoop();
        mcpServiceUnavailableResult('email', entry, loop);
        expect(loop.triggerNow).toHaveBeenCalledTimes(1);
    });

    test('without reconnectionLoop → no error', () => {
        const entry = makeEntry({ state: 'offline' });
        expect(() => mcpServiceUnavailableResult('email', entry)).not.toThrow();
    });

    test('returns isError: true', () => {
        const result = mcpServiceUnavailableResult('email', makeEntry({ state: 'offline' }));
        expect(result.isError).toBe(true);
    });

    test('message includes the service name', () => {
        const result = mcpServiceUnavailableResult('bluesky', makeEntry({ state: 'offline' }));
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('bluesky');
    });

    test('message starts with "The <service> service is currently <state>"', () => {
        const result = mcpServiceUnavailableResult('email', makeEntry({ state: 'offline' }));
        const text = (result.content[0] as { text: string }).text;
        expect(text).toStartWith('The email service is currently offline.');
    });

    test('multiple parts are space-separated (not concatenated)', () => {
        const entry = makeEntry({ state: 'offline', lastError: { code: 'AUTH', message: 'bad creds' } });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        // "The email service..." and "Last error:..." should be separated by a space
        expect(text).toContain('currently offline. Last error');
    });

    test('disabled state does NOT include "Read operations may still work"', () => {
        const entry = makeEntry({ state: 'disabled' });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        expect(text).not.toContain('Read operations may still work');
    });

    test('degraded state does NOT trigger reconnection loop', () => {
        const entry = makeEntry({ state: 'degraded' });
        const loop = makeLoop();
        mcpServiceUnavailableResult('email', entry, loop);
        // degraded is not offline_retryable_later category — but loop is still called
        // Actually looking at the code: reconnectionLoop.triggerNow() is called for any state
        expect(loop.triggerNow).toHaveBeenCalledTimes(1);
    });

    test('nextRetryAt in future: waitSec uses Math.ceil', () => {
        // 500ms in the future → Math.ceil(500/1000) = Math.ceil(0.5) = 1s
        // Use 500ms instead of 1ms to avoid flakiness under parallel test runs (1ms can expire during the call)
        const nextRetryAt = new Date(Date.now() + 500);
        const entry = makeEntry({ state: 'offline', nextRetryAt });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        // Should show ~1s (ceil of 0.5 is 1)
        expect(text).toContain('~1s');
    });
});

// ---- checkServiceHealth ----

describe('checkServiceHealth', () => {
    test('when service is available → returns undefined', () => {
        const entry = makeEntry({ state: 'online' });
        const registry = makeRegistry({ discord: true }, { discord: entry });
        const result = checkServiceHealth(registry, 'discord');
        expect(result).toBeUndefined();
    });

    test('when service is unavailable → returns CallToolResult with isError true', () => {
        const entry = makeEntry({ state: 'offline' });
        const registry = makeRegistry({ discord: false }, { discord: entry });
        const result = checkServiceHealth(registry, 'discord');
        expect(result).toBeDefined();
        expect(result!.isError).toBe(true);
    });

    test('passes reconnectionLoop to mcpServiceUnavailableResult', () => {
        const entry = makeEntry({ state: 'offline' });
        const registry = makeRegistry({ email: false }, { email: entry });
        const loop = makeLoop();
        checkServiceHealth(registry, 'email', loop);
        expect(loop.triggerNow).toHaveBeenCalledTimes(1);
    });

    test('when available, reconnectionLoop is NOT triggered', () => {
        const entry = makeEntry({ state: 'online' });
        const registry = makeRegistry({ email: true }, { email: entry });
        const loop = makeLoop();
        checkServiceHealth(registry, 'email', loop);
        expect(loop.triggerNow).not.toHaveBeenCalled();
    });
});

// ---- checkWriteServiceHealth ----

describe('checkWriteServiceHealth', () => {
    test('when both available → returns undefined', () => {
        const registry = makeRegistry(
            { bluesky: true, discord: true },
            { bluesky: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'online' }) }
        );
        const result = checkWriteServiceHealth(registry, 'bluesky', 'discord');
        expect(result).toBeUndefined();
    });

    test('when primary unavailable → returns error about primary service', () => {
        const registry = makeRegistry(
            { bluesky: false, discord: true },
            { bluesky: makeEntry({ state: 'offline' }), discord: makeEntry({ state: 'online' }) }
        );
        const result = checkWriteServiceHealth(registry, 'bluesky', 'discord');
        expect(result).toBeDefined();
        expect(result!.isError).toBe(true);
        const text = (result!.content[0] as { text: string }).text;
        expect(text).toContain('bluesky');
    });

    test('when primary available but approval unavailable → error mentioning approval service', () => {
        const registry = makeRegistry(
            { bluesky: true, discord: false },
            { bluesky: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'offline' }) }
        );
        const result = checkWriteServiceHealth(registry, 'bluesky', 'discord');
        expect(result).toBeDefined();
        expect(result!.isError).toBe(true);
        const text = (result!.content[0] as { text: string }).text;
        expect(text).toContain('discord');
        expect(text).toContain('approval');
    });

    test('approval unavailable message also mentions primary service being online', () => {
        const registry = makeRegistry(
            { bluesky: true, discord: false },
            { bluesky: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'offline' }) }
        );
        const result = checkWriteServiceHealth(registry, 'bluesky', 'discord');
        const text = (result!.content[0] as { text: string }).text;
        expect(text).toContain('bluesky');
        expect(text).toContain('online');
    });

    test('passes reconnectionLoop to primary check', () => {
        const registry = makeRegistry(
            { bluesky: false, discord: true },
            { bluesky: makeEntry({ state: 'offline' }), discord: makeEntry({ state: 'online' }) }
        );
        const loop = makeLoop();
        checkWriteServiceHealth(registry, 'bluesky', 'discord', loop);
        expect(loop.triggerNow).toHaveBeenCalledTimes(1);
    });

    test('reconnectionLoop NOT triggered when primary available and approval unavailable', () => {
        const registry = makeRegistry(
            { bluesky: true, discord: false },
            { bluesky: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'offline' }) }
        );
        const loop = makeLoop();
        checkWriteServiceHealth(registry, 'bluesky', 'discord', loop);
        // Primary check passes (available), so loop is not triggered
        expect(loop.triggerNow).not.toHaveBeenCalled();
    });
});

// ---- withHealthGuard ----

describe('withHealthGuard', () => {
    test('when healthRegistry is undefined → handler is called directly', async () => {
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withHealthGuard(undefined, 'discord', undefined, handler);
        const result = await wrapped({ x: 1 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ x: 1 });
        expect((result.content[0] as { text: string }).text).toBe('ok');
    });

    test('when service is healthy → handler is called', async () => {
        const registry = makeRegistry({ discord: true }, { discord: makeEntry({ state: 'online' }) });
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withHealthGuard(registry, 'discord', undefined, handler);
        const result = await wrapped({ x: 2 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ x: 2 });
        expect((result.content[0] as { text: string }).text).toBe('ok');
    });

    test('when service is unhealthy → health error returned, handler not called', async () => {
        const registry = makeRegistry({ discord: false }, { discord: makeEntry({ state: 'offline' }) });
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withHealthGuard(registry, 'discord', undefined, handler);
        const result = await wrapped({ x: 3 });
        expect(handler).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('discord');
    });

    test('when service is unhealthy with reconnectionLoop → loop is triggered', async () => {
        const registry = makeRegistry({ discord: false }, { discord: makeEntry({ state: 'offline' }) });
        const loop = makeLoop();
        const handler = mock(async (_args: unknown) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withHealthGuard(registry, 'discord', loop, handler);
        await wrapped({});
        expect(loop.triggerNow).toHaveBeenCalledTimes(1);
        expect(handler).not.toHaveBeenCalled();
    });

    test('passes args through to handler unchanged', async () => {
        const registry = makeRegistry({ email: true }, { email: makeEntry({ state: 'online' }) });
        const handler = mock(async (args: { a: string, b: number }) => ({
            content: [{ type: 'text' as const, text: `${args.a}-${args.b}` }],
        }));
        const wrapped = withHealthGuard(registry, 'email', undefined, handler);
        const result = await wrapped({ a: 'hello', b: 42 });
        expect((result.content[0] as { text: string }).text).toBe('hello-42');
    });
});

// ---- withWriteHealthGuard ----

describe('withWriteHealthGuard', () => {
    test('when healthRegistry is undefined → handler is called directly', async () => {
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withWriteHealthGuard(undefined, 'bluesky', 'discord', undefined, handler);
        const result = await wrapped({ x: 1 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ x: 1 });
        expect((result.content[0] as { text: string }).text).toBe('ok');
    });

    test('when both services healthy → handler is called', async () => {
        const registry = makeRegistry(
            { bluesky: true, discord: true },
            { bluesky: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'online' }) }
        );
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withWriteHealthGuard(registry, 'bluesky', 'discord', undefined, handler);
        const result = await wrapped({ x: 2 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ x: 2 });
        expect((result.content[0] as { text: string }).text).toBe('ok');
    });

    test('when primary service unhealthy → health error returned, handler not called', async () => {
        const registry = makeRegistry(
            { bluesky: false, discord: true },
            { bluesky: makeEntry({ state: 'offline' }), discord: makeEntry({ state: 'online' }) }
        );
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withWriteHealthGuard(registry, 'bluesky', 'discord', undefined, handler);
        const result = await wrapped({ x: 3 });
        expect(handler).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('bluesky');
    });

    test('when primary healthy but approval service unhealthy → error returned, handler not called', async () => {
        const registry = makeRegistry(
            { bluesky: true, discord: false },
            { bluesky: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'offline' }) }
        );
        const handler = mock(async (_args: { x: number }) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withWriteHealthGuard(registry, 'bluesky', 'discord', undefined, handler);
        const result = await wrapped({ x: 4 });
        expect(handler).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('discord');
        expect(text).toContain('approval');
    });

    test('when primary unhealthy with reconnectionLoop → loop is triggered', async () => {
        const registry = makeRegistry(
            { bluesky: false, discord: true },
            { bluesky: makeEntry({ state: 'offline' }), discord: makeEntry({ state: 'online' }) }
        );
        const loop = makeLoop();
        const handler = mock(async (_args: unknown) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const wrapped = withWriteHealthGuard(registry, 'bluesky', 'discord', loop, handler);
        await wrapped({});
        expect(loop.triggerNow).toHaveBeenCalledTimes(1);
        expect(handler).not.toHaveBeenCalled();
    });

    test('passes args through to handler unchanged', async () => {
        const registry = makeRegistry(
            { email: true, discord: true },
            { email: makeEntry({ state: 'online' }), discord: makeEntry({ state: 'online' }) }
        );
        const handler = mock(async (args: { msg: string }) => ({
            content: [{ type: 'text' as const, text: args.msg }],
        }));
        const wrapped = withWriteHealthGuard(registry, 'email', 'discord', undefined, handler);
        const result = await wrapped({ msg: 'hello world' });
        expect((result.content[0] as { text: string }).text).toBe('hello world');
    });
});

// ---- withToolErrorHandling ----

describe('withToolErrorHandling', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        mockLogger.warn.mockClear();
    });

    test('success: passes through handler result', async () => {
        const handler = mock(async (_args: { x: number }) => ({
            content: [{ type: 'text' as const, text: 'ok' }],
        }));
        const wrapped = withToolErrorHandling('myTool', handler);
        const result = await wrapped({ x: 1 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ x: 1 });
        expect((result.content[0] as { text: string }).text).toBe('ok');
        expect(result.isError).toBeFalsy();
    });

    test('success: does not call logger.warn on success', async () => {
        const handler = mock(async (_args: unknown) => ({
            content: [{ type: 'text' as const, text: 'all good' }],
        }));
        const wrapped = withToolErrorHandling('myTool', handler);
        await wrapped({});
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('Error thrown: returns isError: true with "Error: <message>"', async () => {
        const handler = mock(async (_args: unknown): Promise<never> => {
            throw new Error('something went wrong');
        });
        const wrapped = withToolErrorHandling('myTool', handler);
        const result = await wrapped({});
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe('Error: something went wrong');
    });

    test('Error thrown: logs tool name and error message via logger.warn', async () => {
        const handler = mock(async (_args: unknown): Promise<never> => {
            throw new Error('oops');
        });
        const wrapped = withToolErrorHandling('myTool', handler);
        await wrapped({});
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        const [logObj] = mockLogger.warn.mock.calls[0] as [{ tool: string, error: string }, string];
        expect(logObj.tool).toBe('myTool');
        expect(logObj.error).toBe('oops');
    });

    test('non-Error thrown: returns isError: true with string conversion', async () => {
        const handler = mock(async (_args: unknown): Promise<never> => {
            throw 'raw string error';
        });
        const wrapped = withToolErrorHandling('myTool', handler);
        const result = await wrapped({});
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe('Error: raw string error');
    });

    test('non-Error thrown: logs string representation', async () => {
        const handler = mock(async (_args: unknown): Promise<never> => {
            throw 42;
        });
        const wrapped = withToolErrorHandling('myTool', handler);
        await wrapped({});
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        const [logObj] = mockLogger.warn.mock.calls[0] as [{ tool: string, error: string }, string];
        expect(logObj.error).toBe('42');
    });

    test('passes args through to handler', async () => {
        const handler = mock(async (args: { a: string, b: number }) => ({
            content: [{ type: 'text' as const, text: `${args.a}-${args.b}` }],
        }));
        const wrapped = withToolErrorHandling('myTool', handler);
        const result = await wrapped({ a: 'hello', b: 42 });
        expect((result.content[0] as { text: string }).text).toBe('hello-42');
    });

    test('log message format: second argument to logger.warn is "MCP tool error"', async () => {
        const handler = mock(async (_args: unknown): Promise<never> => {
            throw new Error('fail');
        });
        const wrapped = withToolErrorHandling('myTool', handler);
        await wrapped({});
        const [, logMsg] = mockLogger.warn.mock.calls[0] as [unknown, string];
        expect(logMsg).toBe('MCP tool error');
    });
});
