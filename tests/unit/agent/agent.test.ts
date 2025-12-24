/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import _ from 'lodash';
import type Anthropic from '@anthropic-ai/sdk';
import { createClaudeAgent } from '../../../src/agent/agent';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';

describe('createClaudeAgent', () => {
    let mockClient: Anthropic;
    let mockMessageContext: DiscordMessageContext;

    beforeEach(() => {
    // Create mock Anthropic client
        mockClient = {
            messages: {
                create: mock(async () => ({
                    id:      'msg_123',
                    type:    'message',
                    role:    'assistant',
                    content: [
                        {
                            type: 'text',
                            text: 'Hello! This is a test response.',
                        },
                    ],
                    model:         'claude-sonnet-4-20250514',
                    stop_reason:   'end_turn',
                    stop_sequence: null,
                    usage:         {
                        input_tokens:  10,
                        output_tokens: 20,
                    },
                })),
            },
        } as unknown as Anthropic;

        // Create mock Discord message context
        mockMessageContext = {
            guildId:   createGuildId('123456789'),
            channelId: createChannelId('987654321'),
            userId:    createUserId('111222333'),
            messageId: 'msg_999',
            content:   'Hello Claude!',
            timestamp: '2025-01-15T12:00:00Z',
        };
    });

    afterEach(() => {
    // Reset all mocks
        (mockClient.messages.create as ReturnType<typeof mock>).mockClear();
    });

    it('should create an agent with chat method', () => {
        const agent = createClaudeAgent({ client: mockClient });

        expect(agent).toBeDefined();
        expect(typeof agent.chat).toBe('function');
    });

    it('should format message with username prefix', async () => {
        const agent = createClaudeAgent({ client: mockClient });

        await agent.chat(mockMessageContext);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role:    'user',
                        content: 'User @111222333 said: Hello Claude!',
                    },
                ],
            })
        );
    });

    it('should use claude-sonnet-4-20250514 model', async () => {
        const agent = createClaudeAgent({ client: mockClient });

        await agent.chat(mockMessageContext);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'claude-sonnet-4-20250514',
            })
        );
    });

    it('should use max_tokens of 2048', async () => {
        const agent = createClaudeAgent({ client: mockClient });

        await agent.chat(mockMessageContext);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                max_tokens: 2048,
            })
        );
    });

    it('should return text content from Claude response', async () => {
        const agent = createClaudeAgent({ client: mockClient });

        const response = await agent.chat(mockMessageContext);

        expect(response).toBe('Hello! This is a test response.');
    });

    it('should truncate responses longer than 1900 characters', async () => {
        const longText = _.repeat('a', 2000);
        (mockClient.messages.create as ReturnType<typeof mock>).mockResolvedValue({
            id:      'msg_123',
            type:    'message',
            role:    'assistant',
            content: [
                {
                    type: 'text',
                    text: longText,
                },
            ],
            model:         'claude-sonnet-4-20250514',
            stop_reason:   'end_turn',
            stop_sequence: null,
            usage:         {
                input_tokens:  10,
                output_tokens: 500,
            },
        });

        const agent = createClaudeAgent({ client: mockClient });
        const response = await agent.chat(mockMessageContext);

        expect(response).toBe(_.repeat('a', 1897) + '...');
        expect(response?.length).toBe(1900);
    });

    it('should include memory tool when provided', async () => {
        const mockMemoryTool = {
            name: 'memory_tool',
            type: 'custom' as const,
            // Mock memory tool structure
        };

        const agent = createClaudeAgent({
            client:     mockClient,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Mock tool type
            memoryTool: mockMemoryTool as any,
        });

        await agent.chat(mockMessageContext);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                tools: [mockMemoryTool],
            })
        );
    });

    it('should not include tools when memory tool is not provided', async () => {
        const agent = createClaudeAgent({ client: mockClient });

        await agent.chat(mockMessageContext);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Accessing mock call args
        const callArgs = (mockClient.messages.create as ReturnType<typeof mock>).mock.calls[0][0];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing tools property from mock
        expect(callArgs.tools).toBeUndefined();
    });

    it('should return null on API error', async () => {
        (mockClient.messages.create as ReturnType<typeof mock>).mockRejectedValue(
            new Error('API rate limit exceeded')
        );

        const agent = createClaudeAgent({ client: mockClient });
        const response = await agent.chat(mockMessageContext);

        expect(response).toBeNull();
    });

    it('should return null when response has no text content', async () => {
        (mockClient.messages.create as ReturnType<typeof mock>).mockResolvedValue({
            id:            'msg_123',
            type:          'message',
            role:          'assistant',
            content:       [], // Empty content
            model:         'claude-sonnet-4-20250514',
            stop_reason:   'end_turn',
            stop_sequence: null,
            usage:         {
                input_tokens:  10,
                output_tokens: 0,
            },
        });

        const agent = createClaudeAgent({ client: mockClient });
        const response = await agent.chat(mockMessageContext);

        expect(response).toBeNull();
    });

    it('should return null when response has non-text content', async () => {
        (mockClient.messages.create as ReturnType<typeof mock>).mockResolvedValue({
            id:      'msg_123',
            type:    'message',
            role:    'assistant',
            content: [
                {
                    type:  'tool_use',
                    id:    'tool_123',
                    name:  'some_tool',
                    input: {},
                },
            ],
            model:         'claude-sonnet-4-20250514',
            stop_reason:   'tool_use',
            stop_sequence: null,
            usage:         {
                input_tokens:  10,
                output_tokens: 20,
            },
        });

        const agent = createClaudeAgent({ client: mockClient });
        const response = await agent.chat(mockMessageContext);

        expect(response).toBeNull();
    });

    it('should handle empty message content', async () => {
        const emptyMessageContext: DiscordMessageContext = {
            ...mockMessageContext,
            content: '',
        };

        const agent = createClaudeAgent({ client: mockClient });
        await agent.chat(emptyMessageContext);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role:    'user',
                        content: 'User @111222333 said: ',
                    },
                ],
            })
        );
    });

    it('should preserve whitespace in message content', async () => {
        const messageWithWhitespace: DiscordMessageContext = {
            ...mockMessageContext,
            content: '  Hello   World  ',
        };

        const agent = createClaudeAgent({ client: mockClient });
        await agent.chat(messageWithWhitespace);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role:    'user',
                        content: 'User @111222333 said:   Hello   World  ',
                    },
                ],
            })
        );
    });

    it('should handle special characters in message content', async () => {
        const messageWithSpecialChars: DiscordMessageContext = {
            ...mockMessageContext,
            content: 'Hello! @user <#channel> **bold** `code`',
        };

        const agent = createClaudeAgent({ client: mockClient });
        await agent.chat(messageWithSpecialChars);

        expect(mockClient.messages.create).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: [
                    {
                        role:    'user',
                        content: 'User @111222333 said: Hello! @user <#channel> **bold** `code`',
                    },
                ],
            })
        );
    });
});
