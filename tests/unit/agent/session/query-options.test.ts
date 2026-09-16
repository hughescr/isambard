import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { HookEvent, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import {
    buildSessionQueryOptions,
    buildSubagentAgents,
    buildMcpServers,
    buildAllowedTools,
    CROSS_PROVIDER_SUBAGENTS,
    EXPLICIT_TOOLS,
    LAUNCH_RESTRICTED_EFFORTS,
    SUBAGENT_EFFORTS,
    SUBAGENT_LAUNCH_TOOLS,
    SESSION_PEER_NAMES,
    type SessionMcpServers
} from '../../../../src/agent/session/query-options';
import type { SessionRole } from '../../../../src/agent/session/types';
import { mockLogger } from '../../../setup';

const mockMcpServer = { command: 'node', args: ['server.js'] };

function baseParams(overrides: Partial<Parameters<typeof buildSessionQueryOptions>[0]> = {}) {
    return {
        role:                 'conversation' as SessionRole,
        systemPrompt:         'You are Izzy.',
        subagentSystemPrompt: () => 'SUBAGENT-PROMPT',
        mcpServers:           {} as SessionMcpServers,
        hooks:                {} as Partial<Record<HookEvent, HookCallbackMatcher[]>>,
        mainModel:            'sonnet',
        isInterrupting:       () => false,
        ...overrides,
    };
}

describe('EXPLICIT_TOOLS', () => {
    test('EXPLICIT_TOOLS is non-empty and has no blank entries', () => {
        expect(EXPLICIT_TOOLS.length).toBeGreaterThan(0);
        expect(EXPLICIT_TOOLS.every(tool => tool !== '')).toBe(true);
    });
});

describe('sub-agent effort tiers', () => {
    /** The `agents` map from a freshly built options object, typed for assertions. */
    function agentsOf(overrides: Partial<Parameters<typeof buildSessionQueryOptions>[0]> = {}) {
        return buildSessionQueryOptions(baseParams(overrides)).agents;
    }

    test('offers low, medium, high and xhigh — and never max, which not every model has', () => {
        expect(SUBAGENT_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh']);
        expect(LAUNCH_RESTRICTED_EFFORTS).toEqual(['low', 'medium']);
        expect(SUBAGENT_LAUNCH_TOOLS).toEqual(['Agent', 'Task', 'Workflow']);
    });

    test('registers the Claude effort tiers, general-purpose alias, and bounded utraque routes', () => {
        expect(Object.keys(agentsOf())).toEqual([
            'low', 'medium', 'high', 'xhigh', 'general-purpose', ...Object.keys(CROSS_PROVIDER_SUBAGENTS),
        ]);
    });

    test('pins the bounded utraque route contract to literal external model ids and efforts', () => {
        expect(CROSS_PROVIDER_SUBAGENTS).toEqual({
            'astra-high':          { model: 'anthropic-compat.astra', effort: 'high', restricted: false },
            'luna-medium':         { model: 'anthropic-compat.luna', effort: 'medium', restricted: true },
            'terra-high':          { model: 'anthropic-compat.terra', effort: 'high', restricted: false },
            'sol-high':            { model: 'anthropic-compat.sol', effort: 'high', restricted: false },
            'deepseek-flash-low':  { model: 'anthropic-compat.deepseek-flash', effort: 'low', restricted: true },
            'deepseek-flash-high': { model: 'anthropic-compat.deepseek-flash', effort: 'high', restricted: false },
            'deepseek-pro-high':   { model: 'anthropic-compat.deepseek-v4-pro', effort: 'high', restricted: false },
        });
    });

    test('each tier declares its own effort, and general-purpose runs at high', () => {
        const agents = agentsOf();

        for(const effort of SUBAGENT_EFFORTS) {
            expect(agents[effort].effort).toBe(effort);
        }
        expect(agents['general-purpose'].effort).toBe('high');
    });

    test('every tier carries the sub-agent system prompt read from the getter, including the alias', () => {
        const agents = agentsOf();

        for(const name of [...SUBAGENT_EFFORTS, 'general-purpose']) {
            expect(agents[name].prompt).toBe('SUBAGENT-PROMPT');
        }
    });

    test('reads the prompt through the getter at build time, so a reopened session gets the current identity', () => {
        let current = 'FIRST';

        const first = buildSessionQueryOptions(baseParams({ subagentSystemPrompt: () => current })).agents;
        current = 'SECOND';
        const second = buildSessionQueryOptions(baseParams({ subagentSystemPrompt: () => current })).agents;

        expect(first.high.prompt).toBe('FIRST');
        expect(second.high.prompt).toBe('SECOND');
    });

    test('low and medium may not launch sub-agents or workflows of their own', () => {
        const agents = agentsOf();

        expect(agents.low.disallowedTools).toEqual(['Agent', 'Task', 'Workflow']);
        expect(agents.medium.disallowedTools).toEqual(['Agent', 'Task', 'Workflow']);
    });

    test('high, xhigh and general-purpose restrict no tools', () => {
        const agents = agentsOf();

        expect(agents.high.disallowedTools).toBeUndefined();
        expect(agents.xhigh.disallowedTools).toBeUndefined();
        expect(agents['general-purpose'].disallowedTools).toBeUndefined();
    });

    test('no tier pins a model — the launching Agent call carries model, and the tier is the effort knob', () => {
        const agents = agentsOf();

        for(const name of [...SUBAGENT_EFFORTS, 'general-purpose']) {
            expect(agents[name].model).toBeUndefined();
        }
    });

    test('each description names its own effort so the launching model can choose between them', () => {
        const agents = agentsOf();

        for(const effort of SUBAGENT_EFFORTS) {
            expect(agents[effort].description).toBe(`General-purpose Isambard sub-agent at ${effort} effort; pass the model on the launch.`);
        }
        expect(agents['general-purpose'].description).toContain('the same as `high`');
    });

    test('general-purpose is an alias of high, not the old pinned-Sonnet generic agent', () => {
        const agents = agentsOf();

        expect(agents['general-purpose'].prompt).toBe(agents.high.prompt);
        expect(agents['general-purpose'].effort).toBe(agents.high.effort);
        expect(agents['general-purpose'].prompt).not.toContain('general-purpose assistant');
    });

    test('pins each utraque route to its full model id and supported effort', () => {
        const agents = agentsOf();
        for(const [name, route] of Object.entries(CROSS_PROVIDER_SUBAGENTS)) {
            expect(agents[name].model).toBe(route.model);
            expect(agents[name].effort).toBe(route.effort);
            expect(agents[name].description).toContain('omit the Agent model override');
            expect(agents[name].disallowedTools).toEqual(route.restricted ? ['Agent', 'Task', 'Workflow'] : undefined);
        }
    });

    test('omits cross-provider routes when the gateway is disabled', () => {
        expect(Object.keys(buildSessionQueryOptions(baseParams({ crossProviderRoutes: false })).agents)).toEqual([
            'low', 'medium', 'high', 'xhigh', 'general-purpose',
        ]);
    });

    test('includes cross-provider routes when buildSubagentAgents uses its default', () => {
        expect(Object.keys(buildSubagentAgents(() => 'SUBAGENT-PROMPT'))).toEqual([
            'low', 'medium', 'high', 'xhigh', 'general-purpose', ...Object.keys(CROSS_PROVIDER_SUBAGENTS),
        ]);
    });
});

describe('SESSION_PEER_NAMES', () => {
    test('names the conversation session Izzy-main and the perch session Izzy-perch', () => {
        expect(SESSION_PEER_NAMES).toEqual({ conversation: 'Izzy-main', perch: 'Izzy-perch' });
    });

    test('every name carries the Izzy- prefix the peer rule keys on', () => {
        for(const name of Object.values(SESSION_PEER_NAMES)) {
            expect(name.startsWith('Izzy-')).toBe(true);
        }
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

    test('omits explicitly undefined servers while retaining configured ones', () => {
        expect(buildMcpServers({ inbox: undefined, discord: mockMcpServer })).toEqual({ discord: mockMcpServer });
        expect(buildMcpServers({ inbox: undefined })).toBeUndefined();
    });
});

describe('buildAllowedTools', () => {
    test('keeps the complete literal built-in and safe-command allowlist', () => {
        expect(buildAllowedTools({})).toEqual([
            'mcp__memory__*',
            'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
            'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'SendMessage', 'ListAgents',
            'Workflow', 'Monitor', 'ToolSearch', 'Task', 'TaskOutput', 'TaskStop', 'Skill',
            'Bash(git:*)', 'Bash(bun run:*)', 'Bash(bun test:*)', 'Bash(bun lint:*)',
            'Bash(bun typecheck)', 'Bash(ls:*)',
        ]);
    });

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

    test('pushes configured MCP tool patterns onto the end of the list, in OPTIONAL_MCP_SERVER_ORDER order', () => {
        // discord precedes inbox in OPTIONAL_MCP_SERVER_ORDER; push (not unshift) keeps them last, in that order.
        const tools = buildAllowedTools({ discord: mockMcpServer, inbox: mockMcpServer });
        expect(tools.slice(-2)).toEqual(['mcp__discord__*', 'mcp__inbox__*']);
    });

    test('an explicit null server value is treated as absent, not attached', () => {
        const tools = buildAllowedTools({ discord: null } as unknown as SessionMcpServers);
        expect(tools).not.toContain('mcp__discord__*');
    });

    test('a configured server is read as a plain property, not gated behind hasOwnProperty', () => {
        // servers[name] must resolve any truthy value at that key, not only own-enumerable ones.
        const servers = Object.create({ discord: mockMcpServer }) as SessionMcpServers;
        const tools = buildAllowedTools(servers);
        expect(tools).toContain('mcp__discord__*');
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

    // Block-0 probe, 2026-09-09 (docs/plans/session-peers-and-quota.md "P1"): `Options.title`
    // sets the persisted session title (and `session_title` on every hook payload) but NEVER
    // reaches the peer registry — a peer addressed by the title got
    // `No agent named 'Izzy-probe-B' is reachable`. The only knob that sets the messaging
    // identity is the `CLAUDE_CODE_SESSION_NAME` env var, so both must be set, to the same name.
    test.each([
        ['conversation', 'Izzy-main'],
        ['perch', 'Izzy-perch'],
    ] as const)('role=%s titles the session %s', (role, expected) => {
        const opts = buildSessionQueryOptions(baseParams({ role }));
        expect(opts.title).toBe(expected);
    });

    test.each([
        ['conversation', 'Izzy-main'],
        ['perch', 'Izzy-perch'],
    ] as const)('role=%s sets CLAUDE_CODE_SESSION_NAME to %s, the name peers actually address', (role, expected) => {
        const opts = buildSessionQueryOptions(baseParams({ role }));
        expect(opts.env.CLAUDE_CODE_SESSION_NAME).toBe(expected);
    });

    test('title and CLAUDE_CODE_SESSION_NAME are the same string for a role', () => {
        for(const role of ['conversation', 'perch'] as const) {
            const opts = buildSessionQueryOptions(baseParams({ role }));
            expect(opts.env.CLAUDE_CODE_SESSION_NAME).toBe(opts.title);
            expect(opts.title).toBe(SESSION_PEER_NAMES[role]);
        }
    });

    test('setting the session name does not drop the other env entries', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect(opts.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
        expect(opts.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
        expect(opts.env.ENABLE_TOOL_SEARCH).toBe('auto');
    });

    test('inherits the parent environment while preserving Izzy session overrides', () => {
        const key = 'ISAMBARD_QUERY_OPTIONS_ENV_SENTINEL';
        const previous = process.env[key];
        process.env[key] = 'inherited-by-child';
        try {
            const opts = buildSessionQueryOptions(baseParams({ role: 'perch' }));
            expect((opts.env as NodeJS.ProcessEnv)[key]).toBe('inherited-by-child');
            expect(opts.env.CLAUDE_CODE_SESSION_NAME).toBe('Izzy-perch');
            expect(opts.env.ENABLE_TOOL_SEARCH).toBe('auto');
        } finally {
            if(previous === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = previous;
            }
        }
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

    test('plugins are present only when the configured list is non-empty', () => {
        const plugin = { type: 'local', path: '/tmp/isambard-plugin' } as const;

        expect(buildSessionQueryOptions(baseParams()).plugins).toBeUndefined();
        expect(buildSessionQueryOptions(baseParams({ plugins: [] })).plugins).toBeUndefined();
        expect(buildSessionQueryOptions(baseParams({ plugins: [plugin] })).plugins).toEqual([plugin]);
    });

    test('requires the SDK to use only the explicitly configured MCP servers', () => {
        expect(buildSessionQueryOptions(baseParams()).strictMcpConfig).toBe(true);
    });

    test('sandboxes commands while keeping git outside automatic sandbox approval', () => {
        expect(buildSessionQueryOptions(baseParams()).sandbox).toEqual({
            enabled:                  true,
            autoAllowBashIfSandboxed: true,
            excludedCommands:         ['git'],
        });
    });

    test('offers a stop affordance and progress summaries for each task', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect(opts.perTaskStopAffordance).toBe(true);
        expect(opts.agentProgressSummaries).toBe(true);
    });

    test('thinking is adaptive, not disabled', () => {
        const opts = buildSessionQueryOptions(baseParams());
        expect(opts.thinking).toEqual({ type: 'adaptive' });
    });

    test('satisfies Options', () => {
        const opts: Options = buildSessionQueryOptions(baseParams());
        expect(opts).toBeDefined();
    });

    describe('stderr classifier', () => {
        function stderrOf(isInterrupting: () => boolean): (data: string) => void {
            return buildSessionQueryOptions(baseParams({ isInterrupting })).stderr;
        }

        test.each([
            ['"Operation aborted" logs at debug only while isInterrupting() is true', () => true, 'Operation aborted\nstack trace...', 'debug'],
            ['"Operation aborted" logs at error when isInterrupting() is false', () => false, 'Operation aborted\nstack trace...', 'error'],
            ['"Operation aborted" is matched anywhere in the payload, not only at the start', () => true, 'preamble noise Operation aborted trailing detail', 'debug'],
            ['hook-close markers are matched anywhere in the payload, not only at the start/end', () => false, 'noise before Error in hook callback: middle Stream closed noise after', 'debug'],
        ] as [string, () => boolean, string, string][])('%s', (_label, isInterrupting, data, expected) => {
            const stderr = stderrOf(isInterrupting);
            stderr(data);
            if(expected === 'debug') {
                expect(mockLogger.debug).toHaveBeenCalledTimes(1);
                expect(mockLogger.error).not.toHaveBeenCalled();
            } else {
                expect(mockLogger.error).toHaveBeenCalledTimes(1);
                expect(mockLogger.debug).not.toHaveBeenCalled();
            }
        });

        test('"Error in hook callback" + "Stream closed" logs at debug', () => {
            const stderr = stderrOf(() => false);
            stderr('Error in hook callback: Stream closed');
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        test.each([
            ['Error in hook callback'],
            ['Stream closed'],
        ])('a lone hook-close marker remains an error: %s', (data) => {
            const stderr = stderrOf(() => false);
            stderr(data);
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).not.toHaveBeenCalled();
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

        test('logs the exact stderr payload and classification for each branch', () => {
            const stderr = stderrOf(() => true);
            stderr('Operation aborted\nstack trace');
            stderr('Error in hook callback: Stream closed');
            stderr('unknown stderr');
            expect(mockLogger.debug).toHaveBeenNthCalledWith(1,
                { role: 'conversation', stderr: 'Operation aborted\nstack trace' }, 'Agent SDK stderr (abort)');
            expect(mockLogger.debug).toHaveBeenNthCalledWith(2,
                { role: 'conversation', stderr: 'Error in hook callback: Stream closed' }, 'Agent SDK stderr (hook-close race)');
            expect(mockLogger.error).toHaveBeenCalledWith(
                { role: 'conversation', stderr: 'unknown stderr' }, 'Agent SDK stderr');
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

describe('stderr abort specificity', () => {
    beforeEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
    });

    afterEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
    });

    test('does not treat a different operation failure as the expected abort', () => {
        const stderr = buildSessionQueryOptions(baseParams({ isInterrupting: () => true })).stderr;
        stderr('Operation retry failed');

        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).not.toHaveBeenCalled();
    });
});
