import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import type { ButtonInteraction, Message, User, InteractionResponse } from 'discord.js';
import _constant from 'lodash/constant';
import type { PendingQuestion } from '@/agent/question-registry';
import { QuestionRegistry } from '@/agent/question-registry/registry';
import { createInteractionHandler } from '@/integrations/discord/interactions';
import { type ChannelId, type UserId, createUserId  } from '@/integrations/discord/types';

describe('createInteractionHandler', () => {
    let registry: QuestionRegistry;
    let handler: ReturnType<typeof createInteractionHandler>;

    beforeEach(() => {
        jest.useFakeTimers();
        registry = new QuestionRegistry();
        handler = createInteractionHandler({ questionRegistry: registry });
    });

    afterEach(() => {
        registry.stop();
        jest.useRealTimers();
    });

    function createMockButtonInteraction(customId: string, userId: string, messageId: string): ButtonInteraction {
        const mockUser = {
            id: userId,
        } as User;

        const mockMessage = {
            id:   messageId,
            edit: mock().mockResolvedValue({}),
        } as unknown as Message;

        return {
            customId,
            user:      mockUser,
            message:   mockMessage,
            channelId: 'ch1',
            channel:   {
                isThread: _constant(false),
            },
            reply:  mock().mockResolvedValue({} as InteractionResponse),
            update: mock().mockResolvedValue({} as InteractionResponse),
        } as unknown as ButtonInteraction;
    }

    it('should ignore non-question buttons', async () => {
        const interaction = createMockButtonInteraction('other:button:value', 'user1', 'msg1');

        await handler.handleButtonInteraction(interaction);

        // Should not call reply or update
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.update).not.toHaveBeenCalled();
    });

    it('should ignore malformed customId with less than 3 parts', async () => {
        const interaction = createMockButtonInteraction('question:only-two', 'user1', 'msg1');

        await handler.handleButtonInteraction(interaction);

        // Should not call reply or update
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.update).not.toHaveBeenCalled();
    });

    it('should reply ephemeral when question not found', async () => {
        const interaction = createMockButtonInteraction('question:unknown-q:value', 'user1', 'msg1');

        await handler.handleButtonInteraction(interaction);

        expect(interaction.reply).toHaveBeenCalledWith({
            content:   'This question has expired or is no longer valid.',
            ephemeral: true,
        });
    });

    it('should reply ephemeral when question is not in waiting state', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-answered',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Already answered',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [
                { label: 'Yes', value: 'yes' },
                { label: 'No', value: 'no' },
            ],
        };

        // Register and immediately resolve to change state from 'waiting'
        const resultPromise = registry.register(question);
        registry.resolveWithAnswer('q-answered', {
            content:        'yes',
            selectedOption: 'yes',
            responderId:    'user1' as UserId,
            messageId:      'msg1',
            channelId:      'ch1' as ChannelId,
            threadId:       undefined,
        });
        await resultPromise;

        // Now try to interact with the already-answered question
        const interaction = createMockButtonInteraction('question:q-answered:no', 'user2', 'msg2');
        await handler.handleButtonInteraction(interaction);

        expect(interaction.reply).toHaveBeenCalledWith({
            content:   'This question has expired or is no longer valid.',
            ephemeral: true,
        });
    });

    it('should reply ephemeral when question has expired (expiresAt < now)', async () => {
        // Set system time to a known value using vi.useFakeTimers
        const baseTime = new Date('2024-01-01T12:00:00Z').getTime();

        // Re-initialize timers with specific now value for this test
        jest.useRealTimers();
        jest.useFakeTimers({ now: baseTime });

        // Create question that expires in the past relative to current system time
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-expired',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Choose an option',
            createdAt:       baseTime - 10_000, // Created 10s ago
            expiresAt:       baseTime - 1000,  // Expired 1s ago (expiresAt < now)
            options:         [
                { label: 'Option 1', value: 'opt1' },
                { label: 'Option 2', value: 'opt2' },
            ],
        };

        void registry.register(question);

        const interaction = createMockButtonInteraction('question:q-expired:opt1', 'user1', 'msg1');
        await handler.handleButtonInteraction(interaction);

        // Clean up
        registry.cancel('q-expired');

        expect(interaction.reply).toHaveBeenCalledWith({
            content:   'This question has expired or is no longer valid.',
            ephemeral: true,
        });
    });

    it('should resolve question with answer on button click', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q1',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Choose an option',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [
                { label: 'Option 1', value: 'opt1' },
                { label: 'Option 2', value: 'opt2' },
            ],
        };

        const resultPromise = registry.register(question);

        const interaction = createMockButtonInteraction('question:q1:opt1', 'user2', 'msg2');
        await handler.handleButtonInteraction(interaction);

        const result = await resultPromise;
        expect(result.answer).toBeTruthy();
        expect(result.answer?.content).toBe('opt1');
        expect(result.answer?.selectedOption).toBe('opt1');
        expect(result.answer?.responderId).toBe(createUserId('user2'));
        expect(result.answer?.messageId).toBe('msg2');
        expect(result.timedOut).toBe(false);
    });

    it('should remove buttons after click', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q1',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Choose an option',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [
                { label: 'Yes', value: 'yes' },
                { label: 'No', value: 'no' },
            ],
        };

        const resultPromise = registry.register(question);

        const interaction = createMockButtonInteraction('question:q1:yes', 'user1', 'msg1');
        await handler.handleButtonInteraction(interaction);

        // Should update the interaction (which removes buttons)
        expect(interaction.update).toHaveBeenCalledWith({
            components: [],
        });

        await resultPromise;
    });

    it('should use correct answer format', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-test',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Pick a color',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [
                { label: 'Red', value: 'red' },
                { label: 'Blue', value: 'blue' },
            ],
        };

        const resultPromise = registry.register(question);

        const interaction = createMockButtonInteraction('question:q-test:blue', 'user3', 'msg-xyz');
        await handler.handleButtonInteraction(interaction);

        const result = await resultPromise;
        expect(result.answer).toEqual({
            content:        'blue',
            selectedOption: 'blue',
            responderId:    createUserId('user3'),
            messageId:      'msg-xyz',
            channelId:      'ch1' as ChannelId,
            threadId:       undefined,
        });
    });

    it('should handle thread context correctly', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-thread',
            channelId:       'parent-ch' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Thread question',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [
                { label: 'Yes', value: 'yes' },
                { label: 'No', value: 'no' },
            ],
        };

        const resultPromise = registry.register(question);

        // Create mock interaction in a thread
        const mockUser = { id: 'user2' } as User;
        const mockMessage = {
            id:   'msg-thread',
            edit: mock().mockResolvedValue({}),
        } as unknown as Message;

        const mockInteraction = {
            customId:  'question:q-thread:yes',
            user:      mockUser,
            message:   mockMessage,
            channelId: 'thread-123', // Thread ID
            channel:   {
                isThread: _constant(true),
                parentId: 'parent-ch', // Parent channel ID
            },
            reply:  mock().mockResolvedValue({} as InteractionResponse),
            update: mock().mockResolvedValue({} as InteractionResponse),
        } as unknown as ButtonInteraction;

        await handler.handleButtonInteraction(mockInteraction);

        const result = await resultPromise;
        expect(result.answer).toEqual({
            content:        'yes',
            selectedOption: 'yes',
            responderId:    createUserId('user2'),
            messageId:      'msg-thread',
            channelId:      'parent-ch' as ChannelId,
            threadId:       'thread-123', // Thread ID should be captured
        });
    });

    it('should handle value with colons correctly', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-colon',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Complex value',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [
                { label: 'URL', value: 'https://example.com:8080/path' },
                { label: 'Config', value: 'key:value:nested' },
            ],
        };

        const resultPromise = registry.register(question);

        // CustomId with value containing colons: question:q-colon:https://example.com:8080/path
        const interaction = createMockButtonInteraction('question:q-colon:https://example.com:8080/path', 'user1', 'msg1');
        await handler.handleButtonInteraction(interaction);

        const result = await resultPromise;
        expect(result.answer?.content).toBe('https://example.com:8080/path');
        expect(result.answer?.selectedOption).toBe('https://example.com:8080/path');
    });
});
