import { describe, expect, it, beforeEach } from 'bun:test';
import { mockGenerateText } from '../../../setup';
import { classifyWithHaiku } from '@/agent/answer-classifier/haiku-classifier';
import type { MessageToClassify } from '@/agent/answer-classifier/types';
import type { PendingQuestion } from '@/agent/question-registry';
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
        mockGenerateText.mockReset();
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

    it('should parse "answer" response correctly', async () => {
        mockGenerateText.mockResolvedValue('answer');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('answer');
    });

    it('should parse "interruption" response correctly', async () => {
        mockGenerateText.mockResolvedValue('interruption');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('interruption');
    });

    it('should parse "unrelated" response correctly', async () => {
        mockGenerateText.mockResolvedValue('unrelated');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('unrelated');
    });

    it('should handle response with extra whitespace', async () => {
        mockGenerateText.mockResolvedValue('  answer  \n');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('answer');
    });

    it('should handle response with explanation text', async () => {
        mockGenerateText.mockResolvedValue('answer - This message directly responds to the question');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('answer');
    });

    it('should default to interruption on invalid response', async () => {
        mockGenerateText.mockResolvedValue('invalid-classification');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('interruption');
    });

    it('should default to interruption on empty response', async () => {
        mockGenerateText.mockResolvedValue('');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('interruption');
    });

    it('should default to interruption on parse failure', async () => {
        mockGenerateText.mockResolvedValue('Something completely unexpected');

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('interruption');
    });

    it('should default to interruption on text generator error', async () => {
        mockGenerateText.mockRejectedValue(new Error('API error'));

        const result = await classifyWithHaiku(baseQuestion, baseMessage);

        expect(result).toBe('interruption');
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
});
