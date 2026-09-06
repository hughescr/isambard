/**
 * Per-session Agent SDK query options builder.
 *
 * `buildSessionQueryOptions` is the one place that assembles the full SDK `Options` object for
 * a long-lived session query, independent of Discord/perch-specific plumbing (no import from
 * '@/app' — eslint-boundaries forbids it for the agent layer). agent.ts's `buildQueryOptions`
 * delegates here immediately (P5), spreading in the one-shot path's `abortController`, which
 * has no place in the session core (sessions interrupt via `SessionQuery.interrupt()`, not an
 * AbortController).
 *
 * @module agent/session/query-options
 */
import type { HookCallbackMatcher, HookEvent, McpServerConfig, Options, SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { SessionRole } from './types';

/**
 * Names of the MCP servers a session may attach, keyed the same way as the resulting
 * `mcpServers`/`allowedTools` entries (`'user-context'` included verbatim, matching the SDK
 * tool-name segment `mcp__user-context__*`).
 */
export type SessionMcpServerName
    = | 'memory'
      | 'discord'
      | 'inbox'
      | 'email'
      | 'bsky'
      | 'caldav'
      | 'wikipedia'
      | 'media'
      | 'contacts'
      | 'user-context'
      | 'browser'
      | 'health';

/** MCP servers configured for a session, by name. Absent/undefined entries are not attached. */
export type SessionMcpServers = Partial<Record<SessionMcpServerName, McpServerConfig>>;

/**
 * Explicit list of built-in tools available to Isambard.
 * Excludes NotebookEdit (not useful for Discord bot) and AskUserQuestion
 * (Izzy decides autonomously based on context and memories). EnterPlanMode/ExitPlanMode
 * are not exposed by the SDK in non-interactive mode, so they are not listed.
 * Memory tools are added via mcpServers configuration.
 */
export const EXPLICIT_TOOLS = [
    // File operations
    'Read',
    'Write',
    'Edit',
    // Search
    'Glob',
    'Grep',
    // Web
    'WebFetch',
    'WebSearch',
    // Execution
    'Bash',
    // Agent spawning. Still required as agent-invokable tools post-Phase-1 hook cutover.
    // Hooks tell us *about* Task lifecycle; the agent still needs permission to invoke
    // TaskOutput/TaskStop to collect/halt background task results.
    'Task',
    'TaskOutput',
    'TaskStop',
    // Task management (new task system)
    'TaskCreate',
    'TaskUpdate',
    'TaskGet',
    'TaskList',
    // Sub-agent coordination: message a named running sub-agent, list them
    'SendMessage',
    'ListAgents',
    // Dynamic workflows: scripted fan-out of sub-agents
    'Workflow',
    // Event watching: stream stdout lines or websocket frames as events
    'Monitor',
    // Deferred tool loading: fetch a deferred tool's schema on demand
    'ToolSearch',
    // Skills
    'Skill',
];

/**
 * Explicit sub-agent definitions.
 * Only general-purpose is overridden (to pin its model). The SDK's built-in Explore and Plan
 * agents are stronger than any one-line override, so they are left as shipped. The built-in
 * `claude` and `statusline-setup` agents cannot be removed via this option.
 * Agent description/prompt strings are configuration - correctness validated by integration tests.
 */
export const EXPLICIT_AGENTS = {
    'general-purpose': {
        description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks',
        prompt:      'You are a general-purpose assistant helping with software engineering tasks.',
        model:       'sonnet' as const,
    },
};

/** Cron tools disallowed for every session — cron scheduling stays host-driven, not agent-driven. */
const DISALLOWED_CRON_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'];

/**
 * Server names appended to the base allowed-tools list when configured, in a fixed order.
 * `memory` is deliberately excluded — `mcp__memory__*` is unconditional in the base list below,
 * matching the one-shot path's historical behaviour.
 */
const OPTIONAL_MCP_SERVER_ORDER: Exclude<SessionMcpServerName, 'memory'>[] = [
    'discord', 'inbox', 'email', 'bsky', 'caldav', 'wikipedia', 'media', 'contacts', 'user-context', 'browser', 'health',
];

/**
 * Builds the mcpServers configuration object from the servers a session was given.
 * @param servers MCP servers configured for this session, by name
 * @returns A record of configured servers, or undefined when none are configured
 */
export function buildMcpServers(servers: SessionMcpServers): Record<string, McpServerConfig> | undefined {
    // Object.entries() on a Partial<Record<...>> loses the "value may be undefined" part of the
    // type (a known TS index-signature-inference quirk), so the array is recast to the accurate
    // shape before filtering.
    const entries = Object.entries(servers) as [SessionMcpServerName, McpServerConfig | undefined][];
    const configured = entries.filter((entry): entry is [SessionMcpServerName, McpServerConfig] => entry[1] !== undefined);
    if(configured.length === 0) {
        return undefined;
    }
    return Object.fromEntries(configured);
}

/**
 * Builds the allowedTools list based on which MCP servers are configured.
 * @param servers MCP servers configured for this session, by name
 * @returns The full allowedTools list for this session
 */
export function buildAllowedTools(servers: SessionMcpServers): string[] {
    const baseTools = [
        // Memory MCP tools (auto-approved)
        'mcp__memory__*',
        // Read-only and safe tools (auto-approved)
        'Read',
        'Glob',
        'Grep',
        'WebFetch',
        'WebSearch',
        // Task management (new task system)
        'TaskCreate',
        'TaskUpdate',
        'TaskGet',
        'TaskList',
        'SendMessage',
        'ListAgents',
        'Workflow',
        'Monitor',
        'ToolSearch',
        // Still required post-Phase-1 hook cutover — agent invokes these to collect/halt background tasks.
        'Task',
        'TaskOutput',
        'TaskStop',
        // Skills
        'Skill',
        // Bash commands (specific safe commands only)
        'Bash(git:*)',
        'Bash(bun run:*)',
        'Bash(bun test:*)',
        'Bash(bun lint:*)',
        'Bash(bun typecheck)',
        'Bash(ls:*)',
    ];

    const tools = [...baseTools];
    for(const name of OPTIONAL_MCP_SERVER_ORDER) {
        if(servers[name]) {
            tools.push(`mcp__${name}__*`);
        }
    }
    return tools;
}

/** Parameters for {@link buildSessionQueryOptions}. */
export interface BuildSessionQueryOptionsParams {
    /** Which session this options object is for. Tools/hooks are currently identical for both roles. */
    role:           SessionRole
    /** System prompt with core identity, built by the caller */
    systemPrompt:   string
    /** MCP servers configured for this session, by name */
    mcpServers:     SessionMcpServers
    /** Plugin configurations */
    plugins?:       SdkPluginConfig[]
    /** Fully composed hook map (task-tracking, lifecycle, compaction, ...) */
    hooks:          Partial<Record<HookEvent, HookCallbackMatcher[]>>
    /** Session ID to resume, when resuming an existing session */
    resume?:        string
    /** Claude model to use for this session */
    mainModel:      string
    /** Fallback model to use when the primary model is unavailable */
    fallbackModel?: string
    /** Returns true while the session is mid-interrupt, to classify the SDK's expected abort stderr as non-error */
    isInterrupting: () => boolean
}

/**
 * Builds the full Agent SDK `Options` object for a session query, minus `abortController`
 * (the one-shot path's concern only — sessions interrupt via `SessionQuery.interrupt()`).
 * @param params See {@link BuildSessionQueryOptionsParams}
 * @returns Query options object for Agent SDK, satisfying `Options`
 */
export function buildSessionQueryOptions(params: BuildSessionQueryOptionsParams) {
    const { role, systemPrompt, mcpServers, plugins, hooks, resume, mainModel, fallbackModel, isInterrupting } = params;

    return {
        model:           mainModel,
        fallbackModel,
        systemPrompt,
        tools:           EXPLICIT_TOOLS,
        agents:          EXPLICIT_AGENTS,
        mcpServers:      buildMcpServers(mcpServers),
        plugins:         plugins && plugins.length > 0 ? plugins : undefined,
        permissionMode:  'acceptEdits' as const,
        // Only the MCP servers passed above: ignore .mcp.json, user settings, plugin and claude.ai-connector MCP.
        strictMcpConfig: true,
        // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral,ArrayDeclaration: Sandbox configuration values - mutations don't change behavior
        sandbox:         {
            enabled:                  true,
            autoAllowBashIfSandboxed: true,
            excludedCommands:         ['git'],
        },
        // Stryker restore ObjectLiteral,StringLiteral,BooleanLiteral,ArrayDeclaration
        disallowedTools:        DISALLOWED_CRON_TOOLS,
        perTaskStopAffordance:  true,
        allowedTools:           buildAllowedTools(mcpServers),
        // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral: Thinking/effort configuration - mutations don't change behavior
        thinking:               { type: 'adaptive' as const },
        effort:                 'high' as const,
        // Stryker restore ObjectLiteral,StringLiteral,BooleanLiteral
        // 'project' is what discovers Izzy's agents and skills in scratch/.claude. It would also pull in CLAUDE.md files;
        // see CLAUDE_CODE_DISABLE_CLAUDE_MDS in env below.
        settingSources:         ['project'] as SettingSource[],
        // Stryker disable next-line BooleanLiteral: Configuration flag
        agentProgressSummaries: true,
        hooks,
        ...(resume && { resume }),
        // Stryker disable StringLiteral,ObjectLiteral: Environment config - value doesn't affect test behavior
        env:                    {
            ...process.env,
            // Defer rarely-used tool schemas behind ToolSearch once the tool set is large enough (SDK default threshold).
            ENABLE_TOOL_SEARCH:              'auto',
            // settingSources ['project'] is needed for Izzy's own agents/skills under scratch/.claude, but it also loads
            // ~/.claude/CLAUDE.md and the parent repo's .claude/CLAUDE.md (verified 2026-09-04). Those are Craig's
            // instructions for Claude Code, not Izzy's: drop every CLAUDE.md while keeping discovery.
            CLAUDE_CODE_DISABLE_CLAUDE_MDS:  '1',
            // Auto-memory would read and write ~/.claude/projects/<cwd>/memory. Izzy's memory is DynamoDB; keep ~/.claude out of it.
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        // Stryker restore StringLiteral,ObjectLiteral
        // Stryker disable StringLiteral,ObjectLiteral: Observability - message text/field names don't affect behavior; the branches themselves are covered by query-options.test.ts's stderr-classifier suite
        stderr: (data: string) => {
            // Every branch stamps `role` so two concurrent sessions' interleaved SDK stderr can
            // be told apart in logs.
            // SDK writes "Operation aborted" + stack trace to stderr during expected abort
            if(isInterrupting() && data.includes('Operation aborted')) {
                logger.debug({ role, stderr: data }, 'Agent SDK stderr (abort)');
            } else if(data.includes('Error in hook callback') && data.includes('Stream closed')) {
                // SDK tries to ack the hook over the control channel after the input pipe closes.
                // The hook itself succeeded; this is a benign timing race on session stop.
                logger.debug({ role, stderr: data }, 'Agent SDK stderr (hook-close race)');
            } else {
                logger.error({ role, stderr: data }, 'Agent SDK stderr');
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral
    } satisfies Options;
}
