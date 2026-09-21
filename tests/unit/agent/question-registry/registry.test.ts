import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import { QuestionRegistry } from '@/agent/question-registry/registry';
import type { PendingQuestion, QuestionAnswer } from '@/agent/question-registry/types';
import type { ChannelId, UserId } from '@/integrations/discord/types';

describe('QuestionRegistry', () => {
    let registry: QuestionRegistry;

    beforeEach(() => {
        jest.useFakeTimers();
        registry = new QuestionRegistry();
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
            expect(mockLogger.debug).toHaveBeenCalledWith({
                questionId: 'q1',
                channelId:  'ch1',
                threadId:   undefined,
                expiresIn:  5000,
                msg:        'Question registered',
            });

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
            expect(result).toMatchObject({ state: 'answered', answer });
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
            expect(result.state).toBe('timed_out');
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
            const supersededQuestion = registry.getQuestion('q1');
            expect(supersededQuestion).not.toBeNull();

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
            expect(mockLogger.warn).toHaveBeenCalledWith({
                oldQuestionId: 'q1',
                newQuestionId: 'q2',
                channelId:     'ch1',
                msg:           'Replacing existing pending question',
            });

            // First promise should resolve as replaced
            const result1 = await resultPromise1;
            expect(result1).toMatchObject({
                questionId: 'q1',
                channelId:  'ch1' as ChannelId,
                state:      'cancelled',
                reason:     'replaced',
            });
            expect(registry.getQuestion('q1')).toBeNull();
            expect(supersededQuestion?.state).toBe('cancelled');

            // Second question should be active
            const found = registry.findPendingQuestion('ch1' as ChannelId);
            expect(found?.questionId).toBe('q2');

            // Clean up
            registry.cancel('q2');
            await resultPromise2;
        });
    });

    describe('findPendingQuestion', () => {
        it('rejects expired and non-waiting records while keeping the exact expiry instant eligible', async () => {
            const now = Date.now();
            const question = {
                questionId:      'boundary', channelId:       'boundary-channel' as ChannelId,
                originMessageId: 'message', triggerUserId:   'user' as UserId,
                questionText:    'Boundary?', createdAt:       now, expiresAt:       now + 5000,
            };
            const resultPromise = registry.register(question);
            const stored = registry.getQuestion('boundary');
            expect(stored).not.toBeNull();
            stored!.expiresAt = now;
            expect(registry.findPendingQuestion('boundary-channel' as ChannelId)?.questionId).toBe('boundary');
            stored!.expiresAt = now - 1;
            expect(registry.findPendingQuestion('boundary-channel' as ChannelId)).toBeNull();
            stored!.expiresAt = now + 5000;
            stored!.state = 'answered';
            expect(registry.findPendingQuestion('boundary-channel' as ChannelId)).toBeNull();
            stored!.state = 'waiting';
            registry.cancel('boundary');
            await resultPromise;
        });

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

            // Clean up
            registry.cancel('q1');
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

            // Clean up
            registry.cancel('q1');
            registry.cancel('q2');
        });
    });

    it('keeps the main location, empty thread, and named threads distinct', async () => {
        const now = Date.now();
        const base = {
            channelId:       'collision' as ChannelId, originMessageId: 'message',
            triggerUserId:   'user' as UserId, questionText:    'Location?',
            createdAt:       now, expiresAt:       now + 5000,
        };
        const promises = [
            registry.register({ ...base, questionId: 'main' }),
            registry.register({ ...base, questionId: 'empty', threadId: '' }),
            registry.register({ ...base, questionId: 'named-a', threadId: 'thread-a' }),
            registry.register({ ...base, questionId: 'named-b', threadId: 'thread-b' }),
        ];
        expect(registry.findPendingQuestion('collision' as ChannelId)?.questionId).toBe('main');
        expect(registry.findPendingQuestion('collision' as ChannelId, '')?.questionId).toBe('empty');
        expect(registry.findPendingQuestion('collision' as ChannelId, 'thread-a')?.questionId).toBe('named-a');
        expect(registry.findPendingQuestion('collision' as ChannelId, 'thread-b')?.questionId).toBe('named-b');
        for(const id of ['main', 'empty', 'named-a', 'named-b']) {
            registry.cancel(id);
        }
        await Promise.all(promises);
    });

    it('removes a cancelled location before its next question is registered', async () => {
        const now = Date.now();
        const base = {
            channelId:       'reuse' as ChannelId, originMessageId: 'message',
            triggerUserId:   'user' as UserId, questionText:    'Reuse?',
            createdAt:       now, expiresAt:       now + 5000,
        };
        const first = registry.register({ ...base, questionId: 'old' });
        registry.cancel('old');
        await first;
        mockLogger.warn.mockClear();
        const second = registry.register({ ...base, questionId: 'new' });
        expect(mockLogger.warn).not.toHaveBeenCalled();
        registry.cancel('new');
        await second;
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
            expect(result).toMatchObject({ state: 'answered', answer });
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
        it('should resolve promise as interrupted', async () => {
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
            expect(result).toMatchObject({
                questionId: 'q1',
                channelId:  'ch1' as ChannelId,
                state:      'cancelled',
                reason:     'interrupted',
            });
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
        it('does not resolve a record whose exposed state is no longer waiting', async () => {
            const now = Date.now();
            const pending = registry.register({
                questionId:      'finished', channelId:       'finished-channel' as ChannelId,
                originMessageId: 'message', triggerUserId:   'user' as UserId,
                questionText:    'Already settled?', createdAt:       now, expiresAt:       now + 5000,
            });
            registry.getQuestion('finished')!.state = 'answered';
            let resolved = false;
            void pending.then(() => {
                resolved = true;
                return undefined;
            });
            registry.stop();
            await Promise.resolve();
            expect(resolved).toBe(false);
        });

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

            const exposed1 = registry.getQuestion('q1');
            registry.stop();

            expect(exposed1?.state).toBe('cancelled');

            // Both should resolve as shut down
            const result1 = await resultPromise1;
            const result2 = await resultPromise2;

            expect(result1).toMatchObject({
                questionId: 'q1',
                channelId:  'ch1' as ChannelId,
                state:      'cancelled',
                reason:     'shutdown',
            });
            expect(result2).toMatchObject({
                questionId: 'q2',
                channelId:  'ch2' as ChannelId,
                state:      'cancelled',
                reason:     'shutdown',
            });

            // Neither should be findable
            expect(registry.findPendingQuestion('ch1' as ChannelId)).toBeNull();
            expect(registry.findPendingQuestion('ch2' as ChannelId)).toBeNull();
            expect(registry.getQuestion('q1')).toBeNull();
            expect(registry.getQuestion('q2')).toBeNull();
            expect(jest.getTimerCount()).toBe(0);

            mockLogger.warn.mockClear();
            const replacement = registry.register({ ...question1, questionId: 'replacement' });
            expect(mockLogger.warn).not.toHaveBeenCalled();
            registry.cancel('replacement');
            await replacement;
        });
    });

    describe('timeout handling', () => {
        it('should resolve promise as timed out after expiry', async () => {
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
            expect(result.state).toBe('timed_out');
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
            expect(registry.getQuestion('q1')).toBeNull();
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
            expect(result).toMatchObject({ state: 'answered', answer });
            expect(jest.getTimerCount()).toBe(0);

            // Advancing further should not trigger timeout
            jest.advanceTimersByTime(5000);
        });
    });

    describe('custom timeout configuration', () => {
        it('should use custom timeout when provided', async () => {
            const customRegistry = new QuestionRegistry();

            const now = Date.now();
            const question: Omit<PendingQuestion, 'state'> = {
                questionId:      'q1',
                channelId:       'ch1' as ChannelId,
                originMessageId: 'msg1',
                triggerUserId:   'user1' as UserId,
                questionText:    'What is your name?',
                createdAt:       now,
                expiresAt:       now + 10_000,
            };

            const resultPromise = customRegistry.register(question);

            // Should not timeout before custom timeout
            jest.advanceTimersByTime(5000);
            const found = customRegistry.findPendingQuestion('ch1' as ChannelId);
            expect(found).toBeTruthy();

            // Should timeout after custom timeout
            jest.advanceTimersByTime(5000);
            const result = await resultPromise;
            expect(result.state).toBe('timed_out');

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

            // Clean up
            registry.cancel('q1');
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

            // Clean up
            registry.cancel('q1');
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
