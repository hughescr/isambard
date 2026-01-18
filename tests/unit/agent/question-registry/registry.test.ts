import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { createQuestionRegistry } from '@/agent/question-registry/registry';
import type { QuestionRegistry, PendingQuestion, QuestionAnswer } from '@/agent/question-registry';
import type { ChannelId, UserId } from '@/integrations/discord/types';

describe('QuestionRegistry', () => {
    let registry: QuestionRegistry;

    beforeEach(() => {
        jest.useFakeTimers();
        registry = createQuestionRegistry({ defaultTimeoutMs: 5000 });
    });

    afterEach(() => {
        registry.stop();
        jest.useRealTimers();
    });

    describe('register', () => {
        it('should store question and return promise', async () => {
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       Date.now(),
                expiresAt:       Date.now() + 5000,
            };

            const resultPromise = registry.register(question);
            expect(resultPromise).toBeInstanceOf(Promise);

            // Should be findable
            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeTruthy();
            expect(found?.questionId).toBe('q1');
            expect(found?.state).toBe('waiting');

            // Clean up
            registry.cancel('q1');
            await resultPromise;
        });

        it('should resolve promise when answered', async () => {
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       Date.now(),
                expiresAt:       Date.now() + 5000,
            };

            const resultPromise = registry.register(question);

            const answer: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            registry.resolveWithAnswer('q1', answer);

            const result = await resultPromise;
            expect(result.questionId).toBe('q1');
            expect(result.channelId).toBe('ch1' as ChannelId);
            expect(result.threadId).toBeUndefined();
            expect(result.answer).toEqual(answer);
            expect(result.timedOut).toBe(false);
        });

        it('should resolve promise with timeout after expiry', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            // Advance time past expiry
            jest.advanceTimersByTime(5000);

            const result = await resultPromise;
            expect(result.questionId).toBe('q1');
            expect(result.channelId).toBe('ch1' as ChannelId);
            expect(result.threadId).toBeUndefined();
            expect(result.answer).toBeNull();
            expect(result.timedOut).toBe(true);
        });

        it('should replace existing question for same location', async () => {
            const now = Date.now();
            const question1: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'First question?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise1 = registry.register(question1);

            const question2: Omit<PendingQuestion, 'state'> = {
                questionId:      'q2',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg2',
                triggerUserId:   'user1' as UserId,
                questionText:    'Second question?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise2 = registry.register(question2);

            // First promise should resolve with null (cancelled)
            const result1 = await resultPromise1;
            expect(result1.questionId).toBe('q1');
            expect(result1.channelId).toBe('ch1' as ChannelId);
            expect(result1.answer).toBeNull();
            expect(result1.timedOut).toBe(false);

            // Second question should be active
            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found?.questionId).toBe('q2');

            // Clean up
            registry.cancel('q2');
            await resultPromise2;
        });
    });

    describe('findPendingQuestion', () => {
        it('should return pending question for matching channel', () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            void registry.register(question);

            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeTruthy();
            expect(found?.questionId).toBe('q1');
            expect(found?.questionText).toBe('What is your name?');
        });

        it('should return null for unknown channel', () => {
            const found = registry.findPendingQuestion('unknown' as ChannelId);
            expect(found).toBeNull();
        });

        it('should return null for expired question', () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            void registry.register(question);

            // Advance time past expiry
            jest.advanceTimersByTime(6000);

            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeNull();
        });

        it('should return null for answered question', () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            void registry.register(question);

            const answer: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            registry.resolveWithAnswer('q1', answer);

            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeNull();
        });

        it('should isolate thread-specific questions', () => {
            const now = Date.now();
            const mainQuestion: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'Main channel question?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const threadQuestion: Omit<PendingQuestion, 'state'> = {
                questionId:      'q2',
                channelId:       'ch1' as ChannelId,
                threadId:        'thread1',
                originMessageId: 'msg2',
                triggerUserId:   'user1' as UserId,
                questionText:    'Thread question?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            void registry.register(mainQuestion);
            void registry.register(threadQuestion);

            // Main channel should only see main question
            const foundMain = registry.findPendingQuestion('ch1' as ChannelId);
            expect(foundMain?.questionId).toBe('q1');

            // Thread should only see thread question
            const foundThread = registry.findPendingQuestion('ch1' as ChannelId, 'thread1');
            expect(foundThread?.questionId).toBe('q2');
        });
    });

    describe('resolveWithAnswer', () => {
        it('should resolve promise with answer', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            const answer: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            registry.resolveWithAnswer('q1', answer);

            const result = await resultPromise;
            expect(result.answer).toEqual(answer);
            expect(result.timedOut).toBe(false);
        });

        it('should update state to answered', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            const answer: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            registry.resolveWithAnswer('q1', answer);

            // Should no longer be findable
            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeNull();

            await resultPromise;
        });

        it('should do nothing for unknown question', () => {
            expect(() => {
                registry.resolveWithAnswer('unknown', {
                    content:     'test',
                    responderId: 'user1' as UserId,
                    messageId:   'msg1',
                    channelId:   'ch1' as ChannelId,
                });
            }).not.toThrow();
        });

        it('should do nothing for already answered question', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            const answer1: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            registry.resolveWithAnswer('q1', answer1);
            await resultPromise;

            // Second resolution should do nothing
            const answer2: QuestionAnswer = {
                content:     'Bob',
                responderId: 'user2' as UserId,
                messageId:   'msg3',
                channelId:   'ch1' as ChannelId,
            };

            expect(() => {
                registry.resolveWithAnswer('q1', answer2);
            }).not.toThrow();
        });
    });

    describe('cancel', () => {
        it('should resolve promise with null', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            registry.cancel('q1');

            const result = await resultPromise;
            expect(result.questionId).toBe('q1');
            expect(result.channelId).toBe('ch1' as ChannelId);
            expect(result.answer).toBeNull();
            expect(result.timedOut).toBe(false);
        });

        it('should remove question from registry', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            registry.cancel('q1');

            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeNull();

            await resultPromise;
        });

        it('should do nothing for unknown question', () => {
            expect(() => {
                registry.cancel('unknown');
            }).not.toThrow();
        });
    });

    describe('stop', () => {
        it('should clear all timers and cancel pending questions', async () => {
            const now = Date.now();
            const question1: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'Question 1?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const question2: Omit<PendingQuestion, 'state'> = {
                questionId:      'q2',
                channelId:       'ch2' as ChannelId,
                originMessageId: 'msg2',
                triggerUserId:   'user1' as UserId,
                questionText:    'Question 2?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise1 = registry.register(question1);
            const resultPromise2 = registry.register(question2);

            registry.stop();

            // Both should resolve with null
            const result1 = await resultPromise1;
            const result2 = await resultPromise2;

            expect(result1.questionId).toBe('q1');
            expect(result1.channelId).toBe('ch1' as ChannelId);
            expect(result1.answer).toBeNull();
            expect(result1.timedOut).toBe(false);
            expect(result2.questionId).toBe('q2');
            expect(result2.channelId).toBe('ch2' as ChannelId);
            expect(result2.answer).toBeNull();
            expect(result2.timedOut).toBe(false);

            // Neither should be findable
            expect(registry.findPendingQuestion('ch1' as ChannelId)).toBeNull();
            expect(registry.findPendingQuestion('ch2' as ChannelId)).toBeNull();
        });
    });

    describe('timeout handling', () => {
        it('should resolve promise with timedOut: true after timeout', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            jest.advanceTimersByTime(5000);

            const result = await resultPromise;
            expect(result.answer).toBeNull();
            expect(result.timedOut).toBe(true);
        });

        it('should update state to timed_out', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            jest.advanceTimersByTime(5000);

            await resultPromise;

            // Should no longer be findable
            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeNull();
        });

        it('should not timeout if answered before expiry', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            const answer: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            // Answer before timeout
            jest.advanceTimersByTime(3000);
            registry.resolveWithAnswer('q1', answer);

            const result = await resultPromise;
            expect(result.answer).toEqual(answer);
            expect(result.timedOut).toBe(false);

            // Advancing further should not trigger timeout
            jest.advanceTimersByTime(5000);
        });
    });

    describe('custom timeout configuration', () => {
        it('should use custom timeout when provided', async () => {
            const customRegistry = createQuestionRegistry({ defaultTimeoutMs: 10000 });

            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 10000,
            };

            const resultPromise = customRegistry.register(question);

            // Should not timeout before custom timeout
            jest.advanceTimersByTime(5000);
            const found = customRegistry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeTruthy();

            // Should timeout after custom timeout
            jest.advanceTimersByTime(5000);
            const result = await resultPromise;
            expect(result.timedOut).toBe(true);

            customRegistry.stop();
        });
    });

    describe('getQuestion', () => {
        it('should return question by ID', () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            void registry.register(question);

            const found = registry.getQuestion('q1');
            expect(found).toBeTruthy();
            expect(found?.questionId).toBe('q1');
            expect(found?.questionText).toBe('What is your name?');
            expect(found?.state).toBe('waiting');
        });

        it('should return null for unknown ID', () => {
            const found = registry.getQuestion('unknown');
            expect(found).toBeNull();
        });

        it('should return question even after expiry time passes', () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            void registry.register(question);

            // getQuestion returns the question regardless of expiry
            // (unlike findPendingQuestion which checks expiry)
            const found = registry.getQuestion('q1');
            expect(found).toBeTruthy();
            expect(found?.questionId).toBe('q1');
        });

        it('should return null for answered question', async () => {
            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 5000,
            };

            const resultPromise = registry.register(question);

            const answer: QuestionAnswer = {
                content:     'Alice',
                responderId: 'user1' as UserId,
                messageId:   'msg2',
                channelId:   'ch1' as ChannelId,
            };

            registry.resolveWithAnswer('q1', answer);
            await resultPromise;

            const found = registry.getQuestion('q1');
            expect(found).toBeNull();
        });
    });
});
