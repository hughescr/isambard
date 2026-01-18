import { z } from 'zod';
import type { PendingQuestion } from '@/agent/question-registry';

export const classificationResultSchema = z.enum(['answer', 'interruption', 'unrelated']);
export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export interface MessageToClassify {
    content:              string
    authorId:             string
    channelId:            string
    threadId?:            string
    referencedMessageId?: string  // Discord reply reference
    isBotMentioned:       boolean // Whether the bot was @mentioned in the message
    targetUserId?:        string  // Who the question was directed at (advisory)
}

export interface ClassifierConfig {
    /** Function to call Haiku for ambiguous classification */
    classifyWithLLM?: (question: PendingQuestion, message: MessageToClassify) => Promise<ClassificationResult>
}
