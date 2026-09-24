import { z } from 'zod';
import type { ChannelId, UserId } from '@/agent/types';

export const questionOptionSchema = z.object({
    label:       z.string(),
    value:       z.string(),
    description: z.string().optional(),
});

export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const questionStateSchema = z.enum(['waiting', 'answered', 'timed_out', 'cancelled']);
type QuestionState = z.infer<typeof questionStateSchema>;
type TerminalQuestionState = Exclude<QuestionState, 'waiting'>;

export interface ConversationLocation {
    channelId: ChannelId
    threadId?: string
}

export interface PendingQuestion extends ConversationLocation {
    questionId:      string              // UUID
    originMessageId: string         // Platform message ID (Discord snowflake today) of the question
    triggerUserId:   UserId           // User who started the conversation
    questionText:    string
    options?:        QuestionOption[]      // For button-based questions
    targetUserId?:   UserId           // User the question was directed at (advisory)
    createdAt:       number               // Timestamp
    expiresAt:       number               // createdAt + timeout
    state:           QuestionState
}

export interface QuestionAnswer extends ConversationLocation {
    content:         string
    selectedOption?: string         // Button value if clicked
    responderId:     UserId
    messageId:       string
}

export type QuestionResult = ConversationLocation & { questionId: string } & (
  | { state: Extract<TerminalQuestionState, 'answered'>, answer: QuestionAnswer }
  | { state: Extract<TerminalQuestionState, 'timed_out'> }
  | { state: Extract<TerminalQuestionState, 'cancelled'>, reason: 'interrupted' | 'replaced' | 'shutdown' }
);
