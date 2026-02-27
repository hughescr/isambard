import { describe, expect, it, mock } from 'bun:test';
import { AnswerClassifier } from '@/agent/answer-classifier/classifier';
import type { MessageToClassify, ClassificationResult } from '@/agent/answer-classifier/types';
import type { PendingQuestion } from '@/agent/question-registry';
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
            it('should classify "yes" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'yes' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
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

            it('should classify "no" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'no' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "yep" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'yep' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "nope" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'nope' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "sure" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'sure' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "ok" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'ok' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "okay" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'okay' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "I think" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'I think blue' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "because" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'because it reminds me of the sky' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "it\'s" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'it\'s blue' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "they\'re" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'they\'re great' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "that\'s" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'that\'s correct' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "maybe" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'maybe blue' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "probably" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'probably red' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "definitely" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'definitely green' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify "of course" as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'of course!' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify number as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: '42' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should classify decimal number as answer', async () => {
                const message: MessageToClassify = { ...baseMessage, content: '3.14' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });

            it('should be case-insensitive', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'YES' };
                expect(await classifier.classify(baseQuestion, message)).toBe('answer');
            });
        });

        describe('Interruption patterns', () => {
            it('should classify "by the way" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'by the way, I need help with something' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

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

            it('should classify "also" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'also, can you help me?' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "new topic" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'new topic: what about this?' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "different question" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'different question - how do I...' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "hey" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'hey, can you help?' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "@mention" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: '@bot help me with this' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "unrelated" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'unrelated, but I was wondering...' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "actually" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'actually, I want to ask about...' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "wait" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'wait, I have another question' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "hold on" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'hold on, what about...' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });

            it('should classify "sorry to interrupt" as interruption', async () => {
                const message: MessageToClassify = { ...baseMessage, content: 'sorry to interrupt, but...' };
                expect(await classifier.classify(baseQuestion, message)).toBe('interruption');
            });
        });
    });

    describe('Layer 3: LLM fallback', () => {
        it('should call LLM classifier for ambiguous messages', async () => {
            const llmClassifier = mock(async () => 'answer' as ClassificationResult);
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'This is an ambiguous message that matches no patterns',
            };

            await classifier.classify(baseQuestion, message);

            expect(llmClassifier).toHaveBeenCalledWith(baseQuestion, message);
        });

        it('should return LLM result when configured', async () => {
            const llmClassifier = mock(async () => 'answer' as ClassificationResult);
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'This is an ambiguous message',
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('answer');
        });

        it('should propagate interruption from LLM', async () => {
            const llmClassifier = mock(async () => 'interruption' as ClassificationResult);
            const classifier = new AnswerClassifier({ classifyWithLLM: llmClassifier });
            const message: MessageToClassify = {
                ...baseMessage,
                content: 'Ambiguous message',
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('interruption');
        });

        it('should not call LLM for structural matches', async () => {
            const llmClassifier = mock(async () => 'answer' as ClassificationResult);
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
            const llmClassifier = mock(async () => 'interruption' as ClassificationResult);
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
        it('should default to interruption when bot is @mentioned and no LLM configured', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content:        'This is an ambiguous message that matches no patterns',
                isBotMentioned: true,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('interruption');
        });

        it('should default to unrelated when bot is NOT @mentioned and no LLM configured', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content:        'This is an ambiguous message that matches no patterns',
                isBotMentioned: false,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('unrelated');
        });

        it('should default to interruption for empty message when @mentioned', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content:        '',
                isBotMentioned: true,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('interruption');
        });

        it('should default to unrelated for empty message when not @mentioned', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content:        '',
                isBotMentioned: false,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('unrelated');
        });

        it('should default to interruption for whitespace-only message when @mentioned', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content:        '   \n\t  ',
                isBotMentioned: true,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('interruption');
        });

        it('should default to unrelated for whitespace-only message when not @mentioned', async () => {
            const classifier = new AnswerClassifier();
            const message: MessageToClassify = {
                ...baseMessage,
                content:        '   \n\t  ',
                isBotMentioned: false,
            };

            const result = await classifier.classify(baseQuestion, message);

            expect(result).toBe('unrelated');
        });
    });
});
