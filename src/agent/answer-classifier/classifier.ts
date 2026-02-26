import _ from 'lodash';
import type { ClassificationResult, MessageToClassify, ClassifierConfig } from './types';
import type { PendingQuestion } from '@/agent/question-registry';

/**
 * Answer classifier for message classification.
 * Uses 4-layer classification:
 * 1. Structural cues (reply reference, thread match)
 * 2. Heuristics (answer patterns, interrupt patterns)
 * 3. LLM classification (if ambiguous and LLM available)
 * 4. Default to unrelated (if not @mentioned) or interruption (if @mentioned)
 */
export class AnswerClassifier {
    private readonly classifyWithLLM?: ClassifierConfig['classifyWithLLM'];

    constructor(config?: ClassifierConfig) {
        this.classifyWithLLM = config?.classifyWithLLM;
    }

    /**
     * Classify a message as answer, interruption, or unrelated.
     */
    async classify(question: PendingQuestion, message: MessageToClassify): Promise<ClassificationResult> {
        // Layer 1: Structural cues
        // If message is a reply to the question message
        if(message.referencedMessageId === question.originMessageId) {
            return 'answer';
        }

        // If question is in a thread and message is in same thread
        if(question.threadId && message.threadId === question.threadId) {
            return 'answer';
        }

        // Layer 2: Heuristics
        const text = _.toLower(_.trim(message.content));

        // Answer patterns - short affirmative/negative responses, direct answers
        // Longer alternatives first to avoid substring matches
        // Stryker disable next-line Regex: $ anchor required for pattern matching
        const answerPatterns = /^(?:yes|nope|yep|okay|sure|i think|because|it's|they're|that's|maybe|probably|definitely|of course|no|ok|\d+(?:\.\d+)?$)/i;

        // Interruption patterns - topic changes, new questions
        const interruptPatterns = /^(?:by the way|also|new topic|different question|hey|@|unrelated|actually|wait|hold on|sorry to interrupt)/i;

        if(answerPatterns.test(text)) {
            return 'answer';
        }

        if(interruptPatterns.test(text)) {
            return 'interruption';
        }

        // Layer 3: LLM classification (if configured)
        if(this.classifyWithLLM) {
            return this.classifyWithLLM(question, message);
        }

        // Layer 4: Default based on mention status
        // If bot was @mentioned, default to interruption (user is talking to bot)
        // If not @mentioned, default to unrelated (might not be for the bot)
        return message.isBotMentioned ? 'interruption' : 'unrelated';
    }
}
