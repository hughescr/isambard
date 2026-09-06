import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { HookEvent, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import {
    buildSessionQueryOptions,
    buildMcpServers,
    buildAllowedTools,
    EXPLICIT_TOOLS,
    EXPLICIT_AGENTS,
    type SessionMcpServers
} from '../../../../src/agent/session/query-options';
import type { SessionRole } from '../../../../src/agent/session/types';
import { mockLogger } from '../../../setup';

const mockMcpServer = { command: 'node', args: ['server.js'] };

function baseParams(overrides: Partial<Parameters<typeof buildSessionQueryOptions>[0]> = {}) {
    return {
        role:           'conversation' as SessionRole,
        systemPrompt:   'You are Izzy.',
        mcpServers:     {} as SessionMcpServers,
        hooks:          {} as Partial<Record<HookEvent, HookCallbackMatcher[]>>,
        mainModel:      'sonnet',
        isInterrupting: () => false,
        ...overrides,
    };
}

describe('EXPLICIT_TOOLS / EXPLICIT_AGENTS', () => {
    test('EXPLICIT_TOOLS is non-empty and has no blank entries', () => {
        expect(EXPLICIT_TOOLS.length).toBeGreaterThan(0);
        expect(EXPLICIT_TOOLS.every(tool => tool !== '')).toBe(true);
    });

    test('EXPLICIT_AGENTS defines only general-purpose', () => {
        expect(Object.keys(EXPLICIT_AGENTS)).toEqual(['general-purpose']);
    });
});

describe('buildMcpServers', () => {
    test('returns undefined for an empty server map', () => {
        expect(buildMcpServers({})).toBeUndefined();
    });

    test('returns a record keyed by server name for each configured server', () => {
        const servers = buildMcpServers({ inbox: mockMcpServer, discord: mockMcpServer });
        expect(servers).toEqual({ inbox: mockMcpServer, discord: mockMcpServer });
    });
});

describe('buildAllowedTools', () => {
    test('every configured mcpServers key has a matching allowedTools pattern', () => {
        const names: (keyof SessionMcpServers)[] = ['memory', 'discord', 'inbox', 'email', 'bsky', 'caldav', 'wikipedia', 'media', 'contacts', 'user-context', 'browser', 'health'];
        for(const name of names) {
            const tools = buildAllowedTools({ [name]: mockMcpServer });
            expect(tools).toContain(`mcp__${name}__*`);
        }
    });

    test('mcp__memory__* is present even when no servers are configured', () => {
        expect(buildAllowedTools({})).toContain('mcp__memory__*');
    });
});

describe('buildSessionQueryOptions', () => {
    beforeEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
    });

    afterEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
    });

    test('perTaskStopAffordance is true', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect(opts.perTaskStopAffordance).toBe(true);
    });

    test('disallowedTools contains the four cron tools', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect(opts.disallowedTools).toEqual(['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']);
    });

    test.each([
        ['conversation'],
        ['perch'],
    ] as const)('inbox server + mcp__inbox__* are attached for role=%s whenever mcpServers.inbox is given', (role) => {
        const opts = buildSessionQueryOptions(baseParams({ role, mcpServers: { inbox: mockMcpServer } }));
        expect(opts.mcpServers?.inbox).toEqual(mockMcpServer);
        expect(opts.allowedTools).toContain('mcp__inbox__*');
    });

    test.each([
        ['conversation'],
        ['perch'],
    ] as const)('health server + mcp__health__* are attached for role=%s whenever mcpServers.health is given', (role) => {
        const opts = buildSessionQueryOptions(baseParams({ role, mcpServers: { health: mockMcpServer } }));
        expect(opts.mcpServers?.health).toEqual(mockMcpServer);
        expect(opts.allowedTools).toContain('mcp__health__*');
    });

    test('mcp__health__* is absent when no health server is configured', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect(opts.allowedTools).not.toContain('mcp__health__*');
    });

    test('has no abortController key', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect('abortController' in opts).toBe(false);
    });

    test('resume is present only when given', () => {
        const withoutResume = buildSessionQueryOptions(baseParams());
        expect('resume' in withoutResume).toBe(false);

        const withResume = buildSessionQueryOptions(baseParams({ resume: 'sess-123' }));
        expect(withResume.resume).toBe('sess-123');
    });

    test('hooks are passed through by reference', () => {
        const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { Stop: [] };
        const opts = buildSessionQueryOptions(baseParams({ hooks }));
        expect(opts.hooks).toBe(hooks);
    });

    test('satisfies Options', () => {
        const opts: Options = buildSessionQueryOptions(baseParams());
        expect(opts).toBeDefined();
    });

    describe('stderr classifier', () => {
        function stderrOf(isInterrupting: () => boolean): (data: string) => void {
            return buildSessionQueryOptions(baseParams({ isInterrupting })).stderr;
        }

        test('"Operation aborted" logs at debug only while isInterrupting() is true', () => {
            const stderr = stderrOf(() => true);
            stderr('Operation aborted\nstack trace...');
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        test('"Operation aborted" logs at error when isInterrupting() is false', () => {
            const stderr = stderrOf(() => false);
            stderr('Operation aborted\nstack trace...');
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        test('"Error in hook callback" + "Stream closed" logs at debug', () => {
            const stderr = stderrOf(() => false);
            stderr('Error in hook callback: Stream closed');
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        test('anything else logs at error', () => {
            const stderr = stderrOf(() => false);
            stderr('some other stderr noise');
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        test('every stderr log line carries the session role', () => {
            const stderr = buildSessionQueryOptions(baseParams({ role: 'perch', isInterrupting: () => false })).stderr;
            stderr('some other stderr noise');
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ role: 'perch' }), expect.any(String));
        });

        test('isInterrupting is re-checked per call, not captured once', () => {
            let interrupting = false;
            const stderr = stderrOf(() => interrupting);
            stderr('Operation aborted');
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            mockLogger.error.mockClear();
            mockLogger.debug.mockClear();
            interrupting = true;
            stderr('Operation aborted');
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });
});
