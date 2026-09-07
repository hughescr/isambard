import { describe, test, expect, mock } from 'bun:test';
import type { ContextBuilder } from '../../../../src/agent/context-builder';
import {
    buildSystemPrompt,
    buildSessionSystemPrompt,
    BASE_SYSTEM_PROMPT,
    DISCORD_CHANNEL_CONTEXT,
    SESSION_BASE_PROMPT,
    CONVERSATION_ROLE_PROMPT,
    PERCH_ROLE_PROMPT
} from '../../../../src/agent/prompts/system-prompt';

/**
 * Test-local prompt-hygiene check shared by every `buildSessionSystemPrompt` case: no
 * unresolved `{PLACEHOLDER}` tokens, no trailing whitespace on any line, and no duplicated
 * (back-to-back) blank lines.
 */
function assertPromptHygiene(text: string): void {
    expect(text).not.toMatch(/\{[A-Z_]+\}/);
    for(const line of text.split('\n')) {
        expect(line).not.toMatch(/\s$/);
    }
    expect(text).not.toContain('\n\n\n');
}

describe.concurrent('system-prompt', () => {
    describe('constants', () => {
        test('BASE_SYSTEM_PROMPT should be defined and non-empty', () => {
            expect(BASE_SYSTEM_PROMPT).toBeDefined();
            expect(BASE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
            expect(BASE_SYSTEM_PROMPT).toContain('Isambard');
            expect(BASE_SYSTEM_PROMPT).toContain('Memory System');
            expect(BASE_SYSTEM_PROMPT).toContain('Context provided to you automatically');
            expect(BASE_SYSTEM_PROMPT).toContain('[Current state]');
        });

        test('BASE_SYSTEM_PROMPT should describe delegation tools accurately', () => {
            expect(BASE_SYSTEM_PROMPT).toContain('## Delegation and Parallel Work');
            expect(BASE_SYSTEM_PROMPT).toContain('`Task`');
            expect(BASE_SYSTEM_PROMPT).toContain('`SendMessage`');
            expect(BASE_SYSTEM_PROMPT).toContain('`ListAgents`');
            expect(BASE_SYSTEM_PROMPT).toContain('`TaskOutput`');
            expect(BASE_SYSTEM_PROMPT).toContain('`Monitor`');
            expect(BASE_SYSTEM_PROMPT).toContain('`ToolSearch`');
            expect(BASE_SYSTEM_PROMPT).toContain('elenchus');
            expect(BASE_SYSTEM_PROMPT).toContain('memory-archivist');
            expect(BASE_SYSTEM_PROMPT).toContain('memory-curator');
        });

        test('BASE_SYSTEM_PROMPT should say when a Workflow is and is not appropriate', () => {
            expect(BASE_SYSTEM_PROMPT).toContain('### When to use `Workflow`');
            expect(BASE_SYSTEM_PROMPT).toContain('Use `Workflow` when');
            expect(BASE_SYSTEM_PROMPT).toContain('Do not use `Workflow` when');
            expect(BASE_SYSTEM_PROMPT).toContain('workflow-authoring');
        });

        test('BASE_SYSTEM_PROMPT should describe the sandboxed Bash permission correctly', () => {
            expect(BASE_SYSTEM_PROMPT).not.toContain('Bash commands are not available');
            expect(BASE_SYSTEM_PROMPT).toContain('sandbox');
        });

        test('DISCORD_CHANNEL_CONTEXT should be defined and non-empty', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toBeDefined();
            expect(DISCORD_CHANNEL_CONTEXT.length).toBeGreaterThan(0);
            expect(DISCORD_CHANNEL_CONTEXT).toContain('Discord Channel Context');
        });

        test('DISCORD_CHANNEL_CONTEXT should contain sentinel documentation', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('@@NO_RESPONSE@@');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('Response control');
        });

        test('DISCORD_CHANNEL_CONTEXT should document well-known channels', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('#general');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('#catch-up');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('#perch-time');
        });

        test('DISCORD_CHANNEL_CONTEXT should document channel management tools', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('listChannels');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('muteChannel');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('unmuteChannel');
        });

        test('DISCORD_CHANNEL_CONTEXT should say askUserQuestion/sendDiscordMessage take explicit channelId and requestingUserId from the message header', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('askUserQuestion');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('sendDiscordMessage');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('requestingUserId');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('Requesting user:');
            expect(DISCORD_CHANNEL_CONTEXT).toContain('there is no ambient conversation context');
        });

        test('DISCORD_CHANNEL_CONTEXT should have placeholder for channel list', () => {
            expect(DISCORD_CHANNEL_CONTEXT).toContain('{CHANNEL_LIST}');
        });
    });

    describe('buildSystemPrompt', () => {
        describe('backward compatibility', () => {
            test('should work with no arguments', async () => {
                const prompt = await buildSystemPrompt();
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).not.toContain('Current Time');
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with undefined', async () => {
                const prompt = await buildSystemPrompt(undefined);
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).not.toContain('Current Time');
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with ContextBuilder directly (legacy signature)', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt(mockContextBuilder);
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Who You Are');
                expect(prompt).toContain('I am a test identity');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with ContextBuilder that returns null', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => null),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt(mockContextBuilder);
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });
        });

        describe('new options interface', () => {
            test('should work with empty options object', async () => {
                const prompt = await buildSystemPrompt({});
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).not.toContain('Current Time');
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with only contextBuilder option', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({ contextBuilder: mockContextBuilder });
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Who You Are');
                expect(prompt).toContain('I am a test identity');
                expect(prompt).not.toContain('Discord Channel Context');
            });

            test('should work with only channelList option', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['general', 'catch-up'],
                });
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).toContain('#general, #catch-up');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
                expect(prompt).not.toContain('Who You Are');
            });

            test('should work with both contextBuilder and channelList options', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general', 'catch-up', 'perch-time'],
                });

                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).toContain('#general, #catch-up, #perch-time');
                expect(prompt).toContain('Who You Are');
                expect(prompt).toContain('I am a test identity');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
            });
        });

        describe('channel list formatting', () => {
            test('should format single channel with # prefix', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['general'],
                });
                expect(prompt).toContain('#general');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
            });

            test('should format multiple channels with # prefix and comma separation', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['general', 'catch-up', 'perch-time', 'dev'],
                });
                expect(prompt).toContain('#general, #catch-up, #perch-time, #dev');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
            });

            test('should not add Discord context when channelList is empty array', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: [],
                });
                expect(prompt).not.toContain('Discord Channel Context');
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
            });

            test('should not add Discord context when channelList is undefined', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: undefined,
                });
                expect(prompt).not.toContain('Discord Channel Context');
                expect(prompt).toContain(BASE_SYSTEM_PROMPT);
            });

            test('should preserve channel names exactly as provided', async () => {
                const prompt = await buildSystemPrompt({
                    channelList: ['test-channel-123', 'UPPERCASE', 'with_underscores'],
                });
                expect(prompt).toContain('#test-channel-123, #UPPERCASE, #with_underscores');
            });
        });

        describe('section ordering', () => {
            test('should order sections correctly when all options provided', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => 'I am a test identity'),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                // Check order: BASE_SYSTEM_PROMPT, Discord Context, Who You Are
                const basePromptIndex = prompt.indexOf('Isambard');
                const discordIndex = prompt.indexOf('Discord Channel Context');
                const identityIndex = prompt.indexOf('Who You Are');

                expect(basePromptIndex).toBeGreaterThan(-1);
                expect(discordIndex).toBeGreaterThan(basePromptIndex);
                expect(identityIndex).toBeGreaterThan(discordIndex);
            });
        });

        describe('contextBuilder behavior', () => {
            test('should call loadCoreIdentity when contextBuilder provided', async () => {
                const loadCoreIdentity = mock(async () => 'I am a test identity');
                const mockContextBuilder = {
                    loadCoreIdentity,
                } as unknown as ContextBuilder;

                await buildSystemPrompt({ contextBuilder: mockContextBuilder });
                expect(loadCoreIdentity).toHaveBeenCalledTimes(1);
            });

            test('should not call loadCoreIdentity when contextBuilder not provided', async () => {
                // Don't pass the context builder; with no identity loaded, the
                // "Who You Are" section must never be appended to the prompt.
                const prompt = await buildSystemPrompt({ channelList: ['general'] });
                expect(prompt).not.toContain('Who You Are');
                expect(prompt).toContain('Discord Channel Context');
            });

            test('should handle contextBuilder with null identity gracefully', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => null),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).not.toContain('Who You Are');
            });

            test('should handle contextBuilder with empty string identity', async () => {
                const mockContextBuilder = {
                    loadCoreIdentity: mock(async () => ''),
                } as unknown as ContextBuilder;

                const prompt = await buildSystemPrompt({
                    contextBuilder: mockContextBuilder,
                    channelList:    ['general'],
                });

                expect(prompt).toContain('Discord Channel Context');
                expect(prompt).not.toContain('Who You Are');
            });
        });
    });

    describe('buildSessionSystemPrompt', () => {
        test('conversation role contains "shared transcript" and the identity text', () => {
            const prompt = buildSessionSystemPrompt({ role: 'conversation', identity: 'I am Isambard, Craig\'s thought partner.' });

            expect(prompt).toContain('shared transcript');
            expect(prompt).toContain('I am Isambard, Craig\'s thought partner.');
            assertPromptHygiene(prompt);
        });

        test('perch role contains "time box" and "perch channel"', () => {
            const prompt = buildSessionSystemPrompt({ role: 'perch', identity: 'I am Isambard.' });

            expect(prompt).toContain('time box');
            expect(prompt).toContain('perch channel');
            assertPromptHygiene(prompt);
        });

        test('both roles contain working memory, envelope and notification language', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            for(const prompt of [conversation, perch]) {
                expect(prompt).toContain('working memory');
                expect(prompt).toContain('envelope');
                expect(prompt).toContain('notification');
            }
        });

        test('neither role mentions ephemeral, {CHANNEL_LIST}, or the one-shot channel-visibility line', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            for(const prompt of [conversation, perch]) {
                expect(prompt).not.toContain('ephemeral');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
                expect(prompt).not.toContain('Currently visible channels');
                expect(prompt).not.toContain(DISCORD_CHANNEL_CONTEXT);
                expect(prompt).not.toContain('[About this user]');
                expect(prompt).not.toContain('[Recent events]');
            }
        });

        test('appends the identity text once under "## Identity", after the role section', () => {
            const prompt = buildSessionSystemPrompt({ role: 'conversation', identity: 'unique-identity-marker' });

            expect(prompt).toContain('## Identity\nunique-identity-marker');
            const identityIndex = prompt.indexOf('## Identity');
            const roleIndex = prompt.indexOf(CONVERSATION_ROLE_PROMPT);
            expect(roleIndex).toBeGreaterThan(-1);
            expect(identityIndex).toBeGreaterThan(roleIndex);
            expect(prompt.split('unique-identity-marker')).toHaveLength(2);
        });

        test('conversation role tells Izzy getRejectedDrafts is available on demand without waiting for a perch turn; perch does not have email tools and is not told about it', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            expect(conversation).toContain('getRejectedDrafts');
            expect(conversation).toContain('admin-rejected');
            expect(conversation).toContain('gave-up');
            expect(conversation).toContain('perch turn');
            assertPromptHygiene(conversation);

            // The perch conductor attaches no email MCP server (see src/app/sessions.ts,
            // createPerchConductor), so perch must never be told to call an unreachable tool.
            expect(perch).not.toContain('getRejectedDrafts');
            assertPromptHygiene(perch);
        });

        test('both roles are told getServiceHealth reports which integrations are online', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            for(const prompt of [conversation, perch]) {
                expect(prompt).toContain('getServiceHealth');
                assertPromptHygiene(prompt);
            }
        });

        test('SESSION_BASE_PROMPT catalogues every envelope kind a host can send, and tells Izzy a [BOOT] handshake needs no reply', () => {
            // Regression: the first perch soak (2026-09-06) had Izzy treat its own `[BOOT]` handshake
            // as a "data point" worth recording, because the prompt named no envelope kinds at all.
            for(const kind of ['[DISCORD', '[PERCH', '[WRAP-UP', '[NOTIFICATION', '[CATCH-UP', '[BOOT', '[RESUME NOTE]']) {
                expect(SESSION_BASE_PROMPT).toContain(kind);
            }
            expect(SESSION_BASE_PROMPT).toMatch(/\[BOOT[^\n]*(no reply|nothing to do|not a request)/i);
        });

        test('SESSION_BASE_PROMPT, CONVERSATION_ROLE_PROMPT and PERCH_ROLE_PROMPT are non-empty and pass hygiene on their own', () => {
            expect(SESSION_BASE_PROMPT.length).toBeGreaterThan(0);
            expect(CONVERSATION_ROLE_PROMPT.length).toBeGreaterThan(0);
            expect(PERCH_ROLE_PROMPT.length).toBeGreaterThan(0);
            assertPromptHygiene(SESSION_BASE_PROMPT);
            assertPromptHygiene(CONVERSATION_ROLE_PROMPT);
            assertPromptHygiene(PERCH_ROLE_PROMPT);
        });
    });
});
