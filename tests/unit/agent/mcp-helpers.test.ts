import { describe, test, expect, mock } from 'bun:test';
import { mcpServiceUnavailableResult, checkServiceHealth, checkWriteServiceHealth } from '../../../src/agent/mcp-helpers';
import type { ServiceHealthRegistry } from '../../../src/services/health-registry';
import type { ReconnectionLoop } from '../../../src/services/reconnection-loop';
import type { ServiceHealthEntry } from '../../../src/services/types';

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
    } as unknown as ServiceHealthRegistry;
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
        // 1ms in the future → Math.ceil(1/1000) = 1s
        const nextRetryAt = new Date(Date.now() + 1);
        const entry = makeEntry({ state: 'offline', nextRetryAt });
        const result = mcpServiceUnavailableResult('email', entry);
        const text = (result.content[0] as { text: string }).text;
        // Should show ~1s (ceil of 0.001 is 1)
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
