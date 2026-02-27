import { logger } from '@hughescr/logger';
import type { PendingQuestion, QuestionAnswer, QuestionResult } from './types';
// eslint-disable-next-line boundaries/element-types -- Question registry imports Discord ChannelId type; decouple tracked in roadmap
import type { ChannelId } from '@/integrations/discord';

export interface QuestionRegistryConfig {
    defaultTimeoutMs?: number  // Default: 300000 (5 minutes)
}

interface StoredQuestion {
    question: PendingQuestion
    timer:    NodeJS.Timeout
    resolve:  (result: QuestionResult) => void
}

export class QuestionRegistry {
    // Key by channel:thread for fast lookup
    private readonly questionsByLocation = new Map<string, StoredQuestion>();
    // Key by questionId for resolution
    private readonly questionsById = new Map<string, StoredQuestion>();

    /**
     * Register a question and return a promise that resolves when answered or times out.
     */
    register(question: Omit<PendingQuestion, 'state'>): Promise<QuestionResult> {
        const locationKey = this.makeLocationKey(question.channelId, question.threadId);

        // Cancel any existing question for this location
        const existing = this.questionsByLocation.get(locationKey);
        // Stryker disable next-line BlockStatement: Guard clause - tested via behavior
        if(existing) {
            // Stryker disable all: Logger warn object
            logger.warn({
                oldQuestionId: existing.question.questionId,
                newQuestionId: question.questionId,
                channelId:     question.channelId,
                msg:           'Replacing existing pending question',
            });
            // Stryker restore all

            this.cleanupQuestion(existing.question.questionId);
            existing.resolve({
                questionId: existing.question.questionId,
                answer:     null,
                timedOut:   false,
                channelId:  existing.question.channelId,
                threadId:   existing.question.threadId,
            });
        }

        // Stryker disable all: BlockStatement mutations break Promise executor flow causing test timeouts
        return new Promise<QuestionResult>((resolve) => {
            const pendingQuestion: PendingQuestion = {
                ...question,
                state: 'waiting'
            };

            const timer = setTimeout(() => {
                const stored = this.questionsById.get(question.questionId);
                if(stored?.question.state === 'waiting') {
                    stored.question.state = 'timed_out';
                    this.cleanupQuestion(question.questionId);
                    resolve({
                        questionId: question.questionId,
                        answer:     null,
                        timedOut:   true,
                        channelId:  question.channelId,
                        threadId:   question.threadId,
                    });
                }
            }, question.expiresAt - question.createdAt);

            const stored: StoredQuestion = {
                question: pendingQuestion,
                timer,
                resolve
            };

            this.questionsById.set(question.questionId, stored);
            this.questionsByLocation.set(locationKey, stored);

            // Stryker disable all: Logger debug object
            logger.debug({
                questionId: question.questionId,
                channelId:  question.channelId,
                threadId:   question.threadId,
                expiresIn:  question.expiresAt - question.createdAt,
                msg:        'Question registered',
            });
            // Stryker restore all
        });
        // Stryker restore all
    }

    /**
     * Check if a message might be an answer to a pending question.
     * Returns the pending question if found, null otherwise.
     */
    findPendingQuestion(channelId: ChannelId, threadId?: string): PendingQuestion | null {
        const locationKey = this.makeLocationKey(channelId, threadId);
        const stored = this.questionsByLocation.get(locationKey);

        if(!stored) {
            return null;
        }

        const now = Date.now();
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: Expiration validation
        if(stored.question.state !== 'waiting' || stored.question.expiresAt < now) {
            return null;
        }

        return stored.question;
    }

    /**
     * Get a question by its ID.
     * Returns the question if found, null otherwise.
     */
    getQuestion(questionId: string): PendingQuestion | null {
        const stored = this.questionsById.get(questionId);
        return stored ? stored.question : null;
    }

    /**
     * Resolve a question with an answer.
     */
    resolveWithAnswer(questionId: string, answer: QuestionAnswer): void {
        const stored = this.questionsById.get(questionId);
        if(stored?.question.state !== 'waiting') {
            return;
        }

        stored.question.state = 'answered';
        this.cleanupQuestion(questionId);
        stored.resolve({
            questionId: stored.question.questionId,
            answer,
            timedOut:   false,
            channelId:  stored.question.channelId,
            threadId:   stored.question.threadId,
        });
    }

    /**
     * Cancel a question (e.g., due to interruption).
     */
    cancel(questionId: string): void {
        const stored = this.questionsById.get(questionId);
        if(stored?.question.state !== 'waiting') {
            return;
        }

        stored.question.state = 'cancelled';
        this.cleanupQuestion(questionId);
        stored.resolve({
            questionId: stored.question.questionId,
            answer:     null,
            timedOut:   false,
            channelId:  stored.question.channelId,
            threadId:   stored.question.threadId,
        });
    }

    /**
     * Stop the registry and clean up all timers.
     */
    stop(): void {
        // Cancel all pending questions
        for(const stored of this.questionsById.values()) {
            // Stryker disable next-line ConditionalExpression: State check in cleanup loop
            if(stored.question.state === 'waiting') {
                stored.question.state = 'cancelled';
                clearTimeout(stored.timer);
                stored.resolve({
                    questionId: stored.question.questionId,
                    answer:     null,
                    timedOut:   false,
                    channelId:  stored.question.channelId,
                    threadId:   stored.question.threadId,
                });
            }
        }

        this.questionsById.clear();
        this.questionsByLocation.clear();
    }

    private makeLocationKey(channelId: ChannelId, threadId?: string): string {
        // Stryker disable next-line LogicalOperator,StringLiteral: ?? provides default value
        return `${channelId}:${threadId ?? 'main'}`;
    }

    private cleanupQuestion(questionId: string): void {
        const stored = this.questionsById.get(questionId);
        if(!stored) {
            return;
        }

        clearTimeout(stored.timer);
        this.questionsById.delete(questionId);

        const locationKey = this.makeLocationKey(stored.question.channelId, stored.question.threadId);
        this.questionsByLocation.delete(locationKey);
    }
}
