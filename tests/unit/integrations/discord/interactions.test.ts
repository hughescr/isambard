import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { logger } from '@hughescr/logger';
import { MessageFlags, type ButtonInteraction, type Message, type User } from 'discord.js';
import { QuestionRegistry } from '@/agent/question-registry/registry';
import type { PendingQuestion } from '@/agent/question-registry/types';
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
        jest.restoreAllMocks();
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
                isThread: () => false,
            },
            reply:  mock().mockResolvedValue({}),
            update: mock().mockResolvedValue({}),
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
            content: 'This question has expired or is no longer valid.',
            flags:   MessageFlags.Ephemeral,
        });
    });

    it('should propagate a rejected reply when question is not found', async () => {
        const interaction = createMockButtonInteraction('question:unknown-q:value', 'user1', 'msg1');
        const replyError = new Error('reply failed');
        interaction.reply = mock().mockRejectedValue(replyError);

        await expect(handler.handleButtonInteraction(interaction)).rejects.toBe(replyError);
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
            content: 'This question has expired or is no longer valid.',
            flags:   MessageFlags.Ephemeral,
        });
    });

    it('should not update or resolve a registry entry that is no longer waiting', async () => {
        const inactiveQuestion: PendingQuestion = {
            questionId:      'q-inactive',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Already answered',
            createdAt:       Date.now() - 1000,
            expiresAt:       Date.now() + 5000,
            options:         [{ label: 'Yes', value: 'yes' }],
            state:           'answered',
        };
        const inactiveRegistry = {
            getQuestion:       mock(() => inactiveQuestion),
            resolveWithAnswer: mock(),
        } as unknown as QuestionRegistry;
        const inactiveHandler = createInteractionHandler({ questionRegistry: inactiveRegistry });
        const interaction = createMockButtonInteraction('question:q-inactive:yes', 'user2', 'msg2');

        await inactiveHandler.handleButtonInteraction(interaction);

        expect(interaction.reply).toHaveBeenCalledWith({
            content: 'This question has expired or is no longer valid.',
            flags:   MessageFlags.Ephemeral,
        });
        expect(interaction.update).not.toHaveBeenCalled();
        expect(inactiveRegistry.resolveWithAnswer).not.toHaveBeenCalled();
    });

    it('should propagate a rejected reply for a question that is no longer waiting', async () => {
        const inactiveQuestion: PendingQuestion = {
            questionId:      'q-inactive-rejection',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Already answered',
            createdAt:       Date.now() - 1000,
            expiresAt:       Date.now() + 5000,
            options:         [{ label: 'Yes', value: 'yes' }],
            state:           'answered',
        };
        const inactiveRegistry = {
            getQuestion:       mock(() => inactiveQuestion),
            resolveWithAnswer: mock(),
        } as unknown as QuestionRegistry;
        const inactiveHandler = createInteractionHandler({ questionRegistry: inactiveRegistry });
        const interaction = createMockButtonInteraction('question:q-inactive-rejection:yes', 'user2', 'msg2');
        const replyError = new Error('reply failed');
        interaction.reply = mock().mockRejectedValue(replyError);

        await expect(inactiveHandler.handleButtonInteraction(interaction)).rejects.toBe(replyError);
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
            content: 'This question has expired or is no longer valid.',
            flags:   MessageFlags.Ephemeral,
        });
    });

    it('should propagate a rejected reply for an expired question', async () => {
        const expiredQuestion: PendingQuestion = {
            questionId:      'q-expired-rejection',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Expired question',
            createdAt:       Date.now() - 10_000,
            expiresAt:       Date.now() - 1,
            options:         [{ label: 'Yes', value: 'yes' }],
            state:           'waiting',
        };
        const expiredRegistry = {
            getQuestion:       mock(() => expiredQuestion),
            resolveWithAnswer: mock(),
        } as unknown as QuestionRegistry;
        const expiredHandler = createInteractionHandler({ questionRegistry: expiredRegistry });
        const interaction = createMockButtonInteraction('question:q-expired-rejection:yes', 'user2', 'msg2');
        const replyError = new Error('reply failed');
        interaction.reply = mock().mockRejectedValue(replyError);

        await expect(expiredHandler.handleButtonInteraction(interaction)).rejects.toBe(replyError);
    });

    it('should accept a question at its exact expiration timestamp', async () => {
        const now = new Date('2024-01-01T12:00:00Z').getTime();
        jest.useRealTimers();
        jest.useFakeTimers({ now });
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-expiry-boundary',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Choose an option',
            createdAt:       now - 1000,
            expiresAt:       now,
            options:         [{ label: 'Option 1', value: 'opt1' }],
        };
        const resultPromise = registry.register(question);
        const interaction = createMockButtonInteraction('question:q-expiry-boundary:opt1', 'user1', 'msg1');

        await handler.handleButtonInteraction(interaction);

        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.update).toHaveBeenCalledWith({ components: [] });
        const result = await resultPromise;
        expect(result).toMatchObject({
            state:  'answered',
            answer: { selectedOption: 'opt1' },
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
        expect(result).toMatchObject({
            state:  'answered',
            answer: {
                content:        'opt1',
                selectedOption: 'opt1',
                responderId:    createUserId('user2'),
                messageId:      'msg2',
            },
        });
    });

    it('should log the selected button-answer context', async () => {
        const now = Date.now();
        const question: Omit<PendingQuestion, 'state'> = {
            questionId:      'q-log',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Choose an option',
            createdAt:       now,
            expiresAt:       now + 5000,
            options:         [{ label: 'Yes', value: 'yes' }],
        };
        const resultPromise = registry.register(question);
        const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
        const interaction = createMockButtonInteraction('question:q-log:yes', 'user2', 'msg2');

        await handler.handleButtonInteraction(interaction);

        expect(infoSpy).toHaveBeenCalledWith({
            questionId:    'q-log',
            userId:        'user2',
            selectedValue: 'yes',
            msg:           'Button answer received',
        });
        await resultPromise;
    });

    it('should propagate a rejected update before resolving the question', async () => {
        const waitingQuestion: PendingQuestion = {
            questionId:      'q-update-rejection',
            channelId:       'ch1' as ChannelId,
            originMessageId: 'msg1',
            triggerUserId:   'user1' as UserId,
            questionText:    'Choose an option',
            createdAt:       Date.now(),
            expiresAt:       Date.now() + 5000,
            options:         [{ label: 'Yes', value: 'yes' }],
            state:           'waiting',
        };
        const waitingRegistry = {
            getQuestion:       mock(() => waitingQuestion),
            resolveWithAnswer: mock(),
        } as unknown as QuestionRegistry;
        const waitingHandler = createInteractionHandler({ questionRegistry: waitingRegistry });
        const interaction = createMockButtonInteraction('question:q-update-rejection:yes', 'user2', 'msg2');
        const updateError = new Error('update failed');
        interaction.update = mock().mockRejectedValue(updateError);

        await expect(waitingHandler.handleButtonInteraction(interaction)).rejects.toBe(updateError);
        expect(waitingRegistry.resolveWithAnswer).not.toHaveBeenCalled();
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
        expect(result).toMatchObject({
            state:  'answered',
            answer: {
                content:        'blue',
                selectedOption: 'blue',
                responderId:    createUserId('user3'),
                messageId:      'msg-xyz',
                channelId:      'ch1' as ChannelId,
                threadId:       undefined,
            },
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
                isThread: () => true,
                parentId: 'parent-ch', // Parent channel ID
            },
            reply:  mock().mockResolvedValue({}),
            update: mock().mockResolvedValue({}),
        } as unknown as ButtonInteraction;

        await handler.handleButtonInteraction(mockInteraction);

        const result = await resultPromise;
        expect(result).toMatchObject({
            state:  'answered',
            answer: {
                content:        'yes',
                selectedOption: 'yes',
                responderId:    createUserId('user2'),
                messageId:      'msg-thread',
                channelId:      'parent-ch' as ChannelId,
                threadId:       'thread-123', // Thread ID should be captured
            },
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
        expect(result).toMatchObject({
            state:  'answered',
            answer: {
                content:        'https://example.com:8080/path',
                selectedOption: 'https://example.com:8080/path',
            },
        });
    });
});
