import { describe, test, expect } from 'bun:test';
import { createAgentContextBuilder } from '@/integrations/discord/state/agent-context-builder';
import { type BotState, type BotStateManager, createDefaultBotState } from '@/integrations/discord/state/types';
import { createChannelId } from '@/integrations/discord/types';

// Mock BotStateManager - just needs getState() and getMode()
function createMockStateManager(state: BotState): BotStateManager {
    return {
        getState: () => state,
        getMode:  () => state.mode,
    } as BotStateManager;
}

describe('AgentContextBuilder', () => {
    describe('idle mode', () => {
        test('returns empty/disabled config', () => {
            const state = createDefaultBotState();
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.mcpServers).toEqual([
                { name: 'memory', enabled: false },
                { name: 'discord', enabled: false },
                { name: 'inbox', enabled: false },
            ]);
            expect(config.additionalTools).toEqual([]);
            expect(config.systemPromptAdditions).toBe('');
            expect(config.contextInjection.includeFullContext).toBe(false);
            expect(config.contextInjection.catchUpContext).toBeUndefined();
        });
    });

    describe('processing message mode', () => {
        test('returns correct config with memory and discord enabled', () => {
            const channelId = createChannelId('123456789');
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'processing_message',
                modeContext: {
                    channelId,
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.mcpServers).toEqual([
                { name: 'memory', enabled: true },
                { name: 'discord', enabled: true },
                { name: 'inbox', enabled: false },
            ]);
            expect(config.additionalTools).toEqual([]);
            expect(config.systemPromptAdditions).toContain(''); // Base prompt only
            expect(config.contextInjection.includeFullContext).toBe(true);
            expect(config.contextInjection.catchUpContext).toBeUndefined();
        });
    });

    describe('catching up mode', () => {
        test('includes inbox MCP server', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'catching_up',
                modeContext: {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         0,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.mcpServers).toEqual([
                { name: 'memory', enabled: true },
                { name: 'discord', enabled: true },
                { name: 'inbox', enabled: true },
            ]);
        });

        test('includes catch-up context injection', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'catching_up',
                modeContext: {
                    viewedChannels:      new Set([createChannelId('123')]),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        ['general', 'random'],
                    topAuthors:          ['Alice', 'Bob'],
                    timeSinceLastActive: '3 hours ago',
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.contextInjection.includeFullContext).toBe(true);
            expect(config.contextInjection.catchUpContext).toBeDefined();
            expect(config.contextInjection.catchUpContext?.timeSinceLastActive).toBe('3 hours ago');
            expect(config.contextInjection.catchUpContext?.inboxSummary).toContain('5 unread');
            expect(config.contextInjection.catchUpContext?.inboxSummary).toContain('2 channels');
            expect(config.contextInjection.catchUpContext?.workflowGuidance).toContain('inbox');
        });

        test('includes catch-up system prompt preamble', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'catching_up',
                modeContext: {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         0,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.systemPromptAdditions).toContain('catching up');
            expect(config.systemPromptAdditions).toContain('away');
        });

        test('includes inbox tools', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'catching_up',
                modeContext: {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         0,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.additionalTools).toContain('inbox');
        });
    });

    describe('perching mode', () => {
        test('returns correct config with perching prompt', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'perching',
                modeContext: {
                    activityType: 'Observing',
                    sessionId:    null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();

            expect(config.mcpServers).toEqual([
                { name: 'memory', enabled: true },
                { name: 'discord', enabled: true },
                { name: 'inbox', enabled: false },
            ]);
            expect(config.additionalTools).toEqual([]);
            expect(config.systemPromptAdditions).toContain('perching');
            expect(config.systemPromptAdditions).toContain('explore');
            expect(config.contextInjection.includeFullContext).toBe(true);
            expect(config.contextInjection.catchUpContext).toBeUndefined();
        });
    });

    describe('system prompt additions vary by mode', () => {
        test('idle has no additions', () => {
            const state = createDefaultBotState();
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();
            expect(config.systemPromptAdditions).toBe('');
        });

        test('processing_message has base prompt', () => {
            const channelId = createChannelId('123');
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'processing_message',
                modeContext: {
                    channelId,
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();
            expect(config.systemPromptAdditions).toBe(''); // Base prompt is empty/default
        });

        test('catching_up has catch-up preamble', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'catching_up',
                modeContext: {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         0,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();
            expect(config.systemPromptAdditions).toContain('catching up');
        });

        test('perching has perching preamble', () => {
            const state: BotState = {
                ...createDefaultBotState(),
                mode:        'perching',
                modeContext: {
                    activityType: 'Observing',
                    sessionId:    null,
                },
            };
            const stateManager = createMockStateManager(state);
            const builder = createAgentContextBuilder({ stateManager });

            const config = builder.buildConfig();
            expect(config.systemPromptAdditions).toContain('perching');
        });
    });
});
