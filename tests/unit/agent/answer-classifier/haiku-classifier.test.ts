import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mockGenerateText, originalGenerateText, mockLogger } from '../../../setup';
import { classifyWithHaiku } from '@/agent/answer-classifier/haiku-classifier';
import type { ClassificationResult, MessageToClassify } from '@/agent/answer-classifier/types';
import type { PendingQuestion } from '@/agent/question-registry/types';
import { userIdSchema, channelIdSchema } from '@/integrations/discord/types';

describe('classifyWithHaiku', () => {
    const baseQuestion: PendingQuestion = {
        questionId:      'question-123',
        triggerUserId:   userIdSchema.parse('user-123'),
        channelId:       channelIdSchema.parse('channel-123'),
        originMessageId: 'msg-question',
        questionText:    'What is your favorite color?',
        createdAt:       new Date('2025-01-17T12:00:00Z').getTime(),
        expiresAt:       new Date('2025-01-17T12:05:00Z').getTime(),
        state:           'waiting',
    };

    const baseMessage: MessageToClassify = {
        content:        'Blue, definitely blue',
        authorId:       'user-123',
        channelId:      'channel-123',
        isBotMentioned: false,
    };

    beforeEach(() => {
        mockGenerateText.mockClear();
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockLogger.warn.mockReset();
    });

    it('should call text generator with classification prompt', async () => {
        mockGenerateText.mockResolvedValue('answer');

        await classifyWithHaiku(baseQuestion, baseMessage);

        expect(mockGenerateText).toHaveBeenCalledTimes(1);
        const call = mockGenerateText.mock.calls[0];
        const prompt = call[0];

        // Verify prompt includes question context
        expect(prompt).toContain('What is your favorite color?');
        expect(prompt).toContain('Blue, definitely blue');
    });

    it('should include question asked time in prompt', async () => {
        mockGenerateText.mockResolvedValue('answer');

        await classifyWithHaiku(baseQuestion, baseMessage);

        const call = mockGenerateText.mock.calls[0];
        const prompt = call[0];

        expect(prompt).toContain('2025-01-17');
    });

    it.each<[string, ClassificationResult, string]>([
        ['answer', 'answer', 'a plain "answer" response'],
        ['interruption', 'interruption', 'a plain "interruption" response'],
        ['unrelated', 'unrelated', 'a plain "unrelated" response'],
        ['  answer  \n', 'answer', 'a response with extra whitespace'],
        ['answer - This message directly responds to the question', 'answer', 'a response with explanation text'],
        ['invalid-classification', 'interruption', 'an invalid response'],
        ['', 'interruption', 'an empty response'],
        ['Something completely unexpected', 'interruption', 'a response that fails to parse'],
    ])('should parse %j as %j (%s)', async (response, expected) => {
        mockGenerateText.mockResolvedValue(response);

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe(expected);
    });

    it('should default to interruption on text generator error', async () => {
        mockGenerateText.mockRejectedValue(new Error('API error'));

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('interruption');
    });

    it('should warn via logger when text generator throws', async () => {
        const apiError = new Error('API error');
        mockGenerateText.mockRejectedValue(apiError);

        await classifyWithHaiku(baseQuestion, baseMessage);

        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        const warnCall = mockLogger.warn.mock.calls[0];
        expect(warnCall[0]).toMatchObject({
            err:       apiError,
            channelId: 'channel-123',
            msg:       'Haiku classification failed; defaulting to interruption',
        });
    });

    it('should include thread context if present', async () => {
        mockGenerateText.mockResolvedValue('answer');
        const questionWithThread: PendingQuestion = {
            ...baseQuestion,
            threadId: 'thread-123',
        };

        await classifyWithHaiku(questionWithThread, baseMessage);

        const call = mockGenerateText.mock.calls[0];
        const prompt = call[0];

        expect(prompt).toContain('thread');
    });

    it('should include reference message context if present', async () => {
        mockGenerateText.mockResolvedValue('answer');
        const messageWithReference: MessageToClassify = {
            ...baseMessage,
            referencedMessageId: 'msg-ref',
        };

        await classifyWithHaiku(baseQuestion, messageWithReference);

        const call = mockGenerateText.mock.calls[0];
        const prompt = call[0];

        expect(prompt.includes('reply') || prompt.includes('reference')).toBe(true);
    });

    it('passes all present routing cues and the mentioned-user choice set to the classifier', async () => {
        mockGenerateText.mockResolvedValue('answer');
        await classifyWithHaiku(
            { ...baseQuestion, threadId: 'question-thread' },
            { ...baseMessage, threadId: 'message-thread', referencedMessageId: 'reply-id', targetUserId: 'target-user', authorId: 'responder', isBotMentioned: true }
        );

        const prompt: string = mockGenerateText.mock.calls[0][0];
        expect(prompt).toContain('Question is in thread: question-thread');
        expect(prompt).toContain('Question was directed at user ID: target-user');
        expect(prompt).toContain('Responding user ID is: responder');
        expect(prompt).toContain('In thread: message-thread');
        expect(prompt).toContain('Message is a reply/reference to: reply-id');
        expect(prompt).toContain('Bot was @mentioned in this message');
        expect(prompt).not.toContain('"unrelated" if');
        expect(prompt).toContain(`Respond with exactly one word:
- "answer" if the message directly responds to the question
- "interruption" if the message is clearly addressed to the bot but starts a new topic`);
    });

    it('omits absent routing cues and offers the unrelated choice when unmentioned', async () => {
        mockGenerateText.mockResolvedValue('unrelated');
        await classifyWithHaiku(baseQuestion, baseMessage);

        const prompt: string = mockGenerateText.mock.calls[0][0];
        expect(prompt).not.toContain('Question is in thread:');
        expect(prompt).not.toContain('Question was directed at user ID:');
        expect(prompt).not.toContain('In thread:');
        expect(prompt).not.toContain('Message is a reply/reference to:');
        expect(prompt).not.toContain('Bot was @mentioned in this message');
        expect(prompt).toContain('"unrelated" if the message');
        expect(prompt).toBe(`Classify whether the following message is an answer to the question, an interruption (new topic), or unrelated.

Question context:
- Question: "What is your favorite color?"
- Asked at: 2025-01-17T12:00:00.000Z
- Asked by user: user-123
- In channel: channel-123

Message to classify:
- Content: "Blue, definitely blue"
- From user: user-123
- In channel: channel-123

Respond with exactly one word:
- "answer" if the message directly responds to the question
- "interruption" if the message is clearly addressed to the bot (new topic/question)
- "unrelated" if the message doesn't seem to be addressed to the bot at all

Classification:`);
    });
});
