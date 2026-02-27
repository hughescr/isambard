import split from 'lodash/split';
import toLower from 'lodash/toLower';
import trim from 'lodash/trim';
import { type ClassificationResult, type MessageToClassify, classificationResultSchema  } from './types';
import type { PendingQuestion } from '@/agent/question-registry';
import { generateText } from '@/agent/text-generator';

/**
 * Uses Haiku to classify ambiguous messages.
 */
export async function classifyWithHaiku(
    question: PendingQuestion,
    message: MessageToClassify
): Promise<ClassificationResult> {
    try {
        const prompt = buildClassificationPrompt(question, message);
        const response = await generateText(prompt);
        return parseClassificationResponse(response);
    } catch{
        // If LLM call fails, default to interruption (safer)
        return 'interruption';
    }
}

function buildClassificationPrompt(question: PendingQuestion, message: MessageToClassify): string {
    const askedAt = new Date(question.createdAt).toISOString();
    // Stryker disable all: LLM prompt context strings
    const threadContext = question.threadId ? `\n- Question is in thread: ${question.threadId}` : '';
    const referenceContext = message.referencedMessageId
        ? `\n- Message is a reply/reference to: ${message.referencedMessageId}`
        : '';
    const mentionContext = message.isBotMentioned ? '\n- Bot was @mentioned in this message' : '';
    const targetUserContext = message.targetUserId
        ? `\n- Question was directed at user ID: ${message.targetUserId}\n- Responding user ID is: ${message.authorId}\n- (Note: Anyone can answer, but consider whether the responder seems appropriate)`
        : '';

    // If bot was @mentioned, only offer 2 options (answer/interruption)
    // If not @mentioned, offer 3 options (answer/interruption/unrelated)
    const classificationOptions = message.isBotMentioned
        ? `Respond with exactly one word:
- "answer" if the message directly responds to the question
- "interruption" if the message is clearly addressed to the bot but starts a new topic`
        : `Respond with exactly one word:
- "answer" if the message directly responds to the question
- "interruption" if the message is clearly addressed to the bot (new topic/question)
- "unrelated" if the message doesn't seem to be addressed to the bot at all`;
    // Stryker restore all

    // Stryker disable next-line StringLiteral: LLM prompt template
    return `Classify whether the following message is an answer to the question, an interruption (new topic), or unrelated.

Question context:
- Question: "${question.questionText}"
- Asked at: ${askedAt}
- Asked by user: ${question.triggerUserId}
- In channel: ${question.channelId}${threadContext}${targetUserContext}

Message to classify:
- Content: "${message.content}"
- From user: ${message.authorId}
- In channel: ${message.channelId}${
    // Stryker disable all: LLM prompt content
    message.threadId
        ? `\n- In thread: ${message.threadId}`
        : ''
    // Stryker restore all
}${referenceContext}${mentionContext}

${classificationOptions}

Classification:`;
}

function parseClassificationResponse(response: string): ClassificationResult {
    const normalized = toLower(trim(response));

    // Extract first word if response contains explanation
    const firstWord = split(normalized, /[\s-]/)[0];

    // Try to parse as valid classification result
    const parseResult = classificationResultSchema.safeParse(firstWord);

    if(parseResult.success) {
        return parseResult.data;
    }

    // Default to interruption if parsing fails
    return 'interruption';
}
