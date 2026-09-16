import { describe, expect, it, mock } from 'bun:test';
import { AnswerClassifier } from '@/agent/answer-classifier/classifier';
import type { ClassificationResult, MessageToClassify } from '@/agent/answer-classifier/types';
import type { PendingQuestion } from '@/agent/question-registry/types';
import { userIdSchema, channelIdSchema } from '@/integrations/discord/types';

describe('AnswerClassifier', () => {
    const baseQuestion: PendingQuestion = {
        questionId:      'question-123',
        triggerUserId:   userIdSchema.parse('user-123'),
        channelId:       channelIdSchema.parse('channel-123'),
        originMessageId: 'msg-question',
        questionText:    'What is your favorite color?',
        createdAt:       Date.now(),
        expiresAt:       Date.now() + 60_000,
        state:           'waiting',
    };

    const baseMessage: MessageToClassify = {
        content:        'Blue',
        authorId:       'user-123',
        channelId:      'channel-123',
        isBotMentioned: false,
    };

    describe('Layer 1: Structural cues', () => {
        it('should classify as answer when message replies to question', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                referencedMessageId: 'msg-question',
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('answer');
        });

        it('should classify as answer when message is in question thread', async () => {
            const classifier = new AnswerClassifier();
            const questionWithThread: PendingQuestion = {
                ...baseQuestion,
                threadId: 'thread-123',
            };
            const message: MessageToClassify = {
                ...baseMessage,
                threadId: 'thread-123',
            };

            const result = await classifier.classify(questionWithThread, message);

            expect(result).toBe('answer');
        });

        it('should not match thread if question has no thread', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                threadId: 'thread-123',
                content:  'yes',
            };

            const result = await classifier.classify(baseQuestion, message);

            // Should fall through to heuristics and match "yes"
            expect(result).toBe('answer');
        });

        it('should not match different thread', async () => {
            const classifier = new AnswerClassifier();
            const questionWithThread: PendingQuestion = {
                ...baseQuestion,
                threadId: 'thread-123',
            };
            const message: MessageToClassify = {
                ...baseMessage,
                threadId:       'thread-456',
                content:        'some ambiguous message',
                isBotMentioned: false,
            };

            const result = await classifier.classify(questionWithThread, message);

            // Should fall through to default (unrelated since not @mentioned)
            expect(result).toBe('unrelated');
        });
    });

    describe('Layer 2: Heuristics', () => {
        const classifier = new AnswerClassifier();

        describe('Answer patterns', () => {
            it('trims leading whitespace before matching an answer', async () => {
                expect(await classifier.classify(baseQuestion, { ...baseMessage, content: '  yes  ' })).toBe('answer');
            });

            it('does not treat embedded or suffixed numbers as answers', async () => {
                expect(await classifier.classify(baseQuestion, { ...baseMessage, content: 'x42' })).toBe('unrelated');
                expect(await classifier.classify(baseQuestion, { ...baseMessage, content: '42x' })).toBe('unrelated');
                expect(await classifier.classify(baseQuestion, { ...baseMessage, content: '3.14x' })).toBe('unrelated');
            });

            it('should only match answer patterns at start of string', async () => {
                const innerClassifier = new AnswerClassifier();
                const message: MessageToClassify = {
                    ...baseMessage,
                    content:        'I said yes yesterday',
                    isBotMentioned: false,
                };
                // Should NOT match "yes" in the middle - should default to unrelated
                expect(await innerClassifier.classify(baseQuestion, message)).toBe('unrelated');
            });

            it.each<[string, string]>([
                ['"yes"', 'yes'],
                ['"no"', 'no'],
                ['"yep"', 'yep'],
                ['"nope"', 'nope'],
                ['"sure"', 'sure'],
                ['"ok"', 'ok'],
                ['"okay"', 'okay'],
                ['"I think"', 'I think blue'],
                ['"because"', 'because it reminds me of the sky'],
                ['"it\'s"', 'it\'s blue'],
                ['"they\'re"', 'they\'re great'],
                ['"that\'s"', 'that\'s correct'],
                ['"maybe"', 'maybe blue'],
                ['"probably"', 'probably red'],
                ['"definitely"', 'definitely green'],
                ['"of course"', 'of course!'],
                ['number', '42'],
                ['decimal number', '3.14'],
            ])('should classify %s as answer', async (_label, content) => {
                const message: MessageToClassify = { ...baseMessage, content };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should be case-insensitive', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'YES' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('normalizes Unicode Kelvin sign before matching an answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'oKay' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });
        });

        describe('Interruption patterns', () => {
            it('should only match interruption patterns at start of string', async () => {
                const innerClassifier = new AnswerClassifier();
                const message: MessageToClassify = {
                    ...baseMessage,
                    content:        'I was thinking, by the way this is nice',
                    isBotMentioned: false,
                };
                // Should NOT match "by the way" in the middle - should default to unrelated
                expect(await innerClassifier.classify(baseQuestion, message)).toBe('unrelated');
            });

            it.each<[string, string]>([
                ['"by the way"', 'by the way, I need help with something'],
                ['"also"', 'also, can you help me?'],
                ['"new topic"', 'new topic: what about this?'],
                ['"different question"', 'different question - how do I...'],
                ['"hey"', 'hey, can you help?'],
                ['"@mention"', '@bot help me with this'],
                ['"unrelated"', 'unrelated, but I was wondering...'],
                ['"actually"', 'actually, I want to ask about...'],
                ['"wait"', 'wait, I have another question'],
                ['"hold on"', 'hold on, what about...'],
                ['"sorry to interrupt"', 'sorry to interrupt, but...'],
            ])('should classify %s as interruption', async (_label, content) => {
                const message: MessageToClassify = { ...baseMessage, content };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });
        });
    });

    describe('Layer 3: LLM fallback', () => {
        it('should call LLM classifier for ambiguous messages', async () => {
            const llmClassifier = mock<(question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>>(async () => 'answer');
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'This is an ambiguous message that matches no patterns',
            };

            await classifier.classify(baseQuestion, message);

            expect(llmClassifier).toHaveBeenCalledWith(baseQuestion, message);
        });

        it('should return LLM result when configured', async () => {
            const llmClassifier = mock<(question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>>(async () => 'answer');
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'This is an ambiguous message',
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('answer');
        });

        it('should propagate interruption from LLM', async () => {
            const llmClassifier = mock<(question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>>(async () => 'interruption');
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'Ambiguous message',
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('interruption');
        });

        it('should not call LLM for structural matches', async () => {
            const llmClassifier = mock<(question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>>(async () => 'answer');
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                referencedMessageId: 'msg-question',
                content:             'Ambiguous message',
            };

            await classifier.classify(baseQuestion, message);

            expect(llmClassifier).not.toHaveBeenCalled();
        });

        it('should not call LLM for heuristic matches', async () => {
            const llmClassifier = mock<(question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>>(async () => 'interruption');
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'yes',
            };

            await classifier.classify(baseQuestion, message);

            expect(llmClassifier).not.toHaveBeenCalled();
        });
    });

    describe('Layer 4: Default', () => {
        it.each<[ClassificationResult, string, boolean, string]>([
            ['interruption', 'ambiguous message',       true,  'This is an ambiguous message that matches no patterns'],
            ['unrelated',    'ambiguous message',       false, 'This is an ambiguous message that matches no patterns'],
            ['interruption', 'empty message',           true,  ''],
            ['unrelated',    'empty message',           false, ''],
            ['interruption', 'whitespace-only message', true,  '   \n\t  '],
            ['unrelated',    'whitespace-only message', false, '   \n\t  '],
        ])('should default to %s for %s when isBotMentioned=%s', async (expected, _label, isBotMentioned, content) => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content,
                isBotMentioned,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe(expected);
        });
    });
});
