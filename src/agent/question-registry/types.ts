import { z } from 'zod';
// eslint-disable-next-line boundaries/dependencies -- Question types use Discord ChannelId/UserId branded types; decouple per roadmap
import type { ChannelId, UserId } from '@/integrations/discord';

export const questionOptionSchema = z.object({
    label:       z.string(),
    value:       z.string(),
    description: z.string().optional(),
});

export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const questionStateSchema = z.enum(['waiting', 'answered', 'timed_out', 'cancelled']);
export type QuestionState = z.infer<typeof questionStateSchema>;

export interface PendingQuestion {
    questionId:      string              // UUID
    channelId:       ChannelId
    threadId?:       string               // If question was asked in a thread
    originMessageId: string         // Discord message ID of the question
    triggerUserId:   UserId           // User who started the conversation
    questionText:    string
    options?:        QuestionOption[]      // For button-based questions
    targetUserId?:   UserId           // User the question was directed at (advisory)
    createdAt:       number               // Timestamp
    expiresAt:       number               // createdAt + timeout
    state:           QuestionState
}

export interface QuestionAnswer {
    content:         string
    selectedOption?: string         // Button value if clicked
    responderId:     UserId
    messageId:       string
    channelId:       ChannelId      // Channel where answer was given
    threadId?:       string         // Thread ID if answered in a thread
}

export interface QuestionResult {
    questionId: string              // The question that was answered
    answer:     QuestionAnswer | null   // null if timed out
    timedOut:   boolean
    channelId:  ChannelId           // Channel where question was asked
    threadId?:  string              // Thread if question was in a thread
}
