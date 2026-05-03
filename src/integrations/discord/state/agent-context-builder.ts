import { type BotStateManager, type CatchingUpModeContext } from './types';
import { InvariantViolationError } from '@/errors';

/**
 * MCP server configuration
 */
interface McpServerConfig {
    name:    'memory' | 'discord' | 'inbox'
    enabled: boolean
}

/**
 * Catch-up specific context injection
 */
interface CatchUpContextInjection {
    timeSinceLastActive: string | null
    inboxSummary:        string
    workflowGuidance:    string
}

/**
 * Context to inject into the agent
 */
interface ContextInjection {
    /** Full context injection (memories, user info, events) */
    includeFullContext: boolean
    /** Catch-up specific context */
    catchUpContext?:    CatchUpContextInjection
}

/**
 * Agent configuration for the Claude Agent SDK
 */
interface AgentConfig {
    /** MCP servers to include for this mode */
    mcpServers:            McpServerConfig[]
    /** Additional tools allowed in this mode */
    additionalTools:       string[]
    /** System prompt additions for this mode */
    systemPromptAdditions: string
    /** Context to inject into the agent */
    contextInjection:      ContextInjection
}

/**
 * Dependencies for AgentContextBuilder
 */
interface AgentContextBuilderDeps {
    stateManager: BotStateManager
}

/**
 * Builder that produces mode-dependent agent configuration
 */
interface AgentContextBuilder {
    /** Build agent config from current bot state */
    buildConfig(): AgentConfig
}

/**
 * System prompt additions for catch-up mode
 */
// Stryker disable StringLiteral: Prompt template content - mutations don't change behavior
const CATCH_UP_PREAMBLE = `You are catching up on messages that arrived while you were away.

Your goal is to:
1. Review the inbox of messages that accumulated
2. Identify any that require your attention or response
3. Respond thoughtfully to important messages
4. Mark messages as processed once handled

Use the inbox tools to work through messages efficiently.`;
// Stryker restore StringLiteral

/**
 * System prompt additions for perching mode
 */
// Stryker disable StringLiteral: Prompt template content - mutations don't change behavior
const PERCHING_PREAMBLE = `You are in perching mode, free to explore and pursue your own interests.

In this mode, you can:
- Reflect on recent conversations and interactions
- Explore topics that interest you
- Engage in creative thinking or planning
- Review and consolidate memories
- Reach out proactively if you have thoughts to share

There's no immediate task - use this time as you see fit.`;
// Stryker restore StringLiteral

/**
 * Workflow guidance for catch-up mode
 */
// Stryker disable StringLiteral: Prompt template content - mutations don't change behavior
const CATCH_UP_WORKFLOW = `Process inbox messages systematically:
1. Review inbox contents
2. Prioritize messages that mention you or require action
3. Respond to high-priority items first
4. Mark messages as handled after processing`;
// Stryker restore StringLiteral

/**
 * Creates an AgentContextBuilder
 */
export function createAgentContextBuilder(deps: AgentContextBuilderDeps): AgentContextBuilder {
    const { stateManager } = deps;

    return {
        buildConfig(): AgentConfig {
            const state = stateManager.getState();

            switch(state.mode) {
                case 'idle': {
                    return {
                        mcpServers: [
                            { name: 'memory', enabled: false },
                            { name: 'discord', enabled: false },
                            { name: 'inbox', enabled: false },
                        ],
                        additionalTools:       [],
                        systemPromptAdditions: '',
                        contextInjection:      {
                            includeFullContext: false,
                        },
                    };
                }

                case 'processing_message': {
                    return {
                        mcpServers: [
                            { name: 'memory', enabled: true },
                            { name: 'discord', enabled: true },
                            { name: 'inbox', enabled: false },
                        ],
                        additionalTools:       [],
                        systemPromptAdditions: '',
                        contextInjection:      {
                            includeFullContext: true,
                        },
                    };
                }

                case 'catching_up': {
                    const catchingUpContext = state.modeContext as CatchingUpModeContext;
                    const timeSinceLastActive = catchingUpContext.timeSinceLastActive;

                    // Stryker disable next-line StringLiteral,ConditionalExpression,EqualityOperator: Pluralization logic - cosmetic, doesn't affect behavior
                    const inboxSummary = `${catchingUpContext.unreadCount} unread message${catchingUpContext.unreadCount === 1 ? '' : 's'} across ${catchingUpContext.channelNames.length} channel${catchingUpContext.channelNames.length === 1 ? '' : 's'}`;

                    return {
                        mcpServers: [
                            { name: 'memory', enabled: true },
                            { name: 'discord', enabled: true },
                            { name: 'inbox', enabled: true },
                        ],
                        additionalTools:       ['inbox'],
                        systemPromptAdditions: CATCH_UP_PREAMBLE,
                        contextInjection:      {
                            includeFullContext: true,
                            catchUpContext:     {
                                timeSinceLastActive,
                                inboxSummary,
                                workflowGuidance: CATCH_UP_WORKFLOW,
                            },
                        },
                    };
                }

                case 'perching': {
                    return {
                        mcpServers: [
                            { name: 'memory', enabled: true },
                            { name: 'discord', enabled: true },
                            { name: 'inbox', enabled: false },
                        ],
                        additionalTools:       [],
                        systemPromptAdditions: PERCHING_PREAMBLE,
                        contextInjection:      {
                            includeFullContext: true,
                        },
                    };
                }

                default: {
                    // Type-safe exhaustiveness check
                    // Stryker disable StringLiteral: Error message for unreachable code path
                    const _exhaustive: never = state.mode;
                    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- never type used for exhaustiveness check
                    throw new InvariantViolationError('buildAgentContext', `Unknown mode: ${_exhaustive}`);
                    // Stryker restore StringLiteral
                }
            }
        },
    };
}
